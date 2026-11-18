<?php

declare(strict_types=1);

/**
 * Where VUEPort Desktop's LAN shares meet the headsets that want them. A desktop sharing a game serves it itself, on a
 * plain-http port in the local network (packages/desktop/src-tauri/src/lan_share.rs). A page cannot look for that on
 * its own (no mDNS, no broadcast, WebRTC hides the local address), so the desktop says here where it is, and a page
 * asks for the shares of its own network. "Its own network" is the address this server sees: behind one router that
 * is one public IPv4 address, for IPv6 the /64 prefix.
 *
 * Only where to find a share is kept, never the game: a name, a title and the desktop's private addresses. An entry
 * lives TTL seconds unless the desktop renews it, and only the desktop holding its secret can renew or withdraw it.
 * The addresses must be private IPv4 ones, so an entry cannot send a headset anywhere on the internet.
 */

const LAN_SHARES_PATH = '/lan-shares';

// the desktop renews every 30 seconds; three missed renewals and the share is gone from every list
const LAN_SHARES_TTL = 90;
// a share is a few hundred bytes
const LAN_SHARES_MAX_BODY = 4 * 1024;
// shares per network at once, so one network cannot fill the disk
const LAN_SHARES_PER_NETWORK = 16;
const LAN_SHARES_MAX_ADDRESSES = 8;
// networks not asked about for this long have their files swept
const LAN_SHARES_SWEEP_AGE = 600;

function vueport_lan_shares_data_dir(): string
{
    return vueport_env('VUEPORT_DATA_DIR', __DIR__ . '/../data') . '/lan-shares';
}

