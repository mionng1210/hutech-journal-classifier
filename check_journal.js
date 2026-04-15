const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const cliProgress = require('cli-progress');

// =========================================================================
// 0. HÀM GHI LOG VÀO FILE
// =========================================================================
const LOG_FILE = 'run_details.log';
fs.writeFileSync(LOG_FILE, `=== Journal Classification Tool - ${new Date().toLocaleString('vi-VN')} ===\n\n`);
function log(msg) {
    fs.appendFileSync(LOG_FILE, msg + '\n');
}

// =========================================================================
// 1. HÀM TỐI ƯU HÓA RAM (CHẶN ẢNH, FONT, QUẢNG CÁO)
// =========================================================================
async function setupPageInterception(page) {
    await page.setRequestInterception(true);
    page.on('request', (request) => {
        const resourceType = request.resourceType();
        const url = request.url().toLowerCase();

        if (['image', 'font', 'media'].includes(resourceType)) {
            request.abort();
        }
        else if (
            url.includes('google-analytics.com') ||
            url.includes('googletagmanager.com') ||
            url.includes('fbcdn.net') ||
            url.includes('facebook.net') ||
            url.includes('doubleclick.net')
        ) {
            request.abort();
        }
        else {
            request.continue();
        }
    });
}


// =========================================================================
// 3. HÀM KIỂM TRA UNPAYWALL API
// =========================================================================
function checkUnpaywall(doi, retries = 3, backoff = 2000) {
    return new Promise(async (resolve) => {
        if (!doi || !doi.startsWith('10.')) {
            resolve({ isOA: false, hasFullText: false, requiresPayment: null, url: null });
            return;
        }

        const randomDelay = Math.floor(Math.random() * 500) + 300;
        await new Promise(r => setTimeout(r, randomDelay));

        const cleanDoi = doi.replace(/[\.,;]+$/, '');
        const email = 'hutech_bot_checker@gmail.com';
        const apiUrl = `https://api.unpaywall.org/v2/${encodeURIComponent(cleanDoi)}?email=${email}`;

        https.get(apiUrl, (res) => {
            if (res.statusCode === 429) {
                if (retries > 0) {
                    log(`       [!] Unpaywall API Rate Limit (429). Đợi ${backoff / 1000}s và thử lại...`);
                    setTimeout(() => {
                        resolve(checkUnpaywall(doi, retries - 1, backoff * 2));
                    }, backoff);
                } else {
                    log(`       [!] Unpaywall API Rate Limit (429) - Hết số lần thử lại.`);
                    resolve({ isOA: false, hasFullText: false, requiresPayment: null, url: null, error: 'Rate Limit (429)' });
                }
                return;
            }

            if (res.statusCode !== 200 && res.statusCode !== 404) {
                log(`       [!] Unpaywall API trả về mã lỗi: ${res.statusCode}`);
                resolve({ isOA: false, hasFullText: false, requiresPayment: null, url: null, error: `HTTP ${res.statusCode}` });
                return;
            }

            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                if (res.statusCode === 404) {
                    resolve({
                        isOA: false,
                        hasFullText: false,
                        requiresPayment: true,
                        url: null,
                        error: 'Not Found (404)'
                    });
                    return;
                }

                try {
                    const json = JSON.parse(data);

                    const isOA = json.is_oa === true;
                    const journalIsOA = json.journal_is_oa === true;
                    const journalInDOAJ = json.journal_is_in_doaj === true;
                    const hasRepositoryCopy = json.has_repository_copy === true;

                    if (isOA && json.best_oa_location) {
                        const url = json.best_oa_location.url_for_pdf || json.best_oa_location.url_for_landing_page;
                        resolve({
                            isOA: true,
                            hasFullText: true,
                            requiresPayment: false,
                            url: url,
                            source: json.best_oa_location.host_type
                        });
                    }
                    else if (journalIsOA || journalInDOAJ) {
                        resolve({
                            isOA: true,
                            hasFullText: true,
                            requiresPayment: false,
                            url: null,
                            source: journalInDOAJ ? 'DOAJ' : 'Gold OA Journal'
                        });
                    }
                    else if (hasRepositoryCopy) {
                        resolve({
                            isOA: true,
                            hasFullText: true,
                            requiresPayment: false,
                            url: null,
                            source: 'Repository Copy'
                        });
                    }
                    else {
                        resolve({
                            isOA: false,
                            hasFullText: false,
                            requiresPayment: true,
                            url: null,
                            publisherHasOA: false,
                            hasRepositoryCopy: false
                        });
                    }
                } catch (e) {
                    resolve({ isOA: false, hasFullText: false, requiresPayment: null, url: null, error: e.message });
                }
            });
        }).on('error', (err) => {
            log(`       [!] Lỗi mạng khi gọi API Unpaywall: ${err.message}`);
            if (retries > 0) {
                log(`       [!] Lỗi mạng. Đợi ${backoff / 1000}s và thử lại...`);
                setTimeout(() => {
                    resolve(checkUnpaywall(doi, retries - 1, backoff * 2));
                }, backoff);
            } else {
                resolve({ isOA: false, hasFullText: false, requiresPayment: null, url: null, networkError: err.message });
            }
        });
    });
}

