<?php
/**
 * fotOOK — local secrets template.
 *
 * Copy this file to `secrets.local.php` (same folder) and fill in your real
 * values. `secrets.local.php` is in .gitignore and must NEVER be committed
 * or served publicly — it is loaded directly by pay.php / proxy.php as a
 * fallback when the hosting environment doesn't expose real env vars
 * (common on shared hosting, where getenv() often returns nothing for
 * PHP-FPM pools unless explicitly configured).
 *
 * If your host DOES support real environment variables, you don't need
 * this file at all — just set the same names as env vars and delete this
 * copy. getenv() is always tried first.
 */

// From developer.paypal.com → Apps & Credentials → your REST API app.
// Use the LIVE credentials for real charges, SANDBOX ones while testing.
putenv('PAYPAL_CLIENT_ID=YOUR_PAYPAL_CLIENT_ID');
putenv('PAYPAL_SECRET=YOUR_PAYPAL_SECRET');
putenv('PAYPAL_BASE=https://api-m.paypal.com'); // sandbox: https://api-m.sandbox.paypal.com

// From console.anthropic.com → API Keys.
putenv('ANTHROPIC_API_KEY=YOUR_ANTHROPIC_API_KEY');

// Any long random string — used to sign the single-use payment token that
// proves a $3 capture happened before the AI call is allowed. Generate one
// with: php -r "echo bin2hex(random_bytes(32));"
putenv('FOTOOK_TOKEN_SECRET=CHANGE_ME_TO_64_RANDOM_HEX_CHARS');
