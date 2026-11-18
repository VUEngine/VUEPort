<?php

declare(strict_types=1);

// checks the SSRF-relevant logic without server or network: odd paths stay on Planet VB, and the
// RetroAchievements host allowlist is exactly as narrow as it should be
// usage: php tests/proxy-logic-test.php

require_once __DIR__ . '/../src/pvb_proxy.php';
require_once __DIR__ . '/../src/ra_proxy.php';
require_once __DIR__ . '/../src/config.php';
require_once __DIR__ . '/../src/gamepad_profiles.php';
require_once __DIR__ . '/../src/lan_shares.php';

$failures = 0;

function check(string $label, $actual, $expected): void
{
    global $failures;
    if ($actual !== $expected) {
        $failures++;
        printf("  FAIL %s: got %s, expected %s\n", $label, var_export($actual, true), var_export($expected, true));
    }
}

function section(string $name): void
{
    echo "\n$name\n";
}

section('Planet VB target URL');
check('a plain CRC32 path', vueport_pvb_target_url('/pvb/82a95e51/', ''),
    'https://www.virtual-boy.com/api/rom/82a95e51/');
check('the query string survives', vueport_pvb_target_url('/pvb/', 'featured'),
    'https://www.virtual-boy.com/api/rom/?featured');
// title lookups hold spaces, brackets and accents; the path is handed on exactly as encoded, as decoding and
// re-appending it would break every name with a space
check('an encoded title path is handed on untouched',
    vueport_pvb_target_url('/pvb/title/Jack%20Bros./', ''),
    'https://www.virtual-boy.com/api/rom/title/Jack%20Bros./');
check('the bare prefix, no trailing slash, still lands under the upstream path',
    vueport_pvb_target_url('/pvb', ''), 'https://www.virtual-boy.com/api/rom/');
// the upstream prefix sits between the fixed origin and the rest, so a // in the path cannot start a second host
check('an odd path with a leading // still resolves against Planet VB, not elsewhere',
    vueport_pvb_target_url('/pvb//evil.example/x', ''),
    'https://www.virtual-boy.com/api/rom//evil.example/x');

section('RetroAchievements host allowlist');
check('the bare host is allowed', vueport_ra_allowed_host('retroachievements.org'), true);
check('a subdomain is allowed', vueport_ra_allowed_host('media.retroachievements.org'), true);
check('a lookalike suffix is not', vueport_ra_allowed_host('retroachievements.org.evil.example'), false);
check('a host that merely contains the name is not', vueport_ra_allowed_host('notretroachievements.org'), false);
check('an unrelated host is refused', vueport_ra_allowed_host('example.com'), false);

section('Game pad profile submissions');
$profile = [
    'format' => 'vueport-gamepad-profile',
    'version' => 1,
    'id' => '8bitdo-64-bt-chromium-macos',
    'name' => '8BitDo 64 BT',
    'family' => 'generic',
    'match' => ['device' => '2dc8:3019', 'name' => '8BitDo 64 BT', 'mapping' => '', 'engine' => 'chromium',
        'platform' => 'macos', 'buttons' => 18, 'axes' => 10],
    'deadZone' => 0.5,
    'buttons' => [
        'a' => [['kind' => 'button', 'index' => 0]],
        'lLeft' => [['kind' => 'hat', 'index' => 9, 'direction' => 'left'], ['kind' => 'axis', 'index' => 0, 'direction' => -1]],
    ],
    'turbo' => [
        'b' => [['kind' => 'button', 'index' => 1]],
    ],
    'actions' => [
        'commandPalette' => [['kind' => 'button', 'index' => 12]],
        'rewind' => [['kind' => 'button', 'index' => 2]],
        'macro3' => [['kind' => 'button', 'index' => 5]],
    ],
];
$clean = vueport_gamepad_clean_submission(['profile' => $profile, 'note' => '  mode D, Bluetooth ']);
check('a well-formed profile passes', is_array($clean), true);
check('as it came', $clean['profile'] ?? null, $profile);
check('its note trimmed', $clean['note'] ?? null, 'mode D, Bluetooth');
check('the same profile gets the same file name',
    vueport_gamepad_submission_name($clean),
    vueport_gamepad_submission_name(vueport_gamepad_clean_submission(['profile' => $profile])));

$extra = $profile;
$extra['tracking'] = 'x';
$extra['match']['secret'] = 'y';
$extra['buttons']['a'][0]['payload'] = 'z';
check('unknown fields are dropped, not stored',
    vueport_gamepad_clean_submission(['profile' => $extra])['profile'] ?? null, $profile);

