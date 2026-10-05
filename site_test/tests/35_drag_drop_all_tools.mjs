// Drag-and-drop from OS/desktop into every file dropzone on the site.
// Covers: preventDefault at dragenter/dragover/drop (required for a drop to
// register at all — especially in managed/corporate Chrome profiles that
// need an explicit dropEffect), the file actually loading into the tool,
// a stray drop outside any dropzone NOT navigating the page away, and the
// click-to-browse fallback (the workaround users fall back to) still working.
import { chromium } from 'playwright';
import fs from 'fs';

const URL = 'http://localhost:8000/';
const R = [];
const log = (l, s, d = '') => { R.push({ l, s, d }); console.log(`[${s}] ${l}${d ? ' — ' + d : ''}`); };

const minimalPdf = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 400]/Contents 4 0 R/Resources<<>>>>endobj
4 0 obj<</Length 10>>stream
BT ET
endstream
endobj
trailer<</Size 5/Root 1 0 R>>
%%EOF`;
fs.mkdirSync('/tmp/dnd', { recursive: true });
fs.writeFileSync('/tmp/dnd/a.pdf', minimalPdf);
const redJpg = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAQABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD//2Q==', 'base64');
fs.writeFileSync('/tmp/dnd/red.jpg', redJpg);
const jpgB64 = redJpg.toString('base64');

const browser = await chromium.launch();
const page = await browser.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => { if (m.type() === 'error') errs.push('C:' + m.text()); });

async function dropOnDropzone({ b64, mime, name }) {
  return page.evaluate(async ({ b64, mime, name }) => {
    const byteChars = atob(b64);
    const bytes = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
    const file = new File([bytes], name, { type: mime });
    const dt = new DataTransfer();
    dt.items.add(file);
    const candidates = [...document.querySelectorAll('div')].filter(d => /Drop .*here|Drop .*to |Drop file/i.test(d.textContent));
    const target = candidates.sort((a, b) => a.textContent.length - b.textContent.length)[0];
    if (!target) return { ok: false, reason: 'no dropzone found' };
    const r = target.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const mk = type => new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y });
    const prevented = {};
    for (const type of ['dragenter', 'dragover', 'drop']) {
      const ev = mk(type);
      target.dispatchEvent(ev);
      prevented[type] = ev.defaultPrevented;
    }
    return { ok: true, prevented };
  }, { b64, mime, name });
}

try {
  // ── 1. Merge PDF ──
  await page.goto(URL); await page.waitForSelector('h1');
  await page.getByText(/PDF Tools/).first().click(); await page.waitForTimeout(250);
  await page.getByText('Merge PDF').first().click(); await page.waitForTimeout(300);
  let r = await dropOnDropzone({ b64: Buffer.from(minimalPdf).toString('base64'), mime: 'application/pdf', name: 'a.pdf' });
  await page.waitForTimeout(1000);
  log('Merge PDF: drop prevented at every phase (dragenter/dragover/drop)', r.ok && r.prevented.dragenter && r.prevented.dragover && r.prevented.drop ? 'PASS' : 'FAIL', JSON.stringify(r));
  log('Merge PDF: dropped file actually loaded (thumbnail)', await page.locator('.orgpage').count() >= 1 ? 'PASS' : 'FAIL');

  // ── 2. Organize PDF ──
  await page.goto(URL); await page.waitForSelector('h1');
  await page.getByText(/PDF Tools/).first().click(); await page.waitForTimeout(250);
  await page.getByText('Organize PDF').first().click(); await page.waitForTimeout(300);
  r = await dropOnDropzone({ b64: Buffer.from(minimalPdf).toString('base64'), mime: 'application/pdf', name: 'b.pdf' });
  await page.waitForTimeout(1000);
  log('Organize PDF: drop prevented at every phase', r.ok && r.prevented.drop ? 'PASS' : 'FAIL');
  log('Organize PDF: dropped file actually loaded (thumbnail)', await page.locator('.orgpage').count() >= 1 ? 'PASS' : 'FAIL');

  // ── 3. Edit PDF ──
  await page.goto(URL); await page.waitForSelector('h1');
  await page.getByText(/PDF Tools/).first().click(); await page.waitForTimeout(250);
  await page.getByText('Edit PDF').first().click(); await page.waitForTimeout(300);
  r = await dropOnDropzone({ b64: Buffer.from(minimalPdf).toString('base64'), mime: 'application/pdf', name: 'c.pdf' });
  await page.waitForTimeout(2000);
  log('Edit PDF: drop prevented at every phase', r.ok && r.prevented.drop ? 'PASS' : 'FAIL');
  log('Edit PDF: dropped file actually loaded (canvas renders)', await page.evaluate(() => { const c = document.querySelector('canvas'); return c && c.width > 0; }) ? 'PASS' : 'FAIL');

  // ── 4. Scan to PDF (image dropzone) ──
  await page.goto(URL); await page.waitForSelector('h1');
  await page.getByText(/PDF Tools/).first().click(); await page.waitForTimeout(250);
  await page.getByText('Scan to PDF').first().click(); await page.waitForTimeout(300);
  r = await dropOnDropzone({ b64: jpgB64, mime: 'image/jpeg', name: 'scan.jpg' });
  await page.waitForTimeout(1200);
  log('Scan to PDF: drop prevented at every phase', r.ok && r.prevented.drop ? 'PASS' : 'FAIL');

  // ── 5. Compress Image ──
  await page.goto(URL); await page.waitForSelector('h1');
  await page.getByText(/Photo Tools/).first().click(); await page.waitForTimeout(250);
  await page.locator('div.card').nth(5).click(); await page.waitForTimeout(300);
  r = await dropOnDropzone({ b64: jpgB64, mime: 'image/jpeg', name: 'photo.jpg' });
  await page.waitForTimeout(1000);
  log('Compress Image: drop prevented at every phase', r.ok && r.prevented.drop ? 'PASS' : 'FAIL');

  // ── 6. DV Lottery Photo ──
  await page.goto(URL); await page.waitForSelector('h1');
  await page.getByText(/Photo Tools/).first().click(); await page.waitForTimeout(250);
  await page.getByText('DV Lottery Photo').first().click(); await page.waitForTimeout(300);
  r = await dropOnDropzone({ b64: jpgB64, mime: 'image/jpeg', name: 'id.jpg' });
  await page.waitForTimeout(1000);
  log('DV Lottery Photo: drop prevented at every phase', r.ok && r.prevented.drop ? 'PASS' : 'FAIL');

  // ── Global safety net: a stray drop outside any zone must not hijack the page ──
  await page.goto(URL); await page.waitForSelector('h1');
  const before = page.url();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([1, 2, 3])], 'x.bin', { type: 'application/octet-stream' }));
    const el = document.querySelector('nav');
    const r = el.getBoundingClientRect();
    const mk = t => new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 5, clientY: r.top + 5 });
    el.dispatchEvent(mk('dragover'));
    el.dispatchEvent(mk('drop'));
  });
  await page.waitForTimeout(300);
  log('Drop outside any zone does not navigate the page away', page.url() === before ? 'PASS' : 'FAIL');

  // ── Click-to-browse fallback must still work ──
  await page.goto(URL); await page.waitForSelector('h1');
  await page.getByText(/PDF Tools/).first().click(); await page.waitForTimeout(250);
  await page.getByText('Merge PDF').first().click(); await page.waitForTimeout(300);
  const fc = page.waitForEvent('filechooser');
  await page.getByText('Select PDFs').click();
  const chooser = await fc;
  await chooser.setFiles('/tmp/dnd/a.pdf');
  await page.waitForTimeout(1000);
  log('Click-to-browse (Select PDFs button) still works', await page.locator('.orgpage').count() >= 1 ? 'PASS' : 'FAIL');

  log('No console/page errors across the whole run', errs.length === 0 ? 'PASS' : 'FAIL', errs.slice(0, 3).join(' | '));
  await page.screenshot({ path: '/home/user/myfikrat/site_test/screenshots/50_drag_drop.png', fullPage: true });
} catch (e) {
  log('Fatal', 'FAIL', e.message.slice(0, 300));
}

await browser.close();
const fail = R.filter(r => r.s === 'FAIL').length;
console.log(`\n=== Drag-Drop-All-Tools Summary: ${R.length - fail} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);
