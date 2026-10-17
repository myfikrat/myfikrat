import { chromium } from 'playwright';
import fs from 'fs';

const URL = 'http://127.0.0.1:8099/';
const R = [];
const log = (l, s, d = '') => { R.push({ l, s, d }); console.log(`[${s}] ${l}${d ? ' — ' + d : ''}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 950 }, acceptDownloads: true });

// Enable the paywall test bypass flag BEFORE any page script runs.
await ctx.addInitScript(() => { window.__FOTOOK_PP_TEST = true; });

// Stub the real PayPal SDK script: return a fake `paypal.Buttons()` that
// immediately drives create->approve exactly like a real successful payment,
// by calling straight through to our own local pay.php (real server logic).
await ctx.route('https://www.paypal.com/sdk/js**', route => {
  route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: `
      window.paypal = {
        Buttons: function(opts) {
          return {
            render: function(el) {
              const btn = document.createElement('button');
              btn.textContent = 'TEST PAY $3';
              btn.id = 'fake-paypal-pay-btn';
              btn.onclick = async function() {
                const orderID = await opts.createOrder();
                await opts.onApprove({ orderID });
              };
              el.appendChild(btn);
              return Promise.resolve();
            }
          };
        }
      };
    `,
  });
});

const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => { if (m.type() === 'error') errs.push('C:' + m.text()); });

try {
  await page.goto(URL); await page.waitForSelector('h1');
  log('Home loads (paid flow server)', true ? 'PASS' : 'FAIL');

  await page.getByText(/Photo Tools/).first().click(); await page.waitForTimeout(250);
  await page.getByText('DV Lottery Photo').first().click(); await page.waitForTimeout(300);

  const faceImg = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 600; c.height = 750;
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, 600, 750);
    x.fillStyle = '#e8c0a0'; x.beginPath(); x.ellipse(300, 320, 130, 165, 0, 0, 7); x.fill();
    return c.toDataURL('image/jpeg', 0.9);
  });
  fs.mkdirSync('/tmp/e2epay', { recursive: true });
  fs.writeFileSync('/tmp/e2epay/face.jpg', Buffer.from(faceImg.split(',')[1], 'base64'));
  await page.locator('input[type="file"]').first().setInputFiles('/tmp/e2epay/face.jpg');
  await page.waitForTimeout(700);
  await page.getByText(/Check & Crop/i).first().click(); await page.waitForTimeout(1500);
  log('Free check completes', await page.getByText(/check yourself|Auto-checks|issue/i).first().isVisible().catch(() => false) ? 'PASS' : 'FAIL');

  const unlockBtn = page.getByText(/Unlock full report/i).first();
  log('Paid upsell CTA visible', await unlockBtn.isVisible().catch(() => false) ? 'PASS' : 'FAIL');
  await unlockBtn.click(); await page.waitForTimeout(500);

  const priceShown = await page.getByText('$3').first().isVisible().catch(() => false);
  log('Paywall shows $3 (not old $2 price)', priceShown ? 'PASS' : 'FAIL');
  log('Paywall mentions Apple Pay / Google Pay', await page.getByText(/Apple Pay.*Google Pay|Google Pay.*Apple Pay/i).first().isVisible().catch(() => false) ? 'PASS' : 'FAIL');

  // Our stubbed PayPal button should have rendered (real SDK loader succeeded against the stub)
  const payBtn = page.locator('#fake-paypal-pay-btn');
  await payBtn.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  log('Real PayPal SDK loader wired correctly (stub button rendered)', await payBtn.isVisible().catch(() => false) ? 'PASS' : 'FAIL');

  // Click "pay" -> drives createOrder() -> real local pay.php -> onApprove() -> real local pay.php capture -> onPaid(token) -> real local proxy.php -> AI report
  await payBtn.click();
  // Real round trip: create -> capture -> AI call, each a separate HTTP
  // request with HMAC/file-lock work. Poll for the modal's own overlay
  // element to actually unmount — a text-based waitForSelector is unsafe
  // here because the words "pass/borderline/fail" also appear verbatim
  // inside the page's own inline <script> (they're literals in the AI
  // prompt template), so a text selector resolves instantly against the
  // source code rather than the real rendered UI.
  await page.waitForFunction(() => !document.querySelector('[style*="backdrop-filter"]'), { timeout: 15000 }).catch(() => {});

  const modalGone = await page.evaluate(() => !document.querySelector('[style*="backdrop-filter"]'));
  log('Paywall modal overlay unmounted after successful payment', modalGone ? 'PASS' : 'FAIL');
  const reportVisible = await page.getByText(/pass|borderline|fail/i).first().isVisible().catch(() => false);
  log('AI report renders after real payment+AI round trip', reportVisible ? 'PASS' : 'FAIL');
  log('Report shows per-category checklist (headSize/eyeHeight/background etc.)', await page.getByText(/head size|Head Size/i).first().isVisible().catch(() => false) ? 'PASS' : 'FAIL');

  // The AI's crop coordinates should have re-generated the "ready" photo (cropToSpec ran)
  const dlP = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  const dlBtn = page.locator('button', { hasText: /Download/i }).first();
  await dlBtn.click().catch(() => {});
  const d = await dlP;
  log('Final compliant photo is downloadable', d ? 'PASS' : 'FAIL');
  if (d) {
    await d.saveAs('/tmp/e2epay/final.jpg');
    const sz = fs.statSync('/tmp/e2epay/final.jpg').size;
    log('Downloaded photo is a real, non-empty file', sz > 1000 ? 'PASS' : 'FAIL', `${sz} bytes`);
  }

  log('No console/page errors through the whole paid flow', errs.length === 0 ? 'PASS' : 'FAIL', errs.slice(0, 4).join(' | '));
  await page.screenshot({ path: '/home/user/myfikrat/site_test/screenshots/80_paid_ai_report.png', fullPage: true });
} catch (e) {
  log('Fatal', 'FAIL', e.message.slice(0, 300));
}

await browser.close();
const fail = R.filter(r => r.s === 'FAIL').length;
console.log(`\n=== Paid AI E2E Summary: ${R.length - fail} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);
