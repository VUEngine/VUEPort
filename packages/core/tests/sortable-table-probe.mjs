// the shared ordering semantics used by the sortable debug tables
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { nextTableSort, sortTableRows } = require('../lib/browser/panels/emulator-sortable-table.js');

let failures = 0;
function check(label, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}`);
    if (!pass) {
        failures++;
        console.log(`     got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
}

const rows = [
    { id: 'original-first', name: 'Actor 10', value: 2 },
    { id: 'missing', name: undefined, value: undefined },
    { id: 'small', name: 'actor 2', value: 1 },
    { id: 'same-a', name: 'Same', value: 2 },
    { id: 'same-b', name: 'same', value: 2 },
];
const ids = entries => entries.map(entry => entry.id);
const values = (row, column) => row[column];

check('no selected column preserves the existing default order',
    ids(sortTableRows(rows, {}, values)), ids(rows));

const nameAscending = nextTableSort({}, 'name');
check('a new column starts ascending', nameAscending,
    { column: 'name', direction: 'ascending' });
check('strings sort naturally and case-insensitively',
    ids(sortTableRows(rows, nameAscending, values)),
    ['small', 'original-first', 'same-a', 'same-b', 'missing']);

const nameDescending = nextTableSort(nameAscending, 'name');
check('the active column reverses on the next click', nameDescending,
    { column: 'name', direction: 'descending' });
check('missing values remain last when descending',
    ids(sortTableRows(rows, nameDescending, values)),
    ['same-a', 'same-b', 'original-first', 'small', 'missing']);

const numberAscending = nextTableSort(nameDescending, 'value');
check('choosing another column resets to ascending', numberAscending,
    { column: 'value', direction: 'ascending' });
check('numeric ties retain their live-table order',
    ids(sortTableRows(rows, numberAscending, values)),
    ['small', 'original-first', 'same-a', 'same-b', 'missing']);

const panels = {
    'emulator-memory-pools-panel.tsx': ['name', 'count', 'block', 'bytes'],
    'emulator-actors-panel.tsx': ['class', 'rectangle', 'parallax', 'index', 'address'],
    'emulator-vip-worlds-panel.tsx': [
        'index', 'head', 'eyes', 'mode', 'map', 'segments', 'gx', 'gp', 'gy',
        'mx', 'mp', 'my', 'width', 'height', 'flags',
    ],
    'emulator-vip-bgmaps-panel.tsx': ['segment', 'address', 'worlds', 'params'],
    'emulator-vip-objects-panel.tsx': [
        'index', 'eyes', 'jx', 'jp', 'jy', 'character', 'palette', 'flip',
    ],
};
for (const [file, columns] of Object.entries(panels)) {
    const source = readFileSync(new URL(`../src/browser/panels/${file}`, import.meta.url), 'utf8');
    for (const column of columns) {
        check(`${file} wires the ${column} column`, source.includes(`column='${column}'`), true);
    }
}

const objectPanel = readFileSync(
    new URL('../src/browser/panels/emulator-vip-objects-panel.tsx', import.meta.url), 'utf8');
check('objects are sorted before the row limit is applied',
    objectPanel.indexOf('sortTableRows(matching') < objectPanel.indexOf('sorted.slice(0, MAX_OBJECT_ROWS)'), true);

console.log(failures === 0 ? 'Sortable table probe PASS' : `${failures} sorting check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
