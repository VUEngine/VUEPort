/**
 * Checks the VB Color package path the color editor builds on. Every package the patch catalog names for a colorization
 * must read. Given its game's ROM (VBC_ROM_DIR, a directory of ROMs, matched by CRC32) it must also index its load
 * positions, compile without paint to exactly the ROM the shipped BPS makes, and compile a paint layer into a ROM that
 * shows the painted colors. Without VBC_ROM_DIR only the reading is checked.
 * Usage: [VBC_ROM_DIR=~/Downloads/ROMS] node tests/vb-color-package-probe.mjs
 */
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ext = '../';
const { PATCH_DATABASE } = require(ext + 'lib/common/emulator-patch-database.js');
const { applyRomPatch } = require(ext + 'lib/common/emulator-rom-patches.js');
const { crc32 } = require(ext + 'lib/common/emulator-cheat-database.js');
const pkgs = require(ext + 'lib/common/vb-color-package.js');
const exchange = require(ext + 'lib/browser/color/emulator-color-exchange.js');
const { colorPackageFile } = require(ext + 'lib/common/vb-color-package-file.js');

let failures = 0;
function check(label, actual, expected) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures++;
        console.log(`  FAIL ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
}

const data = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', 'data');
const romDir = process.env.VBC_ROM_DIR;
const roms = new Map();
if (romDir && existsSync(romDir)) {
    for (const name of readdirSync(romDir)) {
        if (!name.endsWith('.vb')) continue;
        const bytes = new Uint8Array(readFileSync(path.join(romDir, name)));
        roms.set(crc32(bytes).toString(16).padStart(8, '0'), bytes);
    }
}

// a package that carries its paint (`paint`, as the editor's Export Package writes it, with the edit document in `edit`)
// compiles to the painted ROM by itself, and Import Package reads the paint back as it was
async function checkCarried(id, file, original, layer, paintedRom, runtime) {
    const raw = await exchange.readRawColorPackage(new Uint8Array(readFileSync(file)), runtime);
    const edited = exchange.editedColorPackage(raw, layer, exchange.documentEdit({ format: 'vueport-color-edit', version: 1, paint: layer,
        sheets: [{ id: 'own-1', name: 'Mine', folder: 'My sheets', kind: 'figures', w: 8, h: 8, items: [] }] }, { patch: id, version: raw.version }));
    const carried = pkgs.compileColorPackage(edited, original);
    check(`${id}: a package with the paint in it compiles to the painted ROM`, Buffer.compare(Buffer.from(carried.rom), Buffer.from(paintedRom)), 0);
    const work = exchange.importedColorWork(raw, JSON.parse(JSON.stringify(edited)), false);
    check(`${id}: importing it gives the paint back`, [work.sameBase, JSON.stringify(work.paint.tiles), work.counts.sheets],
        [true, JSON.stringify(layer.tiles), 1]);
}

/**
 * A pixel the game leaves transparent (value 0), painted where the package's runtime can draw it opaque
 * (index.paintsTransparent): the build shows it in the paint, the character's other value-0 pixels stay transparent, and
 * erasing it gives the unpainted look back. Where the runtime cannot (Hyper Fighting's fighters, Golf's frame buffer
 * sprites, runtimes that ignore the OPQ bit, model packages), the editor keeps such pixels unpaintable.
 */
function checkTransparent(id, pkg, original, index, plainRom, entity) {
    const candidates = entity ? [{ key: entity.key, tile: entity.content, way: entity.ways[0] }]
        : [...index.allPositions()].map(p => ({ key: p.key, tile: p.tile, way: (index.waysOf(p.tile)[0] ?? '0/0/e4') }));
    const zero = t => { for (let i = 0; i < 64; i++) if (!pkgs.colorPixelValue(t, i)) return i; return -1; };
    const look0 = index.shown(plainRom);
    const pos = candidates.find(p => p.tile.some(b => b) && zero(p.tile) >= 0 && index.paintsTransparent(p.key)
        && look0(p.key, pkgs.colorLitWay(p.way))?.[zero(p.tile)]?.[2] === null);
    if (!pos) {
        console.log('  (no character whose value-0 pixels can be painted)');
        return;
    }
    const way = pkgs.colorLitWay(pos.way), at = zero(pos.tile);
    const px = new Array(64).fill(null); px[at] = '#00ff7f';
    const painted = pkgs.compileColorPackage(pkg, original, { tiles: { [pos.key]: { [way]: px } } });
    const shown = index.shown(painted.rom)(pos.key, way);
    check(`${id}: a value-0 pixel painted shows its paint (${pos.key})`, shown?.[at]?.[2], '#00ff7f');
    const before = look0(pos.key, way);
    const others = shown.filter(([v], i) => !v && i !== at && before[i][2] === null).every(([, , c]) => !c);
    check(`${id}: the character's other value-0 pixels stay transparent`, others, true);
    const erased = new Array(64).fill(null); erased[at] = '';
    const back = pkgs.compileColorPackage(pkg, original, { tiles: { [pos.key]: { [way]: erased } } });
    check(`${id}: erased, it is transparent again`, index.shown(back.rom)(pos.key, way)?.[at]?.[2] ?? null, null);
}

