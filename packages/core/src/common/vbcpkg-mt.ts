// @ts-nocheck
/* eslint-disable */
// Generated from VB Patches/_tools/vbcpkg/mt.mjs by sync-vueport.mjs: change it there, not here.
// paints the shipped engine's (dev33) own tables in place; no imports, so it runs in a browser and as VUEPort's
// TypeScript copy unchanged. package format: README.md, "Layout mt"

const CUT = 0xFF;

function reader(rom) {
    const m = rom.length - 1;
    const u8 = a => rom[a & m];
    const u16 = a => rom[a & m] | rom[(a + 1) & m] << 8;
    const u32 = a => (rom[a & m] | rom[(a + 1) & m] << 8 | rom[(a + 2) & m] << 16 | rom[(a + 3) & m] << 24) >>> 0;
    const w8 = (a, v) => { rom[a & m] = v & 255; };
    const w16 = (a, v) => { rom[a & m] = v & 255; rom[(a + 1) & m] = (v >> 8) & 255; };
    const w32 = (a, v) => { for (let k = 0; k < 4; k++) rom[(a + k) & m] = (v >>> (8 * k)) & 255; };
    return { u8, u16, u32, w8, w16, w32 };
}
const hexOf = w => '#' + [w & 255, (w >> 8) & 255, (w >> 16) & 255].map(x => x.toString(16).padStart(2, '0')).join('');
const val = (t, i) => (((t[(i >> 3) * 2] | t[(i >> 3) * 2 + 1] << 8) >> ((i & 7) * 2)) & 3);
const shadeOf = (plt, v) => (plt >> (2 * v)) & 3;
const rgbOf = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const dist = (a, b) => { const x = rgbOf(a), y = rgbOf(b); return 2 * (x[0] - y[0]) ** 2 + 4 * (x[1] - y[1]) ** 2 + 3 * (x[2] - y[2]) ** 2; };

// dev32's hash: murmur3's finaliser after the owner and after each of the tile's four words
const mul32 = (a, b) => Math.imul(a, b) >>> 0;
const fmix = h => { h = (h ^ (h >>> 16)) >>> 0; h = mul32(h, 0x85EBCA6B); h = (h ^ (h >>> 13)) >>> 0; h = mul32(h, 0xC2B2AE35); return (h ^ (h >>> 16)) >>> 0; };
function tileHash(seed, owner, t) {
    let h = fmix((seed + mul32(owner, 0x9E3779B9)) >>> 0);
    for (let k = 0; k < 16; k += 4) h = fmix((h ^ (t[k] | t[k + 1] << 8 | t[k + 2] << 16 | t[k + 3] << 24)) >>> 0);
    return h || 1;
}
function find(R, M, owner, t) {
    const h = tileHash(M.seed, owner, t), tag = (h & 0xFFFF) || 1;
    let i = Math.floor(h * M.size / 4294967296);              // mulu: the high word
    for (let n = 0; n < M.size; n++, i = (i + 1) % M.size) {
        const g = R.u16(M.blobs.tags + 2 * i);
        if (g === tag) return i;
        if (!g) return -1;
    }
    return -1;
}

// dev33's classify colors tiles the table lacks with the group at `default` + owner
const defaultOf = (R, M, owner) => M.default ? R.u8(M.default + owner) : 0;

function keysOf(pkg, original, slots) {
    const out = new Map(), M = pkg.mt;
    for (const O of M.owners) {
        const tab = pkg.tables.find(x => x.name === O.table);
        for (const { key, t } of slots(original, tab)) {
            const c = M.ctx?.[key];
            out.set(key, { owner: O.owner, sel: c ? c[0] : O.sel, plt: c ? c[1] : O.plt, t });
        }
    }
    return out;
}

function banksOf(R, M) {
    if (!M.banks) return null;
    const n = R.u32(M.banks.at), list = R.u32(M.banks.at + 4), idx = new Map(), at = [];
    for (let k = 0; k < n; k++) idx.set((R.u32(list + 4 * k) - 0x03000000 - CRAM) >> 4, k);
    for (let b = 0; b < M.banks.n; b++) at.push(R.u32(M.banks.at + 8 + 4 * b));
    return { n, idx, at };
}
const CRAM = 0x79000;
const SCENE_BANK = s => /^stage\d$/.test(s || '') ? 1 + +s.slice(5) : s === 'title' ? 9 : s === 'boot' ? 10 : s === 'menu' ? 0 : -1;
function maskOf(M, key) {
    const all = M.banks ? (1 << M.banks.n) - 1 : 1, c = key.indexOf(':');
    const m = M.masks?.[key.slice(0, c)]?.[+key.slice(c + 1)] || 0;
    return m & all || all;
}
const LIST_BANK = l => l.startsWith('sky:') ? 1 + +l.slice(4) : l === 'boot' ? 10 : 9;
const bankFor = (M, mask, scene) => { if (!M.banks) return -1; const b = SCENE_BANK(scene); return b >= 0 && mask >> b & 1 ? b : 31 - Math.clz32(mask & -mask); };