// =========================================================================
// 4. HÀM LƯU KẾT QUẢ
// =========================================================================
async function saveResults(results) {
    if (!results || results.length === 0) return;

    try {
        fs.writeFileSync('classification_results.json', JSON.stringify(results, null, 2));

        const csvHeader = '\uFEFFJournal Title,Status,Reason,Checked At\n';
        const csvRows = results.map(r => {
            const title = `"${(r.title || '').replace(/"/g, '""')}"`;
            const status = `"${(r.status || '').replace(/"/g, '""')}"`;
            const reason = `"${(r.reason || '').replace(/"/g, '""')}"`;
            const time = `"${new Date().toLocaleString('vi-VN')}"`;
            return `${title},${status},${reason},${time}`;
        }).join('\n');
        fs.writeFileSync('classification_results.csv', csvHeader + csvRows);

        try {
            const ExcelJS = require('exceljs');
            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Kết quả check');

            worksheet.columns = [
                { header: 'Tên Tạp Chí', key: 'title', width: 45 },
                { header: 'Trạng thái', key: 'status', width: 25 },
                { header: 'Lý do cụ thể', key: 'reason', width: 60 },
                { header: 'Thời gian quét', key: 'time', width: 25 },
            ];

            results.forEach(r => {
                const row = worksheet.addRow({
                    title: r.title, status: r.status, reason: r.reason, time: new Date().toLocaleString('vi-VN')
                });
                const statusCell = row.getCell('status');
                if (r.status === 'Không bắt đăng nhập') {
                    statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' } };
                    statusCell.font = { color: { argb: 'FF006100' }, bold: true };
                } else if (r.status === 'Bắt đăng nhập') {
                    statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
                    statusCell.font = { color: { argb: 'FF9C0006' }, bold: true };
                }
            });

            const headerRow = worksheet.getRow(1);
            headerRow.font = { bold: true, size: 12 };
            headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
            headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E0E0' } };
            worksheet.views = [{ state: 'frozen', ySplit: 1 }];

            await workbook.xlsx.writeFile('classification_results.xlsx');
        } catch (excelErr) {
            if (excelErr.code !== 'MODULE_NOT_FOUND') console.error(' [!] Lỗi khi tạo file Excel:', excelErr.message);
        }
    } catch (err) {
        console.error(' [!] Lỗi khi lưu file:', err.message);
    }
}

