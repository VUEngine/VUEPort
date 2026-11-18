// @ts-nocheck
/* eslint-disable */
// Generated from VB Patches/_tools/vbcpkg/models.mjs by sync-vueport.mjs: change it there, not here.
// no imports, so it runs in a browser and as VUEPort's TypeScript copy unchanged; data area layout and paint format:
// README.md, "Model packages"

export function modelRamp(color) {
    const v = parseInt(String(color).replace('#', ''), 16);
    const c = [v >> 16 & 255, v >> 8 & 255, v & 255];
    const f = k => '#' + c.map(x => Math.round(x * k).toString(16).padStart(2, '0')).join('');
    return [f(0.4), f(0.7), f(1)];        // far, mid, near: the game's shades 1..3
}

function rampOf(paint, four = false) {
    if (typeof paint === 'number') return paint;
    if (Array.isArray(paint)) return paint.length === 4 ? (four ? [...paint] : [paint[0], paint[2], paint[3]]) : paint;
    return modelRamp(paint);
}

const hex = v => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0');
const num = v => typeof v === 'number' ? v >>> 0 : parseInt(v, 16) >>> 0;

export function compileModels(pkg, original, opts, h) {
    if (original.length !== pkg.original.size || h.hex8(h.crc32(original)) !== pkg.original.crc32)
        throw new Error(`this ROM is not the package's original (${pkg.game})`);
    if (pkg.layout === 'zr') return compileZr(pkg, original, opts, h);
    const rom = h.bpsApply(original, h.b64(pkg.runtime.bps));
    const mask = rom.length - 1, off = a => (a >>> 0) & mask;
    const stats = { models: 0, edges: 0, paintedEdges: 0, palettes: 0, palettes_used: 0, palettes_free: 0, palettes_short: 0 };
    const u16 = a => original[off(a)] | original[off(a) + 1] << 8;
    const D4 = pkg.data.depth4, four = !!D4;

    const classes = { ...pkg.classes, debrisC: [...pkg.classes.debrisC], debrisD: [...pkg.classes.debrisD] };
    const sites = new Map(pkg.sites.map(([s, p]) => [num(s), p]));
    const edgePaint = new Map();
    const palettes = new Map();
    for (const layer of opts.paint || []) {
        for (const [k, v] of Object.entries(layer.classes || {})) classes[k] = Array.isArray(v) && k.startsWith('debris') && v.length === 12 ? [...v] : v;
        for (const [s, p] of Object.entries(layer.sites || {})) sites.set(num(s), p);
        for (const [list, m] of Object.entries(layer.models || {})) {
            const a = num(list), n = u16(a);
            if (!pkg.models.some(x => num(x.edges) === a)) throw new Error('paint for an unknown model ' + list);
            const t = edgePaint.get(a) || new Array(n).fill(undefined);
            for (const [i, p] of Object.entries(m.edges || {})) {
                if (+i < 0 || +i >= n) throw new Error(`edge ${i} of ${list} (${n} edges)`);
                t[+i] = p === null ? undefined : rampOf(p, four);
            }
            edgePaint.set(a, t);
        }
        for (const [i, cols] of Object.entries(layer.palettes || {})) palettes.set(+i, cols);
    }
    const free = [...(pkg.free_palettes || [])];
    const byRamp = new Map();
    const flags4 = new Set();
    const palOf = ramp => {
        if (typeof ramp === 'number') return ramp & 0xFF;
        const key = ramp.join(',').toLowerCase();
        if (byRamp.has(key)) return byRamp.get(key);
        if (ramp.length === 4) {
            const k = [...free].reverse().find(q => [1, 2, 3].every(d => free.includes(q + d)));
            if (k === undefined) { stats.palettes_short += 4; return 0; }
            for (let d = 0; d < 4; d++) { free.splice(free.indexOf(k + d), 1); palettes.set(k + d, ['#000000', ...Array(3).fill(ramp[3 - d])]); }
            byRamp.set(key, k); flags4.add(k);
            return k;
        }
        const p = free.shift();
        if (p === undefined) { stats.palettes_short++; return 0; }
        byRamp.set(key, p); palettes.set(p, ['#000000', ...ramp]);
        return p;
    };
    const painted0 = [...edgePaint].sort((x, y) => x[0] - y[0]);
    const tables = painted0.map(([list, t]) => [list, Uint8Array.from(t, r => r === undefined ? 0 : palOf(r))]);
    for (const k of ['fixed', 'scenery']) if (typeof classes[k] !== 'number') classes[k] = palOf(rampOf(classes[k], four && k === 'scenery'));
    if (classes.debris !== undefined) {
        const r = rampOf(classes.debris);
        const dim = k => typeof r === 'number' ? r
            : r.map(c => '#' + [1, 3, 5].map(i => Math.round(parseInt(c.slice(i, i + 2), 16) * k).toString(16).padStart(2, '0')).join(''));
        // life bands 1-5, 6-10, 11+, darker as the debris ages
        const bands = [palOf(dim(0.5)), palOf(dim(0.75)), palOf(r)];
        classes.debrisC = Array.from({ length: 12 }, (_, i) => bands[i % 3]);
        classes.debrisD = [...classes.debrisC];
        delete classes.debris;
    }
    stats.palettes_used = byRamp.size + 3 * flags4.size; stats.palettes_free = free.length; stats.ramps4 = flags4.size;

    // data area: 64-byte directory, then depth4, site table, zero block, model table and per-edge color tables
    const D = pkg.data, at = num(D.at), end = num(D.end);
    const w8 = (a, v) => { rom[off(a)] = v & 0xFF; };
    const w32 = (a, v) => { for (let k = 0; k < 4; k++) rom[off(a) + k] = (v >>> (8 * k)) & 0xFF; };
    for (let a = at; a < end; a++) if (rom[off(a)] !== 0xFF) throw new Error('data area not empty at ' + hex(a));
    for (let a = at; a < at + 64; a++) w8(a, 0);
    let p = at + 64;
    if (D4) {
        if (num(D4.at) !== p) throw new Error('depth4 must follow the directory');
        for (let q = 0; q < 256; q++) w8(num(D4.flags) + q, flags4.has(q) ? 1 : 0);      // four-step ramp starts here
        // per routine a bucket per zsum >> 3: the number of thresholds passed
        for (const t of Object.values(D4.tables))
            for (let i = 0; i < t.count; i++) w8(num(t.at) + i, t.thresholds.filter(z => i * D4.step >= z).length);
        p += D4.size;
    }
    const siteList = [...sites].sort((x, y) => x[0] - y[0]);
    if (!siteList.length || siteList[0][0] !== 0) throw new Error('the site table must start at 0');
    const siteAt = p; w32(p, siteList.length); p += 4;
    for (const [s, pal] of siteList) { w32(p, s); w32(p + 4, pal & 0xFF); p += 8; }
    const zeroAt = p; for (let k = 0; k < D.zero; k++) w8(p + k, 0); p += (D.zero + 3) & ~3;
    const painted = tables.filter(([, t]) => t.some(x => x));
    const modelAt = p; w32(p, painted.length); p += 4 + 8 * painted.length;
    painted.forEach(([list, t], k) => {
        w32(modelAt + 4 + 8 * k, list); w32(modelAt + 8 + 8 * k, p);
        t.forEach((v, i) => w8(p + i, v)); p += (t.length + 1) & ~1;
        stats.paintedEdges += t.filter(x => x).length;
    });
    if (p > end) throw new Error(`data area overflow: ${hex(p)} > ${hex(end)}`);
    w32(at, siteAt); w32(at + 4, modelAt); w32(at + 8, zeroAt); w8(at + 12, classes.fixed); w8(at + 13, classes.scenery);
    classes.debrisC.forEach((v, i) => w8(at + 16 + i, v)); classes.debrisD.forEach((v, i) => w8(at + 28 + i, v));

    // palettes are four RGB888 words each (xxxxxxxx BBBBBBBB GGGGGGGG RRRRRRRR)
    const P = pkg.palette_table;
    for (const [i, cols] of palettes) {
        if (i < 0 || i >= P.count) throw new Error('palette ' + i);
        cols.forEach((c, s) => {
            const v = parseInt(c.replace('#', ''), 16), r = v >> 16 & 255, g = v >> 8 & 255, b = v & 255;
            w32(num(P.at) + 16 * i + 4 * s, r | g << 8 | b << 16);
        });
        stats.palettes++;
    }
    stats.models = pkg.models.length; stats.edges = pkg.models.reduce((s, m) => s + (m.count || 0), 0);
    stats.dataUsed = p - at;
    return { rom, stats, blobs: {} };
}

