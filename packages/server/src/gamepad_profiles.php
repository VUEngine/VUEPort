<?php

declare(strict_types=1);

/**
 * Where controller profiles recorded in VUEPort are sent, so the good ones can ship with it. The one route with
 * state: a submission is kept as a file until reviewed, and bundling one is still a manual change to
 * packages/core/src/data/gamepad-profiles/. So it does not become a dump for arbitrary data, every submission is
 * checked and re-encoded from what passed (unknown fields never reach the disk), duplicates are stored once, an
 * address may send a handful an hour (counted under a salted hash, the address itself is never written down), and
 * the queue has a ceiling.
 *
 * Reviewing (listing and deleting) takes a token from VUEPORT_REVIEW_TOKEN, or from a review-token file in the data
 * directory for hosts with no easy way to set environment variables; with neither, review is off.
 * packages/core/scripts/fetch-gamepad-submissions.mjs is its client.
 */

const GAMEPAD_PROFILES_PATH = '/gamepad-profiles';

// a profile is a few kilobytes; a request near this is not one
const GAMEPAD_MAX_BODY = 32 * 1024;
const GAMEPAD_MAX_NOTE = 500;
// submissions per address per hour
const GAMEPAD_RATE_LIMIT = 5;
// unreviewed submissions at once
const GAMEPAD_QUEUE_LIMIT = 500;

const GAMEPAD_BUTTONS = [
    'a', 'b', 'select', 'start', 'lTrigger', 'rTrigger',
    'lUp', 'lDown', 'lLeft', 'lRight', 'rUp', 'rDown', 'rLeft', 'rRight',
];
const GAMEPAD_FAMILIES = ['xbox', 'playstation', 'nintendo', 'generic'];
const GAMEPAD_ENGINES = ['chromium', 'gecko', 'webkit', 'sdl'];
const GAMEPAD_PLATFORMS = ['macos', 'windows', 'linux', 'chromeos', 'android', 'ios'];
const GAMEPAD_HAT_DIRECTIONS = ['up', 'right', 'down', 'left'];
// kept in step by hand with EmulatorAction in vueport-core's emulator-types.ts and GAMEPAD_MACRO_ACTIONS in
// emulator-gamepad-profiles.ts, plus commandPalette (Home)
const GAMEPAD_ACTIONS = [
    'commandPalette',
    'fullscreen', 'toggleControlsOverlay', 'saveState', 'loadState', 'toggleFastForward',
    'pauseToggle', 'toggleSlowmotion', 'toggleLowPower', 'rewind', 'frameAdvance', 'reset',
    'audioMute', 'screenshot', 'videoRecord',
    'macro1', 'macro2', 'macro3', 'macro4', 'macro5', 'macro6', 'macro7', 'macro8',
];

// submissions and rate counters, outside public/
function vueport_gamepad_data_dir(): string
{
    return vueport_env('VUEPORT_DATA_DIR', __DIR__ . '/../data') . '/gamepad-profiles';
}

