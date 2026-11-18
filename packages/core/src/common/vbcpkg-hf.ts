// @ts-nocheck
/* eslint-disable */
// Generated from VB Patches/_tools/vbcpkg/hf.mjs by sync-vueport.mjs: change it there, not here.
/**
 * Hyper Fighting VB Color (layout "hf"): paints the shipped engine's (dev83) own tables in place. vbcpkg.mjs hands
 * compile, shownPixels and cellShown of a package with pkg.layout === 'hf' here; the module has no imports (its helpers
 * come from vbcpkg.mjs), so it runs in a browser and as VUEPort's TypeScript copy unchanged. Package format: README.md,
 * "Layout hf".
 *
 * The engine colours the fighters per frame: drawFighter loads a pose's tiles into Characters 2.. (player 2: 0x102..)
 * and the engine colours the BG Map 4 cells of the fighter's two layers from a table per fighter (FighterEnt). A
 * fighter shows at most 16 combos and 16 single colours, each a pair (player 1 / player 2 in a mirror match).
 *
 * Without paint the ROM is the runtime byte for byte. A painted tile gets the combo that shows most of its pixels and
 * exception pixels for the rest, in the fighter's single colours; a new colour takes a free one (at most 16 per fighter
 * in use), else the nearest is shown and counted as 'pixels short of a colour'. A painted fill cell takes the single
 * colour of its paint. Paint on player 1's table gives player 2's mirror-match colour by the fighter's rule (an
 * existing colour keeps its twin, a new one follows alt_rules), unless player 2's table is painted too.
 */

function reader(rom) {
    const m = rom.length - 1;
    const u8 = a => rom[a & m];
    const u16 = a => rom[a & m] | rom[(a + 1) & m] << 8;
    const u32 = a => (rom[a & m] | rom[(a + 1) & m] << 8 | rom[(a + 2) & m] << 16 | rom[(a + 3) & m] << 24) >>> 0;
    const w16 = (a, v) => { rom[a & m] = v & 255; rom[(a + 1) & m] = (v >> 8) & 255; };
    const w32 = (a, v) => { for (let k = 0; k < 4; k++) rom[(a + k) & m] = (v >>> (8 * k)) & 255; };
    return { u8, u16, u32, w16, w32 };
}
const hexOf = w => '#' + [w & 255, (w >> 8) & 255, (w >> 16) & 255].map(x => x.toString(16).padStart(2, '0')).join('');
const wordOf = h => parseInt(h.slice(1, 3), 16) | parseInt(h.slice(3, 5), 16) << 8 | parseInt(h.slice(5, 7), 16) << 16;
const val = (t, i) => (((t[(i >> 3) * 2] | t[(i >> 3) * 2 + 1] << 8) >> ((i & 7) * 2)) & 3);
const shadeOf = (plt, v) => (plt >> (2 * v)) & 3;
const FIELDS = ['bank', 'ntiles', 'mat', 'pal', 'palalt', 'tinfo', 'exc', 'ncombo', 'cpal', 'cpalalt', 'nsingle', 'spal',
    'spalalt', 'nframes', 'solid', 'soliddef'];
const GPLT = [0xE4, 0x90, 0xE0, 0xD0];               // GPLT0-3 in a fight; a combo's palette g is laid out for GPLT g

// a fighter's FighterEnt: 16 u32 fields (FIELDS), 64 bytes per fighter after the 8-byte tables header
function entry(R, H, k) {
    const at = H.tables + 8 + 64 * k, e = { at };
    FIELDS.forEach((f, i) => { e[f] = R.u32(at + 4 * i); });
    return e;
}
// exception record: row mask, a pixel mask per marked row, then color nibbles low first (nibble n = single color n);
// returns pixel -> nibble, -1 cut out
function decodeExc(R, a) {
    const out = new Map();
    // dev83: a record starting with 0 lists the cut-out pixels first, the same way
    if (R.u8(a) === 0) {
        const rc = R.u8(a + 1); a += 2;
        for (let y = 0; y < 8; y++) if (rc >> y & 1) { const m = R.u8(a++); for (let x = 0; x < 8; x++) if (m >> x & 1) out.set(y * 8 + x, -1); }
    }
    const rows = R.u8(a); let o = a + 1; const px = [];
    for (let y = 0; y < 8; y++) if (rows >> y & 1) { const m = R.u8(o++); for (let x = 0; x < 8; x++) if (m >> x & 1) px.push(y * 8 + x); }
    px.forEach((i, j) => out.set(i, (R.u8(o + (j >> 1)) >> (4 * (j & 1))) & 15));
    return out;
}
function encodeExc(m) {
    const rows = new Map(), cut = new Map();
    for (const [i, c] of [...m].sort((a, b) => a[0] - b[0])) {
        const y = i >> 3;
        if (c < 0) { cut.set(y, (cut.get(y) || 0) | 1 << (i & 7)); continue; }
        if (!rows.has(y)) rows.set(y, []); rows.get(y).push([i & 7, c]);
    }
    const head = [];
    if (cut.size) { let rc = 0; const ms = []; for (let y = 0; y < 8; y++) if (cut.has(y)) { rc |= 1 << y; ms.push(cut.get(y)); } head.push(0, rc, ...ms); }
    let R = 0; const masks = [], cols = [];
    for (let y = 0; y < 8; y++) if (rows.has(y)) { R |= 1 << y; let mk = 0; for (const [x, c] of rows.get(y)) { mk |= 1 << x; cols.push(c); } masks.push(mk); }
    const nib = new Array((cols.length + 1) >> 1).fill(0);
    cols.forEach((c, k) => { nib[k >> 1] |= c << (4 * (k & 1)); });
    return [...head, R, ...masks, ...nib];
}
function fighterView(R, H, k, original) {
    const e = entry(R, H, k);
    // the *alt tables hold player 2's colors in a mirror match
    const single = (alt, n) => hexOf(R.u32((alt ? e.spalalt : e.spal) + 4 * n));
    // cpal[combo * 16 + selector * 4 + shade]
    const combo = (alt, j, v) => hexOf(R.u32((alt ? e.cpalalt : e.cpal) + 4 * (j * 16 + v)));
    const om = original.length - 1;
    const tile = t => original.subarray((e.bank + 16 * t) & om, ((e.bank + 16 * t) & om) + 16);
    // tinfo[t] = combo | (exception record offset + 1) << 5, offset 0 meaning no exception pixels
    const pixels = t => {
        const inf = R.u32(e.tinfo + 4 * t), j = inf & 31, x = inf >>> 5;
        const ex = x ? decodeExc(R, e.exc + x - 1) : null;
        return { j, ex };
    };
    const colours = (t, alt) => {
        const tl = tile(t), { j, ex } = pixels(t), out = new Array(64);
        for (let i = 0; i < 64; i++) {
            const v = val(tl, i); if (!v) { out[i] = null; continue; }
            const n = ex && ex.get(i);
            out[i] = n === -1 ? '' : n !== undefined && n !== null ? single(alt, n) : combo(alt, j, v);
        }
        return out;
    };
    return { e, single, combo, tile, pixels, colours };
}
// a pose's solid fill cells (Character 1): u16 n, then n x u16 cy << 10 | cx << 5 | layer << 4 | single color;
// cells not listed take soliddef
function soloList(R, e, f) {
    const m = new Map(); if (f >= e.nframes) return m;
    const a = R.u32(e.solid + 4 * f); if (!a) return m;
    for (let i = 0, n = R.u16(a); i < n; i++) { const x = R.u16(a + 2 + 2 * i); m.set(x & 0x7FF0, x & 0x800F); }   // bit 15: cut out (dev83)
    return m;
}
const fillQ = n => { const y = n >> 6, xx = n & 63; return y << 10 | (xx & 31) << 5 | (xx >= 32 ? 16 : 0); };
const fillList = name => { const m = /^fill(a?):(\d+):(\d+)$/.exec(name); return m && { alt: !!m[1], k: +m[2], f: +m[3] }; };

