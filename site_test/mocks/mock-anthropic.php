<?php
/**
 * Mock Anthropic Messages API for local testing of proxy.php — NOT for
 * production. Returns a realistic DV Lottery photo-report JSON payload in
 * the exact shape runFullAIReport() in index.html expects to parse.
 */
header('Content-Type: application/json');

// Test-only side channel (see mock-paypal.php for why this can't be a header).
$scenarioFile = sys_get_temp_dir() . '/mock_anthropic_scenario';
$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if ($uri === '/_mock/set-scenario') {
    $b = json_decode(file_get_contents('php://input'), true);
    file_put_contents($scenarioFile, $b['scenario'] ?? 'ok');
    echo json_encode(['ok' => true]);
    exit;
}
$scenario = is_file($scenarioFile) ? trim(file_get_contents($scenarioFile)) : 'ok';
if ($scenario === 'upstream_fail') {
    @file_put_contents($scenarioFile, 'ok'); // one-shot
    http_response_code(529); // Anthropic's "overloaded" status
    echo json_encode(['type' => 'error', 'error' => ['type' => 'overloaded_error', 'message' => 'mock overload']]);
    exit;
}

$raw = file_get_contents('php://input');
$req = json_decode($raw, true);

// Verify the server forced the cheap model regardless of what the client sent.
$modelUsed = $req['model'] ?? 'MISSING';

$report = [
    'crop' => ['topPercent' => 0.08, 'leftPercent' => 0.22, 'widthPercent' => 0.56, 'heightPercent' => 0.62],
    'measurements' => ['headHeightPercent' => 58, 'eyeHeightFromBottomPercent' => 61],
    'overall' => ['verdict' => 'pass', 'score' => 92, 'summary' => 'Meets DV Lottery photo requirements.'],
    'categories' => [
        ['id' => 'dimensions', 'status' => 'pass', 'detail' => '600x600px, correct aspect ratio.'],
        ['id' => 'headSize', 'status' => 'pass', 'detail' => 'Head height is 58% of frame (within 50-69%).'],
        ['id' => 'eyeHeight', 'status' => 'pass', 'detail' => 'Eyes at 61% from bottom (within 56-69%).'],
        ['id' => 'background', 'status' => 'pass', 'detail' => 'Plain white background.'],
        ['id' => 'lighting', 'status' => 'pass', 'detail' => 'Even lighting, no harsh shadows.'],
        ['id' => 'focus', 'status' => 'pass', 'detail' => 'Image is sharp.'],
        ['id' => 'expression', 'status' => 'pass', 'detail' => 'Neutral expression, mouth closed.'],
        ['id' => 'eyes', 'status' => 'pass', 'detail' => 'Both eyes open and visible.'],
        ['id' => 'glasses', 'status' => 'pass', 'detail' => 'No glasses worn.'],
        ['id' => 'headCovering', 'status' => 'pass', 'detail' => 'No head covering.'],
        ['id' => 'singleSubject', 'status' => 'pass', 'detail' => 'Only one person in frame.'],
        ['id' => 'colorRecency', 'status' => 'pass', 'detail' => 'Full color photo.'],
    ],
    'issues' => [],
    'fixes' => [],
    '_mockModelUsed' => $modelUsed, // test-only field to prove server-side model forcing
];

echo json_encode([
    'id' => 'msg_mock123',
    'type' => 'message',
    'role' => 'assistant',
    'content' => [['type' => 'text', 'text' => json_encode($report)]],
    'model' => $modelUsed,
    'usage' => ['input_tokens' => 1200, 'output_tokens' => 350],
]);
