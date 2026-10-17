<?php
/**
 * Mock PayPal REST API for local testing of pay.php — NOT for production.
 * Implements just enough of the real endpoints pay.php calls:
 *   POST /v1/oauth2/token
 *   POST /v2/checkout/orders
 *   POST /v2/checkout/orders/{id}/capture
 *
 * Behavior is controlled by the test via header X-Mock-Scenario:
 *   ok        -> normal successful flow (default)
 *   declined  -> capture returns a non-COMPLETED status (simulates a card decline)
 *   wrongamt  -> capture returns the wrong amount (should be rejected by pay.php)
 */
header('Content-Type: application/json');
$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);

// Test-only side channel: pay.php's server-to-server call to this mock can't
// carry the test's original request headers, so the test sets the scenario
// here directly before calling pay.php, and we persist it for the capture
// that follows (then reset to 'ok' so it doesn't leak into later tests).
$scenarioFile = sys_get_temp_dir() . '/mock_paypal_scenario';
if ($uri === '/_mock/set-scenario') {
    $body = json_decode(file_get_contents('php://input'), true);
    file_put_contents($scenarioFile, $body['scenario'] ?? 'ok');
    echo json_encode(['ok' => true]);
    exit;
}
$scenario = is_file($scenarioFile) ? trim(file_get_contents($scenarioFile)) : 'ok';

if ($uri === '/v1/oauth2/token') {
    echo json_encode(['access_token' => 'mock-access-token', 'expires_in' => 3600]);
    exit;
}

if ($uri === '/v2/checkout/orders') {
    http_response_code(201);
    echo json_encode(['id' => 'MOCKORDER' . substr(md5((string) microtime(true)), 0, 10)]);
    exit;
}

if (preg_match('#^/v2/checkout/orders/([A-Za-z0-9]+)/capture$#', $uri, $m)) {
    $orderID = $m[1];
    @file_put_contents($scenarioFile, 'ok'); // one-shot: reset for subsequent tests
    if ($scenario === 'declined') {
        http_response_code(201);
        echo json_encode(['purchase_units' => [['payments' => ['captures' => [[
            'id' => 'CAP' . substr(md5($orderID), 0, 8), 'status' => 'DECLINED',
            'amount' => ['value' => '3.00', 'currency_code' => 'USD'],
        ]]]]]]);
        exit;
    }
    if ($scenario === 'wrongamt') {
        http_response_code(201);
        echo json_encode(['purchase_units' => [['payments' => ['captures' => [[
            'id' => 'CAP' . substr(md5($orderID), 0, 8), 'status' => 'COMPLETED',
            'amount' => ['value' => '0.01', 'currency_code' => 'USD'],
        ]]]]]]);
        exit;
    }
    http_response_code(201);
    echo json_encode(['purchase_units' => [['payments' => ['captures' => [[
        'id' => 'CAP' . substr(md5($orderID), 0, 8), 'status' => 'COMPLETED',
        'amount' => ['value' => '3.00', 'currency_code' => 'USD'],
    ]]]]]]);
    exit;
}

http_response_code(404);
echo json_encode(['error' => 'mock: unknown endpoint ' . $uri]);
