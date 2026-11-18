/**
 * Applies a BSDiff patch with no `Buffer` global. seek-bzip reaches for a global `Buffer`, which a browser lacks, so
 * emulator-rom-patches installs a Uint8Array subclass instead of bundling the 25 KB `buffer` package. Under Node the
 * real one is present, so no other test exercises that substitute; this one removes the global first. Same fixture as
 * rom-patch-probe.
 * Usage: node tests/rom-patch-nobuffer-probe.mjs
 */
const BSDIFF_BASE64 = 'QlNESUZGNDApAAAAAAAAACUAAAAAAAAABQAAAAAAAABCWmg5MUFZJlNZdZtXgAAABUAAbAggACGGgZoC1MmnF3JFOFCQdZtXgEJaaDkxQVkmU1k98GURAAABQABAgCAAIQCCnF3JFOFCQPfBlERCWmg5MUFZJlNZpjIrIAAAAEAAAgAgACEYRoLuSKcKEhTGRWQA';

const SOURCE = Uint8Array.from([1, 2, 3, 4]);
const TARGET = [1, 9, 3, 4, 5];

let failures = 0;
function check(label, actual, expected) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures++;
        console.log(`  FAIL ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    } else {
        console.log(`  ok   ${label}`);
    }
}

// decoded without `Buffer`, for the same reason the test exists
const binary = atob(BSDIFF_BASE64);
const patch = new Uint8Array(binary.length);
for (let i = 0; i < binary.length; i++) {
    patch[i] = binary.charCodeAt(i);
}

delete globalThis.Buffer;
if (globalThis.Buffer) {
    console.log('  FAIL the Buffer global could not be removed; this probe proves nothing');
    process.exit(1);
}

// imported after the deletion, or a module capturing `Buffer` at load would pass on Node's implementation
const { applyRomPatch, detectRomPatchFormat } =
    await import('../lib/common/emulator-rom-patches.js');

console.log('\n=== BSDiff on a host with no Buffer ===');
check('the format is still recognized', detectRomPatchFormat(patch), 'bsdiff');
check('the bzip2 streams decode', [...applyRomPatch(SOURCE, patch)], TARGET);
check('the substitute is what answered', globalThis.Buffer?.name, 'BunzipBuffer');

if (failures) {
    console.log(`\n${failures} check(s) failed.`);
    process.exit(1);
}
console.log('\nBSDiff patches apply in a browser, without the buffer package.');
