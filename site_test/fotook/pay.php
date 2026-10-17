<?php
/**
 * fotOOK — PayPal Orders v2 payment handler for the paid DV Lottery / visa
 * photo AI verification ($PRICE_USD, one-time, single photo).
 *
 * Flow:
 *   1. Client calls action=create  → we create a PayPal order server-side
 *      for exactly $PRICE_USD and return its id. The client never controls
 *      the amount.
 *   2. Buyer approves in the PayPal/Apple Pay/Google Pay/Card widget.
 *   3. Client calls action=capture → we CAPTURE THE ORDER OURSELVES against
 *      PayPal's API (never trust the client's word that payment succeeded),
 *      verify status=COMPLETED, amount=PRICE_USD, currency=USD, then issue a
 *      single-use HMAC token that proxy.php requires before it will call the
 *      AI. The token is claimed atomically later (see proxy.php) so it can
 *      be spent exactly once even under concurrent requests.
 *
 * Hardening:
 *  - Same-origin allowlist (no wildcard CORS)
 *  - POST-only, body size cap
 *  - Per-IP rate limit (file-based)
 *  - Amount/currency/status verified against PayPal's response, not the client
 *  - Exclusive-create lock file per orderID → a given PayPal order can mint
 *    a payment token at most once (no double-spend from replaying capture)
 *  - Secrets never hard-coded; read from env vars, falling back to an
 *    optional non-public secrets.local.php for shared hosts where real env
 *    vars aren't available to PHP-FPM
 */

// ── 1. Config ──────────────────────────────────────────────
if (is_file(__DIR__ . '/secrets.local.php')) require __DIR__ . '/secrets.local.php';

$PAYPAL_CLIENT_ID = getenv('PAYPAL_CLIENT_ID') ?: '';
$PAYPAL_SECRET    = getenv('PAYPAL_SECRET')    ?: '';
$PAYPAL_BASE      = getenv('PAYPAL_BASE')      ?: 'https://api-m.paypal.com'; // sandbox: api-m.sandbox.paypal.com
$TOKEN_SECRET     = getenv('FOTOOK_TOKEN_SECRET') ?: '';
$PRICE_USD        = '3.00';   // must match AI_PRICE in index.html
$ALLOWED_ORIGINS  = ['https://fotook.net', 'https://www.fotook.net'];
// Only for local/dev testing: EXTRA_ALLOWED_ORIGINS adds origins on top of the
// list above (comma-separated). Never set in production — ships unset there.
$extraOrigins = getenv('EXTRA_ALLOWED_ORIGINS');
if ($extraOrigins) $ALLOWED_ORIGINS = array_merge($ALLOWED_ORIGINS, array_filter(array_map('trim', explode(',', $extraOrigins))));
$MAX_BODY         = 8 * 1024;
$RATE_MAX         = 8;        // order attempts…
$RATE_WINDOW      = 300;      // …per 5 minutes, per IP
$TOKEN_TTL        = 900;      // single-use token valid for 15 minutes after a successful capture

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
$bucket = sys_get_temp_dir() . '/fotook_pay_rl_' . md5($ip);
$now    = time();
$hits   = is_file($bucket) ? (json_decode(@file_get_contents($bucket), true) ?: []) : [];
$hits   = array_values(array_filter($hits, fn ($t) => $t > $now - $RATE_WINDOW));
if (count($hits) >= $RATE_MAX) {
    http_response_code(429);
    header('Retry-After: ' . $RATE_WINDOW);
    echo json_encode(['error' => 'Too many attempts, slow down']);
    exit;
}
$hits[] = $now;
@file_put_contents($bucket, json_encode($hits), LOCK_EX);

// ── 5. Config sanity ────────────────────────────────────────
if ($PAYPAL_CLIENT_ID === '' || $PAYPAL_SECRET === '') {
    http_response_code(500);
    echo json_encode(['error' => 'Server is not configured (PayPal credentials missing)']);
    exit;
}
if (strlen($TOKEN_SECRET) < 32) {
    http_response_code(500);
    echo json_encode(['error' => 'Server is not configured (FOTOOK_TOKEN_SECRET missing)']);
    exit;
}

// ── 6. Parse body ────────────────────────────────────────────
$raw  = file_get_contents('php://input');
if (strlen($raw) > $MAX_BODY) { http_response_code(413); echo json_encode(['error' => 'Payload too large']); exit; }
$data = json_decode($raw, true);
$action = is_array($data) ? ($data['action'] ?? '') : '';

