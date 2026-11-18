// every DWARF global has to be found where the symbol table puts it, and every field path has to describe back as
// itself, so a watch report can name what an instruction wrote. Needs a debug build, so not part of `yarn test`. Usage:
// node tests/probe-symbols-probe.mjs <rom.vb> <image.elf>
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { check, finish, readCoreWasm } from './probe-test-rom.mjs';

const require = createRequire(import.meta.url);
const { VbSymbols, VbMachine, readPool, readInstances } = require('../lib/probe/index.js');

const [romPath, elfPath] = process.argv.slice(2);
if (!romPath || !elfPath) {
    console.log('Usage: node tests/probe-symbols-probe.mjs <rom.vb> <image.elf>');
    process.exit(2);
}
const romBytes = readFileSync(romPath).length;
const symbols = VbSymbols.fromElf(readFileSync(elfPath), romBytes);
check('the .elf reads', symbols !== undefined, true);
check('the build describes its globals', symbols.variables.size > 0, true);

console.log('\nGlobals are where the symbol table says, as big as it says');
let found = 0;
let sized = 0;
let measured = 0;
for (const [name, type] of symbols.variables) {
    const symbol = symbols.lookup(name);
    if (!symbol || symbol.isFunction) {
        continue;
    }
    found++;
    const extent = symbols.locate(name);
    if (extent.address !== symbol.address) {
        check(`${name} is at its symbol`, extent.address, symbol.address);
    }
    if (symbol.size > 0 && type.byteSize > 0) {
        measured++;
        if (symbol.size === type.byteSize) {
            sized++;
        }
    }
}
console.log(`    ${found} globals with symbols, ${sized} of ${measured} sized alike`);
check('nearly every size agrees', sized >= measured * 0.95, true);

console.log('\nField paths survive the round trip');
let paths = 0;
const failed = [];
for (const [name, type] of symbols.variables) {
    if (type.kind !== 'struct' || !symbols.lookup(name)) {
        continue;
    }
    const walk = (prefix, struct, depth) => {
        for (const member of struct.members) {
            if (member.bitSize !== undefined || member.type.byteSize === 0) {
                continue;
            }
            const path = `${prefix}.${member.name}`;
            if (member.type.kind === 'struct' && member.type.struct && depth < 3) {
                walk(path, member.type.struct, depth + 1);
                continue;
            }
            const extent = symbols.locate(path);
            const described = symbols.describe(extent.address);
            paths++;
            // an array is named by its first element, and a struct deeper than this walk by its first leaf
            if (described !== path && !described.startsWith(`${path}[0]`) && !described.startsWith(`${path}.`)) {
                failed.push(`${path} -> ${described}`);
            }
        }
    };
    walk(name, type.struct, 0);
}
console.log(`    ${paths} paths walked`);
check('every path describes back as itself', failed.slice(0, 5), value => value.length === 0);

console.log('\nThe engine\'s objects, for a VUEngine build');
if (symbols.index.memoryPool) {
    const vb = await VbMachine.create({ core: readCoreWasm(), rom: readFileSync(romPath), elf: readFileSync(elfPath) });
    vb.runFrames(300);
    const pool = readPool(vb);
    check('the pools are found once the engine is up', pool !== undefined && pool.pools.length > 0, true);
    const used = pool.pools.reduce((total, entry) => total + entry.usedBlocks, 0);
    const named = pool.pools.reduce((total, entry) => total + entry.classes.reduce((sum, occupant) => sum + occupant.count, 0), 0);
    console.log(`    ${used} blocks in use, ${named} of them named by class`);
    check('most blocks in use name their class', named >= used * 0.5, true);
    const instances = readInstances(vb, { fields: true });
    check('every instance is one the pools counted', instances.length, named);
    const described = instances.filter(instance => instance.fields && instance.fields.length > 0).length;
    check('instances have fields where the build describes their class', described > 0, true);
} else {
    console.log('    not a VUEngine build');
}

finish();