/**
 * A context package's sheet parts at BG map cells the context colors per cell (its map rule 'const' or 'table', its cell
 * requests) are out of reach of the character's paint, so each has a cell key (index.contextCellKey):
 * '<ctx>:m:<map>:<chr>' on a map without cell requests, '<ctx>:c:<map>:<cell>:<chr>' on a map with them. One of each
 * kind is painted and must show its paint as the editor reads it (index.shown) and as the game draws the cell
 * (contextCellShown, else by character), in the map-wide case at another cell of the character too. Value 0 is not
 * paintable there.
 */
function checkContextCells(id, pkg, original, index, plainRom) {
    const cellLook = index.contextCellShown(plainRom);
    let byCell = 0, keyed = 0;
    const pick = { m: null, c: null }, cellsOf = new Map();
    for (const sheet of pkg.sheets ?? []) {
        for (const item of sheet.items) {
            for (const [, , key, , , way, cell] of item.parts) {
                if (cell === undefined || !way.startsWith('0/')) continue;
                const shown = cellLook(key, cell, way);
                if (!shown) continue;
                // overlay characters whose content changes while it shows (its text page) are shown but not paintable
                if (index.groupOf(key)?.startsWith('overlay:') && !(index.entity(key) && !index.entity(key).anyContent)) continue;
                byCell++;
                const cellKey = index.contextCellKey(key, cell);
                if (!cellKey) continue;
                keyed++;
                const kind = cellKey.split(':')[1];
                if (kind === 'm') cellsOf.set(cellKey, [...cellsOf.get(cellKey) ?? [], cell]);
                if (!pick[kind] && shown.filter(([v, s]) => v && s).length >= 16) pick[kind] = { key, cell, way, cellKey };
            }
        }
    }
    console.log(`  sheet parts at cells colored per cell: ${byCell}, paintable by cell key: ${keyed}`);
    check(`${id}: every part at a cell colored per cell has a cell key`, keyed, byCell);
    const colors = ['#ff00ff', '#00ff7f', '#ffd700'];
    for (const p of Object.values(pick).filter(Boolean)) {
        const tile = index.contentOf(p.key);
        const px = Array.from({ length: 64 }, (_, i) => colors[pkgs.colorPixelValue(tile, i) - 1] ?? null);
        const painted = pkgs.compileColorPackage(pkg, original, { tiles: { [p.cellKey]: { [p.way]: px } } });
        const want = (shown) => shown?.filter(([v, s]) => v && s).every(([v, , c]) => c === colors[v - 1]);
        check(`${id}: a cell key painted shows its paint (${p.cellKey})`, want(index.shown(painted.rom)(p.cellKey, p.way)), true);
        const game = cells => cells.map(cell => index.contextCellShown(painted.rom)(p.key, cell, p.way) ?? index.shown(painted.rom)(p.key, p.way));
        const others = (cellsOf.get(p.cellKey) ?? []).filter(cell => cell !== p.cell).slice(0, 3);
        check(`${id}: the game draws the painted cell${others.length ? ` and ${others.length} more of the character in its map` : ''} so`,
            game([p.cell, ...others]).every(want), true);
        check(`${id}: value 0 of a cell key is not paintable`, index.paintsTransparent(p.cellKey), false);
    }
    check(`${id}: a map-wide and a per-cell key found`, [!!pick.m, !!pick.c], [true, true]);
}