function tablesOf(pkg) {
    const byTable = new Map();
    for (const F of pkg.hf.fighters) { byTable.set(F.table, { F, alt: false }); if (F.alt) byTable.set(F.alt, { F, alt: true }); }
    return byTable;
}

// hit sparks: world 13's 4x4 sparks, colored by the projpal ramp of the fighter nearest to the spark
function sparkTable(H, name) {
    const S = H.sparks; if (!S || !name) return null;
    const k = S.tables.indexOf(name);
    return k < 0 ? null : { k, at: S.at, ntiles: S.ntiles };
}
// sparks show nothing but their fighter's projpal ramp, so the color painted most at each shade becomes the ramp
function paintSparks(R, H, original, spWork, put, inc) {
    const pa = H.tables + 8 + 16 * 64 + 16, pp = R.u32(pa), om = original.length - 1;
    const words = []; for (let i = 0; i < 64; i++) words.push(R.u32(pp + 4 * i));
    let changed = false;
    for (const [k, list] of [...spWork].sort((a, b) => a[0] - b[0])) {
        const want = [new Map(), new Map(), new Map(), new Map()];
        for (const { t, ways } of list) {
            if (!(t >= 0 && t < H.sparks.ntiles)) continue;
            const o = (H.sparks.at + 16 * t) & om, tl = original.subarray(o, o + 16);
            for (const [way, px] of Object.entries(ways)) {
                const plt = parseInt(way.split('/')[2] || 'e4', 16);
                px.forEach((c, i) => { const v = val(tl, i); if (v && c === '') inc('erased pixels not supported (hit sparks)'); if (v && c) { const sh = shadeOf(plt, v); want[sh].set(c, (want[sh].get(c) || 0) + 1); } });
            }
        }
        want.forEach((m, sh) => {
            if (!m.size) return;
            const [c] = [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
            let short = 0; for (const [x, n] of m) if (x !== c) short += n;
            if (short) inc('pixels short of a colour', short);
            if (hexOf(words[k * 4 + sh]) !== c) { words[k * 4 + sh] = wordOf(c); changed = true; }
        });
    }
    if (changed) { const b = []; for (const w of words) push32b(b, w); R.w32(pa, put(b)); inc('hit spark ramps changed'); }
}

// fireballs (dev84): player p's projectile, colored by a 4-color ramp per fighter and player in Tables.fbpal (12 words
// per fighter: player 1's rows 0-1, rows 2-3, then player 2's)
function fireballTable(H, name) {
    const F = H.fireballs; if (!F || !name) return null;
    const T = F.tables.find(x => x.name === name);
    return T ? { k: T.k, p: T.p, at: T.at, end: T.end, lower: new Set(T.lower || []) } : null;
}
const fireballRamp = (R, H, FB, t) => H.fireballs.at + 4 * (12 * FB.k + (FB.p ? 8 : FB.lower.has(t) ? 4 : 0));
function paintFireballs(R, H, original, fbWork, inc) {
    const om = original.length - 1;
    for (const [, list] of [...fbWork].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const want = [new Map(), new Map(), new Map(), new Map()], FB = list[0].FB;
        for (const { t, ways } of list) {
            const o = (FB.at + 16 * t) & om; if (!(FB.at + 16 * t < FB.end)) continue;
            const tl = original.subarray(o, o + 16);
            for (const [way, px] of Object.entries(ways)) {
                const plt = parseInt(way.split('/')[2] || 'e4', 16);
                px.forEach((c, i) => { const v = val(tl, i); if (v && c === '') inc('erased pixels not supported (fireballs)'); if (v && c) { const sh = shadeOf(plt, v); want[sh].set(c, (want[sh].get(c) || 0) + 1); } });
            }
        }
        const ramps = FB.p ? [8] : [0, 4];
        want.forEach((m, sh) => {
            if (!m.size) return;
            const [c] = [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
            let short = 0; for (const [x, n] of m) if (x !== c) short += n;
            if (short) inc('pixels short of a colour', short);
            for (const r of ramps) R.w32(H.fireballs.at + 4 * (12 * FB.k + r + sh), wordOf(c));
        });
        inc('fireball ramps changed');
    }
}

// what a built ROM shows: (key, way) -> 64 x [value, shade, '#rrggbb' | null]
export function hfShownPixels(pkg, original, rom) {
    const R = reader(rom), H = pkg.hf, byTable = tablesOf(pkg), views = new Map();
    const prefix = new Map(pkg.tables.map(t => [t.key.split('{')[0], t.name]));
    let firstCell = null, cells = null;
    return (key, way) => {
        const at = key.lastIndexOf(':'), T = byTable.get(prefix.get(key.slice(0, at + 1)));
        const sl = !T && /^scr(\d+)(?:o(\d+))?$/.exec(key.slice(0, at));
        if (sl) {                                                    // a screen character, as its first cell shows it
            const list = sl[2] !== undefined ? `scr:${sl[1]}+${sl[2]}` : `scr:${sl[1]}`, want = +key.slice(at + 1) + 1;
            if (!firstCell) { firstCell = new Map(); for (const [l, c, i] of pkg.cells) if (!firstCell.has(l + '#' + i)) firstCell.set(l + '#' + i, c); }
            const c = firstCell.get(list + '#' + want), tab = pkg.tables.find(x => x.name === prefix.get(key.slice(0, at + 1)));
            if (c === undefined || !tab) return null;
            const tile = Uint8Array.from(tab.bytes.slice(32 * (want - 1), 32 * want).match(/../g).map(x => parseInt(x, 16)));
            return (cells ??= hfCellShown(pkg, original, rom))([list], c, way, tile);
        }
        if (H.effects && prefix.get(key.slice(0, at + 1)) === H.effects.table) {
            const e = entry(R, H, H.effects.k), t = +key.slice(at + 1); if (!(t >= 0 && t < e.ntiles)) return null;
            const m = R.u8(e.mat + t), plt = parseInt(way.split('/')[2] || 'e4', 16), om = original.length - 1, o = (e.bank + 16 * t) & om;
            const tl = original.subarray(o, o + 16), cut = matCut(R, e, t);
            return Array.from({ length: 64 }, (_, i) => { const v = val(tl, i), sh = shadeOf(plt, v); return v ? [v, sh, cut.has(i) ? '' : hexOf(R.u32(e.pal + 4 * (m * 4 + sh)))] : [0, 0, null]; });
        }
        const FB = fireballTable(H, prefix.get(key.slice(0, at + 1)));
        if (FB) {
            const t = +key.slice(at + 1); if (!(t >= 0 && FB.at + 16 * t < FB.end)) return null;
            const ra = fireballRamp(R, H, FB, t), plt = parseInt(way.split('/')[2] || 'e4', 16), om = original.length - 1, o = (FB.at + 16 * t) & om;
            const tl = original.subarray(o, o + 16);
            return Array.from({ length: 64 }, (_, i) => { const v = val(tl, i), sh = shadeOf(plt, v); return v ? [v, sh, hexOf(R.u32(ra + 4 * sh))] : [0, 0, null]; });
        }
        const SP = sparkTable(H, prefix.get(key.slice(0, at + 1)));
        if (SP) {
            const t = +key.slice(at + 1); if (!(t >= 0 && t < SP.ntiles)) return null;
            const pp = R.u32(H.tables + 8 + 16 * 64 + 16), plt = parseInt(way.split('/')[2] || 'e4', 16), om = original.length - 1, o = (SP.at + 16 * t) & om;
            const tl = original.subarray(o, o + 16);
            return Array.from({ length: 64 }, (_, i) => { const v = val(tl, i), sh = shadeOf(plt, v); return v ? [v, sh, hexOf(R.u32(pp + 4 * (SP.k * 4 + sh)))] : [0, 0, null]; });
        }
        if (!T || at < 0) return null;
        const t = +key.slice(at + 1);
        let V = views.get(T.F.k); if (!V) views.set(T.F.k, V = fighterView(R, H, T.F.k, original));
        if (!(t >= 0 && t < V.e.ntiles)) return null;
        const plt = parseInt(way.split('/')[2] || 'e4', 16), tl = V.tile(t), cols = V.colours(t, T.alt);
        return cols.map((c, i) => { const v = val(tl, i); return v ? [v, shadeOf(plt, v), c] : [0, 0, null]; });
    };
}

// (lists, cell, way, tile) -> 64 x [value, shade, color], undefined for a cell none of `lists` names
export function hfCellShown(pkg, original, rom) {
    const R = reader(rom), H = pkg.hf, vcus = new Map();
    return (lists, cell, way, tile) => {
        const plt = parseInt(way.split('/')[2] || 'e4', 16), sel = +(way.split('/')[1] || 0);
        for (let k = lists.length - 1; k >= 0; k--) {
            const L = fillList(lists[k]);
            if (L) {
                const e = entry(R, H, L.k), sl = soloList(R, e, L.f), n = sl.get(fillQ(cell)) ?? e.soliddef;
                const c = n & 0x8000 ? '' : hexOf(R.u32((L.alt ? e.spalalt : e.spal) + 4 * n));
                const px = [];
                for (let i = 0; i < 64; i++) { const v = val(tile, i); px.push(v ? [v, shadeOf(plt, v), c] : [0, 0, null]); }
                return px;
            }
            const S = screenList(lists[k]);
            if (S === null) continue;
            let V = vcus.get(lists[k]); if (!V) vcus.set(lists[k], V = screenVcu(R, H, S));
            return cellPixels(V, cell, sel, plt, tile);
        }
        return undefined;
    };
}

// ---- screens (ScreenEnt, engine.h): what apply_screen writes over the boot Color RAM (defpal in selectors 0-31)
const SFIELDS = ['nsig', 'sig', 'nblk', 'blk', 'selfirst', 'selcount', 'pal', 'flags', 'nsweep', 'sweep', 'cbk', 'sb',
    'nxpal', 'xpal', 'ncellpix', 'cellpix', 'nslots', 'slots', 'sky'];
// list 'scr:<k>' holds screen k's cells, 'scr:<base>+<k>' those of overlay screen k over its base screen
const screenList = name => { const m = /^scr:(\d+)(?:\+(\d+))?$/.exec(name); return m ? { k: m[2] !== undefined ? +m[2] : +m[1], base: m[2] !== undefined ? +m[1] : null } : null; };
function screenEnt(R, H, k) {
    const T = H.tables + 8 + 16 * 64, scr = R.u32(T + 8), e = { k, at: scr + 76 * k };
    SFIELDS.forEach((f, i) => { e[f] = R.u32(e.at + 4 * i); });
    return e;
}
// VIP color state after the boot and apply_screen of the base screen and screen S.k (pixel attribute: slot | 0x4000 OPQ)
function screenVcu(R, H, S) {
    const T = H.tables + 8 + 16 * 64, defpal = R.u32(T), hud = R.u32(T + 12);
    const V = { cram: new Uint32Array(1024), cca: new Uint8Array(65536), pix: new Map(), slots: new Map(), ents: [], written: new Set() };
    const sel = (s, a, boot) => { for (let g = 0; g < 4; g++) { if (!boot) V.written.add(s * 4 + g); for (let x = 0; x < 4; x++) V.cram[(s * 4 + g) * 4 + x] = R.u32(a + 4 * x); } };
    for (let s = 0; s < 32; s++) sel(s, defpal + 16 * s, true);
    for (const k of S.base !== null ? [S.base, S.k] : [S.k]) {
        const e = screenEnt(R, H, k); V.ents.push(e);
        for (let i = 0; i < e.nblk; i++) {
            const off = R.u32(e.blk + 12 * i), len = R.u32(e.blk + 12 * i + 4), d = R.u32(e.blk + 12 * i + 8);
            for (let j = 0; j < len; j++) V.cca[off + j] = R.u8(d + j);
        }
        for (let i = 0; i < e.selcount; i++) sel(e.selfirst + i, e.pal + 16 * i);
        for (let i = 0; i < e.nxpal; i++) { const x = e.xpal + 20 * i, p = R.u32(x); V.written.add(p); for (let s = 0; s < 4; s++) V.cram[p * 4 + s] = R.u32(x + 4 + 4 * s); }
        if (e.ncellpix) {
            const base = e.sb ? e.sb - 1 : 544;
            if (e.nslots & 0x80000000) {
                const pb = (e.nslots >>> 16) & 0xFF, n = (e.nslots & 0xFFFF) * 32;
                for (let i = 0; i < n; i++) {
                    const v = R.u8(e.slots + i), s = base + (i >> 5);
                    let img = V.slots.get(s); if (!img) V.slots.set(s, img = new Uint8Array(64));
                    for (const [q, nib] of [[2 * (i & 31), v & 15], [2 * (i & 31) + 1, v >> 4]]) img[q] = nib === 15 ? 0xFF : nib ? pb + nib - 1 : 0;
                }
            } else for (let s = 0; s < e.nslots; s++) { const img = new Uint8Array(64); for (let q = 0; q < 64; q++) img[q] = R.u8(e.slots + 64 * s + q); V.slots.set(base + s, img); }
            for (let i = 0; i < e.ncellpix; i++) { const v = R.u32(e.cellpix + 4 * i); V.pix.set(v & 0xFFFF, v >>> 16); }
        }
        if (e.flags & 1) for (let i = 0; i < 6; i++) sel(14 + i, hud + 16 * i);
    }
    return V;
}
function cellPixels(V, cell, sel, plt, tile) {
    const g = V.cca[cell] & 0x3F, pa = V.pix.get(cell), img = pa !== undefined ? V.slots.get(pa & 0x3FF) : null, opq = pa !== undefined && !!(pa & 0x4000);
    const px = [];
    for (let i = 0; i < 64; i++) {
        const v = val(tile, i), sh = shadeOf(plt, v), b = img ? img[i] : 0;
        if (b === 0xFF) { px.push([v, sh, v ? '' : null]); continue; }      // cut out by the eraser
        if (!v && !opq) { px.push([v, sh, null]); continue; }              // OPQ draws value 0 too; slot byte 0 means the group's palette
        px.push([v, sh, hexOf(V.cram[(b || g * 4 + sel) * 4 + sh])]);
    }
    return px;
}
export const hfScreenVcu = (rom, H, list) => { const S = screenList(list); return S && screenVcu(reader(rom), H, S); };
export function hfBackdropRows(rom, H, k) {
    const R = reader(rom), e = screenEnt(R, H, k);
    if (e.sky) return Array.from({ length: 224 }, (_, y) => hexOf(R.u32(e.sky + 4 * y)));
    const V = screenVcu(R, H, { k, base: null }), c = hexOf(V.cram[(e.cbk === 0xFFFFFFFF ? 0 : e.cbk & 0xFF) * 4]);
    return new Array(224).fill(c);
}

// ---- player 2's mirror-match color for a new color, by the fighter's alt_rules (dev70's mkrom.alt_colour)
function rgb2hsv(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), v = mx;
    if (mn === mx) return [0, 0, v];
    const s = (mx - mn) / mx, rc = (mx - r) / (mx - mn), gc = (mx - g) / (mx - mn), bc = (mx - b) / (mx - mn);
    let h = r === mx ? bc - gc : g === mx ? 2 + rc - bc : 4 + gc - rc;
    h = ((h / 6) % 1 + 1) % 1;
    return [h, s, v];
}
function hsv2rgb(h, s, v) {
    if (s === 0) return [v, v, v];
    let i = Math.floor(h * 6); const f = h * 6 - i, p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
    i %= 6;
    return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i];
}
function altColour(rules, hex) {
    const c = [1, 3, 5].map(k => parseInt(hex.slice(k, k + 2), 16) / 255);
    const [h, s, v] = rgb2hsv(...c);
    const out = rgb => '#' + rgb.map(x => Math.trunc(x * 255).toString(16).padStart(2, '0')).join('');
    for (const [[lo, hi], smin, vmin, act, value] of rules || []) {
        if (act === 'tint') { if (s < 0.18 && v >= vmin) return out(hsv2rgb(value, 0.28, v)); continue; }
        if (lo <= h && h < hi && s >= smin && v >= vmin) {
            if (act === 'hue') return out(hsv2rgb(value, s, v));
            if (act === 'desat') return out(hsv2rgb(h, s * 0.12, Math.min(1, v * 1.1)));
        }
    }
    return hex;
}
const dist = (a, b) => { let d = 0; for (const k of [1, 3, 5]) { const x = parseInt(a.slice(k, k + 2), 16) - parseInt(b.slice(k, k + 2), 16); d += x * x; } return d; };

