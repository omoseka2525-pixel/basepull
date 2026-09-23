/**
 * Basepull — Airtable → Google Sheets scheduled sync (Sheets editor add-on).
 * Scopes (see appsscript.json): spreadsheets.currentonly, script.external_request, script.scriptapp, userinfo.email
 *
 * Storage model: everything lives in the user's UserProperties so time-driven triggers
 * (which have no "active document" guarantee) can still find the jobs:
 *   bp.token                       Airtable personal access token
 *   bp.reg                         { "<spreadsheetId>": { name, jobs:[...] } }
 *   bp.license                     cached license { pro, until, checkedAt }
 */

var BP_CONFIG = {
  BACKEND_URL: '',          // license backend web-app URL (leave '' while developing → everyone is Free)
  BACKEND_SECRET: '',       // must equal LICENSE_SECRET in the backend's Script Properties
  CHECKOUT_URL: 'https://buy.stripe.com/REPLACE_ME',
  PORTAL_URL: 'https://billing.stripe.com/p/login/REPLACE_ME',
  SITE_URL: 'https://basepull.app/',
  LICENSE_CACHE_HOURS: 6
};

// ---------- Menu / UI ----------
function onInstall(e) { onOpen(e); }
function onOpen(e) {
  SpreadsheetApp.getUi().createAddonMenu()
    .addItem('Open Basepull', 'bpShowSidebar')
    .addItem('Run all syncs now', 'bpRunAllNowMenu')
    .addToUi();
}
function bpShowSidebar() {
  var html = HtmlService.createHtmlOutputFromFile('Sidebar').setTitle('Basepull').setWidth(340);
  SpreadsheetApp.getUi().showSidebar(html);
}
function bpRunAllNowMenu() {
  var jobs = bpRunAll(SpreadsheetApp.getActiveSpreadsheet());
  SpreadsheetApp.getActiveSpreadsheet().toast('Basepull: ran ' + jobs.length + ' sync(s)');
}

// ---------- State ----------
function bpUserProps() { return PropertiesService.getUserProperties(); }
function bpRegistry() {
  var raw = bpUserProps().getProperty('bp.reg');
  try { return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
}
function bpSetRegistry(reg) { bpUserProps().setProperty('bp.reg', JSON.stringify(reg)); }
function bpGetJobs(ssId) { var r = bpRegistry(); return (r[ssId] && r[ssId].jobs) || []; }
function bpSetJobs(ssId, ssName, jobs) {
  var r = bpRegistry();
  if (jobs.length) r[ssId] = { name: ssName, jobs: jobs }; else delete r[ssId];
  bpSetRegistry(r);
}

// ---------- Airtable API ----------
function bpToken() {
  var t = bpUserProps().getProperty('bp.token');
  if (!t) throw new Error('No Airtable token saved. Paste a personal access token first.');
  return t;
}
function bpFetch(url, retry) {
  var res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + bpToken() }, muteHttpExceptions: true });
  var code = res.getResponseCode();
  if (code === 429 && !retry) { Utilities.sleep(31000); return bpFetch(url, true); }
  var body = res.getContentText();
  if (code >= 400) {
    var msg = body;
    try { var j = JSON.parse(body); msg = (j.error && (j.error.message || j.error)) || body; } catch (e) {}
    throw new Error('Airtable ' + code + ': ' + (typeof msg === 'string' ? msg : JSON.stringify(msg)));
  }
  return JSON.parse(body);
}

// ---------- Sidebar RPC ----------
function bpInit() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var email = Session.getEffectiveUser().getEmail();
  var plan = bpPlanInfo();
  return {
    hasToken: !!bpUserProps().getProperty('bp.token'),
    jobs: bpGetJobs(ss.getId()),
    sheets: ss.getSheets().map(function (s) { return s.getName(); }),
    plan: plan,
    email: email,
    checkoutUrl: BP_CONFIG.CHECKOUT_URL + (BP_CONFIG.CHECKOUT_URL.indexOf('?') < 0 ? '?' : '&') + 'prefilled_email=' + encodeURIComponent(email),
    portalUrl: BP_CONFIG.PORTAL_URL,
    siteUrl: BP_CONFIG.SITE_URL
  };
}
function bpSaveToken(token) {
  token = String(token || '').trim();
  if (!/^pat[A-Za-z0-9]+\.[A-Za-z0-9]+$/.test(token)) throw new Error('That does not look like an Airtable personal access token (it starts with "pat").');
  var old = bpUserProps().getProperty('bp.token');
  bpUserProps().setProperty('bp.token', token);
  try { return bpListBases(); }
  catch (e) { if (old) bpUserProps().setProperty('bp.token', old); else bpUserProps().deleteProperty('bp.token'); throw e; }
}
function bpForgetToken() { bpUserProps().deleteProperty('bp.token'); return true; }
function bpListBases() {
  var r = bpFetch('https://api.airtable.com/v0/meta/bases');
  return (r.bases || []).map(function (b) { return { id: b.id, name: b.name }; });
}
function bpListTables(baseId) {
  var r = bpFetch('https://api.airtable.com/v0/meta/bases/' + encodeURIComponent(baseId) + '/tables');
  return (r.tables || []).map(function (t) {
    return { id: t.id, name: t.name, views: (t.views || []).filter(function (v) { return v.type === 'grid'; }).map(function (v) { return { id: v.id, name: v.name }; }) };
  });
}

