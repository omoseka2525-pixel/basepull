/**
 * Basepull license backend — deploy as a Web App ("Execute as: Me", "Who has access: Anyone").
 *
 * Script Properties to set (Project Settings → Script properties):
 *   LICENSE_SECRET   random string, same value as BP_CONFIG.BACKEND_SECRET in the add-on
 *   WEBHOOK_KEY      random string; Stripe webhook endpoint URL = <web app url>?key=<WEBHOOK_KEY>
 *   STRIPE_SECRET    sk_live_… (only used to look up the customer email on subscription events)
 *   SHEET_ID         (optional) spreadsheet id for the license ledger; created automatically if missing
 *
 * Stripe webhook events to subscribe: checkout.session.completed, customer.subscription.updated,
 * customer.subscription.deleted, invoice.payment_failed
 */

function props() { return PropertiesService.getScriptProperties(); }

function ledger() {
  var id = props().getProperty('SHEET_ID');
  var ss = id ? SpreadsheetApp.openById(id) : null;
  if (!ss) { ss = SpreadsheetApp.create('Basepull licenses'); props().setProperty('SHEET_ID', ss.getId()); }
  var sh = ss.getSheetByName('licenses') || ss.insertSheet('licenses');
  if (sh.getLastRow() === 0) sh.appendRow(['email', 'customer_id', 'subscription_id', 'status', 'current_period_end', 'updated_at', 'note']);
  return sh;
}

function findRow(sh, col, value) {
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) if (String(data[i][col]).toLowerCase() === String(value).toLowerCase()) return i + 1;
  return 0;
}

function upsert(rec) {
  var sh = ledger();
  var row = rec.subscription_id ? findRow(sh, 2, rec.subscription_id) : 0;
  if (!row && rec.customer_id) row = findRow(sh, 1, rec.customer_id);
  if (!row && rec.email) row = findRow(sh, 0, rec.email);
  var vals = [rec.email || '', rec.customer_id || '', rec.subscription_id || '', rec.status || '', rec.current_period_end || '', new Date().toISOString(), rec.note || ''];
  if (row) {
    var old = sh.getRange(row, 1, 1, 7).getValues()[0];
    for (var i = 0; i < 5; i++) if (!vals[i]) vals[i] = old[i];
    sh.getRange(row, 1, 1, 7).setValues([vals]);
  } else sh.appendRow(vals);
}

// ---------- License check (called by the add-on) ----------
function doGet(e) {
  var p = (e && e.parameter) || {};
  var out = { pro: false };
  try {
    var email = String(p.email || '').trim(), t = String(p.t || ''), sig = String(p.sig || '');
    if (!email || !t || !sig) throw new Error('bad request');
    if (Math.abs(Date.now() - Number(t)) > 10 * 60000) throw new Error('stale');
    if (hmac(email + '|' + t, props().getProperty('LICENSE_SECRET')) !== sig) throw new Error('bad signature');
    var sh = ledger(), row = findRow(sh, 0, email);
    if (row) {
      var r = sh.getRange(row, 1, 1, 7).getValues()[0];
      var status = String(r[3]), end = r[4] ? new Date(r[4]) : null;
      var active = (status === 'active' || status === 'trialing' || status === 'manual') && (!end || end.getTime() + 3 * 86400000 > Date.now());
      out.pro = active; out.until = end ? end.toISOString() : '';
    }
  } catch (err) { out.error = err.message; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- Stripe webhook ----------
function doPost(e) {
  var p = (e && e.parameter) || {};
  if (p.key !== props().getProperty('WEBHOOK_KEY')) return text('forbidden', 403);
  var ev;
  try { ev = JSON.parse(e.postData.contents); } catch (err) { return text('bad json', 400); }
  var obj = (ev.data && ev.data.object) || {};
  try {
    switch (ev.type) {
      case 'checkout.session.completed':
        upsert({ email: (obj.customer_details && obj.customer_details.email) || obj.customer_email, customer_id: obj.customer, subscription_id: obj.subscription, status: obj.subscription ? 'active' : 'paid', note: 'checkout' });
        break;
      case 'customer.subscription.updated':
      case 'customer.subscription.created':
      case 'customer.subscription.deleted':
        upsert({ email: customerEmail(obj.customer), customer_id: obj.customer, subscription_id: obj.id, status: ev.type.indexOf('deleted') > 0 ? 'canceled' : obj.status, current_period_end: obj.current_period_end ? new Date(obj.current_period_end * 1000).toISOString() : '', note: ev.type });
        break;
      case 'invoice.payment_failed':
        upsert({ customer_id: obj.customer, subscription_id: obj.subscription, status: 'past_due', note: 'payment failed' });
        break;
    }
  } catch (err) { return text('error: ' + err.message, 500); }
  return text('ok', 200);
}

function customerEmail(customerId) {
  var sk = props().getProperty('STRIPE_SECRET');
  if (!sk || !customerId) return '';
  try {
    var res = UrlFetchApp.fetch('https://api.stripe.com/v1/customers/' + customerId, { headers: { Authorization: 'Bearer ' + sk }, muteHttpExceptions: true });
    if (res.getResponseCode() === 200) return JSON.parse(res.getContentText()).email || '';
  } catch (e) {}
  return '';
}

function text(s, code) { return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.TEXT); }

function hmac(msg, secret) {
  var bytes = Utilities.computeHmacSha256Signature(msg, secret || '');
  return bytes.map(function (b) { var v = (b < 0 ? b + 256 : b).toString(16); return v.length < 2 ? '0' + v : v; }).join('');
}

/** Run once from the editor to create the ledger and grant yourself Pro for testing. */
function setupAndGrantMe() {
  upsert({ email: Session.getEffectiveUser().getEmail(), status: 'manual', note: 'owner' });
  Logger.log('Ledger: https://docs.google.com/spreadsheets/d/' + props().getProperty('SHEET_ID'));
}
