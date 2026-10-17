import { chromium } from 'playwright';
import fs from 'fs';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const URL = 'http://localhost:8000/';
const R = [];
const log = (l, s, d = '') => { R.push({ l, s, d }); console.log(`[${s}] ${l}${d ? ' — ' + d : ''}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => { if (m.type() === 'error') errs.push('C:' + m.text()); });

try {
  // Page Numbers
  await page.goto(URL); await page.waitForSelector('h1');
  await page.getByText(/PDF Tools/).first().click(); await page.waitForTimeout(250);
  await page.getByText('Page Numbers').first().click(); await page.waitForTimeout(300);
  await page.locator('input[type="file"]').first().setInputFiles('/tmp/audit/doc.pdf');
  await page.waitForTimeout(2000);
  log('Page Numbers: pages render after upload', await page.locator('.orgpage').count() >= 1 || !(await page.getByText(/Drop file here|Drop PDF/i).first().isVisible().catch(()=>true)) ? 'PASS' : 'FAIL');
  const dlP = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  const btn = page.locator('button:has-text("Download")').first();
  if (await btn.isVisible().catch(()=>false)) { await btn.click(); const d = await dlP; log('Page Numbers: download fires', d ? 'PASS' : 'FAIL'); }
  else log('Page Numbers: download button visible', 'FAIL', 'not found');

  // JPG <-> PDF
  await page.goto(URL); await page.waitForSelector('h1');
  await page.getByText(/PDF Tools/).first().click(); await page.waitForTimeout(250);
  await page.getByText(/JPG.*PDF|JPG ↔ PDF/).first().click(); await page.waitForTimeout(300);
  const img = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 300; c.height = 400;
    const x = c.getContext('2d'); x.fillStyle = '#4ab'; x.fillRect(0,0,300,400);
    return c.toDataURL('image/jpeg', 0.9);
  });
  fs.writeFileSync('/tmp/audit/pic.jpg', Buffer.from(img.split(',')[1], 'base64'));
  await page.locator('input[type="file"]').first().setInputFiles('/tmp/audit/pic.jpg');
  await page.waitForTimeout(2000);
  log('JPG→PDF: image accepted, UI advances', !(await page.getByText(/Drop file here|or click/i).first().isVisible().catch(()=>true)) || await page.locator('.orgpage').count()>=1 ? 'PASS' : 'FAIL');

  log('No console/page errors', errs.length === 0 ? 'PASS' : 'FAIL', errs.slice(0,3).join(' | '));
} catch (e) {
  log('Fatal', 'FAIL', e.message.slice(0, 300));
}
await browser.close();
const fail = R.filter(r => r.s === 'FAIL').length;
console.log(`\n=== Extra Tools Summary: ${R.length - fail} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);