function bpSaveJob(job) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var jobs = bpGetJobs(ss.getId());
  var plan = bpPlanInfo();
  var idx = -1;
  for (var i = 0; i < jobs.length; i++) if (jobs[i].id === job.id) idx = i;
  if (idx < 0 && jobs.length >= plan.limits.jobs) throw new Error('The Free plan allows ' + plan.limits.jobs + ' sync per spreadsheet. Upgrade to Pro for unlimited syncs.');
  if (!plan.limits.schedule && Number(job.interval) > 0) throw new Error('Scheduling is a Pro feature. On Free, run syncs manually.');
  if (!job.baseId || !job.tableId) throw new Error('Pick a base and a table.');
  var clean = {
    id: job.id || Utilities.getUuid(),
    baseId: job.baseId, baseName: job.baseName || job.baseId,
    tableId: job.tableId, tableName: job.tableName || job.tableId,
    viewId: job.viewId || '', viewName: job.viewName || '',
    sheetName: bpSafeSheetName(job.sheetName || job.tableName),
    includeId: !!job.includeId, includeCreated: !!job.includeCreated,
    interval: Number(job.interval) || 0,
    lastRun: idx >= 0 ? jobs[idx].lastRun : '', lastStatus: idx >= 0 ? jobs[idx].lastStatus : '', lastRows: idx >= 0 ? jobs[idx].lastRows : 0
  };
  if (idx >= 0) jobs[idx] = clean; else jobs.push(clean);
  bpSetJobs(ss.getId(), ss.getName(), jobs);
  bpEnsureTrigger();
  return jobs;
}
function bpDeleteJob(id) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var jobs = bpGetJobs(ss.getId()).filter(function (j) { return j.id !== id; });
  bpSetJobs(ss.getId(), ss.getName(), jobs);
  bpEnsureTrigger();
  return jobs;
}
function bpRunJob(id) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var jobs = bpGetJobs(ss.getId()), job = null;
  for (var i = 0; i < jobs.length; i++) if (jobs[i].id === id) job = jobs[i];
  if (!job) throw new Error('Sync not found');
  var r = bpExecute(ss, job);
  bpStamp(job, r);
  bpSetJobs(ss.getId(), ss.getName(), jobs);
  if (!r.ok) throw new Error(r.error);
  return jobs;
}
function bpRunAllRpc() { return bpRunAll(SpreadsheetApp.getActiveSpreadsheet()); }
function bpRunAll(ss) {
  var jobs = bpGetJobs(ss.getId());
  jobs.forEach(function (job) { bpStamp(job, bpExecute(ss, job)); });
  bpSetJobs(ss.getId(), ss.getName(), jobs);
  return jobs;
}
function bpStamp(job, r) {
  job.lastRun = new Date().toISOString();
  job.lastStatus = r.ok ? 'ok' + (r.truncated ? ' (truncated)' : '') : 'error: ' + r.error;
  job.lastRows = r.rows || 0;
}