// checks a { profile, note } submission (profile as gamepadProfileFile writes it) and rebuilds it from what passed;
// returns the clean submission or what was wrong. Pure, so what may reach the disk is testable without a server
function vueport_gamepad_clean_submission($body)
{
    if (!is_array($body) || !is_array($body['profile'] ?? null)) {
        return 'expected { profile, note }';
    }
    $profile = $body['profile'];
    $note = $body['note'] ?? '';
    if (!vueport_gamepad_text($note, 0, GAMEPAD_MAX_NOTE)) {
        return 'note must be text of at most ' . GAMEPAD_MAX_NOTE . ' characters';
    }

    if (($profile['format'] ?? null) !== 'vueport-gamepad-profile' || ($profile['version'] ?? null) !== 1) {
        return 'not a vueport-gamepad-profile, version 1';
    }
    $id = $profile['id'] ?? null;
    if (!is_string($id) || !preg_match('/^[a-z0-9][a-z0-9-]{0,79}$/', $id)) {
        return 'id must be lower-case letters, digits and dashes';
    }
    $name = $profile['name'] ?? null;
    if (!vueport_gamepad_text($name, 1, 100)) {
        return 'name must be 1 to 100 characters';
    }
    $family = $profile['family'] ?? null;
    if (!in_array($family, GAMEPAD_FAMILIES, true)) {
        return 'unknown family';
    }
    $deadZone = $profile['deadZone'] ?? null;
    if ((!is_int($deadZone) && !is_float($deadZone)) || $deadZone < 0.1 || $deadZone > 0.9) {
        return 'deadZone must be between 0.1 and 0.9';
    }

    $match = vueport_gamepad_clean_match($profile['match'] ?? null);
    if (is_string($match)) {
        return $match;
    }

    $cleanButtons = vueport_gamepad_clean_buttons($profile['buttons'] ?? null, 'button');
    if (is_string($cleanButtons)) {
        return $cleanButtons;
    }
    if (count($cleanButtons) === 0) {
        return 'a profile with no buttons mapped has nothing to share';
    }
    $cleanTurbo = vueport_gamepad_clean_buttons($profile['turbo'] ?? [], 'turbo button');
    if (is_string($cleanTurbo)) {
        return $cleanTurbo;
    }

    $actions = $profile['actions'] ?? [];
    if (!is_array($actions)) {
        return 'actions must be an object';
    }
    $cleanActions = [];
    foreach ($actions as $action => $sources) {
        if (!in_array($action, GAMEPAD_ACTIONS, true)) {
            return "unknown action $action";
        }
        if (!is_array($sources) || count($sources) === 0 || count($sources) > 8) {
            return "action $action must have 1 to 8 sources";
        }
        foreach ($sources as $source) {
            $one = vueport_gamepad_clean_source($source);
            if ($one === null) {
                return "action $action has a source that is not one";
            }
            $cleanActions[$action][] = $one;
        }
    }

    return [
        'profile' => [
            'format' => 'vueport-gamepad-profile',
            'version' => 1,
            'id' => $id,
            'name' => $name,
            'family' => $family,
            'match' => $match,
            'deadZone' => round((float)$deadZone, 2),
            'buttons' => $cleanButtons,
        ] + (count($cleanTurbo) > 0 ? ['turbo' => $cleanTurbo] : [])
          + (count($cleanActions) > 0 ? ['actions' => $cleanActions] : []),
        'note' => trim($note),
    ];
}

// returns the cleaned map of VB buttons to sources, or a refusal naming $what
function vueport_gamepad_clean_buttons($buttons, string $what)
{
    if (!is_array($buttons)) {
        return "{$what}s must be an object";
    }
    $clean = [];
    foreach ($buttons as $button => $sources) {
        if (!in_array($button, GAMEPAD_BUTTONS, true)) {
            return "unknown $what $button";
        }
        if (!is_array($sources) || count($sources) === 0 || count($sources) > 8) {
            return "$what $button must have 1 to 8 sources";
        }
        foreach ($sources as $source) {
            $one = vueport_gamepad_clean_source($source);
            if ($one === null) {
                return "$what $button has a source that is not one";
            }
            $clean[$button][] = $one;
        }
    }
    return $clean;
}

// length in characters via a pattern, as mb_strlen needs an extension not every host has; the u flag also refuses
// invalid UTF-8
function vueport_gamepad_text($value, int $min, int $max): bool
{
    return is_string($value) && preg_match('/^.{' . $min . ',' . $max . '}$/us', $value) === 1;
}

