/**
 * founditcheaper — Google Sheet write gateway (Apps Script web app)
 *
 * Lets the website add/remove rows in the promo-code sheet and auto-expire old
 * ones. Reads still come from the published CSV; only writes go through here.
 *
 * SETUP
 *  1. In the sheet: Extensions → Apps Script. Delete any sample code, paste this.
 *  2. Replace the TOKEN value below with your own secret phrase (any random string).
 *  3. Deploy → New deployment → gear icon → Web app
 *       Execute as: Me        Who has access: Anyone
 *     Deploy, authorize when prompted, and copy the "Web app" URL.
 *  4. In Netlify → Environment variables, add:
 *       SHEET_API_URL   = the Web app URL you copied
 *       SHEET_API_TOKEN = the same secret phrase you set below
 *
 * Sheet columns (row 1 headers): amazon_link | promo_code | discount_price | date_added
 * (date_added is filled automatically — you don't touch it.)
 */

var TOKEN      = 'REPLACE_WITH_YOUR_OWN_SECRET';  // must match SHEET_API_TOKEN in Netlify
var SHEET_NAME = '';   // '' = first/active sheet tab
var COLS       = 4;    // amazon_link, promo_code, discount_price, date_added

function _sheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
  var hdr = sh.getRange(1, 1, 1, COLS).getValues()[0];
  if (!hdr[0]) sh.getRange(1, 1, 1, COLS).setValues([['amazon_link', 'promo_code', 'discount_price', 'date_added']]);
  else if (!hdr[3]) sh.getRange(1, 4).setValue('date_added');
  return sh;
}

function _asin(url) {
  var s = String(url || '');
  var m = s.match(/(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|\/product\/|[?&]asin=)([A-Z0-9]{10})/i);
  if (m) return m[1].toUpperCase();
  var b = s.match(/\b(B0[A-Z0-9]{8})\b/i);
  return b ? b[1].toUpperCase() : '';
}

function _today() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function doPost(e) {
  var out = function (o) {
    return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
  };
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: 'bad json' }); }
  if (body.token !== TOKEN) return out({ ok: false, error: 'unauthorized' });

  var sh = _sheet();
  var action = body.action;

  if (action === 'append') {
    var asin = _asin(body.amazon_link);
    if (!asin) return out({ ok: false, error: 'no asin in link' });
    var data = sh.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {           // update in place if the ASIN already exists
      if (_asin(data[i][0]) === asin) {
        sh.getRange(i + 1, 1, 1, COLS).setValues([[body.amazon_link, body.promo_code || '', body.discount_price || '', _today()]]);
        return out({ ok: true, updated: true, asin: asin });
      }
    }
    sh.appendRow([body.amazon_link, body.promo_code || '', body.discount_price || '', _today()]);
    return out({ ok: true, added: true, asin: asin });
  }

  if (action === 'remove') {
    var target = body.asin ? String(body.asin).toUpperCase() : _asin(body.amazon_link);
    if (!target) return out({ ok: false, error: 'no asin' });
    var d = sh.getDataRange().getValues(), removed = 0;
    for (var j = d.length - 1; j >= 1; j--) {
      if (_asin(d[j][0]) === target) { sh.deleteRow(j + 1); removed++; }
    }
    return out({ ok: true, removed: removed });
  }

  if (action === 'cleanup') {                          // delete rows older than N days
    var days = body.days || 5;
    var cutoff = new Date(); cutoff.setDate(cutoff.getDate() - days);
    var rows = sh.getDataRange().getValues(), gone = 0;
    for (var k = rows.length - 1; k >= 1; k--) {
      var dv = rows[k][3], dt = dv ? new Date(dv) : null;
      if (dt && !isNaN(dt.getTime()) && dt < cutoff) { sh.deleteRow(k + 1); gone++; }
    }
    return out({ ok: true, removed: gone });
  }

  return out({ ok: false, error: 'unknown action' });
}

/** Auto-stamp date_added when a row is typed in directly (e.g. by the VA). */
function onEdit(e) {
  try {
    var sh = e.range.getSheet();
    var row = e.range.getRow();
    if (row < 2) return;
    var link = sh.getRange(row, 1).getValue();
    var dateCell = sh.getRange(row, 4);
    if (link && !dateCell.getValue()) dateCell.setValue(_today());
  } catch (err) { /* ignore */ }
}
