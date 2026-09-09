const assert = require('assert');
const L = require('../addon/Lib.gs');
const vm = require('vm'); const fs = require('fs');

// syntax check GAS files (they must parse as plain JS)
for (const f of ['addon/Code.gs', 'backend/Code.gs']) new vm.Script(fs.readFileSync(__dirname + '/../' + f, 'utf8'), { filename: f });

// flatten
assert.strictEqual(L.bpFlattenValue(undefined), '');
assert.strictEqual(L.bpFlattenValue(3.5), 3.5);
assert.strictEqual(L.bpFlattenValue(true), true);
assert.strictEqual(L.bpFlattenValue(['a', 'b']), 'a, b');
assert.strictEqual(L.bpFlattenValue([{ id: 'att1', url: 'https://x/y.png', filename: 'y.png' }]), 'https://x/y.png');
assert.strictEqual(L.bpFlattenValue({ id: 'usr1', email: 'a@b.c', name: 'Ann' }), 'Ann');
assert.strictEqual(L.bpFlattenValue([{ id: 'rec1' }, { id: 'rec2' }]), 'rec1, rec2');
assert.strictEqual(L.bpFlattenValue({ error: '#ERROR' }), '##ERROR');
assert.strictEqual(L.bpFlattenValue({ specialValue: 'NaN' }), 'NaN');

// rows
const schema = { fields: [{ id: 'f1', name: 'Name' }, { id: 'f2', name: 'Tags' }, { id: 'f3', name: 'Qty' }] };
const recs = [
  { id: 'recA', createdTime: '2026-01-01T00:00:00.000Z', fields: { Name: 'A', Tags: ['x', 'y'], Qty: 2 } },
  { id: 'recB', createdTime: '2026-01-02T00:00:00.000Z', fields: { Name: 'B' } }
];
let names = L.bpOrderedFieldNames(schema, null);
assert.deepStrictEqual(names, ['Name', 'Tags', 'Qty']);
let rows = L.bpRecordsToRows(recs, names, { includeId: true, includeCreated: true });
assert.deepStrictEqual(rows[0], ['Record ID', 'Name', 'Tags', 'Qty', 'Created']);
assert.deepStrictEqual(rows[1], ['recA', 'A', 'x, y', 2, '2026-01-01T00:00:00.000Z']);
assert.deepStrictEqual(rows[2], ['recB', 'B', '', '', '2026-01-02T00:00:00.000Z']);
// view visible fields (order follows the view, unknown ids dropped)
names = L.bpOrderedFieldNames(schema, ['f3', 'f1', 'fZ']);
assert.deepStrictEqual(names, ['Qty', 'Name']);
rows = L.bpRecordsToRows(recs, names, {});
assert.deepStrictEqual(rows, [['Qty', 'Name'], [2, 'A'], ['', 'B']]);

// url
assert.strictEqual(L.bpListUrl('appX', 'tblY', 'viwZ', 'itr/abc', 100), 'https://api.airtable.com/v0/appX/tblY?pageSize=100&view=viwZ&offset=itr%2Fabc');
assert.strictEqual(L.bpListUrl('appX', 'tblY', '', null), 'https://api.airtable.com/v0/appX/tblY?pageSize=100');

// due
const now = Date.parse('2026-09-09T10:00:00Z');
assert.strictEqual(L.bpIsDue({ interval: 0, lastRun: '' }, now), false);
assert.strictEqual(L.bpIsDue({ interval: 60, lastRun: '' }, now), true);
assert.strictEqual(L.bpIsDue({ interval: 60, lastRun: '2026-09-09T09:30:00Z' }, now), false);
assert.strictEqual(L.bpIsDue({ interval: 60, lastRun: '2026-09-09T08:59:40Z' }, now), true);
assert.strictEqual(L.bpIsDue({ interval: 1440, lastRun: '2026-09-08T10:00:20Z' }, now), true);

// names / plans
assert.strictEqual(L.bpSafeSheetName('Orders [2026]/Q3*'), 'Orders  2026  Q3');
assert.strictEqual(L.bpSafeSheetName(''), 'Airtable');
assert.strictEqual(L.bpPlanFor(false).jobs, 1);
assert.strictEqual(L.bpPlanFor(true).schedule, true);

console.log('lib tests passed');