// Zero Racers (layout "zr"): the runtime tags each copied line with a palette from a per-model default and a per-model
// span of (line, palette) overrides, first match wins; painting a line topology writes a new span for every member
// model (painted lines first, then its old overrides; identical spans shared), unpainted nothing is written
function compileZr(pkg, original, opts, h) {
    const rom = h.bpsApply(original, h.b64(pkg.runtime.bps));
    const mask = rom.length - 1, off = a => (a >>> 0) & mask;
    const stats = { models: pkg.models.length, edges: 0, paintedEdges: 0, paintedModels: 0, palettes: 0, palettes_used: 0, palettes_free: 0, palettes_short: 0 };
    const Z = pkg.zr, spans = num(Z.spans), ovr = num(Z.overrides);
    // entries are keyed by their `edges` string, a list address plus ':<count>' where models read only the first lines
    // of a list that another entry reads in full
    const key = k => /:/.test(k) ? String(k).toUpperCase().replace(/^0X/, '0x') : hex(num(k));
    const byList = new Map(pkg.models.map(m => [key(m.edges), m]));
    const edgePaint = new Map(), palettes = new Map();
    for (const layer of opts.paint || []) {
        for (const [list, m] of Object.entries(layer.models || {})) {
            const entry = byList.get(key(list));
            if (!entry) throw new Error('paint for an unknown model ' + list);
            const t = edgePaint.get(entry) || new Array(entry.count).fill(undefined);
            for (const [i, p] of Object.entries(m.edges || {})) {
                if (+i < 0 || +i >= entry.count) throw new Error(`line ${i} of ${list} (${entry.count} lines)`);
                t[+i] = p === null ? undefined : rampOf(p);
            }
            edgePaint.set(entry, t);
        }
        for (const [i, cols] of Object.entries(layer.palettes || {})) palettes.set(+i, cols);
    }
    const free = [...(pkg.free_palettes || [])], byRamp = new Map();
    const palOf = ramp => {
        if (typeof ramp === 'number') return ramp & 0xFF;
        const key = ramp.join(',').toLowerCase();
        if (byRamp.has(key)) return byRamp.get(key);
        const p = free.shift();
        if (p === undefined) { stats.palettes_short++; return -1; }
        // the game shades by kind, not distance: track lines use entry 1, machines 3 (race, selected) or 2 (not
        // selected), so entry 1 gets the near color and the far color goes unused
        byRamp.set(key, p); palettes.set(p, ['#000000', ramp[2], ramp[1], ramp[2]]);
        return p;
    };
    const D = pkg.data, at = num(D.at), end = num(D.end);
    for (let a = at; a < end; a++) if (rom[off(a)] !== 0xFF) throw new Error('data area not empty at ' + hex(a));
    const written = new Map();
    let p = at;
    const painted = [...edgePaint].filter(([, t]) => t.some(x => x !== undefined)).sort((x, y) => x[0].model - y[0].model);
    for (const [entry, t] of painted) {
        const lines = t.map((r, i) => [i, r === undefined ? -1 : palOf(r)]).filter(([, pal]) => pal >= 0);
        stats.paintedEdges += lines.length; stats.paintedModels++;
        const mine = new Set(lines.map(([i]) => i));
        for (const model of entry.members) {
            const s = spans + 4 * model, o0 = rom[off(s)] | rom[off(s) + 1] << 8, n0 = rom[off(s) + 2] | rom[off(s) + 3] << 8;
            const old = [];
            for (let k = 0; k < n0; k++) old.push([rom[off(ovr + 2 * (o0 + k))], rom[off(ovr + 2 * (o0 + k) + 1)]]);
            const list = [...lines, ...old.filter(([i]) => !mine.has(i))];
            const key = list.map(([i, q]) => i + ':' + q).join(',');
            let o = written.get(key);
            if (o === undefined) {
                if (p + 2 * list.length > end) throw new Error(`data area overflow: ${hex(p + 2 * list.length)} > ${hex(end)}`);
                o = (p - ovr) / 2;
                if (o > 0xFFFF || o < 0) throw new Error('span offset out of reach: ' + hex(p));
                list.forEach(([i, q], k) => { rom[off(p + 2 * k)] = i; rom[off(p + 2 * k + 1)] = q; });
                p += 2 * list.length; written.set(key, o);
            }
            rom[off(s)] = o & 0xFF; rom[off(s) + 1] = o >> 8; rom[off(s) + 2] = list.length & 0xFF; rom[off(s) + 3] = list.length >> 8;
        }
    }
    // painted VIP screen cells ('cell#<screen>#<cell>#<character key>') each get a Pixel Color Slot: painted pixels on a
    // [black, c, c, c] palette of their color, the rest 0 (dev99's own color); dev100 applies an entry while the
    // screen's marker is up and the cell still holds its BG map word
    if (pkg.zr_screens && pkg.zr?.paint) {
        const cellPaint = new Map();
        for (const layer of opts.paint || []) {
            for (const [k, ways] of Object.entries(layer.tiles || {})) {
                if (!k.startsWith('cell#')) continue;
                const [, list, cell] = k.split('#');
                const S = pkg.zr_screens[list], e = S?.cells[cell];
                if (!e) throw new Error('paint for an unknown cell ' + k);
                const px = cellPaint.get(list + '#' + cell)?.px || new Array(64).fill(null);
                for (const cols of Object.values(ways || {})) cols.forEach((c, i) => { if (c) px[i] = c; else if (c === '') px[i] = null; });
                cellPaint.set(list + '#' + cell, { S, cell: +cell, e, px, key: k.split('#').slice(3).join('#') });
            }
        }
        // bytes at the character's value-0 pixels never show (no OPQ), so they take the image's main palette and cells
        // painted in one color share a slot whatever their character
        const tileOf = new Map();
        for (const tab of pkg.tables || []) {
            if (tab.decode !== 'bytes' || !tab.screen) continue;
            const d = Uint8Array.from(tab.bytes.match(/../g).map(x => parseInt(x, 16)));
            for (let k = 0; k * 16 < d.length; k++) tileOf.set(tab.key.replace('{i}', String(k)), d.subarray(16 * k, 16 * k + 16));
        }
        const value = (t, i) => ((t[2 * (i >> 3)] | t[2 * (i >> 3) + 1] << 8) >> (2 * (i & 7))) & 3;
        const slotsAt = num(pkg.zr.paint.slots?.at ?? 0), slotsEnd = num(pkg.zr.paint.slots?.end ?? 0);
        const maxSlots = Math.min(1023, Math.floor((slotsEnd - slotsAt) / 64));
        const maxEntries = Math.floor((num(pkg.zr.paint.end) - num(pkg.zr.paint.at) - 32) / 8);
        const entries = [], images = [], byImage = new Map();
        // screens whose marker changes while shown (Name Entry: 2 while editing a letter, else 3) set `any_marker`; their
        // entries get mask 0 and match any marker, though the cell's BG map word still has to match
        const add = (cell, word, marker, px, tile, mask = 0xFF) => {
            let img = px.map(c => { if (!c) return 0; const q = palOf([c, c, c]); return q < 0 ? 0 : q; });
            if (tile) {
                const n = new Map(); img.forEach((q, i) => { if (q && value(tile, i)) n.set(q, (n.get(q) || 0) + 1); });
                const main = [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
                img = img.map((q, i) => value(tile, i) ? q : main);
            }
            const k = img.join(',');
            let slot = byImage.get(k);
            if (slot === undefined) {
                if (images.length >= maxSlots || entries.length >= maxEntries) { stats.cells_short = (stats.cells_short || 0) + 1; return false; }
                images.push(img); slot = images.length; byImage.set(k, slot);
            } else if (entries.length >= maxEntries) { stats.cells_short = (stats.cells_short || 0) + 1; return false; }
            entries.push([cell, word, 0x8000 | slot, marker, mask]);
            return true;
        };
        for (const { S, cell, e, px, key } of [...cellPaint.values()].sort((a, b) => a.S.marker - b.S.marker || a.cell - b.cell)) {
            if (!px.some(Boolean)) continue;
            if (add(cell, e[2], S.marker, px, tileOf.get(key), S.any_marker ? 0 : 0xFF)) stats.paintedCells = (stats.paintedCells || 0) + 1;
        }
        // the right eye uses its own character set, so each of its pixels takes the paint of the left-eye pixel it shows
        const byCell = new Map([...cellPaint.values()].map(v => [v.S.marker + '#' + v.S.name + '#' + v.cell, v.px]));
        for (const [sid, S] of Object.entries(pkg.zr_screens)) {
            for (const [cell, [word, map, ti]] of Object.entries(S.right || {})) {
                const refs = map.split(','), px = refs.map(r => {
                    if (!r) return null; const [c, j] = r.split('.'); return byCell.get(S.marker + '#' + S.name + '#' + c)?.[+j] || null;
                });
                if (!px.some(Boolean)) continue;
                const mapped = refs.filter(Boolean).length, got = px.filter(Boolean);
                const tile = ti === undefined ? null : tileOf.get(`zs:${sid}:${ti}`);
                if (tile && got.length * 2 >= mapped) {
                    const n = new Map(); got.forEach(c => n.set(c, (n.get(c) || 0) + 1));
                    const main = [...n].sort((x, y) => y[1] - x[1])[0][0];
                    px.forEach((c, i) => { if (!c && !refs[i] && value(tile, i)) px[i] = main; });
                }
                add(+cell, word, S.marker, px, tile, S.any_marker ? 0 : 0xFF);
            }
        }
        if (entries.length) {
            const dir = num(pkg.zr.paint.at), ent = dir + 32, img = slotsAt;
            for (let a = dir; a < ent + 8 * entries.length; a++) if (rom[off(a)] !== 0xFF) throw new Error('cell paint area not empty at ' + hex(a));
            for (let a = img; a < img + 64 * images.length; a++) if (rom[off(a)] !== 0xFF) throw new Error('slot image area not empty at ' + hex(a));
            const w8 = (a, v) => { rom[off(a)] = v & 0xFF; };
            const w16 = (a, v) => { w8(a, v); w8(a + 1, v >> 8); };
            const w32 = (a, v) => { w16(a, v & 0xFFFF); w16(a + 2, v >>> 16); };
            let stamp = 2166136261;
            entries.forEach(([c, word, pix, marker, m], k) => {
                const a = ent + 8 * k; w16(a, c); w16(a + 2, word); w16(a + 4, pix); w8(a + 6, marker); w8(a + 7, m);
            });
            images.forEach((im, k) => im.forEach((q, i) => { w8(img + 64 * k + i, q); stamp = Math.imul(stamp ^ (q + k), 16777619) >>> 0; }));
            w32(dir, entries.length); w32(dir + 4, ent); w32(dir + 8, img); w32(dir + 12, images.length); w32(dir + 16, stamp || 1);
            for (let a = dir + 20; a < dir + 32; a++) w8(a, 0);
            stats.cellSlots = images.length;
        }
    }
    stats.palettes_used = byRamp.size; stats.palettes_free = free.length;
    const P = pkg.palette_table;
    for (const [i, cols] of palettes) {
        if (i < 0 || i >= P.count) throw new Error('palette ' + i);
        cols.forEach((c, s) => {
            const v = parseInt(c.replace('#', ''), 16), r = v >> 16 & 255, g = v >> 8 & 255, b = v & 255;
            for (let k = 0; k < 4; k++) rom[off(num(P.at) + 16 * i + 4 * s) + k] = ((r | g << 8 | b << 16) >>> (8 * k)) & 0xFF;
        });
        stats.palettes++;
    }
    stats.edges = pkg.models.reduce((s, m) => s + (m.count || 0), 0);
    stats.dataUsed = p - at;
    return { rom, stats, blobs: {} };
}

// what a Zero Racers ROM shows of its VIP screens' cells (vbcpkg.mjs cellShown / shownPixels hand layout "zr" here):
// the screen's Color RAM as recorded from dev99, the cell's attribute group and a painted cell's slot image from the
// ROM's cell paint (README "Layout zr"); ways are 'side/selector/GPLT'
const zrValue = (t, i) => ((t[2 * (i >> 3)] | t[2 * (i >> 3) + 1] << 8) >> (2 * (i & 7))) & 3;
const zrShade = (plt, v) => (plt >> (2 * v)) & 3;
function zrLook(pkg, rom) {
    const mask = rom.length - 1, off = a => (a >>> 0) & mask;
    const u16 = a => rom[off(a)] | rom[off(a) + 1] << 8, u32 = a => (u16(a) | u16(a + 2) << 16) >>> 0;
    const painted = new Map();
    const dir = pkg.zr?.paint ? num(pkg.zr.paint.at) : 0, n = dir ? u32(dir) : 0;
    if (n && n !== 0xFFFFFFFF) {
        const ent = u32(dir + 4), img = u32(dir + 8);
        for (let k = 0; k < n; k++) {
            const a = ent + 8 * k, slot = u16(a + 4) & 0x3FF;
            painted.set(rom[off(a + 6)] + '#' + u16(a), rom.subarray(off(img + 64 * (slot - 1)), off(img + 64 * (slot - 1)) + 64));
        }
    }
    // screens read against their Color RAM as recorded from dev99
    const crams = new Map(), table = num(pkg.palette_table.at);
    const cramOf = S => { let c = crams.get(S); if (!c) crams.set(S, c = Uint8Array.from(atob(S.cram), x => x.charCodeAt(0))); return c; };
    const colour = (S, q, sh) => {
        const src = q >= (pkg.free_palettes?.[0] ?? 256) ? rom.subarray(off(table + 16 * q), off(table + 16 * q) + 16) : cramOf(S).subarray(16 * q, 16 * q + 16);
        return '#' + [src[4 * sh], src[4 * sh + 1], src[4 * sh + 2]].map(x => x.toString(16).padStart(2, '0')).join('');
    };
    return (S, cell, attr, way, tile) => {
        const [, sel, plt] = String(way).split('/'), s = +sel, p = parseInt(plt, 16);   // 'side/selector/GPLT'
        const img = painted.get(S.marker + '#' + cell), g = attr & 0x1F, out = [];
        for (let i = 0; i < 64; i++) {
            const v = zrValue(tile, i), sh = zrShade(p, v), b = img ? img[i] : 0;
            out.push([v, sh, v ? colour(S, b || g * 4 + s, sh) : null]);
        }
        return out;
    };
}
export function zrCellShown(pkg, original, rom) {
    const look = zrLook(pkg, rom);
    return (lists, cell, way, tile) => {
        for (let k = lists.length - 1; k >= 0; k--) {
            const S = pkg.zr_screens?.[lists[k]], e = S?.cells[String(cell)];
            if (e) return look(S, cell, e[1], way, tile);
        }
        return undefined;
    };
}
export function zrShownPixels(pkg, original, rom) {
    const look = zrLook(pkg, rom), tiles = new Map();
    for (const tab of pkg.tables || []) {
        if (tab.decode !== 'bytes' || !tab.screen) continue;
        const d = Uint8Array.from(tab.bytes.match(/../g).map(x => parseInt(x, 16)));
        for (let k = 0; k * 16 < d.length; k++) tiles.set(tab.key.replace('{i}', String(k)), { S: pkg.zr_screens[tab.screen], t: d.subarray(16 * k, 16 * k + 16), k });
    }
    return (key, way) => {
        const e = tiles.get(key); if (!e) return null;
        return look(e.S, -1, e.S.chr_attr?.[String(e.k)] ?? 0, way, e.t);
    };
}
