const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

// =========================================================================
// [MỚI] HÀM TỐI ƯU HÓA RAM (CHẶN ẢNH, FONT, QUẢNG CÁO)
// =========================================================================
async function setupPageInterception(page) {
    await page.setRequestInterception(true);
    page.on('request', (request) => {
        const resourceType = request.resourceType();
        const url = request.url().toLowerCase();

        // 1. Chặn tải các file nặng không cần thiết (Ảnh, Font chữ, Video/Audio)
        if (['image', 'font', 'media'].includes(resourceType)) {
            request.abort();
        }
        // 2. Chặn mã theo dõi của Google, Facebook, Ads làm chậm trình duyệt
        else if (
            url.includes('google-analytics.com') ||
            url.includes('googletagmanager.com') ||
            url.includes('fbcdn.net') ||
            url.includes('facebook.net') ||
            url.includes('doubleclick.net')
        ) {
            request.abort();
        }
        // 3. Cho phép tải HTML, CSS, JS tĩnh bình thường
        else {
            request.continue();
        }
    });
}

/**
 * Hàm lưu kết quả ra 3 định dạng: JSON, CSV, và Excel
 */
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

/**
 * HÀM WORKER: Xử lý 1 link bài báo duy nhất
 */
async function checkSingleArticle(browser, articleHref, index) {
    const articlePage = await browser.newPage();

    // ÁP DỤNG CHẶN RAM CHO TAB BÀI BÁO NÀY
    await setupPageInterception(articlePage);

    let taskResult = { found: false, reason: '' };

    try {
        await articlePage.goto(articleHref, { waitUntil: 'networkidle2' });
        try { await articlePage.waitForSelector('.link-site', { timeout: 5000 }); } catch (e) { }

        const sourceLinks = await articlePage.evaluate(() => {
            return Array.from(document.querySelectorAll('a.link-site')).map(link => ({
                text: link.innerText.trim(), href: link.href
            }));
        });

        // 1. Check PMC
        const pmcLink = sourceLinks.find(l => l.text.toLowerCase().includes('full text (pmc)'));
        if (pmcLink) {
            console.log(`     + [Bài ${index}] Found "Full text (PMC)"`);
            taskResult = { found: true, reason: `Found PMC in article ${index}` };
            return taskResult;
        }

        // 2. Check External (BỎ QUA PMC VÀ BỎ QUA LUÔN PUBMED)
        const otherLinks = sourceLinks.filter(l => {
            const text = l.text.toLowerCase();
            const href = l.href.toLowerCase();
            return !text.includes('full text (pmc)') &&
                !text.includes('pubmed') &&
                !href.includes('pubmed.ncbi.nlm.nih.gov');
        });

        if (otherLinks.length > 0) {
            const link = otherLinks[0]; // Chắc chắn đây là link Nhà xuất bản
            const externalPage = await browser.newPage();

            // ÁP DỤNG CHẶN RAM CHO TAB ĐƯỜNG DẪN NGOÀI
            await setupPageInterception(externalPage);

            try {
                await externalPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                await externalPage.goto(link.href, { waitUntil: 'networkidle2', timeout: 30000 });
                await new Promise(r => setTimeout(r, 2000));

                let retryCount = 0;
                const maxRetries = 2;
                let foundPDF = false;

                while (retryCount <= maxRetries) {
                    try {
                        foundPDF = await externalPage.evaluate(() => {
                            const bodyText = document.body.innerText.toLowerCase();

                            // LỚP 1: TÌM DẤU HIỆU PAYWALL
                            const isPaywalled = bodyText.includes('log in for access') || bodyText.includes('purchase access') ||
                                bodyText.includes('buy this article') || bodyText.includes('get access to full text') ||
                                (bodyText.includes('not a subscriber') && bodyText.includes('buy'));
                            if (isPaywalled) return false;

                            // LỚP 2: TÌM NÚT PDF
                            if (bodyText.includes('download pdf') || bodyText.includes('full text pdf')) return true;

                            const interactiveElements = Array.from(document.querySelectorAll('a, button, [role="button"]'));
                            return interactiveElements.some(el => {
                                const rect = el.getBoundingClientRect();
                                if (rect.width === 0 || rect.height === 0) return false;
                                const style = window.getComputedStyle(el);
                                if (style.display === 'none' || style.visibility === 'hidden') return false;

                                const text = (el.innerText || '').toLowerCase().trim();
                                const href = (el.getAttribute('href') || '').toLowerCase();

                                const isTrapButton = text.includes('buy') || text.includes('purchase') || text.includes('login') || text.includes('log in');
                                if (isTrapButton) return false;

                                const validPdfTexts = ['pdf', 'download pdf', 'view pdf', 'article pdf', 'get pdf'];
                                return validPdfTexts.includes(text) || (href.endsWith('.pdf') && !href.includes('cart') && !href.includes('checkout'));
                            });
                        });
                        break;
                    } catch (evalErr) {
                        if (evalErr.message.includes('Execution context was destroyed') && retryCount < maxRetries) {
                            retryCount++;
                            await new Promise(r => setTimeout(r, 2000));
                        } else {
                            throw evalErr;
                        }
                    }
                }

                if (foundPDF) {
                    console.log(`       => [Bài ${index}] Found PDF at: ${link.text}`);
                    taskResult = { found: true, reason: `Found PDF in external source of article ${index}` };
                }
            } catch (err) {
                // Bỏ qua lỗi vặt ở trang ngoài
            } finally {
                await externalPage.close();
            }
        }
    } catch (err) {
        // Bỏ qua lỗi kết nối
    } finally {
        await articlePage.close();
    }

    return taskResult;
}