function vueport_gamepad_clean_match($match)
{
    if (!is_array($match)) {
        return 'match must be an object';
    }
    $clean = [];
    if (isset($match['device'])) {
        if (!is_string($match['device']) || !preg_match('/^[0-9a-f]{4}:[0-9a-f]{4}$/', $match['device'])) {
            return 'match.device must be vendor:product in hex';
        }
        $clean['device'] = $match['device'];
    }
    if (isset($match['name'])) {
        if (!vueport_gamepad_text($match['name'], 1, 100)) {
            return 'match.name must be 1 to 100 characters';
        }
        $clean['name'] = $match['name'];
    }
    if (!isset($clean['device']) && !isset($clean['name'])) {
        return 'match needs a device or a name';
    }
    $mapping = $match['mapping'] ?? '';
    if ($mapping !== '' && $mapping !== 'standard') {
        return "match.mapping must be '' or 'standard'";
    }
    $clean['mapping'] = $mapping;
    foreach (['engine' => GAMEPAD_ENGINES, 'platform' => GAMEPAD_PLATFORMS] as $key => $allowed) {
        if (isset($match[$key])) {
            if (!in_array($match[$key], $allowed, true)) {
                return "unknown match.$key";
            }
            $clean[$key] = $match[$key];
        }
    }
    foreach (['buttons', 'axes'] as $key) {
        if (isset($match[$key])) {
            if (!is_int($match[$key]) || $match[$key] < 0 || $match[$key] > 128) {
                return "match.$key must be a count";
            }
            $clean[$key] = $match[$key];
        }
    }
    return $clean;
}

function vueport_gamepad_clean_source($source): ?array
{
    if (!is_array($source) || !is_int($source['index'] ?? null) || $source['index'] < 0 || $source['index'] > 255) {
        return null;
    }
    $index = $source['index'];
    switch ($source['kind'] ?? null) {
        case 'button':
            return ['kind' => 'button', 'index' => $index];
        case 'axis':
            $direction = $source['direction'] ?? null;
            return $direction === 1 || $direction === -1
                ? ['kind' => 'axis', 'index' => $index, 'direction' => $direction]
                : null;
        case 'hat':
            $direction = $source['direction'] ?? null;
            return in_array($direction, GAMEPAD_HAT_DIRECTIONS, true)
                ? ['kind' => 'hat', 'index' => $index, 'direction' => $direction]
                : null;
    }
    return null;
}

// id plus a hash of the profile, so the same mapping sent twice lands on the same name
function vueport_gamepad_submission_name(array $clean): string
{
    $hash = substr(hash('sha256', json_encode($clean['profile'])), 0, 12);
    return $clean['profile']['id'] . '-' . $hash . '.json';
}

function vueport_gamepad_reply(int $status, array $body): void
{
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($body);
}

function vueport_gamepad_prepare_dir(string $dir): bool
{
    if (!is_dir($dir) && !@mkdir($dir . '/rate', 0700, true)) {
        return false;
    }
    if (!is_dir($dir . '/rate') && !@mkdir($dir . '/rate', 0700, true)) {
        return false;
    }
    // belt and braces: public/.htaccess already routes every path to index.php, but a deployment that copies
    // public/'s contents up beside src/ would otherwise leave this directory a URL away
    $deny = dirname($dir) . '/.htaccess';
    if (!file_exists($deny)) {
        @file_put_contents($deny, "Require all denied\n");
    }
    return true;
}

// counts this address's submissions in the last hour and takes one more if there is room. A file of timestamps
// named after a salted hash of the address; the salt lives beside it and never leaves the server.
function vueport_gamepad_take_rate(string $dir): bool
{
    $saltFile = $dir . '/rate/salt';
    if (!file_exists($saltFile)) {
        @file_put_contents($saltFile, bin2hex(random_bytes(16)));
    }
    $salt = (string)@file_get_contents($saltFile);
    $address = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    $file = $dir . '/rate/' . substr(hash('sha256', $salt . $address), 0, 24);

    $now = time();
    $handle = @fopen($file, 'c+');
    if ($handle === false) {
        return false;
    }
    flock($handle, LOCK_EX);
    $recent = array_filter(
        array_map('intval', explode("\n", (string)stream_get_contents($handle))),
        function (int $time) use ($now): bool {
            return $time > $now - 3600;
        }
    );
    $allowed = count($recent) < GAMEPAD_RATE_LIMIT;
    if ($allowed) {
        $recent[] = $now;
    }
    ftruncate($handle, 0);
    rewind($handle);
    fwrite($handle, implode("\n", $recent));
    flock($handle, LOCK_UN);
    fclose($handle);
    return $allowed;
}

