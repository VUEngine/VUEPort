// vueport-server, the relay for what a page cannot reach on its own, used by every host. It lives on its own domain, so
// every call is cross-origin: packages/server/src/cors.php's VUEPORT_ALLOWED_ORIGINS must name this build's origin

const PROXY_BASE = 'https://api.vueport.net';

// default for Planet VB lookups; the APIs pane can point either catalog call elsewhere (web-api-bases.ts)
export const PVB_PROXY_BASE = `${PROXY_BASE}/pvb/`;

export const RA_PROXY_URL = `${PROXY_BASE}/ra`;

export const GAMEPAD_PROFILES_URL = `${PROXY_BASE}/gamepad-profiles`; // see web-gamepad-share.ts
