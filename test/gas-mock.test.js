// Runs Code.gs + Lib.gs inside a minimal GAS mock to exercise the sync flow end-to-end.
const assert = require('assert'); const fs = require('fs'); const vm = require('vm');

const store = { user: {}, doc: {} };
const sheets = {};
function mkSheet(name) {
  const s = { name, values: [], notes: {}, frozen: 0, bold: null,
    getName: () => name, clearContents() { s.values = []; }, getFrozenRows: () => s.frozen, setFrozenRows(n) { s.frozen = n; },
    getRange(r, c, nr, nc) { return { setValues(v) { s.values = v; assert.strictEqual(v.length, nr); assert.strictEqual(v[0].length, nc); }, setFontWeight(w) { s.bold = [r, c, nr, nc, w]; }, setNote(n) { s.notes[r + ':' + c] = n; } }; }
  };
  return s;
}
const ss = { id: 'SS1', getId: () => 'SS1', getName: () => 'Test SS', getSheets: () => Object.values(sheets), getSheetByName: n => sheets[n] || null, insertSheet(n) { sheets[n] = mkSheet(n); return sheets[n]; }, toast() {} };
const fetchLog = [];
const airtable = {
  '/v0/meta/bases': { bases: [{ id: 'appA', name: 'CRM' }] },
  '/v0/meta/bases/appA/tables': { tables: [{ id: 'tblT', name: 'Leads', fields: [{ id: 'f1', name: 'Name' }, { id: 'f2', name: 'Stage' }, { id: 'f3', name: 'Files' }], views: [{ id: 'viwV', name: 'Open', type: 'grid', visibleFieldIds: ['f2', 'f1'] }] }] },
};
function page(offset) {
  const all = []; for (let i = 0; i < 250; i++) all.push({ id: 'rec' + i, createdTime: '2026-01-01T00:00:00.000Z', fields: { Name: 'N' + i, Stage: i % 2 ? 'Won' : 'Open', Files: [{ url: 'https://f/' + i, filename: 'x' }] } });
  const start = offset ? Number(offset.split('/')[1]) : 0; const recs = all.slice(start, start + 100);
  return { records: recs, offset: start + 100 < all.length ? 'itr/' + (start + 100) : undefined };
}
const ctx = {
  PropertiesService: { getUserProperties: () => ({ getProperty: k => store.user[k] ?? null, setProperty: (k, v) => { store.user[k] = v; }, deleteProperty: k => { delete store.user[k]; } }) },
  SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: id => ss, getUi: () => ({ createAddonMenu: () => ({ addItem() { return this; }, addToUi() {} }) }) },
  UrlFetchApp: { fetch(url, opts) { fetchLog.push(url); assert.ok(opts.headers.Authorization.startsWith('Bearer pat')); const u = new URL(url); let body; if (u.pathname === '/v0/appA/tblT') body = page(u.searchParams.get('offset')); else body = airtable[u.pathname.replace(/\?.*$/, '')]; if (!body) return { getResponseCode: () => 404, getContentText: () => '{"error":{"message":"NOT_FOUND"}}' }; return { getResponseCode: () => 200, getContentText: () => JSON.stringify(body) }; } },
  Session: { getEffectiveUser: () => ({ getEmail: () => 'me@example.com' }) },
  Utilities: { getUuid: () => 'uuid-' + Math.random().toString(36).slice(2), sleep() {}, computeHmacSha256Signature: () => [1, 2] },
  ScriptApp: { getUserTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyHours: () => ({ create() { ctx._trig = true; } }) }) }), deleteTrigger() {} },
  HtmlService: {}, JSON, Date, Math, String, Number, Array, Object, RegExp, Error, encodeURIComponent, isNaN, console, URL
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + '/../addon/Lib.gs', 'utf8'), ctx);
vm.runInContext(fs.readFileSync(__dirname + '/../addon/Code.gs', 'utf8'), ctx);

// no token → init works, save job fails nicely
let init = ctx.bpInit(); assert.strictEqual(init.hasToken, false); assert.strictEqual(init.plan.name, 'Free');
assert.throws(() => ctx.bpSaveToken('nope'), /personal access token/);
const bases = ctx.bpSaveToken('patABC.def123'); assert.strictEqual(JSON.stringify(bases), JSON.stringify([{ id: "appA", name: "CRM" }]));
const tables = ctx.bpListTables('appA'); assert.strictEqual(tables[0].views.length, 1);

// free plan: schedule rejected, 1 job max
assert.throws(() => ctx.bpSaveJob({ baseId: 'appA', tableId: 'tblT', interval: 60 }), /Pro feature/);
let jobs = ctx.bpSaveJob({ baseId: 'appA', baseName: 'CRM', tableId: 'tblT', tableName: 'Leads', viewId: 'viwV', viewName: 'Open', includeId: true, interval: 0 });
assert.strictEqual(jobs.length, 1); assert.strictEqual(jobs[0].sheetName, 'Leads');
assert.throws(() => ctx.bpSaveJob({ baseId: 'appA', tableId: 'tblT' }), /Free plan allows 1/);

// run: free cap 1000 rows (we have 250) → all rows, view field order applied
jobs = ctx.bpRunJob(jobs[0].id);
assert.strictEqual(jobs[0].lastStatus, 'ok'); assert.strictEqual(jobs[0].lastRows, 250);
const sh = sheets['Leads'];
assert.strictEqual(JSON.stringify(sh.values[0]), JSON.stringify(['Record ID', 'Stage', 'Name']));
assert.strictEqual(JSON.stringify(sh.values[1]), JSON.stringify(['rec0', 'Open', 'N0']));
assert.strictEqual(sh.values.length, 251); assert.strictEqual(sh.frozen, 1);
assert.ok(sh.notes['1:1'].includes('250 rows'));
assert.strictEqual(fetchLog.filter(u => u.includes('/v0/appA/tblT')).length, 3);

// pro plan via cached license → scheduling allowed, trigger created
store.user['bp.license'] = JSON.stringify({ pro: true, until: '', checkedAt: Date.now() });
jobs = ctx.bpSaveJob(Object.assign({}, jobs[0], { interval: 60 }));
assert.strictEqual(jobs[0].interval, 60); assert.strictEqual(ctx._trig, true);
// tick: job just ran → not due; force lastRun old → due → runs
ctx.bpTick(); assert.strictEqual(ctx.bpGetJobs('SS1')[0].lastRows, 250);
const reg = JSON.parse(store.user['bp.reg']); reg.SS1.jobs[0].lastRun = '2026-01-01T00:00:00Z'; reg.SS1.jobs[0].lastRows = 0; store.user['bp.reg'] = JSON.stringify(reg);
ctx.bpTick(); assert.strictEqual(ctx.bpGetJobs('SS1')[0].lastRows, 250); assert.notStrictEqual(ctx.bpGetJobs('SS1')[0].lastRun, '2026-01-01T00:00:00Z');

// error path
jobs = ctx.bpSaveJob({ baseId: 'appA', baseName: 'CRM', tableId: 'tblGone', tableName: 'Gone', interval: 0 });
assert.throws(() => ctx.bpRunJob(jobs[1].id), /Table no longer exists/);
assert.ok(ctx.bpGetJobs('SS1')[1].lastStatus.startsWith('error:'));
// delete
assert.strictEqual(ctx.bpDeleteJob(jobs[1].id).length, 1);
console.log('gas mock tests passed');
