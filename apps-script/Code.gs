/**
 * שמירות — Apps Script לסנכרון החלפות מהאתר לגיליון
 * ------------------------------------------------------------------
 * התקנה (פעם אחת, ע"י בעל הגיליון):
 *  1. בגיליון: הרחבות ← Apps Script. מחקו את התוכן והדביקו את הקובץ הזה.
 *  2. (רשות) הגדרות הפרויקט ← מאפייני סקריפט: הוסיפו SWAP_PIN עם קוד סודי.
 *     אם מוגדר — האתר יבקש את הקוד לפני כל החלפה.
 *  3. פריסה ← פריסה חדשה ← סוג: אפליקציית אינטרנט.
 *     הפעלה בתור: אני · מי יכול לגשת: כל אחד.
 *  4. העתיקו את כתובת ה-/exec והדביקו אותה באתר (⚙️ הגדרות) או ב-js/config.js.
 *
 * GET  ?action=data         → כל המשמרות + החיילים (JSON)
 * POST {pin, by, changes:[{id, from, to}]}  → מעדכן את עמודת "שם השומר"
 *      כל שינוי נבדק: השם הנוכחי בגיליון חייב להיות from (מונע דריסה של שינוי של מישהו אחר).
 */

var LIST_SHEET = 'רשימת שמירות';
var SOLDIERS_SHEET = 'חיילים';
var LOG_SHEET = 'יומן החלפות';
var NAME_HEADER = 'שם השומר';

function doGet(e) {
  return json_(readData_());
}

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'בקשה לא תקינה' }); }

  var pin = PropertiesService.getScriptProperties().getProperty('SWAP_PIN');
  if (pin && String(body.pin || '') !== String(pin)) return json_({ ok: false, error: 'קוד החלפה שגוי', needPin: true });

  var changes = body.changes || [];
  if (!changes.length) return json_({ ok: false, error: 'אין שינויים' });

  var lock = LockService.getDocumentLock();
  lock.waitLock(15000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(LIST_SHEET);
    var values = sh.getDataRange().getDisplayValues();
    var header = values[0];
    var idCol = 0;
    var nameCol = header.indexOf(NAME_HEADER);
    if (nameCol < 0) return json_({ ok: false, error: 'לא נמצאה עמודת "' + NAME_HEADER + '"' });

    var rowById = {};
    for (var r = 1; r < values.length; r++) rowById[String(values[r][idCol]).trim()] = r;

    // בדיקה מקדימה — הכול או כלום
    var conflicts = [];
    changes.forEach(function (c) {
      var r = rowById[String(c.id)];
      if (r === undefined) conflicts.push({ id: c.id, reason: 'משמרת לא נמצאה' });
      else if (String(values[r][nameCol]).trim() !== String(c.from).trim())
        conflicts.push({ id: c.id, reason: 'השם בגיליון השתנה', current: values[r][nameCol] });
    });
    if (conflicts.length) return json_({ ok: false, error: 'התנגשות — הגיליון השתנה מאז הטעינה', conflicts: conflicts });

    changes.forEach(function (c) {
      sh.getRange(rowById[String(c.id)] + 1, nameCol + 1).setValue(c.to);
    });

    var log = ss.getSheetByName(LOG_SHEET) || ss.insertSheet(LOG_SHEET);
    if (log.getLastRow() === 0) log.appendRow(['זמן', 'בוצע ע"י', '# משמרת', 'יום', 'שעה', 'עמדה', 'מ־', 'אל']);
    changes.forEach(function (c) {
      var row = values[rowById[String(c.id)]];
      log.appendRow([new Date(), body.by || '', c.id, row[1], row[2] + '–' + row[3], row[7], c.from, c.to]);
    });
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return json_({ ok: true, data: readData_() });
}

function readData_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return {
    ok: true,
    list: ss.getSheetByName(LIST_SHEET).getDataRange().getDisplayValues(),
    soldiers: ss.getSheetByName(SOLDIERS_SHEET).getDataRange().getDisplayValues(),
    at: new Date().toISOString()
  };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