// ---------- Sync core ----------
function bpExecute(ss, job) {
  try {
    var plan = bpPlanInfo();
    var tables = bpFetch('https://api.airtable.com/v0/meta/bases/' + encodeURIComponent(job.baseId) + '/tables?include=visibleFieldIds').tables || [];
    var schema = null;
    for (var i = 0; i < tables.length; i++) if (tables[i].id === job.tableId) schema = tables[i];
    if (!schema) throw new Error('Table no longer exists in Airtable');
    var visible = null;
    if (job.viewId) {
      var vmeta = schema.views ? schema.views.filter(function (v) { return v.id === job.viewId; })[0] : null;
      if (vmeta && vmeta.visibleFieldIds) visible = vmeta.visibleFieldIds;
    }
    var fieldNames = bpOrderedFieldNames(schema, visible);
    var records = [], offset = null, truncated = false;
    do {
      var page = bpFetch(bpListUrl(job.baseId, job.tableId, job.viewId, offset, 100));
      records = records.concat(page.records || []);
      offset = page.offset || null;
      if (records.length >= plan.limits.rows && offset) { truncated = true; break; }
    } while (offset);
    if (records.length > plan.limits.rows) { records = records.slice(0, plan.limits.rows); truncated = true; }
    var rows = bpRecordsToRows(records, fieldNames, { includeId: job.includeId, includeCreated: job.includeCreated });

    var sh = ss.getSheetByName(job.sheetName) || ss.insertSheet(job.sheetName);
    sh.clearContents();
    if (rows.length && rows[0].length) {
      sh.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
      sh.getRange(1, 1, 1, rows[0].length).setFontWeight('bold');
      if (!sh.getFrozenRows()) sh.setFrozenRows(1);
    }
    sh.getRange(1, 1).setNote('Basepull: ' + records.length + ' rows from ' + job.baseName + ' / ' + job.tableName + (job.viewName ? ' (' + job.viewName + ')' : '') + ' at ' + new Date().toISOString() + (truncated ? '\nTRUNCATED at the plan limit of ' + plan.limits.rows + ' rows — upgrade to Pro for up to 200,000 rows.' : ''));
    return { ok: true, rows: records.length, truncated: truncated };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// ---------- Scheduling ----------
// Editor add-ons may create at most one time-driven trigger per user per document and it may not fire more than hourly.
function bpEnsureTrigger() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var need = bpGetJobs(ss.getId()).some(function (j) { return j.interval > 0; }) && bpPlanInfo().limits.schedule;
  var has = false;
  ScriptApp.getUserTriggers(ss).forEach(function (t) {
    if (t.getHandlerFunction() !== 'bpTick') return;
    if (need) has = true; else ScriptApp.deleteTrigger(t);
  });
  if (need && !has) ScriptApp.newTrigger('bpTick').timeBased().everyHours(1).create();
  return need;
}
function bpTick() {
  var reg = bpRegistry(), now = Date.now(), changed = false;
  if (!bpPlanInfo().limits.schedule) return;
  Object.keys(reg).forEach(function (id) {
    var entry = reg[id], ss = null;
    var jobs = entry.jobs || [];
    if (!jobs.some(function (j) { return bpIsDue(j, now); })) return;
    try {
      ss = SpreadsheetApp.getActiveSpreadsheet();
      if (!ss || ss.getId() !== id) ss = SpreadsheetApp.openById(id); // needs the broader spreadsheets scope; see README
    } catch (e) { entry.lastError = 'Cannot open spreadsheet from the scheduler: ' + e.message; changed = true; return; }
    jobs.forEach(function (job) {
      if (!bpIsDue(job, now)) return;
      bpStamp(job, bpExecute(ss, job));
      changed = true;
    });
    entry.jobs = jobs; delete entry.lastError;
  });
  if (changed) bpSetRegistry(reg);
}

// ---------- Licensing ----------
function bpPlanInfo() {
  var cached = null;
  try { cached = JSON.parse(bpUserProps().getProperty('bp.license') || 'null'); } catch (e) {}
  var fresh = cached && (Date.now() - cached.checkedAt) < BP_CONFIG.LICENSE_CACHE_HOURS * 3600000;
  if (!fresh) { cached = bpFetchLicense(); bpUserProps().setProperty('bp.license', JSON.stringify(cached)); }
  var pro = !!cached.pro;
  return { pro: pro, name: pro ? 'Pro' : 'Free', until: cached.until || '', limits: bpPlanFor(pro) };
}
function bpFetchLicense() {
  var out = { pro: false, until: '', checkedAt: Date.now() };
  if (!BP_CONFIG.BACKEND_URL) return out;
  try {
    var email = Session.getEffectiveUser().getEmail();
    var t = String(Date.now());
    var sig = bpHmac(email + '|' + t, BP_CONFIG.BACKEND_SECRET);
    var res = UrlFetchApp.fetch(BP_CONFIG.BACKEND_URL + '?email=' + encodeURIComponent(email) + '&t=' + t + '&sig=' + sig, { muteHttpExceptions: true, followRedirects: true });
    if (res.getResponseCode() === 200) { var j = JSON.parse(res.getContentText()); out.pro = !!j.pro; out.until = j.until || ''; }
  } catch (e) { /* fail closed to Free, retry after cache expiry */ }
  return out;
}
function bpRefreshLicense() { bpUserProps().deleteProperty('bp.license'); return bpPlanInfo(); }
function bpHmac(msg, secret) {
  var bytes = Utilities.computeHmacSha256Signature(msg, secret);
  return bytes.map(function (b) { var v = (b < 0 ? b + 256 : b).toString(16); return v.length < 2 ? '0' + v : v; }).join('');
}


// ---------- Airtable OAuth 2.0 (PKCE). These override the older token-based functions. ----------
var BP_OAUTH = {
  CLIENT_ID: 'a868b01c-80be-45a5-b106-ef4d9876f9d5',
  AUTHORIZE: 'https://airtable.com/oauth2/v1/authorize',
  TOKEN_URL: 'https://airtable.com/oauth2/v1/token',
  SCOPE: 'data.records:read schema.bases:read'
};

function bpRedirectUri() {
  return 'https://script.google.com/macros/d/' + ScriptApp.getScriptId() + '/usercallback';
}

function bpB64url_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function bpVerifier_() {
  var chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-_';
  var out = '';
  for (var i = 0; i < 64; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
function bpAuthUrl() {
  var p = bpUserProps();
  var v = bpVerifier_();
  p.setProperty('bp.pkce', v);
  var challenge = bpB64url_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, v, Utilities.Charset.UTF_8));
  var state = ScriptApp.newStateToken().withMethod('bpAuthCallback').withTimeout(1800).createToken();
  return BP_OAUTH.AUTHORIZE +
    '?client_id=' + encodeURIComponent(BP_OAUTH.CLIENT_ID) +
    '&redirect_uri=' + encodeURIComponent(bpRedirectUri()) +
    '&response_type=code' +
    '&scope=' + encodeURIComponent(BP_OAUTH.SCOPE) +
    '&state=' + encodeURIComponent(state) +
    '&code_challenge=' + encodeURIComponent(challenge) +
    '&code_challenge_method=S256';
}

function bpAuthCallback(request) {
  var p = bpUserProps();
  try {
    if (request.parameter.error) throw new Error(request.parameter.error);
    var res = UrlFetchApp.fetch(BP_OAUTH.TOKEN_URL, {
      method: 'post',
      muteHttpExceptions: true,
      payload: {
        grant_type: 'authorization_code',
        code: request.parameter.code,
        redirect_uri: bpRedirectUri(),
        client_id: BP_OAUTH.CLIENT_ID,
        code_verifier: p.getProperty('bp.pkce') || ''
      }
    });
    if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode() + ' ' + res.getContentText());
    bpStoreAuth_(JSON.parse(res.getContentText()));
    p.deleteProperty('bp.pkce');
    return HtmlService.createHtmlOutput('<p style="font:14px/1.6 system-ui,sans-serif;padding:24px">Airtable connected. You can close this tab and go back to your spreadsheet.</p>');
  } catch (e) {
    return HtmlService.createHtmlOutput('<p style="font:14px/1.6 system-ui,sans-serif;padding:24px">Could not connect Airtable.<br>' + e.message + '</p>');
  }
}

