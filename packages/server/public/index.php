<?php

declare(strict_types=1);

/**
 * VUEPort's proxy: where shared controller profiles are sent (../src/gamepad_profiles.php) and where desktops sharing
 * a game in the local network are found (../src/lan_shares.php). RetroAchievements' dorequest.php sends no
 * Access-Control-Allow-Origin, so no page (web build or desktop webview) can read its reply (../src/ra_proxy.php, see
 * web-retroachievements.ts). Planet VB allows it but goes through here too, so the web build reaches out from one
 * place (../src/pvb_proxy.php).
 *
 * Plain PHP, not Node, so it runs on hosting that only offers PHP or an outdated Node (see ../README.md). .htaccess
 * routes every request here; router.php does the same for `php -S`, which ignores .htaccess.
 */

require_once __DIR__ . '/../src/config.php';
require_once __DIR__ . '/../src/cors.php';
require_once __DIR__ . '/../src/gamepad_profiles.php';
require_once __DIR__ . '/../src/lan_shares.php';
require_once __DIR__ . '/../src/pvb_proxy.php';
require_once __DIR__ . '/../src/ra_proxy.php';

$allowed = vueport_allowed_origins();
if (vueport_apply_cors($allowed)) {
    return;
}

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
if (!is_string($path) || $path === '') {
    $path = '/';
}

if ($path === RA_PATH) {
    vueport_handle_ra_proxy();
    return;
}
if ($path === PVB_PREFIX || strpos($path, PVB_PREFIX . '/') === 0) {
    vueport_handle_pvb_proxy($path);
    return;
}
if ($path === GAMEPAD_PROFILES_PATH || strpos($path, GAMEPAD_PROFILES_PATH . '/') === 0) {
    vueport_handle_gamepad_profiles($path);
    return;
}
if ($path === LAN_SHARES_PATH || strpos($path, LAN_SHARES_PATH . '/') === 0) {
    vueport_handle_lan_shares($path);
    return;
}

http_response_code(404);
header('Content-Type: text/plain');
echo 'Not found.';
