<?php
/**
 * fotOOK — secure proxy for the Anthropic API (paid DV Lottery / visa photo
 * AI verification). Only reachable with a single-use HMAC token minted by
 * pay.php after a confirmed $PRICE_USD PayPal capture — see pay.php.
 *
 * Hardening:
 *  - Origin/Referer allowlist (no wildcard CORS — protects your API key)
 *  - POST-only
 *  - Request body size cap
 *  - JSON validation; model is forced server-side (client cannot pick a model)
 *  - Simple per-IP rate limit (file-based, no dependencies)
 *  - Single-use payment token, claimed ATOMICALLY via rename() so concurrent
 *    requests can't both spend the same $3 payment (closes the TOCTOU race
 *    a naive is_file()-then-write check would have)
 *  - Token is claimed only once PayPal payment is verified AND we're about
 *    to call Anthropic — if the upstream call then fails, the token is
 *    un-claimed so the buyer isn't charged for a report they never got
 *  - cURL timeout
 */

// ── 1. Config ──────────────────────────────────────────────
if (is_file(__DIR__ . '/secrets.local.php')) require __DIR__ . '/secrets.local.php';

$API_KEY         = getenv('ANTHROPIC_API_KEY') ?: '';
$ANTHROPIC_BASE  = getenv('ANTHROPIC_BASE') ?: 'https://api.anthropic.com'; // override only for local testing
$TOKEN_SECRET    = getenv('FOTOOK_TOKEN_SECRET') ?: '';
$ALLOWED_ORIGINS = ['https://fotook.net', 'https://www.fotook.net'];
// Only for local/dev testing: EXTRA_ALLOWED_ORIGINS adds origins on top of the
// list above (comma-separated). Never set in production — ships unset there.
$extraOrigins = getenv('EXTRA_ALLOWED_ORIGINS');
if ($extraOrigins) $ALLOWED_ORIGINS = array_merge($ALLOWED_ORIGINS, array_filter(array_map('trim', explode(',', $extraOrigins))));
$FORCE_MODEL     = 'claude-haiku-4-5-20251001';
$MAX_BODY        = 6 * 1024 * 1024;   // 6 MB (vision images)
$RATE_MAX        = 10;                 // requests…
$RATE_WINDOW     = 60;                 // …per this many seconds, per IP

// ── 2. Origin allowlist + CORS ─────────────────────────────
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin === '' && isset($_SERVER['HTTP_REFERER'])) {
    $p = parse_url($_SERVER['HTTP_REFERER']);
    if ($p && isset($p['scheme'], $p['host'])) $origin = $p['scheme'] . '://' . $p['host'];
}
$allowed = in_array($origin, $ALLOWED_ORIGINS, true);

header('Vary: Origin');
header('Content-Type: application/json');
if ($allowed) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Access-Control-Allow-Methods: POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    header('Access-Control-Max-Age: 86400');
}
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') { http_response_code($allowed ? 204 : 403); exit; }
if (!$allowed) { http_response_code(403); echo json_encode(['error' => 'Forbidden origin']); exit; }

// ── 3. Method + size guards ────────────────────────────────
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
    exit;
}
if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > $MAX_BODY) {
    http_response_code(413);
    echo json_encode(['error' => 'Payload too large']);
    exit;
}

// ── 4. Per-IP rate limit ───────────────────────────────────
$ip     = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
$bucket = sys_get_temp_dir() . '/fotook_rl_' . md5($ip);
$now    = time();
$hits   = is_file($bucket) ? (json_decode(@file_get_contents($bucket), true) ?: []) : [];
$hits   = array_values(array_filter($hits, fn ($t) => $t > $now - $RATE_WINDOW));
if (count($hits) >= $RATE_MAX) {
    http_response_code(429);
    header('Retry-After: ' . $RATE_WINDOW);
    echo json_encode(['error' => 'Rate limit exceeded, slow down']);
    exit;
}
$hits[] = $now;
@file_put_contents($bucket, json_encode($hits), LOCK_EX);