// =========================================================================
// 5. HÀM XỬ LÝ 1 BÀI BÁO (WORKER)
// =========================================================================
async function checkSingleArticle(browser, articleHref, index) {
    const articlePage = await browser.newPage();
    await setupPageInterception(articlePage);

    let taskResult = { found: false, reason: 'No DOI found to verify via Unpaywall' };

    try {
        await articlePage.goto(articleHref, { waitUntil: 'networkidle2', timeout: 30000 });

        try { await articlePage.waitForSelector('.link-site', { timeout: 5000 }); } catch (e) { }

        const sourceLinks = await articlePage.evaluate(() => {
            return Array.from(document.querySelectorAll('a.link-site')).map(link => ({
                text: link.innerText.trim(), href: link.href
            }));
        });

        // 1. Check PMC trước tiên
        const pmcLink = sourceLinks.find(l => l.text.toLowerCase().includes('full text (pmc)'));
        if (pmcLink) {
            log(`     + [Bài ${index}] Found "Full text (PMC)"`);
            taskResult = { found: true, reason: `Found PMC in article ${index}` };
            await articlePage.close();
            return taskResult;
        }

        // 2. Lấy link Nhà Xuất Bản
        const otherLinks = sourceLinks.filter(l => {
            const text = l.text.toLowerCase();
            const href = l.href.toLowerCase();
            return !text.includes('full text (pmc)') &&
                !text.includes('pubmed') &&
                !href.includes('pubmed.ncbi.nlm.nih.gov');
        });

        if (otherLinks.length > 0) {
            const link = otherLinks[0];

            // --- PRE-CHECK ---
            const freeAccessKeywords = ['read the full text', 'view pdf', 'download pdf', 'full text', 'open access', 'free full text', 'access online'];
            const hasOAIndicator = sourceLinks.some(link =>
                freeAccessKeywords.some(kw => link.text.toLowerCase().includes(kw))
            );

            if (hasOAIndicator) {
                log(`       => [Bài ${index}] PHÁT HIỆN: Nguồn có chỉ rõ "Read/View/Download" => MIỄN PHÍ (Bỏ qua Unpaywall)`);
                taskResult = { found: true, reason: `Direct free access link found in article ${index}` };
                await articlePage.close();
                return taskResult;
            }

            // --- TRÍCH XUẤT DOI VÀ CHECK UNPAYWALL ---
            let extractedDoi = null;
            const doiMatch = link.href.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i) || link.text.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);

            let unpaywallResult = null;

            if (doiMatch) {
                extractedDoi = doiMatch[0].replace(/[\.,;]+$/, '');
                log(`       => [Bài ${index}] Bắt được DOI: ${extractedDoi}. Đang gọi Unpaywall...`);

                unpaywallResult = await checkUnpaywall(extractedDoi);

                if (unpaywallResult.isOA === true) {
                    log(`       => [Bài ${index}] Unpaywall báo: MIỄN PHÍ! (Open Access - ${unpaywallResult.source})`);
                    taskResult = { found: true, reason: `Unpaywall confirmed OA in article ${index} (DOI: ${extractedDoi})` };
                    await articlePage.close();
                    return taskResult;
                }
            } else {
                log(`       => [Bài ${index}] Cảnh báo: KHÔNG tìm thấy DOI an toàn. Chuyển sang Deep Scan.`);
            }

            // --- DEEP SCAN FALLBACK (LOGIC MỚI - DETERMINISTIC) ---
            log(`       => [Bài ${index}] Đang Deep Scan trang gốc: ${link.href}`);
            try {
                await articlePage.goto(link.href, { waitUntil: 'domcontentloaded', timeout: 25000 });
                await new Promise(r => setTimeout(r, 2000));

                const deepScanResult = await articlePage.evaluate(() => {
                    // === BƯỚC 1: TÌM CHUẨN DỮ LIỆU JSON-LD (ĐỘ CHÍNH XÁC 100%) ===
                    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
                    for (const script of scripts) {
                        try {
                            const data = JSON.parse(script.innerText);
                            const items = Array.isArray(data) ? data : [data];
                            for (const item of items) {
                                if (item['@type'] === 'ScholarlyArticle' || item['@type'] === 'Article') {
                                    if (item.isAccessibleForFree === true) {
                                        return { isOA: true, signal: 'JSON-LD: isAccessibleForFree=true' };
                                    }
                                    if (item.isAccessibleForFree === false) {
                                        return { isOA: false, signal: 'JSON-LD: isAccessibleForFree=false' };
                                    }
                                }
                            }
                        } catch (e) { /* Bỏ qua lỗi parse JSON */ }
                    }

                    // === BƯỚC 2: TÌM THẺ META TAG BẢN QUYỀN CHÍNH THỨC ===
                    const hasOaMeta = document.querySelector(
                        'meta[name="DC.AccessRights"][content*="open access" i], ' +
                        'meta[name="dc.rights"][content*="open access" i]'
                    );
                    if (hasOaMeta) return { isOA: true, signal: 'Official Meta Tag: Open Access' };

                    // === BƯỚC 3: GIỚI HẠN VÙNG QUÉT TEXT (CHỈ QUÉT NỘI DUNG CHÍNH HOẶC HEADER) ===
                    const articleHeader = document.querySelector('header, .article-header, .c-article-header, .Title, h1');
                    const mainContent = document.querySelector('article, main, #main-content, .article-wrapper') || document.body;

                    const headerText = articleHeader ? articleHeader.innerText.toLowerCase() : '';
                    const mainText = mainContent.innerText.toLowerCase();

                    // ƯU TIÊN 1: Bắt tín hiệu Paywall (Bắt đăng nhập/Mua bài)
                    const strictPaywallSignals = [
                        'buy this article', 'purchase this article',
                        'get access to this article', 'rent this article',
                        'access through your institution', 'log in to check access',
                        'purchase access', 'restricted access'
                    ];
                    const hasPaywall = strictPaywallSignals.some(s => mainText.includes(s));
                    if (hasPaywall) return { isOA: false, signal: 'Explicit Paywall text found in Main Content' };

                    // ƯU TIÊN 2: Bắt tín hiệu OA an toàn trong vùng Header/Title
                    if (articleHeader) {
                        if (articleHeader.querySelector('.c-article-open-access, [data-test="open-access-label"]')) return { isOA: true, signal: 'Springer OA header badge' };
                        if (articleHeader.querySelector('.OpenAccessLabel, .access-indicator--open')) return { isOA: true, signal: 'Elsevier OA header badge' };
                        if (articleHeader.querySelector('.open-access__icon, .oa-icon')) return { isOA: true, signal: 'Wiley OA header badge' };
                        if (articleHeader.querySelector('.access-icon.open-access')) return { isOA: true, signal: 'T&F OA header badge' };

                        if (headerText.includes('open access') && !headerText.includes('options')) {
                            return { isOA: true, signal: 'Open Access text strictly near Article Title' };
                        }
                    }

                    // === BƯỚC 4: KIỂM TRA GIẤY PHÉP CREATIVE COMMONS TRỰC TIẾP TỪ NGUỒN ===
                    const ccLink = mainContent.querySelector('a[href*="creativecommons.org/licenses/"]');
                    if (ccLink) return { isOA: true, signal: 'Creative Commons License URL found in Main Content' };

                    // === BƯỚC 5: CONSERVATIVE FALLBACK ===
                    return { isOA: false, signal: 'No strict OA markers found (Conservative Fallback)' };
                });

                if (deepScanResult.isOA) {
                    log(`       => [Bài ${index}] DEEP SCAN XÁC NHẬN MIỄN PHÍ: ${deepScanResult.signal}`);
                    taskResult = { found: true, reason: extractedDoi ? `Deep scan in article ${index}: ${deepScanResult.signal} (DOI: ${extractedDoi})` : `Deep scan in article ${index}: ${deepScanResult.signal}` };
                } else {
                    const statusMsg = unpaywallResult && unpaywallResult.error ? `Unpaywall Error (${unpaywallResult.error})` : (extractedDoi ? 'Unpaywall: CÓ PHÍ' : 'No DOI');
                    log(`       => [Bài ${index}] Deep Scan: ${deepScanResult.signal} (${statusMsg}).`);
                    taskResult = { found: false, reason: `${statusMsg}. Deep Scan: ${deepScanResult.signal}` };
                }
            } catch (scanErr) {
                log(`       => [Bài ${index}] Deep Scan thất bại: ${scanErr.message}`);
                const statusMsg = unpaywallResult && unpaywallResult.error ? `Unpaywall Error (${unpaywallResult.error})` : (extractedDoi ? 'Unpaywall: CÓ PHÍ' : 'No DOI');
                taskResult = { found: false, reason: statusMsg };
            }
        }
    } catch (err) {
        // Ignore errors
    } finally {
        if (!articlePage.isClosed()) await articlePage.close();
    }

    return taskResult;
}