function view(R, M, screen = 'match', stage = -1, bank = -1) {
    // palettes as a screen has them: the ROM's table on the boot screens, in a match with the players' own restored (the
    // boot screens borrow some, M.restore), on the title and in the intro with their swapped-in ones (M.views)
    const over = new Map(screen === 'match' ? M.restore || [] : screen === 'boot' ? [] : M.views?.[screen] || []);
    const words = new Map();
    const S = M.stages, T = M.tcourt;
    if (S && typeof stage === 'number' && stage >= 0) {
        const f = R.u32(S.at + 16 * stage + 4);
        S.pfill.forEach((p, k) => over.set(p, f + 16 * k));
        for (const [sel, h] of Object.entries(S.home)) { const sh = (h >> 6) & 3; if (sh) words.set((S.gcourt * 4 + +sel) * 4 + sh, f + 64); }
    } else if (S && T && stage === 'court') S.pfill.forEach((p, k) => over.set(p, T.fade + 128 * T.level + 16 * k));
    const BK = bank >= 0 ? banksOf(R, M) : null;
    const pal = (p, s) => {
        const k = BK?.idx.get(p);
        if (k !== undefined) return hexOf(R.u32(BK.at[bank] + 16 * k + 4 * s));
        return hexOf(R.u32(words.get(p * 4 + s) ?? (over.get(p) ?? M.blobs.pal + 16 * p) + 4 * s));
    };
    const entry = i => {
        const v = R.u32(M.blobs.vals + 4 * i), n = (v >>> 7) & 0x7F, off = (v >>> 14) & 0x1FFFF, ex = new Map();
        for (let k = 0; k < n; k++) { const x = R.u16(M.blobs.exc + 2 * (off + k)); ex.set((x >> 8) & 63, x & 255); }
        return { v, group: v & 63, fill: (v >> 6) & 1, opq: v >>> 31, n, off, ex, edges: R.u16(M.blobs.edges + 2 * i) };
    };
    const colours = (E, K) => {
        const out = new Array(64);
        for (let i = 0; i < 64; i++) {
            const v = val(K.t, i), p = E.ex.get(i);
            if (!v && !(E.opq && p !== undefined)) { out[i] = null; continue; }
            if (p === 0xFF) { out[i] = null; continue; }
            out[i] = pal(p !== undefined && p ? p : E.group * 4 + K.sel, shadeOf(K.plt, v));
        }
        return out;
    };
    return { pal, entry, colours };
}

// what a built ROM shows: (key, way) -> 64 x [value, shade, '#rrggbb' | null], at the key's own selector and GPLT
export function mtShownPixels(pkg, original, rom, h, scene) {
    const R = reader(rom), M = pkg.mt, views = new Map(), stage = /^stage\d$/.test(scene || '') ? +scene.slice(5) : -1;
    let bank = -1;
    const screenOf = (M, K, E) => {
        const sc = K.owner < 8 || !E ? 'match' : E.edges === M.title_mark ? 'logo' : M.intro_groups && E.group >= M.intro_groups[0] && E.group <= M.intro_groups[1] ? 'intro' : 'match';
        const id = sc + '/' + bank;
        let V = views.get(id); if (!V) views.set(id, V = view(R, M, sc, sc === 'match' ? stage : -1, bank)); return V;
    };
    let keys = null;
    return (key) => {
        keys ??= keysOf(pkg, original, h.slots);
        const K = keys.get(key); if (!K) return null;
        const i = find(R, M, K.owner, K.t);
        if (i < 0 && !M.extras?.includes(key)) return null;
        bank = bankFor(M, maskOf(M, key), scene);
        const E = i >= 0 ? screenOf(M, K, null).entry(i) : { v: 0, group: defaultOf(R, M, K.owner), fill: 0, opq: 0, n: 0, off: 0, ex: new Map(), edges: 0 };
        const cols = screenOf(M, K, E).colours(E, K);
        return cols.map((c, j) => { const v = val(K.t, j); return c ? [v, shadeOf(K.plt, v), c] : [v, 0, null]; });
    };
}