// ── 5. Validate + sanitize the request body ────────────────
$raw  = file_get_contents('php://input');
if (strlen($raw) > $MAX_BODY) {
    http_response_code(413);
    echo json_encode(['error' => 'Payload too large']);
    exit;
}
$data = json_decode($raw, true);
if (!is_array($data) || !isset($data['messages']) || !is_array($data['messages'])) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid request body']);
    exit;
}

// ── 5b. Require a valid, unexpired, single-use payment token ──
// Token format: "{nonce}.{exp}.{hmac}" issued by pay.php after a confirmed
// $PRICE_USD PayPal capture.
$payToken = $data['payToken'] ?? ($_SERVER['HTTP_X_FOTOOK_TOKEN'] ?? '');
unset($data['payToken']);
if (strlen($TOKEN_SECRET) < 32) {
    http_response_code(500);
    echo json_encode(['error' => 'Server not configured (FOTOOK_TOKEN_SECRET)']);
    exit;
}
$parts = explode('.', (string) $payToken);
if (count($parts) !== 3) {
    http_response_code(402);
    echo json_encode(['error' => 'Payment required']);
    exit;
}
[$nonce, $exp, $sig] = $parts;
$expected = hash_hmac('sha256', "{$nonce}.{$exp}", $TOKEN_SECRET);
if (!hash_equals($expected, $sig) || !ctype_xdigit($nonce) || (int) $exp < time()) {
    http_response_code(402);
    echo json_encode(['error' => 'Invalid or expired payment token']);
    exit;
}
// Single-use enforcement — ATOMIC claim (rename is atomic on one filesystem,
// so only one of N concurrent php-fpm workers can win; closes the TOCTOU race).
$tokFile = sys_get_temp_dir() . '/fotook_tok_' . $nonce;
$claim   = $tokFile . '.used';
if (!is_file($tokFile) || !@rename($tokFile, $claim)) {
    // Either never issued by pay.php, or already claimed by a prior/concurrent request.
    http_response_code(402);
    echo json_encode(['error' => 'Payment token already used or invalid']);
    exit;
}
$tokRec = json_decode(@file_get_contents($claim), true);
if (!is_array($tokRec) || (int) ($tokRec['exp'] ?? 0) < time()) {
    http_response_code(402);
    echo json_encode(['error' => 'Payment token expired']);
    exit;
}

// Force model + sane token cap — the client cannot override these.
$data['model']      = $FORCE_MODEL;
$data['max_tokens'] = min((int) ($data['max_tokens'] ?? 1024), 2048);
$body = json_encode($data);

// ── 6. Proxy to Anthropic ──────────────────────────────────
if ($API_KEY === '') {
    @rename($claim, $tokFile); // give the token back — nothing was charged for an AI call
    http_response_code(500);
    echo json_encode(['error' => 'Server is not configured (set ANTHROPIC_API_KEY)']);
    exit;
}

$ch = curl_init($ANTHROPIC_BASE . '/v1/messages');
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => $body,
    CURLOPT_HTTPHEADER     => [
        'Content-Type: application/json',
        'x-api-key: ' . $API_KEY,
        'anthropic-version: 2023-06-01',
    ],
    CURLOPT_TIMEOUT        => 30,
    CURLOPT_CONNECTTIMEOUT => 10,
]);

$response = curl_exec($ch);
$status   = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$err      = curl_error($ch);
curl_close($ch);

if ($err || $status >= 500 || $status === 0) {
    // Transient upstream failure — un-claim the token so the buyer isn't
    // charged $PRICE_USD for a report they never received. They can retry
    // with the same token until it expires.
    @rename($claim, $tokFile);
    http_response_code(502);
    echo json_encode(['error' => 'Upstream request failed, please try again']);
} else {
    http_response_code($status ?: 200);
    echo $response;
}
