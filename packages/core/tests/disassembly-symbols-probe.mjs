// does the Disassembly panel name what it points at, on a real build? The naming is a pure function of listing and
// symbol index (annotateDisassembly), so it runs here without a browser; the standalone web build cannot read the
// files beside a ROM, so there it cannot be seen. Usage: node tests/disassembly-symbols-probe.mjs <rom.vb> <image.elf>
import fs from 'fs';
import path from 'path';

const romPath = process.argv[2];
const elfPath = process.argv[3];
if (!romPath || !elfPath) {
    console.error('Usage: node tests/disassembly-symbols-probe.mjs <rom.vb> <image.elf> [project-root]');
    process.exit(2);
}

let failures = 0;
function check(label, ok, detail) {
    if (!ok) { failures++; }
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : `: ${detail}`}`);
}

const here = path.dirname(new URL(import.meta.url).pathname);
const { readElf } = await import(path.join(here, '../lib/browser/core/emulator-elf.js'));
const { indexElfSymbols, findFunctionAt } =
    await import(path.join(here, '../lib/browser/core/emulator-symbols.js'));
const { annotateDisassembly, attachSourceLines } =
    await import(path.join(here, '../lib/browser/core/emulator-disassembly.js'));
const { makeSourcePathMapper, recordedPathFor } =
    await import(path.join(here, '../lib/browser/core/emulator-line-table.js'));
const { parseDwarfLineTable, sourcePathCandidates } =
    await import(path.join(here, '../lib/browser/core/emulator-line-table.js'));

const image = readElf(new Uint8Array(fs.readFileSync(elfPath)));
if (!image) { throw new Error('That .elf could not be read.'); }
const symbols = indexElfSymbols(image);
console.log(`\n${symbols.codeSymbols.length} functions, ${symbols.dataSymbols.length} data symbols`);
check('the build has functions to name', symbols.codeSymbols.length > 50);
check('and data to name', symbols.dataSymbols.length > 50);

const core = fs.readFileSync(path.join(here, '../wasm/shrooms/core.wasm'));
const { instance } = await WebAssembly.instantiate(core, {
    env: { emscripten_notify_memory_growth: () => { } },
});
const E = instance.exports;
E._initialize();

const rom = fs.readFileSync(romPath);
const romPtr = E.Realloc(0, rom.length);
new Uint8Array(E.memory.buffer, romPtr, rom.length).set(rom);
const sim = E.CreateSim();
if (E.vbSetCartROM(sim, romPtr, rom.length) !== 0) { throw new Error('ROM rejected'); }
E.vbSetCartRAM(sim, E.Realloc(0, 16384), 16384);

// the same sixteen options the worker asks for; see DISASSEMBLY_STYLE
const STYLE = [0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1];
const bytes = new Uint8Array(E.memory.buffer);
const str = slot => {
    const at = new Uint32Array(E.memory.buffer, slot, 1)[0];
    if (at === 0) { return ''; }
    let end = at;
    while (bytes[end] !== 0) { end++; }
    return new TextDecoder().decode(bytes.subarray(at, end));
};

function disassemble(address, count) {
    const dasm = E.Disassemble(...STYLE, sim, address >>> 0, count, 0);
    if (dasm === 0) { return []; }
    const table = E.Realloc(0, count * 17 * 4);
    E.GetDasm(table, dasm, count);
    const words = new Uint32Array(E.memory.buffer, table, count * 17);
    const out = [];
    let z = 0;
    for (let line = 0; line < count; line++) {
        const lineAddress = words[z++];
        const code = new Array(words[z++]);
        for (let y = 0; y < code.length; y++) { code[y] = words[z++]; }
        z += 4 - code.length;
        const isPC = words[z++] !== 0;
        z += 5;
        const mnemonic = str(dasm + words[z++]);
        const operands = new Array(words[z++]);
        for (let y = 0; y < operands.length; y++) { operands[y] = str(dasm + words[z++]); }
        z += 3 - operands.length;
        out.push({ address: lineAddress, code, isPC, mnemonic, operands });
    }
    E.Realloc(table, 0);
    E.Realloc(dasm, 0);
    return out;
}

const romBytes = rom.length;
let headers = 0;
let namedTargets = 0;
let namedLoads = 0;
let adrift = 0;
let strays = 0;
let instructions = 0;
const samples = [];

const functions = symbols.codeSymbols.filter(s => s.size > 4).slice(0, 400);
for (const symbol of functions) {
    const rows = annotateDisassembly(
        disassemble(symbol.address, Math.min(24, Math.ceil(symbol.size / 2))),
        symbols, romBytes);
    for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        instructions++;
        if (row.header) { headers++; }
        if (row.adrift) {
            adrift++;
            // each should sit right after a conditional branch, the only thing the core mis-sizes; anything else
            // means guessing
            const before = rows[index - 1]?.line;
            const opcode = before && before.code.length >= 2
                ? ((before.code[1] << 8) | before.code[0]) >>> 10
                : -1;
            if (opcode < 0x20 || opcode > 0x27) { strays++; }
        }
        namedTargets += row.targets.size;
        if (row.loaded) { namedLoads++; }
        if (samples.length < 14 && (row.targets.size > 0 || row.loaded)) {
            const operands = row.line.operands
                .map((text, index) => row.targets.get(index)?.label ?? text).join(', ');
            samples.push(`${(row.line.address >>> 0).toString(16).toUpperCase()}  `
                + `${row.line.mnemonic.padEnd(7)} ${operands}`
                + (row.loaded ? `   -> ${row.loaded.label}` : ''));
        }
    }
}

console.log(`\n${instructions} instructions over ${functions.length} functions`);
console.log(`  ${headers} function headers, ${namedTargets} named targets, `
    + `${namedLoads} named data loads, ${adrift} lines the core mis-sized\n`);
for (const sample of samples) { console.log(`    ${sample}`); }

console.log('');
// at least one per function, more where a window overran a short routine into the next one
check('every function opened with a header', headers >= functions.length,
    `${headers} of ${functions.length}`);
check('branch and call targets are named', namedTargets > functions.length, String(namedTargets));
check('movhi/movea pairs name what they point at', namedLoads > 0, String(namedLoads));
// a core sizing conditional branches at four bytes instead of two loses the instruction after each (about a seventh
// of this build's listing before vbuCodeSize was fixed). Checks that the listing is whole, and that otherwise the
// panel marks exactly the lines a mis-sizing would produce
check('the listing is in step from end to end', adrift === 0,
    `${adrift} of ${instructions} lines begin inside the line before them `
    + `(${(100 * adrift / instructions).toFixed(1)}%)`);
check('and any line that were not would be one following a branch, not a guess',
    strays === 0, `${strays} of ${adrift} follow something else`);

console.log('\nOne routine, read from its own middle');
{
    const target = functions.find(s => s.size > 40) ?? functions[0];
    const rows = annotateDisassembly(disassemble(target.address, 12), symbols, romBytes);
    const name = rows[0]?.header?.name;
    console.log(`    header: ${name}  (${target.name}, ${target.size} bytes)`);
    check('the header names the routine', typeof name === 'string' && name.length > 0, String(name));
    const inside = rows.flatMap(row => [...row.targets.values()])
        .filter(t => t.label.startsWith('+0x'));
    console.log(`    targets inside it: ${inside.map(t => t.label).join(' ') || 'none'}`);
    check('a jump inside the routine reads as an offset, not a name',
        inside.length === 0 || inside.every(t => /^\+0x[0-9A-F]+$/.test(t.label)),
        JSON.stringify(inside.slice(0, 3)));
}

console.log('\nThe line table, out of .debug_line');
{
    const section = image.section('.debug_line');
    check('the build carries line data', section !== undefined
        && section.byteLength > 0, String(section?.byteLength));

    const started = Date.now();
    const table = parseDwarfLineTable(section, romBytes);
    const took = Date.now() - started;
    console.log(`    ${table.entries.length} rows over ${table.files.length} files, `
        + `read in ${took} ms`);
    check('it decodes to rows', table.entries.length > 1000, String(table.entries.length));
    check('and does not take long enough to be worth caching elsewhere', took < 2000,
        `${took} ms`);

    const target = symbols.codeSymbols.find(s => /_SoundState_destructor$/.test(s.name));
    const at = table.locate((target.address & 0x00ffffff) % romBytes);
    console.log(`    ${target.name} -> ${at ? `${at.file.split('/').slice(-2).join('/')}:${at.line}` : 'nothing'}`);
    check('an address resolves to a source line', at !== undefined);
    const back = at && table.resolve(at.file, at.line);
    check('and that line resolves back to an address', back !== undefined
        && back.offset === at.offset, JSON.stringify(back));

    // a row must never be attributed past the end of its sequence
    const ends = table.entries.filter(entry => entry.end).length;
    console.log(`    ${ends} sequence ends, which is where attribution stops`);
    check('sequences are closed', ends > 0, String(ends));

    console.log('\nA listing with its source');
    const rows = attachSourceLines(
        annotateDisassembly(disassemble(target.address, 16), symbols, romBytes),
        table, romBytes);
    const shown = rows.filter(row => row.source);
    // the text itself, read as a host would, so the numbers can be seen to line up with the file
    const romDir = path.dirname(path.resolve(romPath));
    const cache = new Map();
    const textOf = (file, line) => {
        if (!cache.has(file)) {
            const found = sourcePathCandidates(file, romDir).find(c => fs.existsSync(c));
            cache.set(file, found ? fs.readFileSync(found, 'utf8').split(/\r?\n/) : null);
        }
        const text = cache.get(file);
        return text ? (text[line - 1] ?? '').trim() : undefined;
    };
    for (const row of rows.slice(0, 12)) {
        if (row.source) {
            const text = textOf(row.source.file, row.source.line);
            console.log(`      ${row.source.file.split('/').slice(-1)[0]}:${row.source.line}`
                + (text === undefined ? '' : `   ${text}`));
        }
        console.log(`        ${(row.line.address >>> 0).toString(16).toUpperCase()}  `
            + `${row.line.mnemonic.padEnd(7)} ${row.line.operands.join(', ')}`);
    }
    const withText = shown.filter(row => textOf(row.source.file, row.source.line) !== undefined);
    check('the source text can be read for those lines',
        withText.length === shown.length, `${withText.length} of ${shown.length}`);
    check('the listing is broken into source lines', shown.length > 0, String(shown.length));
    check('but not one per instruction', shown.length < rows.length, `${shown.length} of ${rows.length}`);
    // recorded paths are relative to where the build ran, so a host works it out from the ROM's location; checked here
    // against a real layout
    const romDirectory = path.dirname(path.resolve(romPath));
    const opens = recorded =>
        sourcePathCandidates(recorded, romDirectory).some(candidate => fs.existsSync(candidate));
    const firstMissing = shown.map(row => row.source.file).find(file => !opens(file));
    console.log(`      ${shown[0]?.source.file}`);
    console.log(`      -> ${sourcePathCandidates(shown[0]?.source.file ?? '', romDirectory)
        .find(candidate => fs.existsSync(candidate)) ?? 'nothing'}`);
    check('and the files it names can be found from the ROM', firstMissing === undefined,
        String(firstMissing));
}

// a breakpoint set in an editor: can a breakpoint on a line of the project's own source become an address? The path
// (which the build rewrites) and the line number (which it had better not) both have to line up

if (process.argv[4]) {
    const project = path.resolve(process.argv[4]);
    console.log(`\nBreakpoints by source line, against ${project}`);
    const section = image.section('.debug_line');
    const table = parseDwarfLineTable(section, romBytes);
    const romDirectory = path.dirname(path.resolve(romPath));

    // one root per component, named as the build names it under `working`: the engine's core, every plugin and the
    // project. Extra roots are passed as a fifth argument
    const roots = [{ name: path.basename(project), root: project }];
    for (const extra of process.argv.slice(5)) {
        roots.push({ name: path.basename(path.resolve(extra)), root: path.resolve(extra) });
    }
    console.log(`    roots: ${roots.map(r => r.name).join(', ')}`);
    const mapper = makeSourcePathMapper(roots);

    const own = table.files.filter(file => file.includes('/objects/'));
    const mapped = own.map(file => ({ recorded: file, source: mapper(file) }))
        .filter(entry => entry.source !== entry.recorded);
    console.log(`    ${mapped.length} of ${own.length} compiled files map back to the project`);
    check('the build\'s paths map back to the project\'s own sources', mapped.length > 0,
        String(mapped.length));

    /**
     * How far a line number can be trusted, measured on blank lines: the preprocessor rewrites class syntax even inside
     * comments, but cannot rewrite nothing. Most files map line by line; some gain a line and everything below shifts.
     * Reported, not asserted, as the figure is a property of the build, but a collapse means the path mapping broke.
     */
    let aligned = 0;
    let sampled = 0;
    let files = 0;
    for (const entry of mapped.slice(0, 40)) {
        const generated = sourcePathCandidates(entry.recorded, romDirectory)
            .find(candidate => fs.existsSync(candidate));
        if (!generated || !fs.existsSync(entry.source)) {
            continue;
        }
        files++;
        const after = fs.readFileSync(generated, 'utf8').split(/\r?\n/);
        const before = fs.readFileSync(entry.source, 'utf8').split(/\r?\n/);
        for (let index = 0; index < before.length; index++) {
            if (before[index].trim() !== '') {
                continue;
            }
            sampled++;
            if ((after[index] ?? '').trim() === '') { aligned++; }
        }
    }
    const share = sampled === 0 ? 0 : aligned / sampled;
    console.log(`    ${aligned} of ${sampled} blank lines across ${files} files `
        + `sit at the same number in both (${(100 * share).toFixed(1)}%)`);
    console.log('    (a line number is carried across unchanged; where a file has '
        + 'drifted,\n     a breakpoint lands on the next statement that generated code)');
    check('most line numbers mean the same in both files', sampled > 20 && share > 0.6,
        `${aligned} of ${sampled}`);

    // the direction a host with editors needs: it holds the path of the clicked file, not the one the compiler recorded
    const editorPath = mapped[0]?.source;
    const back = editorPath && recordedPathFor(table, mapper, editorPath);
    console.log(`    ${editorPath?.split('/').slice(-2).join('/')} -> `
        + `${back?.split('/').slice(-2).join('/') ?? 'nothing'}`);
    check('an editor\'s own path finds the compiled one', back === mapped[0]?.recorded,
        String(back));

    const example = mapped.find(entry => /SoundState\.c$/.test(entry.source));
    if (example) {
        const found = table.resolve(example.recorded, 177);
        const symbol = found && findFunctionAt(symbols, 0x07000000 + found.offset, romBytes);
        console.log(`    ${path.basename(example.source)}:177 -> `
            + `0x${found ? (0x07000000 + found.offset).toString(16).toUpperCase() : '?'}`
            + ` (${symbol ? symbol.name : 'no function'})`);
        check('a source line resolves to an address inside the right routine',
            symbol !== undefined && /SoundState_destructor/.test(symbol.name),
            symbol?.name);
    }
}

console.log('\nThe breakpoint set, driven the way an editor would');
{
    const { VesBreakpoints } = await import(path.join(here, '../lib/browser/core/emulator-breakpoints.js'));
    const table = parseDwarfLineTable(image.section('.debug_line'), romBytes);
    const file = table.files.find(name => /States\/SoundState\/SoundState\.c$/.test(name));
    check('the build names a file to set one in', file !== undefined, String(file));

    const points = new VesBreakpoints();
    let changes = 0;
    points.onDidChange(() => changes++);

    // what an editor sends: all the lines it has, every time
    points.setForFile(file, [{ line: 177 }, { line: 178 }], table);
    console.log(`    two lines -> ${points.armed().map(a => '0x' + a.toString(16).toUpperCase()).join(', ')}`);
    check('lines become addresses', points.armed().length > 0, JSON.stringify(points.armed()));
    check('and each remembers the line it came from',
        points.all().every(point => point.origin?.file === file), JSON.stringify(points.all()[0]));

    const inside = points.all().every(point => {
        const symbol = findFunctionAt(symbols, point.address, romBytes);
        return symbol !== undefined && /SoundState/.test(symbol.name);
    });
    check('and they land in the routine that line is in', inside);

    points.setForFile(file, [{ line: 177 }], table);
    check('a line removed in the editor is removed here', points.all().length === 1,
        String(points.all().length));

    // one set by hand in the gutter, which the editor must not touch
    const byHand = 0x07000100;
    points.add(byHand);
    points.setForFile(file, [], table);
    check('but one set on an address survives the editor emptying the file',
        points.has(byHand) && points.all().length === 1, JSON.stringify(points.all()));

    points.setEnabled(byHand, false);
    check('a disabled one stays in the set', points.has(byHand));
    check('and is not armed', points.armed().length === 0, JSON.stringify(points.armed()));

    check('every change was announced once', changes >= 5, String(changes));

    // a rebuild moves the code; the line did not move
    points.clear();
    points.setForFile(file, [{ line: 177 }], table);
    const before = points.armed()[0];
    points.reresolve(table);
    check('re-resolving against the same build changes nothing',
        points.armed()[0] === before, `${before} -> ${points.armed()[0]}`);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