// fill cells of a recorded pose as dev32's fillwin decides them: each takes the material its neighbours' facing edges
// vote for
function decideFills(R, M, V, keys, list) {
    const arr = M.poses[list], pre = list.slice(5).replace(/\d+$/, ''), cells = new Map();
    for (let k = 0; k < arr.length; k += 3) {               // cell, key index, flips
        const K = keys.get(pre + arr[k + 1]), i = K ? find(R, M, K.owner, K.t) : -1;
        const E = i >= 0 ? { fill: (R.u32(M.blobs.vals + 4 * i) >> 6) & 1, edges: R.u16(M.blobs.edges + 2 * i) } : { fill: 0, edges: 0 };
        cells.set(arr[k], { flip: arr[k + 2], ...E });
    }
    const out = new Map(), order = [...cells.keys()].filter(c => cells.get(c).fill).sort((a, b) => a - b);
    const near = (c, d) => {
        const x = c & 63, y = c >> 6 & 63;
        if (d === -64 && (y & 15) === 0) return undefined;
        if (d === 64 && (y & 15) === 15) return undefined;
        if (d === -1 && (x & 15) === 0) return undefined;
        if (d === 1 && (x & 15) === 15) return undefined;
        return c + d;
    };
    const SIDES = [[-64, 1, 1], [64, 0, 1], [-1, 3, 2], [1, 2, 2]];   // [delta, the neighbour's facing edge, flip bit]
    for (let rnd = 1; rnd <= 3; rnd++) {
        let open = 0;
        for (const c of order) {
            if (out.has(c)) continue;
            const votes = SIDES.map(([d, base, fb]) => {
                const n = near(c, d), N = n === undefined ? undefined : cells.get(n);
                if (!N) return 0;
                if (rnd === 1) return N.fill ? 0 : (N.edges >> (4 * (base ^ (N.flip & fb ? 1 : 0)))) & 15;
                return N.fill ? (out.get(n) || 0) : 0;
            });
            let best = 0, cnt = 0;
            for (const v of votes) { if (!v) continue; const n = votes.filter(x => x === v).length; if (n > cnt) { cnt = n; best = v; } }
            if (rnd < 3 && !(2 * cnt > votes.filter(Boolean).length)) best = 0;
            if (best) out.set(c, best); else open++;
        }
        if (!open) break;
    }
    return out;
}

function cellLists(M) {
    const out = new Set(M.tcourt ? ['tcourt'] : []);
    if (M.stages) for (let st = 0; st < 8; st++) out.add('sky:' + st);
    return out;
}

function cellRecords(R, M, name) {
    // records (cell, BG map entry, Cell Pixel Color Attribute, Color Attribute); the boot screens' lack the pixel attribute
    const D = M.cellsets?.[name];
    if (D) {
        const C = { cells: new Map(), slot0: D.slot0 ?? 928, block: D.imgrec ? (D.imgrec === M.cellsets.boot?.imgrec ? 'boot' : 'title') : 'title' };
        C.img = D.imgrec ? R.u32(D.imgrec) : D.img; C.nimg = D.imgrec ? R.u32(D.imgrec + 4) / 32 : 96;
        for (let k = 0; k < D.n; k++) {
            const a = D.at + D.stride * k, c = R.u16(a);
            C.cells.set(c, D.stride === 6 ? { pix: 0, attr: R.u16(a + 4), at: a, kind: 'rec6' } : { pix: R.u16(a + 4), attr: R.u16(a + 6), at: a, kind: 'rec8' });
        }
        return C;
    }
    // a pixel attribute per row (or cell) of BG Map 0, in the steady fade's palettes
    if (name === 'tcourt') {
        const T = M.tcourt, C = { cells: new Map(), slot0: T.slot0, block: 'title' };
        C.img = T.imgrec ? R.u32(T.imgrec) : T.img; C.nimg = T.imgrec ? R.u32(T.imgrec + 4) / 32 : 96;
        const w = T.c1 - T.c0;
        for (let r = 0; r < T.rows; r++) for (let c = T.c0; c < T.c1; c++) {
            const a = T.percell ? T.at + 2 * (r * w + c - T.c0) : T.at + 2 * r;
            C.cells.set(r * 64 + c, { pix: R.u16(a), attr: 0, at: a, kind: 'pix' });
        }
        return C;
    }
    // a stage's skyline: entries cell | attribute << 16 | image << 24
    const st = +name.slice(4), S = M.stages, e = R.u32(S.at + 16 * st), n = R.u32(e);
    const C = { cells: new Map(), img: R.u32(S.at + 16 * st + 8), nimg: R.u32(S.at + 16 * st + 12) / 32, slot0: S.slot0, block: 'sky:' + st, st };
    for (let k = 0; k < n; k++) {
        const x = R.u32(e + 4 + 4 * k);
        C.cells.set(S.base + (x & 0xFFFF), { pix: 0xC000 | (S.slot0 + (x >>> 24)), attr: (x >> 16) & 0xFF, at: e + 4 + 4 * k, kind: 'sky', x });
    }
    return C;
}