// =====================================================================
// HÀM CHÍNH
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

    let browser = await puppeteer.launch({
        headless: false,
        // headless: "new", // Chạy ngầm
        executablePath: executablePath,
        // args: [
        //     '--no-sandbox',
        //     '--disable-setuid-sandbox'
        // ]

        args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized']
    });

    let page = await browser.newPage();

    // ÁP DỤNG CHẶN RAM CHO TAB CHÍNH (THƯ VIỆN HUTECH)
    await setupPageInterception(page);

    // =====================================================================
    // KHU VỰC CẤU HÌNH TÙY CHỈNH
    // =====================================================================
    const results = [];
    const limit = 200; // Số lượng tạp chí tối đa cần lấy
    const targetLetter = ''; // Chữ cái để lọc
    const targetJournalName = ''; // Tên tạp chí muốn check riêng
    const maxArticles = 20; // Số bài báo tối đa cần gom trên mỗi tạp chí
    const concurrencyLevel = 2; // Số tab chạy song song
    // =====================================================================

    try {
        let url = 'https://lib.hutech.edu.vn/journalcategories';
        console.log(`Navigating to journal categories...`);
        await page.goto(url, { waitUntil: 'networkidle2' });

        try {
            console.log(' - Waiting for journals to load...');
            await page.waitForSelector('a.journal-cat-table-title-link', { timeout: 10000 });
        } catch (e) {
            console.warn(' - Warning: No journals appeared after 10s. Trying to proceed anyway...');
        }

        // --- LỌC THEO CHỮ CÁI ---
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
                    console.log(`   + Đã click thành công chữ [ ${targetLetter.toUpperCase()} ]. Đang chờ 10 giây để trang web tải danh sách mới...`);
                    await new Promise(r => setTimeout(r, 10000));
                } else {
                    console.log(`   + [!] KHÔNG TÌM THẤY chữ cái [ ${targetLetter.toUpperCase()} ]. Tool sẽ quét danh sách hiện tại.`);
                }
            } catch (err) {
                console.log(`   + [!] Lỗi khi click chữ cái: ${err.message}`);
            }
        }

        // Tự động cuộn trang
        async function autoScroll(page, targetCount, targetName) {
            let currentCount = 0; let previousCount = -1; let found = false;
            while (!found && currentCount !== previousCount) {
                if (!targetName && currentCount >= targetCount) break;
                previousCount = currentCount;
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await new Promise(r => setTimeout(r, 2000));
                const journalsOnPage = await page.evaluate(() => Array.from(document.querySelectorAll('a.journal-cat-table-title-link')).map(link => link.innerText.trim().toLowerCase()));
                currentCount = journalsOnPage.length;
                if (targetName) found = journalsOnPage.includes(targetName.toLowerCase());
            }
        }

        await autoScroll(page, limit, targetJournalName);

        const journalLinks = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a.journal-cat-table-title-link')).map(link => ({
                title: link.innerText.trim(), href: link.href
            }));
        });

        let journalsToCheck = targetJournalName ? journalLinks.filter(j => j.title.toLowerCase() === targetJournalName.toLowerCase()) : journalLinks.slice(0, limit);
        if (journalsToCheck.length === 0) { console.error('Không tìm thấy tạp chí nào.'); await browser.close(); return; }

        console.log(`Found ${journalLinks.length} journals. Checking ${journalsToCheck.length} journal(s)...`);

        for (let i = 0; i < journalsToCheck.length; i++) {
            const journal = journalsToCheck[i];
            console.log(`\n[${i + 1}/${journalsToCheck.length}] Checking: ${journal.title}`);

            // CƠ CHẾ AUTO-HEAL
            if (!browser.isConnected()) {
                console.log('   [!] CẢNH BÁO: Trình duyệt đã bị crash do quá tải. Đang khởi động lại Chrome...');
                browser = await puppeteer.launch({
                    // headless: "new",
                    headless: false,
                    defaultViewport: null,
                    executablePath: executablePath,
                    args: ['--no-sandbox', '--disable-setuid-sandbox']
                });
                page = await browser.newPage();
                await setupPageInterception(page);
                console.log('   [+] Trình duyệt đã khôi phục. Tiếp tục làm việc...');
            }

            try {
                console.log(` - Navigating to search results...`);
                await page.goto(journal.href, { waitUntil: 'networkidle2' });
                const articleSelector = "a[href^='/details/']";

                try {
                    await page.waitForSelector(articleSelector, { timeout: 20000 });
                } catch (e) {
                    console.log(' - Đã chờ 20s nhưng không có bài báo nào xuất hiện.');
                    results.push({ title: journal.title, status: 'Unknown', reason: 'No articles found' });
                    await saveResults(results);
                    continue;
                }

                let articleHrefs = [];
                let currentPageNum = 1;
                console.log(` - Đang tìm kiếm bài báo (Mục tiêu quét: đúng ${maxArticles} bài)...`);

                while (articleHrefs.length < maxArticles) {
                    try {
                        await page.waitForSelector(articleSelector, { timeout: 20000 });
                    } catch (e) {
                        console.log(`   + Không tìm thấy thêm bài báo nào ở trang ${currentPageNum}.`);
                        break;
                    }

                    const currentHrefs = await page.evaluate((sel) => Array.from(document.querySelectorAll(sel)).map(link => link.href), articleSelector);

                    for (let href of currentHrefs) {
                        if (!articleHrefs.includes(href)) articleHrefs.push(href);
                        if (articleHrefs.length >= maxArticles) break;
                    }

                    console.log(`   + Đang ở trang ${currentPageNum}. Đã gom được: ${articleHrefs.length}/${maxArticles} bài.`);

                    if (articleHrefs.length >= maxArticles) {
                        console.log(`   -> Đã đủ chỉ tiêu ${maxArticles} bài. Dừng thu thập.`);
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
                        console.log('   -> Đã đến trang kết quả cuối cùng của tạp chí này.');
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

                console.log(` - Bắt đầu quét ${articleHrefs.length} bài báo với ${concurrencyLevel} luồng (tabs) song song...`);

                let journalClassified = false;
                let finalReason = 'Checked articles and found no PDF indicators';
                let stopSignal = false;
                let currentIndex = 0;

                async function worker(workerId) {
                    while (currentIndex < articleHrefs.length && !stopSignal && browser.isConnected()) {
                        const taskIndex = currentIndex++;
                        const href = articleHrefs[taskIndex];
                        console.log(`   [Luồng ${workerId}] Đang mở bài ${taskIndex + 1}/${articleHrefs.length}...`);

                        const taskResult = await checkSingleArticle(browser, href, taskIndex + 1);

                        if (taskResult.found && !stopSignal) {
                            stopSignal = true;
                            journalClassified = true;
                            finalReason = taskResult.reason;
                            console.log(`   [Luồng ${workerId}] => TÌM THẤY PDF/PMC! Kích hoạt DỪNG SỚM các luồng khác.`);
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
                    results.push({ title: journal.title, status: 'Không bắt đăng nhập', reason: finalReason });
                } else if (browser.isConnected()) {
                    console.log(' - Result: Bắt đăng nhập (No PDF found in checked articles)');
                    results.push({ title: journal.title, status: 'Bắt đăng nhập', reason: finalReason });
                }

            } catch (err) {
                console.error(` - Error checking ${journal.title}:`, err.message);
                if (browser.isConnected()) {
                    results.push({ title: journal.title, status: 'Error', reason: err.message });
                }
            }

            await saveResults(results);
            console.log(` - Progress saved (${results.length} journals updated).`);
        }

        await saveResults(results);
        console.log('\n--- Finished ---');
        console.log('Results saved to JSON, CSV and Excel files.');
        console.table(results);

    } catch (error) {
        console.error('Fatal Error:', error);
    } finally {
        if (browser && browser.isConnected()) {
            await browser.close();
        }
    }
})();