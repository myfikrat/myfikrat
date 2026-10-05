<?php
/**
 * fotOOK — contact form handler.
 *
 * Receives a JSON POST from contact.html and emails it to the site owner.
 * No database, no dependencies — just PHP mail().
 *
 * Hardening:
 *  - Same-origin allowlist (no wildcard CORS)
 *  - POST-only, small body cap
 *  - Per-IP rate limit (file-based)
 *  - Honeypot anti-spam field
 *  - Email header-injection protection (strips CR/LF from all header fields)
 *  - Length limits + email format validation
 */

// ── 1. Config ──────────────────────────────────────────────
$TO              = 'support@fotook.net';                 // where messages land
$FROM            = 'support@fotook.net';                 // real domain mailbox → best deliverability
$ALLOWED_ORIGINS = ['https://fotook.net', 'https://www.fotook.net'];
$ALLOWED_SUBJECTS = ['Report a problem', 'General Information / Contact', 'Sales', 'Privacy'];
$MAX_BODY        = 64 * 1024;   // 64 KB is plenty for a contact message
$RATE_MAX        = 5;           // messages…
$RATE_WINDOW     = 300;         // …per 5 minutes, per IP

// ── 2. Origin allowlist + CORS ─────────────────────────────
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin === '' && isset($_SERVER['HTTP_REFERER'])) {
    $p = parse_url($_SERVER['HTTP_REFERER']);
    if ($p && isset($p['scheme'], $p['host'])) {
        $origin = $p['scheme'] . '://' . $p['host'];
    }
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

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code($allowed ? 204 : 403);
    exit;
}
if (!$allowed) {
    http_response_code(403);
    echo json_encode(['ok' => false, 'error' => 'Forbidden origin']);
    exit;
}

// ── 3. Method + size guards ────────────────────────────────
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    http_response_code(405);
    echo json_encode(['ok' => false, 'error' => 'Method not allowed']);
    exit;
}
if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > $MAX_BODY) {
    http_response_code(413);
    echo json_encode(['ok' => false, 'error' => 'Message too large']);
    exit;
}

// ── 4. Per-IP rate limit ───────────────────────────────────
$ip     = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
$bucket = sys_get_temp_dir() . '/fotook_contact_rl_' . md5($ip);
$now    = time();
$hits   = is_file($bucket) ? (json_decode(@file_get_contents($bucket), true) ?: []) : [];
$hits   = array_values(array_filter($hits, fn ($t) => $t > $now - $RATE_WINDOW));
if (count($hits) >= $RATE_MAX) {
    http_response_code(429);
    header('Retry-After: ' . $RATE_WINDOW);
    echo json_encode(['ok' => false, 'error' => 'Too many messages — please try again later.']);
    exit;
}

// ── 5. Parse + validate the body ───────────────────────────
$raw  = file_get_contents('php://input');
if (strlen($raw) > $MAX_BODY) {
    http_response_code(413);
    echo json_encode(['ok' => false, 'error' => 'Message too large']);
    exit;
}
$data = json_decode($raw, true);
if (!is_array($data)) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'Invalid request']);
    exit;
}

// Honeypot: real users never fill this hidden field; bots do. Pretend success.
if (!empty($data['company'])) {
    echo json_encode(['ok' => true]);
    exit;
}

$name    = trim((string) ($data['name'] ?? ''));
$email   = trim((string) ($data['email'] ?? ''));
$subject = trim((string) ($data['subject'] ?? ''));
$message = trim((string) ($data['message'] ?? ''));

// Required fields
if ($name === '' || $email === '' || $subject === '' || $message === '') {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'Please fill in all fields.']);
    exit;
}
// Length caps
if (mb_strlen($name) > 120 || mb_strlen($email) > 200 || mb_strlen($message) > 8000) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'One of the fields is too long.']);
    exit;
}
// Valid email
if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'Please enter a valid email address.']);
    exit;
}
// Subject must be one of the known categories
if (!in_array($subject, $ALLOWED_SUBJECTS, true)) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'Please choose a valid subject.']);
    exit;
}

// ── 6. Build a header-injection-safe email ─────────────────
// Strip CR/LF from anything that goes into a header (name, email, subject).
$clean = fn ($s) => str_replace(["\r", "\n", "%0a", "%0d"], '', $s);
$safeName    = $clean($name);
$safeEmail   = $clean($email);
$safeSubject = $clean($subject);

$mailSubject = "[{$safeSubject}] fotook.net contact";
$bodyLines = [
    "Subject:  {$safeSubject}",
    "Name:     {$safeName}",
    "Email:    {$safeEmail}",
    "IP:       {$ip}",
    "",
    "Message:",
    $message,   // body can contain newlines safely
    "",
];
$mailBody = implode("\r\n", $bodyLines);

$headers  = "From: fotOOK <{$FROM}>\r\n";
$headers .= "Reply-To: {$safeName} <{$safeEmail}>\r\n";
$headers .= "Content-Type: text/plain; charset=UTF-8\r\n";
$headers .= "X-Mailer: fotook-contact\r\n";

$sent = @mail($TO, $mailSubject, $mailBody, $headers, "-f{$FROM}");

if (!$sent) {
    http_response_code(502);
    echo json_encode([
        'ok'    => false,
        'error' => 'Could not send right now. Please email us directly at ' . $TO . '.',
    ]);
    exit;
}

// Record the hit only on a successful send.
$hits[] = $now;
@file_put_contents($bucket, json_encode($hits), LOCK_EX);

echo json_encode(['ok' => true]);