let read = 0, built = 0;
for (const entry of PATCH_DATABASE) {
    for (const patch of entry.patches) {
        if (patch.type !== 'vb-color') continue;
        // the package the catalog names next to the BPS (a Japanese build has its own, vb-color-japan.vbcpkg)
        if (!patch.package) continue;
        const file = path.join(data, patch.package);
        if (!existsSync(file)) continue;
        console.log(`\n${patch.id}`);
        const published = colorPackageFile(patch.package);
        check(`${patch.id}: listed as published`, !!published, true);
        const runtime = published?.runtime ? new Uint8Array(readFileSync(path.join(data, published.runtime))) : undefined;
        const pkg = await pkgs.readColorPackage(new Uint8Array(readFileSync(file)), runtime);
        read++;
        check(`${patch.id}: format`, pkg.format, pkgs.COLOR_PACKAGE_FORMAT);
        const original = entry.crc32.map(c => roms.get(c)).find(Boolean);
        if (!original) { console.log('  (no ROM: reading only)'); continue; }

        const shipped = applyRomPatch(original, new Uint8Array(readFileSync(path.join(data, patch.file))));
        const plain = pkgs.compileColorPackage(pkg, original);
        check(`${patch.id}: compiles to the shipped ROM`, Buffer.compare(Buffer.from(plain.rom), Buffer.from(shipped)), 0);

        if (pkg.kind === 'models') {
            const model = pkg.models.find(m => m.kind === 'object');
            const painted = pkgs.compileColorPackage(pkg, original, { tiles: {}, models: { [model.edges]: { edges: { 0: '#ff0000' } } } });
            check(`${patch.id}: an edge painted takes one palette`, painted.stats.palettes_used, 1);
            check(`${patch.id}: and changes the ROM`, Buffer.compare(Buffer.from(painted.rom), Buffer.from(shipped)) !== 0, true);
            continue;
        }
        const index = new pkgs.ColorPackageIndex(pkg, original);
        check(`${patch.id}: kind`, index.kind, pkg.contexts ? 'contexts' : 'load-source');
        if (index.kind === 'contexts') {
            const groups = index.groups();
            // plus one per shared group and one per overlay id (Dragon Hopper's pause, menus, dialog box)
            check(`${patch.id}: a group per context`, groups.length, pkg.contexts.length + (pkg.shared?.length ?? 0) + new Set((pkg.overlays ?? []).map(o => o.id)).size);
            const entity = groups.flatMap(g => index.sections(g.id)).flatMap(s => s.entities).find(e => e.ways.length && !e.anyContent);
            check(`${patch.id}: a context character with a way`, !!entity, true);
            if (entity) {
                checkTransparent(patch.id, pkg, original, index, plain.rom, entity);
                const painted = pkgs.compileColorPackage(pkg, original, { tiles: { [entity.key]: { [entity.ways[0]]: new Array(64).fill('#ff00ff') } } });
                check(`${patch.id}: painting it changes the build`, Buffer.compare(Buffer.from(painted.rom), Buffer.from(plain.rom)) !== 0, true);
                await checkCarried(patch.id, file, original, { tiles: { [entity.key]: { [entity.ways[0]]: new Array(64).fill('#ff00ff') } } }, painted.rom, runtime);
            }
            // BG parts at cells of a map the context rules without a cell request: on a 'chr' map the cell shows its
            // character's colors, on a 'const' map the map's palette for that selector regardless of the character
            // (the editor once showed the character colors there, Dragon Hopper's title came out blue)
            const cellLook = index.contextCellShown(plain.rom);
            const contexts = new Map(pkg.contexts.map(C => [C.id, C]));
            const requested = new Map();
            let chrCells = 0, chrWrong = 0, constCells = 0, constWrong = 0;
            for (const sheet of pkg.sheets ?? []) {
                for (const item of sheet.items) {
                    for (const [, , key, , , way, cell] of item.parts) {
                        const C = way.startsWith('0/') && cell !== undefined ? contexts.get(Number(key.split(':')[0])) : undefined;
                        const rule = C?.maps?.find(R => R.map === cell >> 12);
                        if (!rule) continue;
                        if (!requested.has(C.id)) requested.set(C.id, new Set((C.cells ?? []).map(([m, c]) => m * 4096 + c)));
                        if (requested.get(C.id).has(cell)) continue;
                        const shown = cellLook(key, cell, way);
                        if (rule.mode === 'chr') {
                            chrCells++;
                            chrWrong += shown === undefined ? 0 : 1;
                        }
                        const selector = Number(way.split('/')[1]);
                        // only the shades the map's palette names, the compiler fills the others
                        const palette = new Map(rule.mode === 'const' ? rule.want.filter(([s]) => s === selector).map(([, shade, color]) => [shade, color]) : []);
                        if (palette.size) {
                            constCells++;
                            constWrong += shown && shown.every(([value, shade, color]) => !value || !palette.has(shade) || palette.get(shade) === color) ? 0 : 1;
                        }
                    }
                }
            }
            check(`${patch.id}: sheet cells of 'chr' maps show their characters (${chrCells})`, chrWrong, 0);
            check(`${patch.id}: sheet cells of 'const' maps show the map's palette (${constCells})`, constWrong, 0);
            checkContextCells(patch.id, pkg, original, index, plain.rom);
            built++;
            continue;
        }
        // Mario's Tennis (layout 'mt') paints into the engine's own tables and has no units: painting a load
        // position must change the build
        if (pkg.layout === 'mt') {
            const pos = index.allPositions().find(p => p.tile.some(b => b));
            check(`${patch.id}: a load position with a tile`, !!pos, true);
            if (pos) {
                const painted = pkgs.compileColorPackage(pkg, original, { tiles: { [pos.key]: { '0/0/e4': new Array(64).fill('#ff00ff') } } });
                check(`${patch.id}: painting it changes the build`, Buffer.compare(Buffer.from(painted.rom), Buffer.from(plain.rom)) !== 0, true);
            }
            checkTransparent(patch.id, pkg, original, index, plain.rom);
            built++;
            continue;
        }
        const tiles = new Map();
        for (const p of index.allPositions()) if (!tiles.has(pkgs.colorTileId(p.tile))) tiles.set(pkgs.colorTileId(p.tile), p);
        let pos = null, way = null;
        for (const side of ['1/', '0/']) {                      // an object's, else a cell's
            for (const unit of pkg.units) {                     // by tile (Mario Clash) or by load position (Teleroboxer)
                const cand = unit.ctx.map(([w]) => w).find(w => w.startsWith(side));
                const p = cand && (unit.id.includes(':') ? index.position(unit.id) : tiles.get(unit.id));
                if (p && p.tile.some(b => b)) { pos = p; way = cand; break; }
            }
            if (pos) break;
        }
        check(`${patch.id}: a drawn load position found`, !!pos, true);
        if (!pos) continue;
        check(`${patch.id}: positionsOf finds it`, index.positionsOf(pos.tile).some(p => p.key === pos.key), true);
        check(`${patch.id}: waysOf lists the way`, index.waysOf(pos.tile).includes(way), true);

        const groups = index.groups();
        let listed = 0, wayless = 0, misplaced = 0;
        for (const group of groups) {
            for (const section of index.sections(group.id)) {
                listed += section.entities.length;
                wayless += section.entities.filter(e => !e.ways.length).length;
                if (process.env.WAYLESS) for (const e of section.entities.filter(e => !e.ways.length).slice(0, 3)) console.log('  wayless', group.id, e.key);
                misplaced += section.entities.filter(e => index.groupOf(e.key) !== group.id).length;
            }
        }
        // stand-in tables hold no game tiles and are not in the tree
        const standIn = new Set((pkg.tables ?? []).filter(t => t.stand_in && !t.swatch).map(t => t.name));
        const nonBlank = [...index.allPositions()].filter(p => p.tile.some(b => b) && !standIn.has(p.table)).length;
        check(`${patch.id}: the tree lists every non-blank load position`, listed, nonBlank);
        check(`${patch.id}: group sizes add up`, groups.reduce((n, g) => n + g.size, 0), nonBlank);
        check(`${patch.id}: each in its group`, misplaced, 0);
        check(`${patch.id}: each with a way it is drawn`, wayless, 0);
        check(`${patch.id}: an entity by its key`, index.entity(pos.key)?.key, pos.key);

        // paint every drawn pixel magenta; pixels the way puts at shade 0 keep their color because shade 0 is shared
        // and the paint applies to the lit pixel
        const before = index.shown(plain.rom)(pos.key, way);
        const px = before.map(([v]) => (v ? '#ff00ff' : null));
        const painted = pkgs.compileColorPackage(pkg, original, { tiles: { [pos.key]: { [way]: px } } });
        const after = index.shown(painted.rom)(pos.key, way);
        check(`${patch.id}: painted pixels show the paint`, after.filter(([v, s]) => v && s).every(([, , c]) => c === '#ff00ff'), true);
        check(`${patch.id}: the BPS round trip`, Buffer.compare(Buffer.from(applyRomPatch(original, pkgs.colorBuildPatch(pkg, original, painted.rom))), Buffer.from(painted.rom)), 0);
        await checkCarried(patch.id, file, original, { tiles: { [pos.key]: { [way]: px } } }, painted.rom, runtime);
        checkTransparent(patch.id, pkg, original, index, plain.rom);
        built++;
    }
}
console.log(`\n${read} packages read, ${built} built and painted${romDir ? '' : ' (set VBC_ROM_DIR to build them)'}`);
check('at least one package', read > 0, true);
if (failures) {
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
}
console.log('\nall checks passed');