// the part of the caller's address its whole network shares: IPv4 as is (NAT), the /64 of IPv6; null for anything
// that's no address
function vueport_lan_network(string $address): ?string
{
    if (filter_var($address, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false) {
        return $address;
    }
    if (filter_var($address, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) !== false) {
        $packed = inet_pton($address);
        if ($packed === false) {
            return null;
        }
        // an IPv4 caller seen through an IPv6 socket (::ffff:a.b.c.d) is that IPv4 caller
        if (substr($packed, 0, 12) === str_repeat("\0", 10) . "\xff\xff") {
            return inet_ntop(substr($packed, 12));
        }
        return bin2hex(substr($packed, 0, 8)) . '::/64';
    }
    return null;
}

// host:port with a private IPv4 host (10/8, 172.16/12, 192.168/16) and a port other than 0
function vueport_lan_private_address($address): bool
{
    if (!is_string($address) || !preg_match('/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/', $address, $m)) {
        return false;
    }
    for ($i = 1; $i <= 4; $i++) {
        if ((int)$m[$i] > 255 || ($m[$i] !== '0' && $m[$i][0] === '0')) {
            return false;
        }
    }
    $port = (int)$m[5];
    if ($port < 1 || $port > 65535) {
        return false;
    }
    $a = (int)$m[1];
    $b = (int)$m[2];
    return $a === 10 || ($a === 172 && $b >= 16 && $b <= 31) || ($a === 192 && $b === 168);
}

// checks a share as the desktop sends it ({ id, secret, device, title, name, token, addresses[], state, romId? }) and
// rebuilds it from what passed; returns the clean share or what was wrong. Pure, so testable without a server
function vueport_lan_clean_share($body)
{
    if (!is_array($body)) {
        return 'expected a share';
    }
    foreach (['id' => 16, 'secret' => 32, 'token' => 16] as $key => $min) {
        $value = $body[$key] ?? null;
        if (!is_string($value) || !preg_match('/^[0-9a-f]{' . $min . ',64}$/', $value)) {
            return "$key must be $min to 64 lower-case hex digits";
        }
    }
    foreach (['device' => 60, 'title' => 100, 'name' => 120] as $key => $max) {
        $value = $body[$key] ?? null;
        // no control characters, as these end up in a list on the user's screen
        if (!is_string($value) || preg_match('/^[^\x00-\x1f\x7f]{1,' . $max . '}$/u', $value) !== 1) {
            return "$key must be 1 to $max characters";
        }
    }
    $addresses = $body['addresses'] ?? null;
    if (!is_array($addresses) || count($addresses) === 0 || count($addresses) > LAN_SHARES_MAX_ADDRESSES) {
        return 'addresses must hold 1 to ' . LAN_SHARES_MAX_ADDRESSES . ' entries';
    }
    foreach ($addresses as $address) {
        if (!vueport_lan_private_address($address)) {
            return 'every address must be a private IPv4 address with a port';
        }
    }
    $state = $body['state'] ?? false;
    if (!is_bool($state)) {
        return 'state must be true or false';
    }
    $romId = $body['romId'] ?? null;
    if ($romId !== null && (!is_string($romId) || !preg_match('/^[0-9a-f]{8}$/', $romId))) {
        return 'romId must be 8 lower-case hex digits';
    }

    return [
        'id' => $body['id'],
        'secret' => $body['secret'],
        'device' => $body['device'],
        'title' => $body['title'],
        'name' => $body['name'],
        'token' => $body['token'],
        'addresses' => array_values(array_unique($addresses)),
        'state' => $state,
    ] + ($romId !== null ? ['romId' => $romId] : []);
}

// what a page is told of a share: everything but the secret
function vueport_lan_public_share(array $stored): array
{
    unset($stored['secretHash']);
    return $stored;
}

function vueport_lan_reply(int $status, array $body): void
{
    http_response_code($status);
    header('Content-Type: application/json');
    // a list that changes every few seconds must never come out of a cache
    header('Cache-Control: no-store');
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
}

function vueport_lan_prepare_dir(string $dir): bool
{
    if (!is_dir($dir) && !@mkdir($dir, 0700, true)) {
        return false;
    }
    // as gamepad_profiles.php: a deployment that lays public/ beside src/ must not serve the data directory
    $deny = dirname($dir) . '/.htaccess';
    if (!file_exists($deny)) {
        @file_put_contents($deny, "Require all denied\n");
    }
    return true;
}

// one file per network, named after a salted hash of it, so the addresses are never written down
function vueport_lan_network_file(string $dir, string $network): string
{
    $saltFile = $dir . '/salt';
    if (!file_exists($saltFile)) {
        @file_put_contents($saltFile, bin2hex(random_bytes(16)));
    }
    $salt = (string)@file_get_contents($saltFile);
    return $dir . '/' . substr(hash('sha256', $salt . $network), 0, 32) . '.json';
}

// reads the network's shares under a lock, drops expired ones and writes back what $change returns (null leaves the
// file alone). Returns $change's result, or null if the file couldn't be opened
function vueport_lan_with_shares(string $file, callable $change, bool $create)
{
    if (!$create && !file_exists($file)) {
        return $change([]) ?? [];
    }
    $handle = @fopen($file, 'c+');
    if ($handle === false) {
        return null;
    }
    flock($handle, LOCK_EX);
    $stored = json_decode((string)stream_get_contents($handle), true);
    $now = time();
    $shares = array_filter(is_array($stored) ? $stored : [], function ($share) use ($now): bool {
        return is_array($share) && ($share['expires'] ?? 0) > $now;
    });
    $next = $change($shares);
    if ($next !== null) {
        ftruncate($handle, 0);
        rewind($handle);
        fwrite($handle, json_encode($next, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    }
    flock($handle, LOCK_UN);
    fclose($handle);
    if ($next === []) {
        @unlink($file);
    }
    return $next ?? $shares;
}

// now and then on a write, so networks that went quiet do not leave their files behind for ever
function vueport_lan_sweep(string $dir): void
{
    if (random_int(1, 20) !== 1) {
        return;
    }
    $files = glob($dir . '/*.json');
    foreach ($files === false ? [] : $files as $file) {
        $modified = @filemtime($file);
        if ($modified !== false && $modified < time() - LAN_SHARES_SWEEP_AGE) {
            @unlink($file);
        }
    }
}

function vueport_handle_lan_shares(string $path): void
{
    $dir = vueport_lan_shares_data_dir();
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    $rest = substr($path, strlen(LAN_SHARES_PATH));
    $network = vueport_lan_network((string)($_SERVER['REMOTE_ADDR'] ?? ''));
    if ($network === null) {
        vueport_lan_reply(400, ['error' => 'cannot tell which network this is']);
        return;
    }

    if ($method === 'GET' && ($rest === '' || $rest === '/')) {
        if (!is_dir($dir)) {
            vueport_lan_reply(200, ['shares' => []]);
            return;
        }
        $shares = vueport_lan_with_shares(vueport_lan_network_file($dir, $network), function () {
            return null;
        }, false);
        vueport_lan_reply(200, ['shares' => array_values(array_map('vueport_lan_public_share', $shares ?? []))]);
        return;
    }
    if ($method !== 'POST') {
        vueport_lan_reply(405, ['error' => 'method not allowed']);
        return;
    }

    $raw = file_get_contents('php://input', false, null, 0, LAN_SHARES_MAX_BODY + 1);
    if ($raw === false || strlen($raw) > LAN_SHARES_MAX_BODY) {
        vueport_lan_reply(413, ['error' => 'too large']);
        return;
    }
    $body = json_decode($raw, true);
    if (!vueport_lan_prepare_dir($dir)) {
        vueport_lan_reply(503, ['error' => 'cannot keep shares right now']);
        return;
    }
    $file = vueport_lan_network_file($dir, $network);

    if ($rest === '' || $rest === '/') {
        $clean = vueport_lan_clean_share($body);
        if (is_string($clean)) {
            vueport_lan_reply(400, ['error' => $clean]);
            return;
        }
        $outcome = 'shared';
        $result = vueport_lan_with_shares($file, function (array $shares) use ($clean, &$outcome) {
            $existing = $shares[$clean['id']] ?? null;
            if ($existing !== null && !hash_equals($existing['secretHash'] ?? '', hash('sha256', $clean['secret']))) {
                $outcome = 'taken';
                return null;
            }
            if ($existing === null && count($shares) >= LAN_SHARES_PER_NETWORK) {
                $outcome = 'full';
                return null;
            }
            $secret = $clean['secret'];
            unset($clean['secret']);
            $shares[$clean['id']] = $clean + [
                'secretHash' => hash('sha256', $secret),
                'since' => $existing['since'] ?? time(),
                'expires' => time() + LAN_SHARES_TTL,
            ];
            return $shares;
        }, true);
        vueport_lan_sweep($dir);
        if ($result === null) {
            vueport_lan_reply(503, ['error' => 'cannot keep shares right now']);
        } elseif ($outcome === 'taken') {
            vueport_lan_reply(403, ['error' => 'this share belongs to somebody else']);
        } elseif ($outcome === 'full') {
            vueport_lan_reply(503, ['error' => 'this network already shares ' . LAN_SHARES_PER_NETWORK . ' games']);
        } else {
            vueport_lan_reply(200, ['status' => 'shared', 'ttl' => LAN_SHARES_TTL]);
        }
        return;
    }

    if ($rest === '/withdraw') {
        $id = is_array($body) ? ($body['id'] ?? null) : null;
        $secret = is_array($body) ? ($body['secret'] ?? null) : null;
        if (!is_string($id) || !is_string($secret)) {
            vueport_lan_reply(400, ['error' => 'expected { id, secret }']);
            return;
        }
        vueport_lan_with_shares($file, function (array $shares) use ($id, $secret) {
            $existing = $shares[$id] ?? null;
            if ($existing === null || !hash_equals($existing['secretHash'] ?? '', hash('sha256', $secret))) {
                return null;
            }
            unset($shares[$id]);
            return $shares;
        }, false);
        // the same answer whether there was such a share or not: withdrawing is done either way
        vueport_lan_reply(200, ['status' => 'withdrawn']);
        return;
    }

    vueport_lan_reply(404, ['error' => 'not found']);
}
