/**
 * Basepull — pure helpers (no GAS services). Also loaded by the Node test harness.
 */

/** Convert one Airtable cell value into a spreadsheet-friendly scalar. */
function bpFlattenValue(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) {
    return v.map(function (x) {
      if (x && typeof x === 'object') {
        if (x.url && x.filename) return x.url;            // attachment
        if (x.email && x.name) return x.name;             // collaborator
        if (x.name) return x.name;
        if (x.id) return x.id;
        return JSON.stringify(x);
      }
      return x;
    }).join(', ');
  }
  if (typeof v === 'object') {
    if (v.error) return '#' + v.error;                    // formula errors
    if (v.specialValue) return v.specialValue;            // NaN / Infinity
    if (v.email && v.name) return v.name;
    if (v.name) return v.name;
    return JSON.stringify(v);
  }
  return v;
}

/**
 * Build a 2D array from Airtable records.
 * fieldNames: ordered list of field names to output (from table schema or view).
 * opts.includeId: prepend "Record ID" column. opts.includeCreated: append "Created".
 */
function bpRecordsToRows(records, fieldNames, opts) {
  opts = opts || {};
  var header = [];
  if (opts.includeId) header.push('Record ID');
  header = header.concat(fieldNames);
  if (opts.includeCreated) header.push('Created');
  var rows = [header];
  for (var i = 0; i < records.length; i++) {
    var r = records[i], f = r.fields || {}, row = [];
    if (opts.includeId) row.push(r.id);
    for (var j = 0; j < fieldNames.length; j++) row.push(bpFlattenValue(f[fieldNames[j]]));
    if (opts.includeCreated) row.push(r.createdTime || '');
    rows.push(row);
  }
  return rows;
}

/** Field names actually present in the view: schema order, but only fields that are visible in the view if visibleFieldIds given. */
function bpOrderedFieldNames(tableSchema, visibleFieldIds) {
  var fields = tableSchema.fields || [];
  if (visibleFieldIds && visibleFieldIds.length) {
    var set = {};
    visibleFieldIds.forEach(function (id) { set[id] = true; });
    var byId = {};
    fields.forEach(function (f) { byId[f.id] = f; });
    return visibleFieldIds.filter(function (id) { return byId[id]; }).map(function (id) { return byId[id].name; });
  }
  return fields.map(function (f) { return f.name; });
}

/** Build the Airtable list-records URL. */
function bpListUrl(baseId, tableId, view, offset, pageSize) {
  var u = 'https://api.airtable.com/v0/' + encodeURIComponent(baseId) + '/' + encodeURIComponent(tableId) + '?pageSize=' + (pageSize || 100);
  if (view) u += '&view=' + encodeURIComponent(view);
  if (offset) u += '&offset=' + encodeURIComponent(offset);
  return u;
}

/** Is a job due? interval in minutes; lastRun ISO string or ''. */
function bpIsDue(job, nowMs) {
  if (!job.interval || job.interval <= 0) return false;
  if (!job.lastRun) return true;
  var last = Date.parse(job.lastRun);
  if (isNaN(last)) return true;
  return nowMs - last >= job.interval * 60000 - 30000; // 30s slack for trigger jitter
}

/** Normalise a sheet-safe tab name. */
function bpSafeSheetName(name) {
  var s = String(name || 'Airtable').replace(/[\[\]\*\?\/\\:]/g, ' ').trim();
  if (!s) s = 'Airtable';
  return s.length > 90 ? s.slice(0, 90) : s;
}

/** Plan limits. */
var BP_LIMITS = {
  free: { jobs: 1, rows: 1000, schedule: false },
  pro:  { jobs: 1000, rows: 200000, schedule: true }
};

function bpPlanFor(isPro) { return isPro ? BP_LIMITS.pro : BP_LIMITS.free; }

if (typeof module !== 'undefined') {
  module.exports = { bpFlattenValue: bpFlattenValue, bpRecordsToRows: bpRecordsToRows, bpOrderedFieldNames: bpOrderedFieldNames, bpListUrl: bpListUrl, bpIsDue: bpIsDue, bpSafeSheetName: bpSafeSheetName, bpPlanFor: bpPlanFor };
}