function vueport_gamepad_queue(string $dir): array
{
    $files = glob($dir . '/*.json');
    return $files === false ? [] : $files;
}

function vueport_gamepad_review_token(): string
{
    $token = vueport_env('VUEPORT_REVIEW_TOKEN', '');
    if ($token === '') {
        $file = vueport_env('VUEPORT_DATA_DIR', __DIR__ . '/../data') . '/review-token';
        $token = is_readable($file) ? trim((string)file_get_contents($file)) : '';
    }
    return $token;
}

// X-Review-Token rather than Authorization, which Apache in front of PHP-FPM (Plesk) drops before PHP sees it
// unless the vhost is told not to
function vueport_gamepad_may_review(): bool
{
    $token = vueport_gamepad_review_token();
    $given = $_SERVER['HTTP_X_REVIEW_TOKEN'] ?? '';
    // short tokens are refused outright, this one guards a delete
    return strlen($token) >= 24 && is_string($given) && hash_equals($token, $given);
}

function vueport_handle_gamepad_profiles(string $path): void
{
    $dir = vueport_gamepad_data_dir();
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    $rest = substr($path, strlen(GAMEPAD_PROFILES_PATH));

    if ($method === 'POST' && ($rest === '' || $rest === '/')) {
        vueport_gamepad_receive($dir);
        return;
    }
    if ($method === 'GET' && ($rest === '' || $rest === '/')) {
        if (!vueport_gamepad_may_review()) {
            vueport_gamepad_reply(404, ['error' => 'not found']);
            return;
        }
        $submissions = [];
        foreach (vueport_gamepad_queue($dir) as $file) {
            $stored = json_decode((string)file_get_contents($file), true);
            if (is_array($stored)) {
                $submissions[] = ['name' => basename($file)] + $stored;
            }
        }
        vueport_gamepad_reply(200, ['submissions' => $submissions]);
        return;
    }
    if ($method === 'DELETE' && preg_match('#^/([a-z0-9-]+\.json)$#', $rest, $found)) {
        if (!vueport_gamepad_may_review()) {
            vueport_gamepad_reply(404, ['error' => 'not found']);
            return;
        }
        $file = $dir . '/' . $found[1];
        if (!file_exists($file)) {
            vueport_gamepad_reply(404, ['error' => 'no such submission']);
            return;
        }
        @unlink($file);
        http_response_code(204);
        return;
    }
    vueport_gamepad_reply(405, ['error' => 'method not allowed']);
}

function vueport_gamepad_receive(string $dir): void
{
    $raw = file_get_contents('php://input', false, null, 0, GAMEPAD_MAX_BODY + 1);
    if ($raw === false || strlen($raw) > GAMEPAD_MAX_BODY) {
        vueport_gamepad_reply(413, ['error' => 'too large']);
        return;
    }
    $clean = vueport_gamepad_clean_submission(json_decode($raw, true));
    if (is_string($clean)) {
        vueport_gamepad_reply(400, ['error' => $clean]);
        return;
    }
    if (!vueport_gamepad_prepare_dir($dir)) {
        vueport_gamepad_reply(503, ['error' => 'cannot store submissions right now']);
        return;
    }
    $file = $dir . '/' . vueport_gamepad_submission_name($clean);
    // a duplicate is answered before the rate counter is touched
    if (file_exists($file)) {
        vueport_gamepad_reply(200, ['status' => 'duplicate']);
        return;
    }
    if (count(vueport_gamepad_queue($dir)) >= GAMEPAD_QUEUE_LIMIT) {
        vueport_gamepad_reply(503, ['error' => 'the review queue is full; please try again later']);
        return;
    }
    if (!vueport_gamepad_take_rate($dir)) {
        vueport_gamepad_reply(429, ['error' => 'too many submissions; please try again in an hour']);
        return;
    }
    $stored = ['receivedAt' => gmdate('c')] + $clean;
    if (@file_put_contents($file, json_encode($stored, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)) === false) {
        vueport_gamepad_reply(503, ['error' => 'cannot store submissions right now']);
        return;
    }
    vueport_gamepad_reply(201, ['status' => 'received']);
}
