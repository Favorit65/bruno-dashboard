// Имитация сервисов Apps Script для прогона apps-script/*.gs в node:
// таблица в памяти, Utilities, LockService, MailApp, UrlFetchApp…
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { ROOT } = require('./load.js');

function fakeGas() {
  const mails = [], props = {};
  const sheets = [];
  function Sheet(name) {
    const cells = []; // cells[r][c], 0-based
    const sh = {
      name, cells, frozen: 0,
      getName: () => name,
      getLastRow: () => { for (let r = cells.length - 1; r >= 0; r--) if ((cells[r] || []).some((v) => v !== '' && v != null)) return r + 1; return 0; },
      getLastColumn: () => cells.reduce((m, row) => { let l = 0; (row || []).forEach((v, i) => { if (v !== '' && v != null) l = i + 1; }); return Math.max(m, l); }, 0),
      getMaxRows: () => Math.max(1000, cells.length),
      setFrozenRows: (n) => { sh.frozen = n; },
      getRange: (r, c, nr, nc) => {
        nr = nr || 1; nc = nc || 1;
        const rg = {
          getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => { const v = (cells[r - 1 + i] || [])[c - 1 + j]; return v == null ? '' : v; })),
          setValues: (vals) => {
            assert.equal(vals.length, nr); vals.forEach((row) => assert.equal(row.length, nc, 'ширина setValues'));
            vals.forEach((row, i) => row.forEach((v, j) => {
              const rr = r - 1 + i; cells[rr] = cells[rr] || [];
              // Как в Таблицах: «'» в начале — признак текста, в значение не входит;
              // строка с «=» без него стала бы формулой.
              if (typeof v === 'string' && v.startsWith('=')) throw new Error('формула в ячейке: ' + v);
              cells[rr][c - 1 + j] = typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v;
            }));
            return rg;
          },
          setNumberFormat: () => rg, setFontWeight: () => rg, setBackground: () => rg, setDataValidation: () => rg
        };
        return rg;
      }
    };
    return sh;
  }
  const ss = {
    getId: () => 'sheet-id', getName: () => 'Поручения',
    getSheetByName: (n) => sheets.find((s) => s.name === n) || null,
    insertSheet: (n) => { const s = Sheet(n); sheets.push(s); return s; },
    getSheets: () => sheets.slice(), deleteSheet: (s) => sheets.splice(sheets.indexOf(s), 1)
  };
  const vb = { requireValueInList: () => vb, setAllowInvalid: () => vb, setHelpText: () => vb, build: () => ({}) };
  const g = {
    console: { log() {}, warn() {}, error: (...a) => console.error(...a) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss, flush() {}, newDataValidation: () => vb },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ setMimeType() { return this; }, text: s }) },
    MailApp: { quota: 100, getRemainingDailyQuota() { return this.quota; }, sendEmail(o) { mails.push(o); } },
    UrlFetchApp: { fetch: () => ({ getContentText: () => fs.readFileSync(path.join(ROOT, 'docs/demo_tasks.json'), 'utf8') }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, s) => Array.from(crypto.createHash(alg).update(s, 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
      getUuid: () => crypto.randomUUID(),
      formatDate: (d, tz, fmt) => {
        const p = {}; new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
          .formatToParts(d).forEach((x) => { p[x.type] = x.value; });
        return fmt.replace('yyyy', p.year).replace('yy', p.year.slice(2)).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute);
      }
    }
  };
  const ctx = vm.createContext(g);
  for (const f of ['Code.gs', 'Core.gs', 'Status.gs']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'apps-script', f), 'utf8'), ctx, { filename: f });
  const post = (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  const rows = (name) => { const s = ss.getSheetByName(name); const [h, ...r] = s.cells; return r.filter((x) => x && x[0]).map((x) => Object.fromEntries(h.map((k, i) => [k, x[i] == null ? '' : x[i]]))); };
  return { ctx, post, rows, mails, ss };
}

module.exports = { fakeGas };