export function mtCellShown(pkg, original, rom, h, scene) {
    const R = reader(rom), M = pkg.mt, done = new Map(), sets = new Map();
    const V = view(R, M, 'match', /^stage\d$/.test(scene || '') ? +scene.slice(5) : -1);
    let keys = null;
    const cellSet = name => {
        let C = sets.get(name); if (C) return C;
        C = cellRecords(R, M, name);
        const bank = M.banks ? LIST_BANK(name) : -1;
        C.V = name === 'tcourt' ? view(R, M, 'logo', 'court', bank) : M.cellsets?.[name] ? view(R, M, M.cellsets[name].screen, -1, bank)
            : view(R, M, 'match', +name.slice(4), bank);
        sets.set(name, C); return C;
    };
    const byCell = (name, cell, way, tile) => {
        const C = cellSet(name), X = C.cells.get(cell); if (!X) return undefined;
        const [, sel, pl] = way.split('/'), plt = parseInt(pl || 'e4', 16), s = +sel || 0;
        // slots from slot0 on are the block's images at img
        const img = X.pix & 0x8000 ? C.img + 64 * ((X.pix & 0x3FF) - C.slot0) : -1, opq = (X.pix & 0xC000) === 0xC000;
        if (img >= 0 && (X.pix & 0x3FF) - C.slot0 >= C.nimg) return undefined;
        const px = [];
        for (let i = 0; i < 64; i++) {
            const v = val(tile, i), sh = shadeOf(plt, v), b = img >= 0 ? R.u8(img + i) : 0;
            if ((!v && !opq) || b === 0xFF) { px.push([v, sh, null]); continue; }
            px.push([v, sh, C.V.pal(b || (X.attr & 63) * 4 + s, sh)]);
        }
        return px;
    };
    return (lists, cell, way, tile) => {
        for (const l of [...lists].reverse()) if (M.cellsets?.[l] || cellLists(M).has(l)) { const px = byCell(l, cell, way, tile); if (px) return px; }
        const L = [...lists].reverse().find(l => M.poses?.[l]);
        if (!L) return undefined;
        let D = done.get(L);
        if (!D) { keys ??= keysOf(pkg, original, h.slots); done.set(L, D = decideFills(R, M, V, keys, L)); }
        const n = D.get(cell); if (!n) return undefined;
        const p = M.materials[n - 1][3];
        const px = [];
        for (let i = 0; i < 64; i++) { const v = val(tile, i); px.push(v ? [v, shadeOf(0x6C, v), V.pal(p, shadeOf(0x6C, v))] : [0, 0, null]); }
        return px;
    };
}