function bpStoreAuth_(t) {
  var p = bpUserProps();
  p.setProperty('bp.oauth', JSON.stringify({
    a: t.access_token,
    r: t.refresh_token,
    e: Date.now() + (((t.expires_in || 3600) - 120) * 1000)
  }));
  p.setProperty('bp.token', 'oauth');
}

function bpRefreshAuth_(o) {
  var res = UrlFetchApp.fetch(BP_OAUTH.TOKEN_URL, {
    method: 'post',
    muteHttpExceptions: true,
    payload: { grant_type: 'refresh_token', refresh_token: o.r, client_id: BP_OAUTH.CLIENT_ID }
  });
  if (res.getResponseCode() !== 200) {
    bpForgetToken();
    throw new Error('The Airtable connection has expired. Click Connect Airtable in the sidebar to reconnect.');
  }
  var t = JSON.parse(res.getContentText());
  if (!t.refresh_token) t.refresh_token = o.r;
  bpStoreAuth_(t);
  return t.access_token;
}

function bpToken() {
  var raw = bpUserProps().getProperty('bp.oauth');
  if (!raw) throw new Error('Airtable is not connected. Click Connect Airtable in the Basepull sidebar.');
  var o = JSON.parse(raw);
  if (!o.a || Date.now() >= o.e) return bpRefreshAuth_(o);
  return o.a;
}

function bpSaveToken() {
  throw new Error('Basepull now connects to Airtable with OAuth. Click Connect Airtable in the sidebar.');
}

function bpForgetToken() {
  var p = bpUserProps();
  p.deleteProperty('bp.oauth');
  p.deleteProperty('bp.token');
  p.deleteProperty('bp.pkce');
  return true;
}

// bpInit oauth override
function bpInit() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var email = Session.getEffectiveUser().getEmail();
  var plan = bpPlanInfo();
  return {
    hasToken: !!bpUserProps().getProperty('bp.oauth'),
    jobs: bpGetJobs(ss.getId()),
    sheets: ss.getSheets().map(function (s) { return s.getName(); }),
    plan: plan,
    email: email,
    checkoutUrl: BP_CONFIG.CHECKOUT_URL + (BP_CONFIG.CHECKOUT_URL.indexOf('?') < 0 ? '?' : '&') + 'prefilled_email=' + encodeURIComponent(email),
    portalUrl: BP_CONFIG.PORTAL_URL,
    siteUrl: BP_CONFIG.SITE_URL
  };
}
