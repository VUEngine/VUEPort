<?php

declare(strict_types=1);

// VUEPORT_ALLOWED_ORIGINS, comma-separated; unset allows any origin (fine for a local build, a real deployment should
// narrow it), `*` does so explicitly. Returns string[] or '*'
function vueport_allowed_origins()
{
    $raw = trim(vueport_env('VUEPORT_ALLOWED_ORIGINS', '*'));
    if ($raw === '' || $raw === '*') {
        return '*';
    }
    $origins = array_map('trim', explode(',', $raw));
    return array_values(array_filter($origins, function (string $origin): bool {
        return $origin !== '';
    }));
}

// returns true for an OPTIONS preflight, whose response is then complete; $allowed is string[] or '*'
function vueport_apply_cors($allowed): bool
{
    $origin = $_SERVER['HTTP_ORIGIN'] ?? null;
    if ($allowed === '*') {
        header('Access-Control-Allow-Origin: *');
    } elseif ($origin !== null && in_array($origin, $allowed, true)) {
        header('Access-Control-Allow-Origin: ' . $origin);
        // only with one specific origin rather than * does a cache have to vary on it
        header('Vary: Origin');
    }
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');

    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
        http_response_code(204);
        return true;
    }
    return false;
}