// the shared effect poses (dev70's material path: each tile shows one of 6 materials, a 4-color ramp by shade); a
// painted tile takes the material whose ramp shows its paint, else one no unpainted tile uses, given that ramp
function paintEffects(R, H, original, fxWork, put, inc) {
    const e = entry(R, H, H.effects.k), om = original.length - 1;
    const ramps = []; for (let m = 0; m < 6; m++) ramps.push([0, 1, 2, 3].map(sh => hexOf(R.u32(e.pal + 4 * (m * 4 + sh)))));
    const use = new Array(6).fill(0); for (let t = 0; t < e.ntiles; t++) if (!fxWork.has(t)) use[R.u8(e.mat + t)]++;
    let changed = false; const cuts = new Map();
    for (const [t, ways] of [...fxWork].sort((a, b) => a[0] - b[0])) {
        if (!(t < e.ntiles)) continue;
        const o = (e.bank + 16 * t) & om, tl = original.subarray(o, o + 16), cur = R.u8(e.mat + t), want = new Map();
        for (const [way, px] of Object.entries(ways)) {
            const plt = parseInt(way.split('/')[2] || 'e4', 16);
            px.forEach((c, i) => { const v = val(tl, i); if (v && c) { const sh = shadeOf(plt, v); if (!want.has(sh)) want.set(sh, new Map()); want.get(sh).set(c, (want.get(sh).get(c) || 0) + 1); } });
        }
        const cut = new Set(); for (const px of Object.values(ways)) px.forEach((c, i) => { if (c === '' && val(tl, i)) cut.add(i); });
        const had = matCut(R, e, t); if (cut.size || had.size) cuts.set(t, cut);
        const ramp = new Map([...want].map(([sh, m]) => [sh, [...m].sort((a, b) => b[1] - a[1])[0][0]]));
        const fits = m => [...ramp].every(([sh, c]) => ramps[m][sh] === c);
        let m = fits(cur) ? cur : [0, 1, 2, 3, 4, 5].find(fits);
        if (m === undefined) {
            m = [0, 1, 2, 3, 4, 5].find(q => !use[q]);
            if (m === undefined) { inc('pixels short of a colour', [...want.values()].reduce((n, x) => n + [...x.values()].reduce((a, b) => a + b, 0), 0)); m = cur; }
            else { ramps[m] = ramps[cur].map((c, sh) => ramp.get(sh) ?? c); changed = true; inc('effect materials changed'); }
        }
        use[m]++;
        if (m !== cur) R.w32(e.mat + t, (R.u32(e.mat + t) & ~0xFF) | m);
    }
    if (changed) { const b = []; for (const r of ramps) for (const c of r) push32b(b, wordOf(c)); R.w32(e.at + 12, put(b)); }
    if (cuts.size) {                     // dev83: the eraser's cut-outs, a record per tile in a new exc array
        const arr = []; for (let t = 0; t < e.ntiles; t++) arr.push(e.exc ? R.u32(e.exc + 4 * t) : 0);
        for (const [t, cut] of cuts) {
            if (!cut.size) { arr[t] = 0; continue; }
            let rc = 0; const ms = [0, 0, 0, 0, 0, 0, 0, 0];
            for (const i of cut) { rc |= 1 << (i >> 3); ms[i >> 3] |= 1 << (i & 7); }
            arr[t] = put([rc, ...ms.filter((_, y) => rc >> y & 1)], 1); inc('erased pixels', cut.size);
        }
        const b = []; for (const x of arr) push32b(b, x); R.w32(e.at + 24, put(b));
    }
}
// dev83: a material tile's cut-out pixels from its exc entry (0, or a record of row mask and pixel masks)
function matCut(R, e, t) {
    const out = new Set(); if (!e.exc) return out;
    let a = R.u32(e.exc + 4 * t); if (!a) return out;
    const rc = R.u8(a++);
    for (let y = 0; y < 8; y++) if (rc >> y & 1) { const m = R.u8(a++); for (let x = 0; x < 8; x++) if (m >> x & 1) out.add(y * 8 + x); }
    return out;
}
const push32b = (b, x) => b.push(x & 255, x >> 8 & 255, x >> 16 & 255, x >>> 24 & 255);
// each painted cell gets a slot image of its own (its old one if unshared), new colors take palettes the screen leaves
// free; slots, cell pixel attributes and palettes go into new arrays
function paintScreen(R, H, pkg, original, list, cells, put, inc0, noSlots = false) {
    // counts are committed only once the paint is written, since a screen without room is painted again without new slots
    const counts = new Map(), inc = (k, n = 1) => counts.set(k, (counts.get(k) || 0) + n);
    const commit = () => { for (const [k, n] of counts) inc0(k, n); };
    const S = screenList(list), V = screenVcu(R, H, S), e = V.ents[V.ents.length - 1];
    const tiles = new Map(), want = new Map();
    for (const [l, c, i] of pkg.cells) if (l === list) want.set(c, i);
    const tab = pkg.tables.find(t => t.key.split('{')[0] === list.replace(':', '').replace('+', 'o') + ':');
    const tileOf = i => { if (!tiles.has(i)) tiles.set(i, Uint8Array.from(tab.bytes.slice(32 * i, 32 * i + 32).match(/../g).map(x => parseInt(x, 16)))); return tiles.get(i); };
    const used = new Set(V.written);
    for (let c = 0; c < 65536; c++) { const g = V.cca[c] & 0x3F; for (let q = 0; q < 4; q++) used.add(g * 4 + q); }
    for (const img of V.slots.values()) for (const b of img) used.add(b);
    for (let p = 0; p < 128; p++) used.add(p);                        // the boot palettes (selectors 0-31)
    if (V.ents.some(x => x.flags & 1)) for (let p = 128; p < 244; p++) used.add(p);
    for (let k = 0, n = R.u32(H.tables + 8 + 16 * 64 + 4); k < n; k++) {
        const o = screenEnt(R, H, k); if (!(o.flags & 4)) continue;
        for (let i = 0; i < o.nxpal; i++) used.add(R.u32(o.xpal + 20 * i));
        const pb = (o.nslots >>> 16) & 0xFF; if (o.nslots & 0x80000000) for (let q = 0; q < 15; q++) used.add(pb + q);
    }
    used.add(255); used.add(e.cbk & 0xFF);
    const free = []; for (let p = 1; p < 255; p++) if (!used.has(p)) free.push(p);
    const xpal = [], ccaPatch = new Map();
    // packed screens (the portraits) store slot pixels as nibbles, n = single-color palette pb + n - 1
    const packed = !!(e.nslots & 0x80000000), pb = (e.nslots >>> 16) & 0xFF, nibUsed = new Set(), virt = [];
    const Img = packed ? Uint16Array : Uint8Array;
    if (packed) for (const img of V.slots.values()) for (const b of img) if (b >= pb && b < pb + 14) nibUsed.add(b);
    const paletteFor = (sh, c) => {
        if (packed) {
            // stays packed while the colors fit the 14 nibble palettes: one that shows the color, or one no pixel names
            for (let p = pb; p < pb + 14; p++) if (nibUsed.has(p) && [0, 1, 2, 3].every(q => hexOf(V.cram[p * 4 + q]) === c)) return p;
            const i = virt.indexOf(c); return 0x100 + (i < 0 ? virt.push(c) - 1 : i);   // placeholder, resolved to a nibble or palette later
        }
        for (const p of V.written) if (hexOf(V.cram[p * 4 + sh]) === c) return p;
        const x = xpal.find(([, cc]) => cc.every(y => y === c)); if (x) return x[0];
        if (!free.length) return null;
        const p = free.shift(); xpal.push([p, [c, c, c, c]]); const w = wordOf(c); for (let q = 0; q < 4; q++) V.cram[p * 4 + q] = w;
        V.written.add(p); return p;
    };
    // new slots go after the screen's range, outside the ranges of screens shown with it (base screen, overlays like VS
    // and win quote) and below 1024
    const ranges = [], ovsOf = new Set(pkg.cells.filter(([l]) => l.startsWith(`scr:${e.k}+`)).map(([l]) => +l.split('+')[1]));
    for (let k = 0, n = R.u32(H.tables + 8 + 16 * 64 + 4); k < n; k++) {
        const o = screenEnt(R, H, k); if (!o.ncellpix || k === e.k) continue;
        if (!((e.flags & 4 && (o.flags & 4 || k === S.base)) || ovsOf.has(k))) continue;
        const b = o.sb ? o.sb - 1 : 544; ranges.push([b, b + (o.nslots & 0x80000000 ? o.nslots & 0xFFFF : o.nslots)]);
    }
    const inRange = q => ranges.find(([lo, hi]) => q >= lo && q < hi);
    let base = e.sb ? e.sb - 1 : 544;
    // a screen without slots starts at the first free one from 544 (the fighters' slots end at 543)
    if (!e.ncellpix) for (let r; (r = inRange(base)); ) base = r[1];
    const own = new Map(), slots = new Map();
    for (let i = 0; i < e.ncellpix; i++) { const v = R.u32(e.cellpix + 4 * i); own.set(v & 0xFFFF, v >>> 16); }
    const n0 = e.nslots & 0x80000000 ? e.nslots & 0xFFFF : e.nslots;
    for (let q = 0; q < n0; q++) slots.set(base + q, Img.from(V.slots.get(base + q) || new Uint8Array(64)));
    const share = new Map(); for (const v of own.values()) share.set(v & 0x3FF, (share.get(v & 0x3FF) || 0) + 1);
    let next = base + n0;
    const touched = new Set();
    // slots in the range that no cell names (dev76-81 left some) go first, then new ones behind it
    const spare = []; for (let q = base; q < base + n0; q++) if (!share.has(q)) spare.push(q);
    const take = () => noSlots ? null : spare.length ? spare.shift() : (next < 1024 && !inRange(next) ? next++ : null);
    for (const [cell, P] of [...cells].sort((a, b) => a[0] - b[0])) {
        const i = want.get(cell); if (!i) { inc('painted cells not on the screen'); continue; }
        const tile = tileOf(i - 1), [, sel, pl] = P.way.split('/'), plt = parseInt(pl, 16);
        const cur = cellPixels(V, cell, +sel, plt, tile), pa = own.get(cell);
        const img = pa !== undefined && slots.get(pa & 0x3FF) ? slots.get(pa & 0x3FF).slice() : new Img(64);
        const g = V.cca[cell] & 0x3F; let short = 0;
        // painting a value-0 pixel makes the cell opaque (OPQ) and cuts out its other value-0 pixels
        const opq0 = pa !== undefined && !!(pa & 0x4000), opq = opq0 || P.px.some((c, q) => c && !val(tile, q));
        for (let q = 0; q < 64; q++) {
            const v = val(tile, q), c = P.px[q], sh = shadeOf(plt, v);
            if (c === null || c === undefined) { if (pa === undefined) img[q] = 0; if (!v && opq && !opq0) img[q] = 0xFF; continue; }
            if (c === '') { img[q] = v || opq ? 0xFF : 0; continue; }
            if (c === cur[q][2]) { if (pa === undefined) img[q] = 0; continue; }
            if (hexOf(V.cram[(g * 4 + +sel) * 4 + sh]) === c) { img[q] = 0; continue; }
            const p = paletteFor(sh, c); if (p === null) { short++; continue; }
            img[q] = p;
        }
        if (short) inc('pixels short of a colour', short);
        let slot = pa !== undefined && share.get(pa & 0x3FF) === 1 ? pa & 0x3FF : take();
        if (slot === null) {
            // no slot left (the title uses all 1024): if the cell's colors form one ramp (a color per shade), it gets a
            // palette of its own and its group switches to that palette's
            const ramp = new Map(); let one = true;
            for (let q = 0; q < 64; q++) if (P.px[q] === '' && val(tile, q)) inc('erased pixels without a slot');
            for (let q = 0; q < 64; q++) if (P.px[q] && !val(tile, q)) inc('opaque pixels without a slot');
            for (let q = 0; q < 64; q++) {
                const v = val(tile, q); if (!v) continue;
                const c = P.px[q] || cur[q][2], sh = shadeOf(plt, v);
                if (ramp.has(sh) && ramp.get(sh) !== c) one = false; ramp.set(sh, c);
            }
            const has = one && [...V.written].sort((x, y) => x - y).find(q => (q & 3) === +sel && [...ramp].every(([sh, c]) => hexOf(V.cram[q * 4 + sh]) === c));
            if (has !== undefined) { ccaPatch.set(cell, has >> 2); own.delete(cell); inc('painted cells by palette'); continue; }
            const k = one ? free.findIndex(q => (q & 3) === +sel) : -1;
            if (k < 0) { inc('painted cells without a slot'); continue; }
            const p = free.splice(k, 1)[0], cs = [0, 1, 2, 3].map(sh => ramp.get(sh) ?? hexOf(V.cram[(g * 4 + +sel) * 4 + sh]));
            xpal.push([p, cs]); cs.forEach((c, q) => { V.cram[p * 4 + q] = wordOf(c); }); V.written.add(p);
            ccaPatch.set(cell, p >> 2); own.delete(cell); inc('painted cells by palette');
            continue;
        }
        touched.add(slot); slots.set(slot, img); own.set(cell, (opq ? 0x4000 : 0) | slot);
        if (opq && !opq0) inc('cells made opaque');
    }
    // a packed screen's new colours take free nibbles (palettes no slot pixel names any more) when there are enough, so
    // the slots stay packed; else single-colour palettes (slots unpacked, 64 bytes each) while the data area has room;
    // else the nearest nibble colour, counted short, and the slots stay packed
    if (packed && virt.length) {
        const live = new Map(); for (const img of slots.values()) for (const b of img) if (b >= pb && b < pb + 14) live.set(b, (live.get(b) || 0) + 1);
        const freeNib = []; for (let p = pb; p < pb + 14; p++) if (!live.has(p)) freeNib.push(p);
        const uses = new Array(virt.length).fill(0); for (const img of slots.values()) for (const b of img) if (b >= 0x100) uses[b - 0x100]++;
        const map = new Map(), nsl0 = Math.max(0, ...[...slots.keys()].map(q => q - base + 1));
        const nib = (p, c) => { xpal.push([p, [c, c, c, c]]); const w = wordOf(c); for (let q = 0; q < 4; q++) V.cram[p * 4 + q] = w; V.written.add(p); live.set(p, 1); };
        if (virt.length <= freeNib.length) virt.forEach((c, i) => { map.set(0x100 + i, freeNib[i]); nib(freeNib[i], c); });
        else if (!noSlots && put.room() >= 64 * nsl0 + 1024 && virt.length <= free.length) virt.forEach((c, i) => { const p = free.shift(); map.set(0x100 + i, p); xpal.push([p, [c, c, c, c]]); });
        else {
            const order = virt.map((c, i) => i).sort((a, b) => uses[b] - uses[a]);
            order.slice(0, freeNib.length).forEach((i, n) => { map.set(0x100 + i, freeNib[n]); nib(freeNib[n], virt[i]); });
            for (const i of order.slice(freeNib.length)) {
                let bp = null, bd = Infinity;
                for (const p of live.keys()) { const d = dist(hexOf(V.cram[p * 4]), virt[i]); if (d < bd) { bd = d; bp = p; } }
                map.set(0x100 + i, bp); inc('pixels short of a colour', uses[i]); inc('portrait colours taken from the nearest (no data room)');
            }
        }
        for (const img of slots.values()) for (let q = 0; q < 64; q++) if (img[q] >= 0x100) img[q] = map.get(img[q]);
    }
    const nsl = Math.max(0, ...[...slots.keys()].map(q => q - base + 1));
    const sb = new Uint8Array(64 * nsl); for (const [q, img] of slots) sb.set(img, 64 * (q - base));
    const cp = []; for (const [c, v] of [...own].sort((a, b) => a[0] - b[0])) { const x = (c | v << 16) >>> 0; cp.push(x & 255, x >> 8 & 255, x >> 16 & 255, x >>> 24); }
    const xp = [];
    const push32 = x => xp.push(x & 255, x >> 8 & 255, x >> 16 & 255, x >>> 24 & 255);
    for (let i = 0; i < e.nxpal; i++) for (let q = 0; q < 5; q++) push32(R.u32(e.xpal + 20 * i + 4 * q));
    for (const [p, cs] of xpal) { push32(p); for (const c of cs) push32(wordOf(c)); }
    if (ccaPatch.size) {
        const blks = []; for (let i = 0; i < e.nblk; i++) blks.push([R.u32(e.blk + 12 * i), R.u32(e.blk + 12 * i + 4), R.u32(e.blk + 12 * i + 8)]);
        const data = new Map();
        for (const [cell, g] of ccaPatch) {
            const i = blks.findIndex(([o, n]) => cell >= o && cell < o + n);
            if (i < 0) { blks.push([cell, 1, null]); data.set(blks.length - 1, [g]); continue; }
            if (!data.has(i)) { const d = []; for (let j = 0; j < blks[i][1]; j++) d.push(R.u8(blks[i][2] + j)); data.set(i, d); }
            data.get(i)[cell - blks[i][0]] = g;
        }
        ccaPatch.blks = blks; ccaPatch.data = data;
    }
    const nibOf = b => b === 0 ? 0 : b === 0xFF ? 15 : b >= pb && b < pb + 14 ? b - pb + 1 : -1;
    const repack = packed && [...sb].every(b => nibOf(b) >= 0);
    const pk = repack ? Array.from({ length: 32 * nsl }, (_, i) => nibOf(sb[2 * i]) | nibOf(sb[2 * i + 1]) << 4) : null;
    const inPlace = (repack || !packed) && nsl <= n0 && e.slots;
    let cpInPlace = !!e.cellpix && cp.length <= 4 * e.ncellpix;
    for (let k = 0, n = R.u32(H.tables + 8 + 16 * 64 + 4); cpInPlace && k < n; k++) if (k !== e.k && screenEnt(R, H, k).cellpix === e.cellpix) cpInPlace = false;
    const need = xp.length + (cpInPlace ? 0 : cp.length) + (inPlace ? 0 : repack ? pk.length : sb.length) + (ccaPatch.size ? 4096 : 0) + 64;
    if (!noSlots && need > put.room()) return paintScreen(R, H, pkg, original, list, cells, put, inc0, true);
    // the new arrays are written first, so a screen whose paint finds no room keeps its tables as they are (counted)
    let ax, ac, as;
    try {
        ax = xpal.length ? put(xp, 4, true) : 0; ac = cpInPlace ? e.cellpix : put(cp, 4, true); as = inPlace ? 0 : put(repack ? pk : [...sb], 4, true);
        if (ccaPatch.size) {
            const { blks, data } = ccaPatch;
            for (const [i, d] of data) blks[i][2] = put(d, 4, true);
            const bd = []; for (const b of blks) for (const x of b) push32b(bd, x);
            ccaPatch.at = put(bd, 4, true);
        }
    } catch (err) {
        if (!/data area full/.test(err.message)) throw err;
        inc0('painted cells without data room', cells.size); return;
    }
    commit();
    if (noSlots) inc0('screens painted without new slots (data room)');
    if (ccaPatch.size) { R.w32(e.at + 8, ccaPatch.blks.length); R.w32(e.at + 12, ccaPatch.at); }
    if (xpal.length) { R.w32(e.at + 48, e.nxpal + xpal.length); R.w32(e.at + 52, ax); }
    if (cpInPlace) for (let i = 0; i < cp.length; i++) R.w32(ac + i, (R.u32(ac + i) & ~0xFF) | cp[i]);
    R.w32(e.at + 56, own.size); R.w32(e.at + 60, ac);
    if (inPlace && repack) {                                          // no screen shares a slot array
        for (const q of touched) for (let i = 0; i < 32; i++) { const a = e.slots + 32 * (q - base) + i, b = pk[32 * (q - base) + i]; R.w32(a, (R.u32(a) & ~0xFF) | b); }
        inc0('packed portraits kept packed');
    } else if (inPlace) {
        for (const q of touched) for (let i = 0; i < 64; i++) R.w32(e.slots + 64 * (q - base) + i, (R.u32(e.slots + 64 * (q - base) + i) & ~0xFF) | slots.get(q)[i]);
    } else if (repack) { R.w32(e.at + 64, (0x80000000 | pb << 16 | nsl) >>> 0); R.w32(e.at + 68, as); inc0('packed portraits kept packed'); }
    else { R.w32(e.at + 64, nsl); R.w32(e.at + 68, as); if (packed) inc0('packed portraits unpacked (data room)'); }
    R.w32(e.at + 44, base + 1);
    if (xpal.length) inc0('screen palettes added', xpal.length);
}

