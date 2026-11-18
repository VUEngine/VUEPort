<?php

declare(strict_types=1);

/**
 * Relay for RetroAchievements, whose dorequest.php sends no Access-Control-Allow-Origin, so a page can't read its
 * reply. This script is not a page, so CORS doesn't limit it, and cors.php lets the page read the relayed answer.
 * The request shape is agreed with WebRetroAchievementsTransport (web-retroachievements.ts). Dumb on purpose: it
 * relays one request; when to call and what to do with the answer is up to emulator-retroachievements.ts.
 */

require_once __DIR__ . '/http_client.php';

// the only host this will ever reach, checked rather than trusted
const RA_ALLOWED_HOST_SUFFIX = 'retroachievements.org';

// must match RETROACHIEVEMENTS_CLIENT in packages/core/src/common/vb-constants.ts; hand-copied, as this package is
// deployed as nothing but its own files, with no build step
const RETROACHIEVEMENTS_CLIENT = 'VUEPort/1.0.0';

// generous for a handful of form fields, but a bound, as the whole body is read into memory
const RA_MAX_BODY_BYTES = 1024 * 1024;

function vueport_ra_allowed_host(string $host): bool
{
    $host = strtolower($host);
    return $host === RA_ALLOWED_HOST_SUFFIX
        || substr($host, -strlen('.' . RA_ALLOWED_HOST_SUFFIX)) === '.' . RA_ALLOWED_HOST_SUFFIX;
}

function vueport_handle_ra_proxy(): void
{
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
        http_response_code(405);
        header('Content-Type: text/plain');
        echo 'POST only.';
        return;
    }

    $declaredLength = isset($_SERVER['CONTENT_LENGTH']) ? (int) $_SERVER['CONTENT_LENGTH'] : null;
    if ($declaredLength !== null && $declaredLength > RA_MAX_BODY_BYTES) {
        http_response_code(413);
        header('Content-Type: text/plain');
        echo 'Request body too large.';
        return;
    }

    // read one byte past the bound, so an oversized body is caught without trusting Content-Length alone
    $raw = file_get_contents('php://input', false, null, 0, RA_MAX_BODY_BYTES + 1);
    if ($raw === false) {
        http_response_code(400);
        header('Content-Type: text/plain');
        echo 'Could not read the request body.';
        return;
    }
    if (strlen($raw) > RA_MAX_BODY_BYTES) {
        http_response_code(413);
        header('Content-Type: text/plain');
        echo 'Request body too large.';
        return;
    }

    $parsed = json_decode($raw, true);
    if (!is_array($parsed)) {
        http_response_code(400);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'Body was not valid JSON.']);
        return;
    }

    $method = $parsed['method'] ?? null;
    $method = ($method === 'GET' || $method === 'POST') ? $method : null;
    $url = isset($parsed['url']) && is_string($parsed['url']) ? $parsed['url'] : null;
    $body = isset($parsed['body']) && is_string($parsed['body']) ? $parsed['body'] : null;
    $contentType = isset($parsed['contentType']) && is_string($parsed['contentType']) ? $parsed['contentType'] : null;

    if ($method === null || $url === null) {
        http_response_code(400);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'Expected { method: "GET"|"POST", url, body?, contentType? }.']);
        return;
    }

    $host = parse_url($url, PHP_URL_HOST);
    if (!is_string($host) || $host === '') {
        http_response_code(400);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'Bad url.']);
        return;
    }
    if (!vueport_ra_allowed_host($host)) {
        http_response_code(400);
        header('Content-Type: application/json');
        echo json_encode(['error' => "Refusing to reach $host: not RetroAchievements."]);
        return;
    }

    $headers = ['User-Agent: ' . RETROACHIEVEMENTS_CLIENT];
    if ($contentType !== null) {
        $headers[] = 'Content-Type: ' . $contentType;
    }

    $result = vueport_http_request($method, $url, $headers, $method === 'POST' ? ($body ?? '') : null);
    if ($result['error'] !== null) {
        // RetroAchievements was not reached at all: still 200 for "the relay worked", and error tells
        // emulator-retroachievements.ts there is no status/body pair to read
        http_response_code(200);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'Could not reach RetroAchievements: ' . $result['error']]);
        return;
    }

    http_response_code(200);
    header('Content-Type: application/json');
    echo json_encode(['status' => $result['status'], 'body' => $result['body']]);
}
