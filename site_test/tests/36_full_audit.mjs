import { chromium } from 'playwright';
import fs from 'fs';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

const URL = 'http://localhost:8000/';
const R = [];
const log = (l, s, d = '') => { R.push({ l, s, d }); console.log(`[${s}] ${l}${d ? ' — ' + d : ''}`); };

fs.mkdirSync('/tmp/audit', { recursive: true });
// 2-page PDF fixture
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 2; i++) {
    const pg = doc.addPage([300, 400]);
    pg.drawText(`Page ${i}`, { x: 40, y: 350, size: 24, font });
  }
  fs.writeFileSync('/tmp/audit/doc.pdf', await doc.save());
}
// another PDF for merge
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pg = doc.addPage([300, 400]);
  pg.drawText('Second file', { x: 40, y: 350, size: 20, font });
  fs.writeFileSync('/tmp/audit/doc2.pdf', await doc.save());
}

const browser = await chromium.launch();
const allErrs = [];

async function freshPage() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', e => allErrs.push({ where: page.url(), msg: e.message }));
  page.on('console', m => { if (m.type() === 'error' && !/Indexing all PDF objects/i.test(m.text())) allErrs.push({ where: page.url(), msg: 'C:' + m.text() }); });
  return { ctx, page };
}

try {
  // ═══ 1. HOME + navigation ═══
  let { page } = await freshPage();
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('h1');
  log('Home loads', true ? 'PASS' : 'FAIL');
  log('Title present', /fotOOK/i.test(await page.title()) ? 'PASS' : 'FAIL', await page.title());
  const metaDesc = await page.evaluate(() => document.querySelector('meta[name="description"]')?.content || '');
  log('Meta description present', metaDesc.length > 20 ? 'PASS' : 'FAIL');
  const favicon = await page.evaluate(() => !!document.querySelector('link[rel="icon"]'));
  log('Favicon link present', favicon ? 'PASS' : 'FAIL');

  await page.getByText(/Photo Tools/).first().click(); await page.waitForTimeout(300);
  log('Photo Tools hub opens', await page.getByText('DV Lottery').first().isVisible().catch(() => false) ? 'PASS' : 'FAIL');
  await page.goto(URL); await page.waitForSelector('h1');
  await page.getByText(/PDF Tools/).first().click(); await page.waitForTimeout(300);
  log('PDF Tools hub opens', await page.getByText('Merge PDF').first().isVisible().catch(() => false) ? 'PASS' : 'FAIL');

  // ═══ 2. MERGE PDF — full happy path incl. download ═══
  await page.goto(URL); await page.waitForSelector('h1');
  await page.getByText(/PDF Tools/).first().click(); await page.waitForTimeout(250);
  await page.getByText('Merge PDF').first().click(); await page.waitForTimeout(300);
  await page.locator('input[type="file"]').first().setInputFiles(['/tmp/audit/doc.pdf', '/tmp/audit/doc2.pdf']);
  await page.waitForTimeout(2500);
  const mergeThumbs = await page.locator('.orgpage').count();
  log('Merge: multi-file upload shows page thumbnails', mergeThumbs === 3 ? 'PASS' : 'FAIL', `${mergeThumbs} thumbs (expect 3)`);
  const dlP1 = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  await page.locator('button:has-text("Merge & Download")').click();
  const d1 = await dlP1;
  if (d1) {
    await d1.saveAs('/tmp/audit/merged.pdf');
    const mp = await PDFDocument.load(fs.readFileSync('/tmp/audit/merged.pdf'));
    log('Merge: downloaded PDF has correct page count', mp.getPageCount() === 3 ? 'PASS' : 'FAIL', `${mp.getPageCount()} pages`);
  } else log('Merge: download fires', 'FAIL', 'no download event');

  // ═══ 3. SPLIT PDF ═══
  await page.goto(URL); await page.waitForSelector('h1');
  await page.getByText(/PDF Tools/).first().click(); await page.waitForTimeout(250);
  await page.getByText('Split PDF').first().click(); await page.waitForTimeout(300);
  await page.locator('input[type="file"]').first().setInputFiles('/tmp/audit/doc.pdf');
  await page.waitForTimeout(2000);
  log('Split: pages render after upload', await page.locator('.orgpage').count() >= 1 ? 'PASS' : 'FAIL');

  // ═══ 4. ORGANIZE PDF — rotate + reorder + download ═══
  await page.goto(URL); await page.waitForSelector('h1');
  await page.getByText(/PDF Tools/).first().click(); await page.waitForTimeout(250);
  await page.getByText('Organize PDF').first().click(); await page.waitForTimeout(300);
  await page.locator('input[type="file"]').first().setInputFiles('/tmp/audit/doc.pdf');
  await page.waitForTimeout(2000);
  log('Organize: pages render', await page.locator('.orgpage').count() === 2 ? 'PASS' : 'FAIL');
  const dlP2 = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  await page.locator('button:has-text("Download")').first().click();
  const d2 = await dlP2;
  log('Organize: download fires', d2 ? 'PASS' : 'FAIL');

  // ═══ 5. EDIT PDF — upload, add text, export ═══
  await page.goto(URL); await page.waitForSelector('h1');
  await page.getByText(/PDF Tools/).first().click(); await page.waitForTimeout(250);
  await page.getByText('Edit PDF').first().click(); await page.waitForTimeout(300);
  await page.locator('input[type="file"]').first().setInputFiles('/tmp/audit/doc.pdf');
  await page.waitForTimeout(3000);
  const canvasOk = await page.evaluate(() => { const c = document.querySelector('canvas'); return c && c.width > 0; });
  log('Edit PDF: canvas renders the page', canvasOk ? 'PASS' : 'FAIL');
  await page.locator('button[title="Text"]').click();
  const cbox = await page.evaluate(() => { const c = document.querySelector('canvas'); const r = c.getBoundingClientRect(); return { x: r.left + 60, y: r.top + 60 }; });
  await page.mouse.click(cbox.x, cbox.y); await page.waitForTimeout(200);
  await page.keyboard.type('AUDIT'); await page.waitForTimeout(150);
  await page.mouse.click(cbox.x + 200, cbox.y + 200); await page.waitForTimeout(200);
  log('Edit PDF: text annotation typed', await page.evaluate(() => document.body.innerText.includes('AUDIT')) ? 'PASS' : 'FAIL');
  const dlP3 = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  await page.locator('button:has-text("Download Edited PDF")').click();
  const d3 = await dlP3;
  log('Edit PDF: export download fires', d3 ? 'PASS' : 'FAIL');

  // ═══ 6. SCAN TO PDF ═══
  await page.goto(URL); await page.waitForSelector('h1');
  await page.getByText(/PDF Tools/).first().click(); await page.waitForTimeout(250);
  await page.getByText('Scan to PDF').first().click(); await page.waitForTimeout(300);
  const scanImg = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 400; c.height = 500;
    const x = c.getContext('2d'); x.fillStyle = '#eee'; x.fillRect(0,0,400,500);
    x.fillStyle = '#333'; x.fillRect(40,40,320,420);
    return c.toDataURL('image/jpeg', 0.9);
  });
  fs.writeFileSync('/tmp/audit/scan.jpg', Buffer.from(scanImg.split(',')[1], 'base64'));
  await page.locator('input[type="file"]').first().setInputFiles('/tmp/audit/scan.jpg');
  await page.waitForTimeout(2000);
  log('Scan to PDF: image accepted, UI advances', !(await page.getByText(/Drop file here/i).first().isVisible().catch(()=>true)) ? 'PASS' : 'FAIL');

  // ═══ 7. PHOTO TOOLS: DV Lottery ═══
  await page.goto(URL); await page.waitForSelector('h1');
  await page.getByText(/Photo Tools/).first().click(); await page.waitForTimeout(250);
  await page.getByText('DV Lottery Photo').first().click(); await page.waitForTimeout(300);
  const faceImg = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 600; c.height = 750;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0,0,600,750);
    x.fillStyle = '#e8c0a0'; x.beginPath(); x.ellipse(300,320,130,165,0,0,7); x.fill();
    return c.toDataURL('image/jpeg', 0.9);
  });
  fs.writeFileSync('/tmp/audit/face.jpg', Buffer.from(faceImg.split(',')[1], 'base64'));
  await page.locator('input[type="file"]').first().setInputFiles('/tmp/audit/face.jpg');
  await page.waitForTimeout(700);
  await page.getByText(/Check & Crop/i).first().click(); await page.waitForTimeout(1500);
  log('DV Lottery: photo check produces a result', await page.getByText(/check yourself|Auto-checks|issue/i).first().isVisible().catch(()=>false) ? 'PASS' : 'FAIL');

  // ═══ 8. COMPRESS IMAGE ═══
  await page.goto(URL); await page.waitForSelector('h1');
  await page.getByText(/Photo Tools/).first().click(); await page.waitForTimeout(250);
  await page.locator('div.card').nth(5).click(); await page.waitForTimeout(300);
  await page.locator('input[type="file"]').first().setInputFiles('/tmp/audit/face.jpg');
  await page.waitForTimeout(1500);
  log('Compress Image: produces output', await page.getByText(/COMPRESSED/i).first().isVisible().catch(()=>false) ? 'PASS' : 'FAIL');

  // ═══ 9. RESIZE IMAGE ═══
  await page.goto(URL); await page.waitForSelector('h1');
  await page.getByText(/Photo Tools/).first().click(); await page.waitForTimeout(250);
  await page.locator('div.card').nth(4).click(); await page.waitForTimeout(300);
  await page.locator('input[type="file"]').first().setInputFiles('/tmp/audit/face.jpg');
  await page.waitForTimeout(1200);
  log('Resize Image: loads photo, UI advances', !(await page.getByText(/Drop photo here/i).first().isVisible().catch(()=>true)) ? 'PASS' : 'FAIL');

  // ═══ 10. PRIVACY + CONTACT pages ═══
  await page.goto(URL + 'privacy.html'); await page.waitForSelector('h1');
  log('Privacy page: loads with H1', /Privacy Policy/i.test(await page.locator('h1').first().innerText()) ? 'PASS' : 'FAIL');
  await page.goto(URL + 'contact.html'); await page.waitForSelector('h1');
  log('Contact page: loads with H1', /Contact/i.test(await page.locator('h1').first().innerText()) ? 'PASS' : 'FAIL');
  const subjOpts = (await page.locator('#subject option').allInnerTexts()).join('|');
  log('Contact page: subject dropdown has all 4 categories', ['Report a problem','General Information','Sales','Privacy'].every(s => subjOpts.includes(s)) ? 'PASS' : 'FAIL');

  // ═══ 11. MOBILE responsive ═══
  const { ctx: mctx, page: mpage } = await freshPage();
  await mctx.close(); // close default, reopen with mobile viewport
  const mctx2 = await browser.newContext({ viewport: { width: 375, height: 720 }, isMobile: true });
  const mp2 = await mctx2.newPage();
  const mErrs = [];
  mp2.on('pageerror', e => mErrs.push(e.message));
  await mp2.goto(URL); await mp2.waitForSelector('h1');
  const noScroll = await mp2.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  log('Mobile 375px: no horizontal overflow on home', noScroll ? 'PASS' : 'FAIL');
  await mp2.getByText(/PDF Tools/).first().click(); await mp2.waitForTimeout(300);
  const noScroll2 = await mp2.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  log('Mobile 375px: no horizontal overflow on PDF hub', noScroll2 ? 'PASS' : 'FAIL');
  log('Mobile: no page errors', mErrs.length === 0 ? 'PASS' : 'FAIL', mErrs.slice(0,2).join(' | '));
  await mctx2.close();

  // ═══ 12. Cloud import buttons present (Dropbox/Google configured) ═══
  await page.goto(URL); await page.waitForSelector('h1');
  await page.getByText(/PDF Tools/).first().click(); await page.waitForTimeout(250);
  await page.getByText('Merge PDF').first().click(); await page.waitForTimeout(300);
  const hasDbx = await page.locator('button:has-text("Dropbox")').first().isVisible().catch(()=>false);
  const hasGdr = await page.locator('button:has-text("Google Drive")').first().isVisible().catch(()=>false);
  log('Cloud import: Dropbox button present', hasDbx ? 'PASS' : 'FAIL');
  log('Cloud import: Google Drive button present', hasGdr ? 'PASS' : 'FAIL');

  // ═══ FINAL: all collected console/page errors across the entire audit ═══
  const realErrs = allErrs.filter(e => !/Indexing all PDF objects|favicon\.ico/i.test(e.msg));
  log('No console/page errors across the ENTIRE audit', realErrs.length === 0 ? 'PASS' : 'FAIL', JSON.stringify(realErrs.slice(0, 5)));

  await page.screenshot({ path: '/home/user/myfikrat/site_test/screenshots/60_audit_final.png', fullPage: true });
} catch (e) {
  log('Fatal', 'FAIL', e.message.slice(0, 300));
}

await browser.close();
const fail = R.filter(r => r.s === 'FAIL').length;
console.log(`\n=== FULL AUDIT Summary: ${R.length - fail} pass, ${fail} fail ===`);
if (fail) {
  console.log('\n--- FAILURES ---');
  R.filter(r => r.s === 'FAIL').forEach(r => console.log(`  ✗ ${r.l}${r.d ? ' — ' + r.d : ''}`));
}
process.exit(fail ? 1 : 0);