export function compileHf(pkg, original, opts, h) {
    if (original.length !== pkg.original.size || h.hex8(h.crc32(original)) !== pkg.original.crc32)
        throw new Error(`this ROM is not the package's original (${pkg.game})`);
    const rom = h.bpsApply(original, h.b64(pkg.runtime.bps));
    const R = reader(rom), H = pkg.hf, byTable = tablesOf(pkg), stats = {};
    const inc = (k, n = 1) => { stats[k] = (stats[k] || 0) + n; };
    const prefix = new Map(pkg.tables.map(t => [t.key.split('{')[0], t.name]));

    // ---- paint per fighter: tiles (t -> {n, a}, 64 colors or null per player) and fill cells ('frame:cell' -> {n, a})
    const work = new Map(), scrWork = new Map(), fxWork = new Map(), spWork = new Map(), fbWork = new Map();
    const screenPaint = (list, cell, ways) => {
        let m = scrWork.get(list); if (!m) scrWork.set(list, m = new Map());
        const k = Object.keys(ways).sort()[0]; m.set(cell, { way: k, px: merge(ways) }); inc('painted cells');
    };
    const of = k => { let w = work.get(k); if (!w) work.set(k, w = { tiles: new Map(), fills: new Map() }); return w; };
    const merge = ways => {
        const px = new Array(64).fill(null);
        for (const k of Object.keys(ways).sort()) ways[k].forEach((c, i) => { if (px[i] == null && c != null) px[i] = c; });   // '' = erased
        return px;
    };
    for (const layer of opts.paint || []) for (const [key, ways] of Object.entries(layer.tiles || {})) {
        if (key.startsWith('cell#')) {
            const [, list, cell] = key.split('#'), L = fillList(list);
            if (!L && screenList(list)) { screenPaint(list, +cell, ways); continue; }
            if (!L) throw new Error('painted cell of an unknown list ' + key);
            const px = merge(ways).filter(c => c != null);
            if (!px.length) continue;
            const cnt = new Map(); for (const c of px) cnt.set(c, (cnt.get(c) || 0) + 1);
            const c = [...cnt].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
            const w = of(L.k), id = L.f + ':' + cell, cur = w.fills.get(id) || { n: null, a: null };
            cur[L.alt ? 'a' : 'n'] = c; w.fills.set(id, cur); inc('painted cells');
            continue;
        }
        const at = key.lastIndexOf(':'), T = byTable.get(prefix.get(key.slice(0, at + 1)));
        const sl = /^scr(\d+)(?:o(\d+))?$/.exec(key.slice(0, at));
        if (!T && H.effects && prefix.get(key.slice(0, at + 1)) === H.effects.table) { fxWork.set(+key.slice(at + 1), ways); inc('painted load positions'); continue; }
        const FB = !T && fireballTable(H, prefix.get(key.slice(0, at + 1)));
        if (FB) { const id = FB.k + '/' + FB.p; if (!fbWork.has(id)) fbWork.set(id, []); fbWork.get(id).push({ FB, t: +key.slice(at + 1), ways }); inc('painted load positions'); continue; }
        const SP = !T && sparkTable(H, prefix.get(key.slice(0, at + 1)));
        if (SP) { if (!spWork.has(SP.k)) spWork.set(SP.k, []); spWork.get(SP.k).push({ t: +key.slice(at + 1), ways }); inc('painted load positions'); continue; }
        if (!T && sl) {
            const list = sl[2] !== undefined ? `scr:${sl[1]}+${sl[2]}` : `scr:${sl[1]}`, want = +key.slice(at + 1) + 1;
            for (const [l, c, i] of pkg.cells) if (l === list && i === want) screenPaint(list, c, ways);
            continue;
        }
        if (!T) throw new Error(`painted load position ${key} is not in the package's tables`);
        const t = +key.slice(at + 1), w = of(T.F.k), cur = w.tiles.get(t) || { n: null, a: null };
        cur[T.alt ? 'a' : 'n'] = merge(ways); w.tiles.set(t, cur); inc('painted load positions');
    }
    const skies = new Map();
    for (const layer of opts.paint || []) for (const [target, rows] of Object.entries(layer.backdrops || {})) {
        const S = screenList(target);
        if (S && S.base === null && Array.isArray(rows) && rows.length) skies.set(S.k, rows);
    }
    if (!work.size && !scrWork.size && !fxWork.size && !spWork.size && !fbWork.size && !skies.size) return { rom, stats, blobs: {} };

    // ---- free data area
    let at = pkg.data.at;
    const more = (pkg.data.more || []).map(([lo, hi]) => ({ at: lo, end: hi }));
    const areaSize = pkg.data.end - pkg.data.at + more.reduce((n, A) => n + A.end - A.at, 0);
    // `low` data (the screens', reached by no offset) goes into the extra areas first, keeping the main area for the
    // fighters' exception records, which must lie above its start
    const put = (bytes, align = 4, low = false) => {
        for (const A of low ? more : []) {
            const a = Math.ceil(A.at / align) * align;
            if (a + bytes.length <= A.end) { bytes.forEach((b, k) => { rom[(a + k) & (rom.length - 1)] = b; }); A.at = a + bytes.length; return a; }
        }
        at = Math.ceil(at / align) * align;
        if (at + bytes.length > pkg.data.end) {
            // same shape as vbcpkg.mjs DataAreaFull, so VUEPort's editor can explain it
            throw Object.assign(new Error('data area full'), { code: 'data-area-full', area: areaSize });
        }
        bytes.forEach((b, k) => { rom[(at + k) & (rom.length - 1)] = b; });
        const a = at; at += bytes.length; return a;
    };
    put.room = () => pkg.data.end - at + more.reduce((n, A) => n + A.end - A.at, 0);
    const BASE = Math.ceil(pkg.data.at / 4) * 4;                    // painted fighters' exception records: offsets from here

    for (const [k, w] of [...work].sort((a, b) => a[0] - b[0])) {
        const F = H.fighters.find(x => x.k === k), V = fighterView(R, H, k, original), e = V.e;
        const pairs = [];
        for (let n = 0; n < e.nsingle; n++) pairs.push([V.single(false, n), V.single(true, n)]);
        const combos = [];
        for (let j = 0; j < e.ncombo; j++) combos.push([1, 2, 3].map(v => V.combo(false, j, v) + '|' + V.combo(true, j, v)));
        const use = new Array(16).fill(0), cuse = new Array(combos.length).fill(0);
        const enc = new Map();
        for (let t = 0; t < e.ntiles; t++) {
            const p = V.pixels(t); enc.set(t, p);
            if (w.tiles.has(t)) continue;
            cuse[p.j]++;
            if (p.ex) for (const n of p.ex.values()) use[n]++;
        }
        const lists = new Map();
        for (let f = 0; f < e.nframes; f++) lists.set(f, soloList(R, e, f));
        for (const [f, l] of lists) for (const [q, n] of l) if (!(n & 0x8000) && !w.fills.has(f + ':' + ((q >> 10) * 64 + ((q >> 5) & 31) + (q & 16 ? 32 : 0)))) use[n]++;
        use[e.soliddef]++;
        const twin = c => { const p = pairs.find(x => x[0] === c); return p ? p[1] : altColour(F.alt_rules, c); };
        const pairId = (n, a) => n + '|' + a;
        const tileWant = new Map();
        for (const [t, P] of [...w.tiles].sort((a, b) => a[0] - b[0])) {
            if (!(t < e.ntiles)) continue;
            const tl = V.tile(t), cn = V.colours(t, false), ca = V.colours(t, true), px = new Array(64).fill(null);
            for (let i = 0; i < 64; i++) {
                const v = val(tl, i);
                const pn = P.n ? P.n[i] ?? null : null, pa = P.a ? P.a[i] ?? null : null;
                if (!v) { if (pn || pa) inc('opaque pixels not supported'); continue; }
                const old = pairId(cn[i], ca[i]);
                // erased ('') cuts out for both players, since they share the tile's record
                if (pn === '' || pa === '' || (pn === null && pa === null && cn[i] === '')) { px[i] = { id: 'cut', old, keepN: true, keepA: true }; continue; }
                const n = pn || cn[i], a = pa || (pn && pn !== cn[i] ? twin(pn) : ca[i]);
                const id = pairId(n, a);
                px[i] = { id, old, keepN: !pn, keepA: !pa };
                if (id === old) { const x = enc.get(t).ex?.get(i); if (x !== undefined && x >= 0) use[x]++; }
            }
            tileWant.set(t, px);
        }
        const fillWant = new Map();
        for (const [id, P] of [...w.fills].sort()) {
            const [f, cell] = id.split(':').map(Number), l = lists.get(f); if (!l) continue;
            const cur = (l.get(fillQ(cell)) ?? e.soliddef) & 15;
            if (P.n === '' || P.a === '') { fillWant.set(id, { id: 'cut', cur, cut: true }); continue; }
            const n = P.n || pairs[cur][0], a = P.a || (P.n && P.n !== pairs[cur][0] ? twin(P.n) : pairs[cur][1]);
            fillWant.set(id, { id: pairId(n, a), cur, keepN: !P.n, keepA: !P.a });
        }
        // combos no unpainted tile uses take the triples that save the painted tiles most exception pixels
        let changed = 0;
        const free = []; cuse.forEach((u, j) => { if (!u) free.push(j); });
        const cover = (px, tl, C) => { let s = 0; for (let i = 0; i < 64; i++) { const v = val(tl, i); if (v && px[i].id === C[v - 1]) s++; } return s; };
        const painted = [...tileWant].map(([t, px]) => ({ t, px, tl: V.tile(t) }));
        if (free.length && painted.length) {
            const fixed = combos.filter((_, j) => cuse[j]);
            for (const T of painted) T.best = fixed.length ? Math.max(...fixed.map(C => cover(T.px, T.tl, C))) : 0;
            const cand = new Map();
            for (const T of painted) {
                const cnt = [new Map(), new Map(), new Map()];
                for (let i = 0; i < 64; i++) { const v = val(T.tl, i); if (v && T.px[i].id !== 'cut') cnt[v - 1].set(T.px[i].id, (cnt[v - 1].get(T.px[i].id) || 0) + 1); }
                const top = m => [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
                const tri = cnt.map(top);
                if (tri.some(x => x === undefined)) { const any = tri.find(x => x !== undefined); for (let v = 0; v < 3; v++) tri[v] ??= any; }
                if (tri[0] !== undefined) cand.set(tri.join('#'), tri);
            }
            const cands = [...cand.values()].sort((a, b) => (a.join('#') < b.join('#') ? -1 : 1));
            for (const j of free) {
                let bt = null, bg = 0;
                for (const C of cands) {
                    let g = 0; for (const T of painted) g += Math.max(0, cover(T.px, T.tl, C) - T.best);
                    if (g > bg) { bg = g; bt = C; }
                }
                if (!bt) break;
                combos[j] = bt; cuse[j] = 1; changed++; inc('combos changed');
                for (const T of painted) T.best = Math.max(T.best, cover(T.px, T.tl, bt));
            }
        }
        const tinfoNew = new Map(), need = new Map();
        for (const { t, px, tl } of painted) {
            const old = enc.get(t).j; let bj = 0, bs = -1;
            combos.forEach((C, j) => { const s = cover(px, tl, C); if (s > bs || (s === bs && j === old)) { bj = j; bs = s; } });
            const ex = new Map();
            for (let i = 0; i < 64; i++) {
                const v = val(tl, i); if (!v || px[i].id === combos[bj][v - 1]) continue;
                ex.set(i, px[i]); if (px[i].id !== 'cut') need.set(px[i].id, (need.get(px[i].id) || 0) + 1);
            }
            tinfoNew.set(t, { j: bj, ex });
        }
        for (const F2 of fillWant.values()) if (!F2.cut) need.set(F2.id, (need.get(F2.id) || 0) + 64);
        const idx = new Map(), order = [...need].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(x => x[0]);
        for (const id of order) {
            const n = pairs.findIndex(p => pairId(p[0], p[1]) === id);
            if (n >= 0) { idx.set(id, n); use[n]++; }
        }
        for (const id of order) {
            if (idx.has(id)) continue;
            const n = [...Array(16).keys()].find(q => q >= pairs.length || !use[q]);
            if (n === undefined) continue;
            pairs[n] = id.split('|'); idx.set(id, n); use[n]++; inc('single colours added');
        }
        // out of room: the nearest single color, weighting the side the paint didn't touch, so painting player 2's
        // colors doesn't change player 1's
        const nearest = (id, keepN, keepA, extra) => {
            const [pn, pa] = id.split('|'), wn = keepN ? 1000 : 1, wa = keepA ? 1000 : 1;
            let best = null, bd = Infinity;
            for (const [q, p] of [...pairs.map((p, q) => [q, p]), ...(extra || [])]) {
                const d = dist(p[0], pn) * wn + dist(p[1], pa) * wa; if (d < bd) { bd = d; best = q; }
            }
            return best;
        };
        for (const [t, T] of tinfoNew) {
            const tl = V.tile(t);
            for (const [i, P] of T.ex) {
                if (P.id === 'cut') { T.ex.set(i, -1); inc('erased pixels'); continue; }
                let n = idx.get(P.id);
                if (n === undefined) {
                    const cj = combos[T.j][val(tl, i) - 1].split('|');
                    n = nearest(P.id, P.keepN, P.keepA, [[null, cj]]); inc('pixels short of a colour');
                }
                if (n === null) T.ex.delete(i); else T.ex.set(i, n);
            }
        }
        const ns = pairs.length;
        if (ns !== e.nsingle || pairs.some((p, n) => n < e.nsingle && (p[0] !== V.single(false, n) || p[1] !== V.single(true, n)))) {
            const arr = alt => { const b = []; for (const p of pairs) { const x = wordOf(p[alt]); b.push(x & 255, x >> 8 & 255, x >> 16 & 255, 0); } return b; };
            R.w32(e.at + 40, ns); R.w32(e.at + 44, put(arr(0))); R.w32(e.at + 48, put(arr(1)));
        }
        if (changed) {
            const arr = alt => {
                const b = [];
                for (const C of combos) for (const g of GPLT) {
                    const s = [0, 0, 0, 0];
                    for (let v = 1; v < 4; v++) s[shadeOf(g, v)] = wordOf(C[v - 1].split('|')[alt]);
                    for (const x of s) b.push(x & 255, x >> 8 & 255, x >> 16 & 255, 0);
                }
                return b;
            };
            R.w32(e.at + 32, put(arr(0))); R.w32(e.at + 36, put(arr(1)));
        }
        const records = [...tinfoNew.values()].some(T => T.ex.size);
        if (records) {
            for (let t = 0; t < e.ntiles; t++) {
                if (tinfoNew.has(t)) continue;
                const inf = R.u32(e.tinfo + 4 * t), x = inf >>> 5; if (!x) continue;
                const off = e.exc + x - 1 - BASE + 1;
                if (off <= 0 || off >= 1 << 27) throw new Error('exception record out of reach');
                R.w32(e.tinfo + 4 * t, ((inf & 31) | off << 5) >>> 0);
            }
            R.w32(e.at + 24, BASE);
        }
        const exBase = records ? BASE : e.exc;
        for (const [t, { j, ex }] of tinfoNew) {
            let inf = j;
            if (ex.size) { const a = put(encodeExc(ex), 1); inf = (inf | (a - exBase + 1) << 5) >>> 0; }
            R.w32(e.tinfo + 4 * t, inf >>> 0);
        }
        const frames = new Map();
        for (const [id, Fw] of fillWant) {
            const [f, cell] = id.split(':').map(Number); let n = Fw.cut ? 0x8000 : idx.get(Fw.id);
            if (n === undefined) { n = nearest(Fw.id, Fw.keepN, Fw.keepA, [[Fw.cur, pairs[Fw.cur]]]); inc('pixels short of a colour', 64); }
            const l = frames.get(f) || new Map(lists.get(f));
            l.set(fillQ(cell), n); frames.set(f, l);
        }
        for (const [f, l] of frames) {
            const xs = [...l].map(([q, n]) => q | n).sort((a, b) => a - b), b = [xs.length & 255, xs.length >> 8];
            for (const x of xs) b.push(x & 255, x >> 8);
            R.w32(e.solid + 4 * f, put(b, 4));
        }
        stats['single colours ' + F.name] = pairs.length;
    }
    for (const [list, cells] of [...scrWork].sort()) paintScreen(R, H, pkg, original, list, cells, put, inc);
    if (fxWork.size) paintEffects(R, H, original, fxWork, put, inc);
    if (spWork.size) paintSparks(R, H, original, spWork, put, inc);
    if (fbWork.size) paintFireballs(R, H, original, fbWork, inc);
    for (const [k, rows] of [...skies].sort((a, b) => a[0] - b[0])) {
        // the engine writes a screen's sky (224 RGB888 words) into the Backdrop Row Table (BKREN) when it applies the
        // screen; a screen without one follows its CBKPAL palette
        const e = screenEnt(R, H, k); if (e.flags & 4) continue;
        const b = []; for (let y = 0; y < 224; y++) push32b(b, wordOf(rows[Math.min(y, rows.length - 1)]));
        R.w32(e.at + 72, put(b, 4, true)); inc('backdrops painted');
    }
    // a new state magic makes a running engine start over and re-read every table (VUEPort's Apply to the Game)
    const stamp = h.crc32(Uint8Array.from(JSON.stringify((opts.paint || []).map(l => [l.tiles || {}, l.backdrops || {}])), c => c.charCodeAt(0) & 255));
    let lo = stamp & 0x7FFF; if (lo === 0x4332) lo ^= 1;
    for (const o of H.magic) {
        if ((rom[o] | rom[o + 1] << 8) !== 0x4332) throw new Error('engine state magic not where the package says');
        rom[o] = lo & 255; rom[o + 1] = lo >> 8;
    }
    stats.data_free = pkg.data.end - at;
    return { rom, stats, blobs: {} };
}