$refused = function (string $label, array $change) use ($profile): void {
    $bad = array_replace_recursive($profile, $change);
    check($label, is_string(vueport_gamepad_clean_submission(['profile' => $bad])), true);
};
$refused('another format is refused', ['format' => 'something-else']);
$refused('an id that could name a path is refused', ['id' => '../../etc/passwd']);
$refused('an unknown family is refused', ['family' => 'sega']);
$refused('a dead zone out of range is refused', ['deadZone' => 5]);
$refused('an unknown button is refused', ['buttons' => ['turbo' => [['kind' => 'button', 'index' => 1]]]]);
$refused('an unknown turbo button is refused', ['turbo' => ['fire' => [['kind' => 'button', 'index' => 1]]]]);
$refused('a turbo source that is not one is refused', ['turbo' => ['a' => [['kind' => 'wheel', 'index' => 1]]]]);
$refused('turbo that is not a map is refused', ['turbo' => 'fast']);
$refused('a macro slot past the eighth is refused', ['actions' => ['macro9' => [['kind' => 'button', 'index' => 3]]]]);
$refused('a source of an unknown kind is refused', ['buttons' => ['a' => [['kind' => 'wheel', 'index' => 1]]]]);
$refused('an axis direction other than ±1 is refused', ['buttons' => ['a' => [['kind' => 'axis', 'index' => 1, 'direction' => 2]]]]);
$refused('a hat direction that is not one is refused', ['buttons' => ['a' => [['kind' => 'hat', 'index' => 9, 'direction' => 'north']]]]);
$refused('an unknown engine is refused', ['match' => ['engine' => 'trident']]);
$refused('an action nobody knows is refused', ['actions' => ['selfDestruct' => [['kind' => 'button', 'index' => 3]]]]);
$refused('a malformed device id is refused', ['match' => ['device' => '2dc8-3019']]);
$noTurbo = $profile;
unset($noTurbo['turbo']);
check('a profile without turbo passes, and gains none',
    vueport_gamepad_clean_submission(['profile' => $noTurbo])['profile'] ?? null, $noTurbo);
$noDevice = $profile;
$noDevice['match'] = ['mapping' => ''];
check('a profile matching no device is refused',
    is_string(vueport_gamepad_clean_submission(['profile' => $noDevice])), true);
$empty = $profile;
$empty['buttons'] = [];
check('a profile with nothing mapped is refused',
    is_string(vueport_gamepad_clean_submission(['profile' => $empty])), true);
check('a long note is refused',
    is_string(vueport_gamepad_clean_submission(['profile' => $profile, 'note' => str_repeat('x', 501)])), true);
check('a note that is not UTF-8 is refused',
    is_string(vueport_gamepad_clean_submission(['profile' => $profile, 'note' => "\xff\xfe"])), true);
check('a body that is not a submission is refused', is_string(vueport_gamepad_clean_submission('hello')), true);

section('LAN shares');
check('an IPv4 caller is its own network', vueport_lan_network('85.214.133.93'), '85.214.133.93');
check('an IPv4 caller seen through IPv6 is still that address', vueport_lan_network('::ffff:85.214.133.93'),
    '85.214.133.93');
check('two IPv6 devices of one /64 share a network', vueport_lan_network('2001:db8:1:2::aa')
    === vueport_lan_network('2001:db8:1:2:ffff::1'), true);
check('another /64 is another network', vueport_lan_network('2001:db8:1:2::aa')
    === vueport_lan_network('2001:db8:1:3::aa'), false);
check('something that is no address is no network', vueport_lan_network('localhost'), null);

check('192.168/16 is private', vueport_lan_private_address('192.168.1.17:47913'), true);
check('10/8 is private', vueport_lan_private_address('10.0.0.2:80'), true);
check('172.16/12 is private', vueport_lan_private_address('172.31.255.1:1'), true);
check('172.32 is not', vueport_lan_private_address('172.32.0.1:80'), false);
check('a public address is refused', vueport_lan_private_address('85.214.133.93:80'), false);
check('loopback is refused', vueport_lan_private_address('127.0.0.1:80'), false);
check('an address without a port is refused', vueport_lan_private_address('192.168.1.17'), false);
check('port 0 is refused', vueport_lan_private_address('192.168.1.17:0'), false);
check('an octet over 255 is refused', vueport_lan_private_address('192.168.1.256:80'), false);
check('a leading zero is refused, as some parsers read it as octal', vueport_lan_private_address('192.168.01.1:80'),
    false);
check('a hostname is refused', vueport_lan_private_address('evil.example:80'), false);

$share = [
    'id' => str_repeat('a', 16), 'secret' => str_repeat('b', 32), 'token' => str_repeat('c', 16),
    'device' => 'Mac mini', 'title' => 'Wario Land', 'name' => 'Wario Land (Japan, USA).vb',
    'addresses' => ['192.168.1.17:47913', '192.168.1.17:47913', '10.0.0.4:47913'], 'state' => true,
    'romId' => '133e9372', 'extra' => 'dropped',
];
$clean = vueport_lan_clean_share($share);
check('a good share passes', is_array($clean), true);
check('unknown fields are dropped', isset($clean['extra']), false);
check('repeated addresses are kept once', $clean['addresses'], ['192.168.1.17:47913', '10.0.0.4:47913']);
check('a share pointing at the internet is refused',
    is_string(vueport_lan_clean_share(['addresses' => ['8.8.8.8:80']] + $share)), true);
check('a short secret is refused', is_string(vueport_lan_clean_share(['secret' => 'abc'] + $share)), true);
check('a title with a control character is refused',
    is_string(vueport_lan_clean_share(['title' => "Wario\nLand"] + $share)), true);
check('state must be a boolean', is_string(vueport_lan_clean_share(['state' => 'yes'] + $share)), true);
check('the CRC32 is optional', is_array(vueport_lan_clean_share(array_diff_key($share, ['romId' => 0]))), true);
check('nine addresses are too many', is_string(vueport_lan_clean_share(['addresses' => array_map(
    function (int $n): string { return "192.168.1.$n:80"; }, range(1, 9))] + $share)), true);
check('the secret never reaches a page', isset(vueport_lan_public_share(['secretHash' => 'x', 'id' => 'y'])['secretHash']),
    false);

echo $failures === 0 ? "\nAll checks passed.\n" : "\n$failures check(s) failed.\n";
exit($failures === 0 ? 0 : 1);
