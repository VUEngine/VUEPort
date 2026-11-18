<?php

declare(strict_types=1);

// relay for Planet VB's API (https://www.virtual-boy.com/api/rom/…), which sends CORS headers itself but goes through
// here so the web build reaches out from one place. Dumb on purpose like ra_proxy.php: it passes a GET on and the reply
// back; web-planet-vb.ts and web-homebrew.ts know the shape

require_once __DIR__ . '/http_client.php';

const PVB_ORIGIN = 'https://www.virtual-boy.com';
const PVB_UPSTREAM_PREFIX = '/api/rom';
// everything after this, path and query alike, is handed on to PVB_UPSTREAM_PREFIX as it came:
// /pvb/<crc32>/ here is /api/rom/<crc32>/ there, /pvb/?featured is /api/rom/?featured
const PVB_PREFIX = '/pvb';

// upstream URL for a path under PVB_PREFIX, or null if it would leave PVB_ORIGIN; pure so the SSRF part is testable.
// The rest is appended as a string, never resolved as a relative URL, where a leading // could name another host; the
// origin check below guards the same thing a second time
function vueport_pvb_target_url(string $path, string $queryString): ?string
{
    $rest = substr($path, strlen(PVB_PREFIX));
    if ($rest === false) {
        $rest = '';
    }
    if (substr($rest, 0, 1) !== '/') {
        $rest = '/' . $rest;
    }
    $search = $queryString !== '' ? '?' . $queryString : '';
    $target = PVB_ORIGIN . PVB_UPSTREAM_PREFIX . $rest . $search;

    $parts = parse_url($target);
    if ($parts === false || !isset($parts['scheme'], $parts['host'])) {
        return null;
    }
    $origin = $parts['scheme'] . '://' . $parts['host'] . (isset($parts['port']) ? ':' . $parts['port'] : '');
    if ($origin !== PVB_ORIGIN) {
        return null;
    }
    return $target;
}

function vueport_handle_pvb_proxy(string $path): void
{
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
        http_response_code(405);
        header('Content-Type: text/plain');
        echo 'This proxies reads; only GET is offered.';
        return;
    }

    $target = vueport_pvb_target_url($path, $_SERVER['QUERY_STRING'] ?? '');
    if ($target === null) {
        http_response_code(400);
        header('Content-Type: text/plain');
        echo 'Bad path.';
        return;
    }

    $result = vueport_http_request('GET', $target, ['Accept: application/json'], null);
    if ($result['error'] !== null) {
        http_response_code(502);
        header('Content-Type: text/plain');
        echo 'Could not reach Planet VB: ' . $result['error'];
        return;
    }

    http_response_code($result['status']);
    header('Content-Type: ' . ($result['contentType'] ?? 'application/octet-stream'));
    echo $result['body'];
}