// ── 7. PayPal OAuth2 (client-credentials) ────────────────────
function paypal_token($base, $id, $secret) {
    $ch = curl_init($base . '/v1/oauth2/token');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => 'grant_type=client_credentials',
        CURLOPT_USERPWD        => $id . ':' . $secret,
        CURLOPT_HTTPHEADER     => ['Accept: application/json'],
        CURLOPT_TIMEOUT        => 15,
        CURLOPT_CONNECTTIMEOUT => 8,
    ]);
    $r = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if (!$r || $status !== 200) return null;
    $j = json_decode($r, true);
    return $j['access_token'] ?? null;
}
function paypal_api($base, $path, $method, $accessToken, $body = null) {
    $ch = curl_init($base . $path);
    $headers = ['Authorization: Bearer ' . $accessToken, 'Content-Type: application/json'];
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST  => $method,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_TIMEOUT        => 20,
        CURLOPT_CONNECTTIMEOUT => 8,
    ]);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    $r      = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err    = curl_error($ch);
    curl_close($ch);
    return [$status, $r, $err];
}

$accessToken = paypal_token($PAYPAL_BASE, $PAYPAL_CLIENT_ID, $PAYPAL_SECRET);
if (!$accessToken) {
    http_response_code(502);
    echo json_encode(['error' => 'Could not reach PayPal']);
    exit;
}

// ── 8a. action=create — open a $PRICE_USD order, amount decided HERE ────
if ($action === 'create') {
    $order = [
        'intent' => 'CAPTURE',
        'purchase_units' => [[
            'amount' => ['currency_code' => 'USD', 'value' => $PRICE_USD],
            'description' => 'fotOOK — Full AI photo verification (single photo)',
        ]],
        'application_context' => [
            'shipping_preference' => 'NO_SHIPPING',
            'user_action' => 'PAY_NOW',
        ],
    ];
    [$status, $resp] = paypal_api($PAYPAL_BASE, '/v2/checkout/orders', 'POST', $accessToken, $order);
    $j = json_decode($resp, true);
    if ($status !== 201 || empty($j['id'])) {
        http_response_code(502);
        echo json_encode(['error' => 'Could not create order']);
        exit;
    }
    echo json_encode(['id' => $j['id']]);
    exit;
}

// ── 8b. action=capture — capture server-side, verify, issue the token ───
if ($action === 'capture') {
    $orderID = is_string($data['orderID'] ?? null) ? $data['orderID'] : '';
    if ($orderID === '' || !preg_match('/^[A-Za-z0-9]{10,30}$/', $orderID)) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid orderID']);
        exit;
    }

    // Atomic double-spend guard: only the FIRST capture attempt for a given
    // orderID may proceed to mint a token. fopen(..., 'x') fails if the file
    // already exists, and file creation is atomic even across concurrent
    // PHP-FPM workers on the same filesystem.
    $lockFile = sys_get_temp_dir() . '/fotook_order_' . preg_replace('/[^A-Za-z0-9]/', '', $orderID);
    $lock = @fopen($lockFile, 'x');
    if ($lock === false) {
        http_response_code(409);
        echo json_encode(['error' => 'This order was already processed']);
        exit;
    }
    fwrite($lock, (string) time());
    fclose($lock);

    [$status, $resp] = paypal_api($PAYPAL_BASE, "/v2/checkout/orders/{$orderID}/capture", 'POST', $accessToken);
    $j = json_decode($resp, true);

    $capture = $j['purchase_units'][0]['payments']['captures'][0] ?? null;
    $okStatus   = ($status === 201 || $status === 200) && ($capture['status'] ?? '') === 'COMPLETED';
    $okAmount   = isset($capture['amount']['value']) && (string) $capture['amount']['value'] === $PRICE_USD;
    $okCurrency = isset($capture['amount']['currency_code']) && $capture['amount']['currency_code'] === 'USD';

    if (!$okStatus || !$okAmount || !$okCurrency) {
        @unlink($lockFile); // not a confirmed charge — let a genuine retry try again
        http_response_code(402);
        echo json_encode(['error' => 'Payment could not be confirmed']);
        exit;
    }

    // Mint a single-use HMAC token proving this $PRICE_USD capture happened.
    // Consumed atomically by proxy.php via rename() — see that file.
    $nonce = bin2hex(random_bytes(16));
    $exp   = time() + $TOKEN_TTL;
    $sig   = hash_hmac('sha256', "{$nonce}.{$exp}", $TOKEN_SECRET);
    $token = "{$nonce}.{$exp}.{$sig}";

    $tokFile = sys_get_temp_dir() . '/fotook_tok_' . $nonce;
    @file_put_contents($tokFile, json_encode([
        'exp'        => $exp,
        'orderID'    => $orderID,
        'captureID'  => $capture['id'] ?? '',
        'amount'     => $capture['amount']['value'],
    ]), LOCK_EX);

    echo json_encode(['token' => $token]);
    exit;
}

http_response_code(400);
echo json_encode(['error' => 'Unknown action']);