// =====================================================================
// 6. HÀM CHÍNH (MAIN)
// =====================================================================
(async () => {
    console.log('--- Starting Journal Classification Tool ---');

    const chromePaths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe')
    ];

    let executablePath = '';
    for (const p of chromePaths) {
        if (fs.existsSync(p)) { executablePath = p; break; }
    }

    if (!executablePath) {
        console.error('Không tìm thấy trình duyệt Chrome.'); return;
    }

    function killZombieChrome() {
        try {
            const result = execSync(
                'wmic process where "name=\'chrome.exe\' and commandline like \'%--headless%\'" get processid /format:list',
                { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
            );
            const pids = result.match(/ProcessId=(\d+)/g);
            if (pids) {
                for (const pidStr of pids) {
                    const pid = pidStr.replace('ProcessId=', '');
                    try {
                        execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore' });
                    } catch (e) { }
                }
            }
        } catch (e) { }
    }

    const CHROME_ARGS = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--start-maximized',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
    ];

    async function launchBrowser() {
        return puppeteer.launch({
            headless: "new",
            executablePath: executablePath,
            args: CHROME_ARGS
        });
    }

    killZombieChrome();
    await new Promise(r => setTimeout(r, 1000));

    let browser = await launchBrowser();

    process.on('SIGINT', async () => {
        console.log('\n[!] Bạn đã nhấn Ctrl+C. Đang dọn dẹp và đóng các Chrome ẩn để tránh rác RAM (zombie process)...');
        if (browser && browser.isConnected()) {
            try { await browser.close(); } catch (e) { }
        }
        killZombieChrome();
        process.exit(0);
    });

    let page = await browser.newPage();

    // =====================================================================
    // KHU VỰC CẤU HÌNH TÙY CHỈNH
    // =====================================================================
    const results = [];
    const limit = 423;
    const targetLetter = '';
    const targetJournalName = '';
    const startFromJournal = '';
    const maxArticles = 5;
    const concurrencyLevel = 2;
    const maxJournalsBeforeRestart = 10;
    // =====================================================================

    try {
        const url = 'https://lib.hutech.edu.vn/journalcategories';
        const MAX_PAGE_RETRIES = 5;

        async function waitForJournals(pg, timeoutMs = 20000) {
            const start = Date.now();
            while (Date.now() - start < timeoutMs) {
                const count = await pg.evaluate(() =>
                    document.querySelectorAll('a.journal-cat-table-title-link').length
                );
                if (count > 0) return count;
                await new Promise(r => setTimeout(r, 1000));
            }
            return 0;
        }

        let journalsLoaded = false;

        for (let attempt = 1; attempt <= MAX_PAGE_RETRIES; attempt++) {
            console.log(`Navigating to journal categories... (lần ${attempt}/${MAX_PAGE_RETRIES})`);

            if (attempt > 1) {
                console.log(' - Đang relaunch browser mới hoàn toàn...');
                try { await browser.close(); } catch (e) { }
                killZombieChrome();
                await new Promise(r => setTimeout(r, 2000));
                browser = await launchBrowser();
                page = await browser.newPage();
            }

            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            } catch (navErr) {
                console.warn(` - Lỗi navigation: ${navErr.message}. Thử lại...`);
                if (attempt < MAX_PAGE_RETRIES) continue;
                throw navErr;
            }

            console.log(' - Waiting for Blazor to render journals...');
            let count = await waitForJournals(page, 20000);

            if (count === 0 && attempt < MAX_PAGE_RETRIES) {
                console.warn(` - Warning: No journals appeared after 20s. Relaunch browser và thử lại... (lần ${attempt})`);
                continue;
            }

            if (count > 0) {
                journalsLoaded = true;
            }

            if (targetLetter) {
                console.log(` - Đang tìm và click mục chữ cái [ ${targetLetter.toUpperCase()} ]...`);
                try {
                    await new Promise(r => setTimeout(r, 2000));

                    const clicked = await page.evaluate((letter) => {
                        const elements = Array.from(document.querySelectorAll('a, button, span, .journal-cat-filter-btn'));
                        const target = elements.find(el =>
                            el.innerText.trim() === letter.toUpperCase() && el.offsetParent !== null
                        );
                        if (target) {
                            target.click();
                            return true;
                        }
                        return false;
                    }, targetLetter);

                    if (clicked) {
                        console.log(`   + Đã click thành công chữ [ ${targetLetter.toUpperCase()} ]. Đang chờ danh sách tải...`);
                        count = await waitForJournals(page, 20000);

                        if (count === 0 && attempt < MAX_PAGE_RETRIES) {
                            console.warn(`   + [!] Sau khi click [ ${targetLetter.toUpperCase()} ], không thấy tạp chí nào. Thử lại từ đầu...`);
                            continue;
                        }

                        if (count > 0) {
                            console.log(`   + Đã tải xong: phát hiện ${count} tạp chí.`);
                            journalsLoaded = true;
                        } else {
                            console.warn(`   + [!] Không tìm thấy tạp chí nào sau khi click [ ${targetLetter.toUpperCase()} ].`);
                        }
                    } else {
                        console.log(`   + [!] KHÔNG TÌM THẤY chữ cái [ ${targetLetter.toUpperCase()} ]. Tool sẽ quét danh sách hiện tại.`);
                    }
                } catch (err) {
                    console.log(`   + [!] Lỗi khi click chữ cái: ${err.message}`);
                }
            }

            if (journalsLoaded || count > 0) break;
        }

        if (!journalsLoaded) {
            console.warn(' - [!] Vẫn không tải được danh sách tạp chí sau tất cả các lần thử. Tiếp tục với dữ liệu hiện có...');
        }

        async function autoScroll(page, targetCount, targetName) {
            let currentCount = 0; let previousCount = -1; let found = false;
            while (currentCount !== previousCount || (!found && targetName)) {
                if (!targetName && currentCount >= targetCount) break;
                if (found && currentCount >= targetCount) break;
                previousCount = currentCount;
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await new Promise(r => setTimeout(r, 2000));
                const journalsOnPage = await page.evaluate(() => Array.from(document.querySelectorAll('a.journal-cat-table-title-link')).map(link => link.innerText.trim().toLowerCase()));
                currentCount = journalsOnPage.length;
                if (targetName && !found) {
                    found = journalsOnPage.includes(targetName.toLowerCase());
                    if (found) {
                        const idx = journalsOnPage.indexOf(targetName.toLowerCase());
                        targetCount = idx + limit;
                    }
                }
            }
        }

        const scrollTarget = startFromJournal || targetJournalName || '';
        if (scrollTarget) {
            console.log(` - Đang scroll tìm tạp chí: "${scrollTarget}"...`);
        }
        await autoScroll(page, limit, scrollTarget || null);

        const journalLinks = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a.journal-cat-table-title-link')).map(link => ({
                title: link.innerText.trim(), href: link.href
            }));
        });

        let journalsToCheck = targetJournalName ? journalLinks.filter(j => j.title.toLowerCase() === targetJournalName.toLowerCase()) : journalLinks;
        if (journalsToCheck.length === 0) { console.error('Không tìm thấy tạp chí nào.'); await browser.close(); return; }

        if (startFromJournal) {
            const startIndex = journalsToCheck.findIndex(j => j.title.toLowerCase() === startFromJournal.toLowerCase());
            if (startIndex === -1) {
                console.warn(`[!] Không tìm thấy tạp chí "${startFromJournal}" trong danh sách (đã scroll ${journalsToCheck.length} tạp chí). Bắt đầu từ đầu.`);
                journalsToCheck = journalsToCheck.slice(0, limit);
            } else {
                console.log(`Bỏ qua ${startIndex} tạp chí đầu. Bắt đầu từ: "${journalsToCheck[startIndex].title}"`);
                journalsToCheck = journalsToCheck.slice(startIndex, startIndex + limit);
            }
        } else {
            journalsToCheck = journalsToCheck.slice(0, limit);
        }

        await setupPageInterception(page);

        console.log(`Found ${journalLinks.length} journals. Checking ${journalsToCheck.length} journal(s)...`);

        const termWidth = process.stdout.columns || 120;
        const maxNameLen = Math.max(20, termWidth - 110);
        function truncName(name) {
            return name.length > maxNameLen ? name.substring(0, maxNameLen - 3) + '...' : name;
        }

        const progressBar = new cliProgress.SingleBar({
            format: 'Tiến độ: |{bar}| {percentage}% || {value}/{total} Tạp chí || Đang check: {journalName}',
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
            clearOnComplete: true,
            forceRedraw: true
        }, cliProgress.Presets.shades_classic);

        progressBar.start(journalsToCheck.length, 0, { journalName: 'Bắt đầu...' });

        for (let i = 0; i < journalsToCheck.length; i++) {
            const journal = journalsToCheck[i];

            progressBar.update(i, { journalName: truncName(journal.title) });

            if (i > 0 && i % maxJournalsBeforeRestart === 0) {
                if (browser && browser.isConnected()) {
                    await browser.close();
                }
            }

            if (!browser.isConnected()) {
                if (i % maxJournalsBeforeRestart !== 0) {
                    log('   [!] CẢNH BÁO: Trình duyệt đã bị crash do quá tải. Đang khôi phục...');
                }
                killZombieChrome();
                await new Promise(r => setTimeout(r, 1000));
                browser = await launchBrowser();
                page = await browser.newPage();
                await setupPageInterception(page);
            }

            try {
                log(`\n[Tạp chí ${i + 1}/${journalsToCheck.length}] ${journal.title}`);
                log(` - Navigating to search results...`);
                const articleSelector = "a[href^='/details/']";
                const MAX_ARTICLE_RETRIES = 5;

                let selectorFound = false;
                for (let attempt = 1; attempt <= MAX_ARTICLE_RETRIES; attempt++) {
                    try {
                        await page.goto(journal.href, { waitUntil: 'networkidle2', timeout: 30000 });
                        await new Promise(r => setTimeout(r, 3000));

                        const hasNoResults = await page.evaluate(() => {
                            const text = document.body.innerText;
                            return text.includes('Không có kết quả') || text.includes('Không có dữ liệu');
                        });

                        if (hasNoResults && attempt < MAX_ARTICLE_RETRIES) {
                            log(` - Lần ${attempt}: Blazor trả "Không có kết quả" (lỗi tạm). Re-navigate...`);
                            continue;
                        }

                        await page.waitForSelector(articleSelector, { timeout: 15000 });
                        selectorFound = true;
                        break;
                    } catch (e) {
                        if (attempt < MAX_ARTICLE_RETRIES) {
                            log(` - Lần ${attempt} không tìm thấy bài báo. Re-navigate lại toàn bộ...`);
                        } else {
                            log(` - Lần ${attempt} vẫn không tìm thấy bài báo nào. Bỏ qua.`);
                        }
                    }
                }

                if (!selectorFound) {
                    results.push({ title: journal.title, status: 'Unknown', reason: 'No articles found (after retry)' });
                    await saveResults(results);
                    continue;
                }

                let articleHrefs = [];
                let currentPageNum = 1;
                log(` - Đang tìm kiếm bài báo (Mục tiêu quét: đúng ${maxArticles} bài)...`);

                while (articleHrefs.length < maxArticles) {
                    try {
                        await page.waitForSelector(articleSelector, { timeout: 20000 });
                    } catch (e) {
                        log(`   + Không tìm thấy thêm bài báo nào ở trang ${currentPageNum}.`);
                        break;
                    }

                    const currentHrefs = await page.evaluate((sel) => Array.from(document.querySelectorAll(sel)).map(link => link.href), articleSelector);

                    for (let href of currentHrefs) {
                        if (!articleHrefs.includes(href)) articleHrefs.push(href);
                        if (articleHrefs.length >= maxArticles) break;
                    }

                    log(`   + Đang ở trang ${currentPageNum}. Đã gom được: ${articleHrefs.length}/${maxArticles} bài.`);

                    if (articleHrefs.length >= maxArticles) {
                        log(`   -> Đã đủ chỉ tiêu ${maxArticles} bài. Dừng thu thập.`);
                        break;
                    }

                    const hasNext = await page.evaluate((current) => {
                        const buttons = Array.from(document.querySelectorAll('button.btn-paginate'));
                        const nextBtn = buttons.find(b => b.innerText.trim() === (current + 1).toString());
                        if (nextBtn) { nextBtn.click(); return true; }

                        const arrowBtn = buttons.find(b => b.innerText.includes('>') && !b.hasAttribute('disabled'));
                        if (arrowBtn) { arrowBtn.click(); return true; }

                        return false;
                    }, currentPageNum);

                    if (!hasNext) {
                        log('   -> Đã đến trang kết quả cuối cùng của tạp chí này.');
                        break;
                    }

                    currentPageNum++;
                    await new Promise(r => setTimeout(r, 3000));
                }

                if (articleHrefs.length === 0) {
                    results.push({ title: journal.title, status: 'Unknown', reason: 'No articles found after pagination' });
                    await saveResults(results);
                    continue;
                }

                log(` - Bắt đầu quét ${articleHrefs.length} bài báo với ${concurrencyLevel} luồng (tabs) song song...`);

                let journalClassified = false;
                let finalReason = 'No DOI found in any checked article to verify via Unpaywall';
                let stopSignal = false;
                let currentIndex = 0;

                async function worker(workerId) {
                    while (currentIndex < articleHrefs.length && !stopSignal && browser.isConnected()) {
                        const taskIndex = currentIndex++;
                        const href = articleHrefs[taskIndex];
                        log(`   [Luồng ${workerId}] Đang mở bài ${taskIndex + 1}/${articleHrefs.length}...`);

                        const taskResult = await checkSingleArticle(browser, href, taskIndex + 1);

                        if (taskResult.found && !stopSignal) {
                            stopSignal = true;
                            journalClassified = true;
                            finalReason = taskResult.reason;
                            log(`   [Luồng ${workerId}] => TÌM THẤY! Kích hoạt DỪNG SỚM các luồng khác.`);
                        }
                    }
                }

                const workers = [];
                const actualWorkers = Math.min(concurrencyLevel, articleHrefs.length);
                for (let w = 1; w <= actualWorkers; w++) {
                    workers.push(worker(w));
                }

                await Promise.all(workers);

                if (journalClassified) {
                    log(` => KẾT QUẢ: Không bắt đăng nhập (${finalReason})`);
                    results.push({ title: journal.title, status: 'Không bắt đăng nhập', reason: finalReason });
                } else if (browser.isConnected()) {
                    log(` => KẾT QUẢ: Bắt đăng nhập (${finalReason})`);
                    results.push({ title: journal.title, status: 'Bắt đăng nhập', reason: finalReason });
                }

            } catch (err) {
                log(` - Error checking ${journal.title}: ${err.message}`);
                if (browser.isConnected()) {
                    results.push({ title: journal.title, status: 'Error', reason: err.message });
                }
            }

            await saveResults(results);
            progressBar.update(i + 1);
        }

        progressBar.stop();
        await saveResults(results);
        console.log('\n--- Finished ---');
        console.log(`Results saved to JSON, CSV, Excel files.`);
        console.log(`Chi tiết từng tạp chí xem tại: ${LOG_FILE}`);
        console.table(results);

        // =====================================================================
        // BẢNG THỐNG KÊ TÓM TẮT
        // =====================================================================
        const countFree = results.filter(r => r.status === 'Không bắt đăng nhập').length;
        const countPaid = results.filter(r => r.status === 'Bắt đăng nhập').length;
        const countUnknown = results.filter(r => r.status === 'Unknown').length;
        const countError = results.filter(r => r.status === 'Error').length;
        console.log('\n========== THỐNG KÊ KẾT QUẢ ==========');
        console.log(`  Không bắt đăng nhập : ${countFree}`);
        console.log(`  Bắt đăng nhập       : ${countPaid}`);
        console.log(`  Unknown              : ${countUnknown}`);
        if (countError > 0) console.log(`  Error               : ${countError}`);
        console.log(`  Tổng cộng           : ${results.length}`);
        console.log('========================================');

    } catch (error) {
        console.error('Fatal Error:', error);
    } finally {
        if (browser && browser.isConnected()) {
            await browser.close();
        }
    }
})();