// without paint the ROM is the runtime (dev33) byte for byte
export function compileMt(pkg, original, opts, h) {
    if (original.length !== pkg.original.size || h.hex8(h.crc32(original)) !== pkg.original.crc32)
        throw new Error(`this ROM is not the package's original (${pkg.game})`);
    const rom = h.bpsApply(original, h.b64(pkg.runtime.bps));
    const R = reader(rom), M = pkg.mt, V = view(R, M), stats = {};
    const NB = M.banks ? M.banks.n : 1, ALL = (2 ** NB) - 1;
    const inc = (k, n = 1) => { stats[k] = (stats[k] || 0) + n; };
    const merge = ways => {
        const px = new Array(64).fill(null);
        for (const k of Object.keys(ways).sort()) ways[k].forEach((c, i) => { if (px[i] == null && (c || c === '')) px[i] = c; });
        return px;
    };
    // ---- the paint per table entry (keys with the same owner and bytes are one entry, later layers win) and per cell
    const extras = new Set(M.extras || []);
    let load = -1;
    // a painted extra key (a tile the table lacks) gets an entry with its owner's default group on its probe path
    const insert = (owner, t) => {
        if (load < 0) { load = 0; for (let i = 0; i < M.size; i++) if (R.u16(M.blobs.tags + 2 * i)) load++; }
        // at most 80 % full: a lookup of a missing tile only ends at a free place
        if (load >= 0.8 * M.size) { inc('painted extra tiles left out: table full'); return -2; }
        const h = tileHash(M.seed, owner, t), tag = (h & 0xFFFF) || 1;
        let i = Math.floor(h * M.size / 4294967296);
        for (let n = 0; n < M.size; n++, i = (i + 1) % M.size) {
            const g = R.u16(M.blobs.tags + 2 * i);
            if (g === tag) return -1;
            if (!g) { R.w16(M.blobs.tags + 2 * i, tag); R.w32(M.blobs.vals + 4 * i, defaultOf(R, M, owner)); R.w16(M.blobs.edges + 2 * i, 0); load++; return i; }
        }
        return -1;
    };
    let keys = null;
    const work = new Map();
    const cwork = new Map();
    for (const layer of opts.paint || []) for (const [key, ways] of Object.entries(layer.tiles || {})) {
        keys ??= keysOf(pkg, original, h.slots);
        if (key.startsWith('cell#')) {
            const [, list, cell, ...tk] = key.split('#'), tkey = tk.join('#');
            if (!keys.has(tkey)) throw new Error(`painted cell ${key}: no such load position`);
            const id = list + '#' + cell, e = cwork.get(id) || { list, cell: +cell, key: tkey, ways: {} }; cwork.set(id, e);
            e.key = tkey;
            for (const [way, px] of Object.entries(ways)) {
                const to = e.ways[way] ??= new Array(64).fill(null);
                px.forEach((c, i) => { if (c != null) to[i] = c; });
            }
            inc('painted cells');
            continue;
        }
        const K = keys.get(key);
        if (!K) throw new Error(`painted load position ${key} is not in the package's tables`);
        let i = find(R, M, K.owner, K.t);
        if (i < 0 && extras.has(key)) { i = insert(K.owner, K.t); if (i >= 0) inc('table entries added'); else if (i === -1) inc('painted extra tiles left out: tag taken on the path'); if (i < 0) continue; }
        if (i < 0) { inc('painted tiles the table does not hold'); continue; }
        const px = merge(ways), cur = work.get(i), mask = maskOf(M, key);
        if (cur) { px.forEach((c, j) => { if (c != null) cur.px[j] = c; }); cur.mask |= mask; } else work.set(i, { K, px, mask });
        inc('painted load positions');
    }
    if (!work.size && !cwork.size) return { rom, stats, blobs: {} };

    // ---- palettes a painted pixel may name, per shade: color -> [palette, ...] (steady ones first); never the ones the
    // game rewrites (M.dynamic), its 'swap' ones only for players
    const dyn = M.dynamic || {}, never = new Set(Object.entries(dyn).filter(([k]) => k !== 'swap').flatMap(([, v]) => v));
    const swap = new Set(dyn.swap || []);
    const avail = player => {
        const by = [new Map(), new Map(), new Map(), new Map()];
        for (let p = 1; p < 256; p++) {
            if (never.has(p) || (!player && swap.has(p))) continue;
            const w = [0, 1, 2, 3].map(s => V.pal(p, s)), steady = w[1] === w[2] && w[2] === w[3];
            for (let s = 0; s < 4; s++) {
                const l = by[s].get(w[s]) || []; if (steady) l.unshift(p); else l.push(p); by[s].set(w[s], l);
            }
        }
        return by;
    };
    const AV = [avail(false), avail(true)];
    const nearest = (by, c) => { let best = null, d = Infinity; for (const k of by.keys()) { const x = dist(k, c); if (x < d) { d = x; best = k; } } return best; };
    const mats = (M.materials || []).map(([nib, , , p]) => ({ nib, p }));

    // ---- data blobs (cell images, records, banks) from the end of the data area down; exception lists below them
    let top = pkg.data.end;
    const blob = (bytes, align = 16) => {
        top = (top - bytes.length) & ~(align - 1);
        for (let k = 0; k < bytes.length; k++) R.w8(top + k, bytes[k]);
        return top;
    };

    // ---- exception lists: equal lists are shared; a new one goes into the first gap no unpainted entry's list holds
    // (painted entries' old lists are free again), else after the pool, below the blobs and 2^17 halfwords of offset
    const lists = new Map(), cap = Math.min(0x1FFFF, (pkg.data.end - M.blobs.exc) >> 1);
    const used = new Uint8Array(cap + 1);
    for (let i = 0; i < M.size; i++) {
        if (!R.u16(M.blobs.tags + 2 * i) || work.has(i)) continue;
        const v = R.u32(M.blobs.vals + 4 * i), n = (v >>> 7) & 0x7F; if (!n) continue;
        const off = (v >>> 14) & 0x1FFFF, b = [];
        for (let k = 0; k < n; k++) { b.push(R.u16(M.blobs.exc + 2 * (off + k))); used[off + k] = 1; }
        const id = b.join(','); if (!lists.has(id)) lists.set(id, off);
    }
    const pool = (pkg.data.at - M.blobs.exc) >> 1;             // the ROM's pool ends here (its gaps are reused first)
    for (let k = M.exc_n ?? pool; k < pool; k++) used[k] = 1;   // dev33's gate stubs sit between the lists and the data area
    let hint = 0, beyond = 0;
    const putList = hw => {
        const id = hw.join(','); if (lists.has(id)) return lists.get(id);
        const limit = Math.min(cap, (top - M.blobs.exc) >> 1);
        while (hint < limit && used[hint]) hint++;
        for (let s = hint, run = 0; s < limit; s++) {
            run = used[s] ? 0 : run + 1;
            if (run < hw.length) continue;
            const off = s - hw.length + 1;
            hw.forEach((x, k) => { R.w16(M.blobs.exc + 2 * (off + k), x); used[off + k] = 1; });
            if (off + hw.length > pool) beyond = Math.max(beyond, off + hw.length - pool);
            lists.set(id, off); return off;
        }
        return null;
    };

    // ---- spare palettes: M.spare (named only by exception pixels) once no unpainted entry or slot image names them,
    // then M.unused (shown in no surveyed frame, named by nothing)
    const spare = new Set([...M.spare || [], ...M.unused || []]), late = new Set(M.unused || []);
    for (let i = 0; i < M.size && spare.size; i++) {
        if (!R.u16(M.blobs.tags + 2 * i) || work.has(i)) continue;
        for (const p of V.entry(i).ex.values()) spare.delete(p);
    }
    for (const [a, n] of M.images || []) for (let k = 0; k < n; k++) spare.delete(R.u8(a + k));

    // ---- painted entries: painting a value-0 pixel makes the entry opaque and cuts out its other value-0 pixels
    const plan = [];
    for (const [i, { K, px, mask }] of [...work].sort((a, b) => a[0] - b[0])) {
        const E = V.entry(i), was = V.colours(E, K), player = K.owner < 8;
        const opq = E.opq || px.some((c, j) => c && !val(K.t, j));
        const want = new Array(64).fill(null);
        for (let j = 0; j < 64; j++) {
            const v = val(K.t, j);
            if (!v) {
                if (px[j] === '') want[j] = CUT;
                else if (px[j]) want[j] = px[j];
                else if (E.opq) want[j] = E.ex.has(j) ? E.ex.get(j) : null;
                else if (opq) want[j] = CUT;
                continue;
            }
            want[j] = px[j] === '' ? CUT : px[j] || was[j];
        }
        const [glo, ghi] = player ? M.groups.players : M.groups.scenery;
        const cands = new Set([E.group]); for (let g = glo; g <= ghi; g++) cands.add(g);
        let best = E.group, bs = -1;
        for (const g of cands) {
            let n = 0;
            for (let j = 0; j < 64; j++) { const v = val(K.t, j); if (v && V.pal(g * 4 + K.sel, shadeOf(K.plt, v)) === want[j]) n++; }
            if (n > bs || (n === bs && g === E.group)) { bs = n; best = g; }
        }
        const need = [];                                     // [pixel, shade, color] or [pixel, -1, palette] (cut-out / kept)
        for (let j = 0; j < 64; j++) {
            const v = val(K.t, j);
            if (want[j] === null) continue;
            if (typeof want[j] === 'number') { need.push([j, -1, want[j]]); continue; }
            const sh = shadeOf(K.plt, v);
            if (v && V.pal(best * 4 + K.sel, sh) === want[j]) continue;
            need.push([j, sh, want[j]]);
        }
        plan.push({ i, K, px, E, was, want, best, need, player, mask, opq });
    }

    const recs = new Map();
    const recOf = l => { let C = recs.get(l); if (!C) recs.set(l, C = cellRecords(R, M, l)); return C; };
    const cplan = [];
    for (const [, c] of cwork) {
        if (!(M.cellsets?.[c.list] || cellLists(M).has(c.list))) { inc('painted cells of a list the runtime does not have'); continue; }
        const C = recOf(c.list), X = C.cells.get(c.cell);
        if (!X) { inc('painted cells the list does not name'); continue; }
        if (X.kind === 'rec6' || (c.list === 'tcourt' && !M.tcourt.percell)) { inc('painted cells the runtime colours by group only'); continue; }
        const t = keys.get(c.key).t, slot = X.pix & 0x8000 ? (X.pix & 0x3FF) - C.slot0 : -1;
        const cur = new Array(64).fill(0);
        if (slot >= 0) for (let i = 0; i < 64; i++) cur[i] = R.u8(C.img + 64 * slot + i);
        const ways = Object.entries(c.ways).sort((a, b) => (a[0] < b[0] ? -1 : 1));
        const px = new Array(64).fill(null), pw = new Array(64).fill(null);
        for (const [way, arr] of ways) arr.forEach((col, i) => { if (px[i] == null && (col || col === '')) { px[i] = col; pw[i] = way; } });
        const wasOpq = (X.pix & 0xC000) === 0xC000;
        const opq = wasOpq || px.some((col, i) => col && !val(t, i));
        const mask = M.banks ? 1 << LIST_BANK(c.list) : 1;
        const need = [];
        const img = cur.slice();
        for (let i = 0; i < 64; i++) {
            const v = val(t, i);
            if (px[i] === '') { img[i] = CUT; continue; }
            if (!px[i]) { if (!v && opq && !wasOpq && !img[i]) img[i] = CUT; continue; }
            const [, sel, pl] = (pw[i] || '0/0/e4').split('/'), plt = parseInt(pl || 'e4', 16);
            need.push([i, shadeOf(plt, v), px[i], +sel || 0]);
        }
        cplan.push({ ...c, C, X, t, img, need, mask, opq, slot });
    }

    const pick = (player, sh, c) => {
        const l = AV[player ? 1 : 0][sh].get(c); if (!l) return null;
        const p = l.find(q => !spare.has(q)) ?? l[0]; spare.delete(p); return p;
    };
    // new colors (no palette shows them at that shade) per color and kind, with the banks that want them
    const fresh = new Map();
    const want0 = (player, sh, c) => !AV[player ? 1 : 0][sh].has(c);
    const addFresh = (sh, c, mask) => { const id = (sh ? 'n ' : 'z ') + c, F = fresh.get(id) || { c, kind: sh ? 'n' : 'z', mask: 0, n: 0 }; F.mask |= mask; F.n++; fresh.set(id, F); };
    for (const P of plan) for (const [, sh, c] of P.need) if (sh >= 0 && want0(P.player, sh, c)) addFresh(sh, c, P.mask);
    for (const P of cplan) for (const [, sh, c] of P.need) if (want0(false, sh, c)) addFresh(sh, c, P.mask);
    for (const P of plan) for (const x of P.need) if (x[1] >= 0 && !want0(P.player, x[1], x[2])) pick(P.player, x[1], x[2]);
    for (const P of cplan) for (const x of P.need) if (!want0(false, x[1], x[2])) pick(false, x[1], x[2]);
    // the remaining spares take the new colors, most wanted first, each only on the banks that want it, so a palette can
    // serve other colors on other screens; their old colors leave the lists
    const free = [...spare].sort((a, b) => late.has(a) - late.has(b) || a - b);
    for (const p of free) for (const by of AV) for (let sh = 0; sh < 4; sh++) {
        const c = V.pal(p, sh), l = by[sh].get(c); if (!l) continue;
        const k = l.indexOf(p); if (k >= 0) l.splice(k, 1); if (!l.length) by[sh].delete(c);
    }
    const taken = new Map();                                 // palette -> Array(NB) of words (undefined: not taken there)
    const freshPal = new Map();
    for (const [id, F] of [...fresh].sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1))) {
        const p = free.find(q => { const T = taken.get(q); if (!T) return true; for (let b = 0; b < NB; b++) if (F.mask >> b & 1 && T[b]) return false; return true; });
        if (p === undefined) continue;
        const w = parseInt(F.c.slice(1, 3), 16) | parseInt(F.c.slice(3, 5), 16) << 8 | parseInt(F.c.slice(5, 7), 16) << 16;
        // 'z' (value-0 pixels) [c, c, c, c], else [black, c, c, c], which stays steady through fades
        const words = [F.kind === 'z' ? w : 0, w, w, w];
        const T = taken.get(p) || new Array(NB).fill(null); taken.set(p, T);
        for (let b = 0; b < NB; b++) if (F.mask >> b & 1) T[b] = words;
        freshPal.set(id, p);
    }
    const banked = [];
    for (const [p, T] of taken) {
        const one = T.every(x => x && T[0] && x.join() === T[0].join());
        if (one || !M.banks) { const w = T.find(Boolean); for (let s = 0; s < 4; s++) R.w32(M.blobs.pal + 16 * p + 4 * s, w[s]); }
        else banked.push(p);
    }
    stats['palettes_free'] = free.filter(p => !taken.has(p)).length; stats['palettes taken for new colours'] = taken.size;
    if (banked.length) stats['palettes banked per screen'] = banked.length;
    const choose = (player, sh, c) => {
        const f = freshPal.get((sh ? 'n ' : 'z ') + c);
        if (f !== undefined) return f;
        let p = pick(player, sh, c);
        if (p === null) { const by = AV[player ? 1 : 0][sh]; p = pick(player, sh, nearest(by, c)); inc('slot pixels short of a colour'); }
        return p;
    };

    // ---- banks (dev33): count, the palettes' Color RAM addresses, then per bank its palettes (base words where not taken)
    if (banked.length) {
        banked.sort((a, b) => a - b);
        const n = banked.length, data = new Uint8Array(4 * n + 16 * n * NB), dv = new DataView(data.buffer);
        banked.forEach((p, k) => dv.setUint32(4 * k, 0x03000000 + CRAM + 16 * p, true));
        for (let b = 0; b < NB; b++) banked.forEach((p, k) => { const T = taken.get(p); for (let s = 0; s < 4; s++) dv.setUint32(4 * n + 16 * (n * b + k) + 4 * s, T[b] ? T[b][s] : R.u32(M.blobs.pal + 16 * p + 4 * s), true); });
        const at = blob(data);
        R.w32(M.banks.at, n); R.w32(M.banks.at + 4, at);
        for (let b = 0; b < NB; b++) R.w32(M.banks.at + 8 + 4 * b, at + 4 * n + 16 * n * b);
    }

    // ---- painted cells: each block is copied with the new images appended
    const blocks = new Map();
    const cellsDone = [];
    for (const P of cplan) {
        for (const [i, sh, c] of P.need) P.img[i] = choose(false, sh, c);
        let B = blocks.get(P.C.block);
        if (!B) {
            B = { C: P.C, imgs: [], have: new Map() };
            for (let k = 0; k < P.C.nimg; k++) B.imgs.push(Array.from({ length: 64 }, (_, i) => R.u8(P.C.img + 64 * k + i)));
            blocks.set(P.C.block, B);
        }
        const id = P.img.join(',');
        let slot = B.have.get(id);
        if (slot === undefined) {
            if (B.imgs.length >= 96) { inc('painted cells left out: no slot'); continue; }
            slot = B.imgs.length; B.imgs.push(P.img); B.have.set(id, slot);
        }
        cellsDone.push({ P, slot });
    }
    for (const [name, B] of blocks) {
        const bytes = new Uint8Array(64 * B.imgs.length); B.imgs.forEach((im, k) => bytes.set(im, 64 * k));
        const at = blob(bytes);
        if (name.startsWith('sky:')) { const st = B.C.st; R.w32(M.stages.at + 16 * st + 8, at); R.w32(M.stages.at + 16 * st + 12, bytes.length >> 1); }
        else { const rec = name === 'boot' ? M.cellsets.boot.imgrec : M.tcourt.imgrec; R.w32(rec, at); R.w32(rec + 4, bytes.length >> 1); }
        stats['cell images ' + name] = B.imgs.length;
    }
    for (const { P, slot } of cellsDone) {
        const X = P.X, s0 = P.C.slot0;
        if (X.kind === 'sky') {
            if (slot > 255) { inc('painted cells left out: no slot'); continue; }
            R.w32(X.at, ((X.x & 0x00FFFFFF) | slot << 24) >>> 0);
        } else {
            const pix = (P.opq ? 0xC000 : 0x8000) | (s0 + slot);
            R.w16(X.kind === 'rec8' ? X.at + 4 : X.at, pix);
        }
        inc('cells painted');
    }

    // ---- painted entries
    for (const { i, K, px, E, was, want, best, need, player, opq } of plan) {
        const hw = [];
        for (const [j, sh, c] of need) {
            if (sh < 0) { hw.push(j << 8 | c); continue; }
            hw.push(j << 8 | choose(player, sh, c));
        }
        let off = 0;
        if (hw.length) {
            off = putList(hw);
            if (off === null) { inc('tiles left out: data area full'); continue; }
        }
        const fill = px.some(c => c != null) ? 0 : E.fill;
        R.w32(M.blobs.vals + 4 * i, ((best | fill << 6 | hw.length << 7 | off << 14) >>> 0) | (opq ? 0x80000000 : 0));
        if (opq && !E.opq) inc('entries made opaque');
        // where an edge pixel changed color, that side names the nearest material (never the outline)
        if (E.edges !== M.title_mark && mats.length) {
            const sides = [[0, 1, 2, 3, 4, 5, 6, 7], [56, 57, 58, 59, 60, 61, 62, 63], [0, 8, 16, 24, 32, 40, 48, 56], [7, 15, 23, 31, 39, 47, 55, 63]];
            let edges = E.edges;
            sides.forEach((idx, side) => {
                if (!idx.some(j => px[j] && px[j] !== was[j])) return;
                const cnt = new Map();
                for (const j of idx) {
                    const v = val(K.t, j); if (!v || typeof want[j] !== 'string') continue;
                    let bm = null, bd = Infinity;
                    for (const m of mats) { const d = dist(V.pal(m.p, shadeOf(0x6C, v)), want[j]); if (d < bd) { bd = d; bm = m.nib; } }
                    if (bm !== M.outline) cnt.set(bm, (cnt.get(bm) || 0) + 1);
                }
                const tp = [...cnt].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
                edges = (edges & ~(15 << (4 * side))) | ((tp ? tp[0] : 0) << (4 * side));
            });
            if (edges !== E.edges) { R.w16(M.blobs.edges + 2 * i, edges); inc('edges changed'); }
        }
        inc('entries painted');
    }
    stats['data bytes'] = 2 * beyond + (pkg.data.end - top);
    return { rom, stats, blobs: {} };
}
