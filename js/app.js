/* =======================================================================
   השמירונית — לוגיקת האתר
   מקור נתונים: גיליון Google (חי) ← מטמון מקומי ← תמונת מצב מובנית
   ======================================================================= */
'use strict';

const C = window.CONFIG;
const WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const LS = {
  get(k, d) { try { const v = localStorage.getItem('shmirot.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('shmirot.' + k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem('shmirot.' + k); } catch (e) {} }
};

/* ---------- עזרים ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hm = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
const fmtHM = min => { min = ((Math.round(min) % 1440) + 1440) % 1440; return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'); };
const normTime = t => { const m = String(t || '').trim().match(/^(\d{1,2}):(\d{2})/); return m ? m[1].padStart(2, '0') + ':' + m[2] : String(t || '').trim(); };
const teamNum = team => (String(team).match(/\d+/) || [''])[0];
const teamCls = team => 'team team-' + teamNum(team);
const postBase = post => String(post).replace(/\s*[אב]['׳]\s*$/, '').trim();
const fmtHours = h => (Math.round(h * 10) / 10).toString();
function fmtDur(min) {
  min = Math.max(0, Math.round(min));
  if (min < 60) return min + ' דק׳';
  const h = Math.floor(min / 60), m = min % 60;
  if (h >= 24) { const d = Math.floor(h / 24); return d + ' ימים ו־' + (h % 24) + ' שע׳'; }
  return h + ':' + String(m).padStart(2, '0') + ' שע׳';
}
function fmtCountdown(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}
function toast(msg, ms = 3200) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
const sheetUrl = (gid = C.LIST_GID, range) =>
  `https://docs.google.com/spreadsheets/d/${C.SHEET_ID}/edit#gid=${gid}` + (range ? '&range=' + range : '');

/* =======================================================================
   1. מצב
   ======================================================================= */
const S = {
  base: null,          // { rows, soldiers, source, at }
  rows: [],            // שורות אפקטיביות (כולל שינויים מקומיים)
  byId: new Map(),
  soldiers: new Map(), // name -> { name, team, sleepsInField }
  changes: LS.get('changes', []),
  settings: Object.assign({ start: '', script: C.APPS_SCRIPT_URL || '', by: '', auto: true, notify: '' }, LS.get('settings', {})),
  sim: null,           // זמן מדומה בדקות מתחילת המחנה (או null)
  boardDay: null,
  sort: { search: { key: 't', dir: 1 }, sol: { key: 'team', dir: 1 } },
  swapMode: 'swap'
};

/* =======================================================================
   2. טעינת נתונים
   ======================================================================= */
function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// טבלת "רשימת שמירות" (מערך של מערכים, שורה ראשונה = כותרות) → אובייקטים
function tableToRows(table) {
  const head = table[0].map(h => String(h).trim());
  const col = (name, fallback) => { const i = head.indexOf(name); return i >= 0 ? i : fallback; };
  const I = {
    id: col('#', 0), day: col('יום', 1), from: col('משעה', 2), to: col('עד שעה', 3), hours: col('שעות', 4),
    type: col('סוג', 5), team: col('צוות משובץ', 6), post: col('עמדה', 7), name: col('שם השומר', 8),
    activity: col('פעילות הצוות באותו זמן', 9), note: col('הערה', 10)
  };
  const out = [];
  table.slice(1).forEach((r, i) => {
    const g = k => String(r[I[k]] ?? '').trim();
    if (!g('day') || !g('from')) return;
    out.push({
      id: Number(g('id')) || out.length + 1, sheetRow: i + 2,
      day: g('day'), from: normTime(g('from')), to: normTime(g('to')), hours: Number(g('hours')) || 0,
      type: g('type'), team: g('team'), post: g('post'), name: g('name'),
      activity: g('activity'), note: g('note')
    });
  });
  return out;
}
function tableToSoldiers(table) {
  const head = table[0].map(h => String(h).trim());
  const iN = Math.max(0, head.indexOf('שם')), iT = head.indexOf('צוות'), iS = head.indexOf('ישן בשטח');
  return table.slice(1).filter(r => String(r[iN] || '').trim()).map(r => ({
    name: String(r[iN]).trim(),
    team: iT >= 0 ? String(r[iT]).trim() : '',
    sleepsInField: iS >= 0 ? String(r[iS]).trim() !== 'לא' : true
  }));
}

async function fetchLive() {
  const script = S.settings.script.trim();
  if (script) {
    const res = await fetch(script + (script.includes('?') ? '&' : '?') + 'action=data', { cache: 'no-store' });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'שגיאה ב-Apps Script');
    return { rows: tableToRows(j.list), soldiers: tableToSoldiers(j.soldiers), source: 'script', at: Date.now() };
  }
  const url = gid => `https://docs.google.com/spreadsheets/d/${C.SHEET_ID}/gviz/tq?tqx=out:csv&headers=1&gid=${gid}&_=${Date.now()}`;
  const [a, b] = await Promise.all([fetch(url(C.LIST_GID)), fetch(url(C.SOLDIERS_GID))]);
  if (!a.ok) throw new Error('HTTP ' + a.status);
  const rows = tableToRows(parseCSV(await a.text()));
  if (rows.length < 10 || !rows.some(r => r.name)) throw new Error('הגיליון החזיר נתונים חלקיים');
  let soldiers = [];
  try { if (b.ok) soldiers = tableToSoldiers(parseCSV(await b.text())); } catch (e) {}
  return { rows, soldiers, source: 'live', at: Date.now() };
}

async function loadData(manual) {
  setStatus('loading', 'טוען מהגיליון…');
  try {
    const data = await fetchLive();
    if (!data.soldiers.length && S.base) data.soldiers = S.base.soldiers;
    S.base = data;
    LS.set('cache', data);
    setStatus('live', (data.source === 'script' ? 'מחובר לגיליון (Apps Script)' : 'מחובר לגיליון החי') + ' · עודכן ' + new Date(data.at).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }));
    if (manual) toast('הנתונים עודכנו מהגיליון ✓');
  } catch (err) {
    console.warn('live load failed', err);
    const cache = LS.get('cache', null);
    if (cache && cache.rows && cache.rows.length) {
      S.base = cache;
      setStatus('offline', 'אין חיבור לגיליון — מוצגת הגרסה האחרונה שנטענה (' + new Date(cache.at).toLocaleString('he-IL', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) + ')');
    } else {
      const snap = window.SNAPSHOT.expand();
      snap.rows.forEach(r => { r.sheetRow = r.id + 1; });
      S.base = { ...snap, source: 'snapshot', at: Date.parse(window.SNAPSHOT.takenAt) };
      setStatus('offline', 'אין חיבור לגיליון — מוצגת תמונת מצב מ־' + new Date(S.base.at).toLocaleDateString('he-IL'));
    }
    if (manual) toast('לא הצלחנו להתחבר לגיליון');
  }
  rebuild();
}

function setStatus(kind, text) {
  const el = $('#dataStatus');
  el.classList.toggle('live', kind === 'live');
  el.classList.toggle('offline', kind === 'offline');
  $('#dataStatusText').textContent = text;
}

/* =======================================================================
   3. בניית מודל: שינויים מקומיים, זמנים, זוגות
   ======================================================================= */
function rebuild() {
  const rows = S.base.rows.map(r => ({ ...r }));
  const byId = new Map(rows.map(r => [r.id, r]));

  // שינויים מקומיים: מוחלים רק אם השם בגיליון עדיין המקורי
  S.changes.forEach(ch => {
    const r = byId.get(ch.id);
    if (!r) { ch.state = 'stale'; return; }
    if (ch.status === 'synced') { ch.state = r.name === ch.to ? 'synced' : 'stale-synced'; return; }
    if (r.name === ch.to) ch.state = 'in-sheet';
    else if (r.name === ch.from) { ch.state = 'local'; r.name = ch.to; r.changed = true; }
    else ch.state = 'stale';
  });

  rows.forEach(r => {
    r.dayIdx = C.DAYS.indexOf(r.day);
    if (r.dayIdx < 0) r.dayIdx = WEEKDAYS.indexOf(r.day);
    r.startMin = r.dayIdx * 1440 + hm(r.from);
    let dur = ((hm(r.to) - hm(r.from)) % 1440 + 1440) % 1440;
    if (!dur) dur = r.hours ? r.hours * 60 : 1440;
    r.endMin = r.startMin + dur;
    r.hours = dur / 60;
    r.base = postBase(r.post);
    r.night = r.type === 'לילה';
    r.range = r.type === 'מטווחים' || r.base.includes('ש"ג') || r.base.includes('ש״ג');
  });
  rows.sort((a, b) => a.startMin - b.startMin || postOrder(a.post) - postOrder(b.post));

  // זוגות באותה עמדה ובאותה משמרת
  const slot = new Map();
  rows.forEach(r => { const k = r.startMin + '|' + r.base; (slot.get(k) || slot.set(k, []).get(k)).push(r); });
  rows.forEach(r => { r.partners = slot.get(r.startMin + '|' + r.base).filter(x => x !== r); });

  S.rows = rows;
  S.byId = byId;

  // חיילים: מהלשונית + כל שם שמופיע בשיבוץ
  S.soldiers = new Map();
  (S.base.soldiers || []).forEach(s => S.soldiers.set(s.name, { ...s }));
  rows.forEach(r => { if (r.name && !S.soldiers.has(r.name)) S.soldiers.set(r.name, { name: r.name, team: r.team, sleepsInField: true, unknown: true }); });

  S.campStart = Math.min(...rows.map(r => r.startMin));
  S.campEnd = Math.max(...rows.map(r => r.endMin));
  S.days = C.DAYS.filter(d => rows.some(r => r.day === d));
  rows.forEach(r => { if (!S.days.includes(r.day)) S.days.push(r.day); });
  S.posts = [...C.POSTS.filter(p => rows.some(r => r.post === p)), ...new Set(rows.map(r => r.post).filter(p => !C.POSTS.includes(p)))];
  S.teams = [...new Set(rows.map(r => r.team).concat([...S.soldiers.values()].map(s => s.team)).filter(Boolean))].sort((a, b) => teamNum(a) - teamNum(b));

  fillStaticLists();
  renderAll();
}
function postOrder(p) { const i = C.POSTS.indexOf(p); return i < 0 ? 99 : i; }

/* ---------- זמן ---------- */
function campStartDate() {
  if (S.settings.start) return new Date(S.settings.start + 'T00:00:00');
  // ברירת מחדל: יום ראשון של השבוע הנוכחי אם אנחנו בימי המחנה, אחרת ראשון הבא
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const wd = d.getDay();
  d.setDate(d.getDate() - wd + (wd <= C.DAYS.length - 1 ? 0 : 7));
  return d;
}
// זמן נוכחי בדקות ביחס לחצות של יום ראשון במחנה
function nowAbs() {
  if (S.sim != null) return S.sim;
  const n = new Date();
  const sec = n.getHours() * 60 + n.getMinutes() + n.getSeconds() / 60;
  if (S.settings.start) {
    const diff = Math.floor((new Date(n.getFullYear(), n.getMonth(), n.getDate()) - campStartDate()) / 864e5);
    return diff * 1440 + sec;
  }
  const idx = C.DAYS.indexOf(WEEKDAYS[n.getDay()]);
  return idx >= 0 ? idx * 1440 + sec : (n.getDay() - 0) * 1440 + sec; // אחרי ימי המחנה בשבוע
}
const isNow = (r, t = nowAbs()) => r.startMin <= t && t < r.endMin;
const dayName = idx => C.DAYS[idx] || WEEKDAYS[((idx % 7) + 7) % 7] || '';
const when = r => `${r.day} ${r.from}–${r.to}`;

/* =======================================================================
   4. בדיקות שיבוץ (החלפות)
   ======================================================================= */
function checkAssign(name, shift, exclude = []) {
  const out = [];
  if (!name) return out;
  const sol = S.soldiers.get(name);
  if (!sol || sol.unknown) out.push({ lvl: 'warn', msg: `״${name}״ לא מופיע/ה ברשימת החיילים` });
  const mine = S.rows.filter(r => r.name === name && r.id !== shift.id && !exclude.includes(r.id));
  mine.forEach(r => {
    if (r.startMin < shift.endMin && shift.startMin < r.endMin) out.push({ lvl: 'err', msg: `כבר משובץ/ת באותו זמן: ${when(r)} ב${r.post}` });
    else if (r.endMin === shift.startMin || r.startMin === shift.endMin) out.push({ lvl: 'warn', msg: `משמרת צמודה ללא הפסקה: ${when(r)} ב${r.post}` });
    else {
      const gap = r.endMin <= shift.startMin ? shift.startMin - r.endMin : r.startMin - shift.endMin;
      if (gap < 60) out.push({ lvl: 'warn', msg: `פחות משעה מנוחה (${gap} דק׳) ממשמרת ${when(r)}` });
    }
  });
  if (shift.night && sol && sol.sleepsInField === false) out.push({ lvl: 'warn', msg: 'משמרת לילה — לא ישן/ה בשטח' });
  if (sol && sol.team) {
    shift.partners.forEach(p => {
      const pt = (S.soldiers.get(p.name) || {}).team || p.team;
      if (p.name && pt && pt !== sol.team) out.push({ lvl: 'warn', msg: `בן/בת הזוג בעמדה (${p.name}, ${pt}) מצוות אחר — הנוהל: זוג מאותו צוות` });
    });
  }
  return out;
}
function renderChecks(list) {
  if (!list.length) return '<div class="check-item ok">✓ אין התנגשויות — ההחלפה תקינה</div>';
  return list.map(c => `<div class="check-item ${c.lvl}">${c.lvl === 'err' ? '⛔' : '⚠️'} ${esc(c.msg)}</div>`).join('');
}
/* ---------- זיהוי שם לפי שם פרטי / חלק מהשם ---------- */
const normName = s => String(s || '').trim().replace(/\s+/g, ' ').replace(/[׳']/g, "'").replace(/[״"]/g, '"');
// כל החיילים שמתאימים לטקסט: שם מלא מדויק, או שכל מילה שהוקלדה היא תחילת מילה בשם (״גלעד״, ״גלעד ש״, ״שלמון״)
function findNames(q) {
  q = normName(q);
  if (!q) return [];
  const all = [...S.soldiers.keys()];
  const exact = all.find(n => normName(n) === q);
  if (exact) return [exact];
  const toks = q.split(' ');
  return all.filter(n => { const w = normName(n).split(' '); return toks.every(t => w.some(x => x.startsWith(t))); })
    .sort((a, b) => a.localeCompare(b, 'he'));
}
// שם מלא אם יש התאמה יחידה, אחרת הטקסט כפי שהוקלד
function resolveName(q) { const m = findNames(q); return m.length === 1 ? m[0] : String(q || '').trim(); }
// שדה שם: בהתאמה יחידה — משלים לשם המלא; בכמה התאמות — מציג כפתורי בחירה מתחת לשדה
function nameChoices(input, onPick) {
  const host = input.closest('label, .hero-search, .replace-row') || input;
  let box = host.nextElementSibling && host.nextElementSibling.classList.contains('name-choices') ? host.nextElementSibling : null;
  const m = findNames(input.value);
  if (m.length === 1 && input.value.trim() !== m[0]) input.value = m[0];
  if (m.length < 2) { if (box) box.remove(); return m.length === 1; }
  if (!box) { box = document.createElement('div'); box.className = 'name-choices suggest-list'; host.after(box); }
  box.innerHTML = `<span class="muted small">למי התכוונת?</span>` + m.slice(0, 12).map(n => `<button type="button" data-choice="${esc(n)}"><span class="badge ${teamCls((S.soldiers.get(n) || {}).team)}">${teamNum((S.soldiers.get(n) || {}).team)}</span>${esc(n)}</button>`).join('') + (m.length > 12 ? `<span class="muted small">ועוד ${m.length - 12}…</span>` : '');
  box.onclick = e => { const b = e.target.closest('[data-choice]'); if (!b) return; input.value = b.dataset.choice; box.remove(); onPick(); };
  return false;
}

function soldierHours(name) { return S.rows.filter(r => r.name === name).reduce((a, r) => a + r.hours, 0); }

// מועמדים להחליף במשמרת — בלי התנגשות, מאותו צוות של בן הזוג, עם הכי מעט שעות
function candidates(shift, limit = 10) {
  const pteam = shift.partners.length ? ((S.soldiers.get(shift.partners[0].name) || {}).team || shift.partners[0].team) : shift.team;
  return [...S.soldiers.values()]
    .filter(s => s.name !== shift.name && !shift.partners.some(p => p.name === s.name))
    .map(s => {
      const chk = checkAssign(s.name, shift);
      if (chk.some(c => c.lvl === 'err')) return null;
      const warns = chk.filter(c => c.lvl === 'warn').length;
      const hours = soldierHours(s.name);
      return { s, warns, hours, score: warns * 10 + hours * 2 + (s.team === pteam ? 0 : 6) };
    })
    .filter(Boolean).sort((a, b) => a.score - b.score).slice(0, limit);
}

/* =======================================================================
   5. ביצוע שינויים
   ======================================================================= */
async function applyChanges(changes, label) {
  const script = S.settings.script.trim();
  const stamp = Date.now();
  const recs = changes.map(c => {
    const r = S.byId.get(c.id) || S.rows.find(x => x.id === c.id);
    return { id: c.id, from: c.from, to: c.to, at: stamp, label, desc: `${r.day} ${r.from}–${r.to} · ${r.post}`, sheetRow: r.sheetRow, status: 'local' };
  });

  if (script) {
    try {
      let pin = sessionStorage.getItem('shmirot.pin') || '';
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await fetch(script, { method: 'POST', body: JSON.stringify({ pin, by: S.settings.by || '', changes }) });
        const j = await res.json();
        if (j.ok) {
          recs.forEach(r => { r.status = 'synced'; });
          S.changes.push(...recs); saveChanges();
          if (j.data) {
            S.base = { rows: tableToRows(j.data.list), soldiers: tableToSoldiers(j.data.soldiers), source: 'script', at: Date.now() };
            LS.set('cache', S.base);
          }
          rebuild();
          toast('ההחלפה נשמרה בגיליון ✓');
          return true;
        }
        if (j.needPin) {
          pin = prompt('קוד החלפה (מהמפקד/ת):') || '';
          if (!pin) break;
          sessionStorage.setItem('shmirot.pin', pin);
          continue;
        }
        alert('ההחלפה לא בוצעה: ' + (j.error || 'שגיאה') + (j.conflicts ? '\nרעננו את הנתונים ונסו שוב.' : ''));
        if (j.conflicts) loadData();
        return false;
      }
      return false;
    } catch (err) {
      console.warn(err);
      toast('אין חיבור לסקריפט — ההחלפה נשמרה מקומית בלבד');
    }
  }
  S.changes.push(...recs); saveChanges();
  rebuild();
  if (!script) toast('נשמר אצלך. כדי שכולם יראו — עדכנו בגיליון (קישור ברשימת השינויים)', 5000);
  return true;
}
function saveChanges() { LS.set('changes', S.changes.map(({ state, ...c }) => c)); }

/* =======================================================================
   6. רינדור
   ======================================================================= */
function renderAll() {
  renderNow();
  renderMine();
  renderBoard();
  renderSearch();
  renderSwapForm();
  renderChanges();
  renderSoldiers();
}

function fillStaticLists() {
  $('#namesList').innerHTML = [...S.soldiers.keys()].sort((a, b) => a.localeCompare(b, 'he')).map(n => `<option value="${esc(n)}">`).join('');
  const fillSel = (sel, items, keep = true) => {
    const el = $(sel), v = el.value;
    const first = el.querySelector('option[value=""]');
    el.innerHTML = (first ? first.outerHTML : '') + items.map(i => `<option value="${esc(i)}">${esc(i)}</option>`).join('');
    if (keep && items.includes(v)) el.value = v;
  };
  fillSel('#fDay', S.days); fillSel('#fTeam', S.teams); fillSel('#fPost', S.posts);
  fillSel('#fType', [...new Set(S.rows.map(r => r.type))]);
  fillSel('#boardTeam', S.teams); fillSel('#solTeam', S.teams);
  const sd = $('#simDay'), v = sd.value;
  sd.innerHTML = S.days.map((d, i) => `<option value="${C.DAYS.indexOf(d) >= 0 ? C.DAYS.indexOf(d) : i}">${d}</option>`).join('');
  if (v) sd.value = v;
  $('#teamLegend').innerHTML = S.teams.map(t => `<span class="badge ${teamCls(t)}">● ${esc(t)}</span>`).join('') +
    '<span class="type-badge night">🌙 לילה</span><span class="type-badge range">🎯 מטווחים</span>';
}

const nameBtn = (name, extra = '') => name ? `<button class="name-btn" data-person="${esc(name)}" ${extra}>${esc(name)}</button>` : '<span class="muted">— לא משובץ —</span>';
const teamBadge = t => t ? `<span class="badge ${teamCls(t)}">${esc(t)}</span>` : '';
const typeBadge = r => r.night ? '<span class="type-badge night">🌙 לילה</span>' : r.range ? '<span class="type-badge range">🎯 מטווחים</span>' : '<span class="type-badge">☀️ יום</span>';

/* ---------- עכשיו ---------- */
function postCards(rows, t, showProgress) {
  const groups = new Map();
  rows.forEach(r => (groups.get(r.base) || groups.set(r.base, []).get(r.base)).push(r));
  return [...groups.values()].map(g => {
    const r = g[0];
    const pct = showProgress ? Math.min(100, Math.max(0, (t - r.startMin) / (r.endMin - r.startMin) * 100)) : 0;
    const left = r.endMin - t;
    return `<div class="post-card ${teamCls(r.team)}">
      <h4><span>${esc(r.base)}</span>${teamBadge(r.team)}</h4>
      <div class="time">${r.from}–${r.to} ${showProgress ? '· נותרו <b data-left="' + r.endMin + '">' + fmtDur(left) + '</b>' : '· בעוד ' + fmtDur(r.startMin - t)}</div>
      <div class="names">${g.map(x => `<div>${nameBtn(x.name)} <span class="muted small">${esc(x.post.replace(r.base, '').trim())}</span> <button class="link-btn small" data-shift="${x.id}">פרטים</button></div>`).join('')}</div>
      <div class="activity">פעילות ${esc(r.team)}: ${esc(r.activity || '—')}</div>
      ${showProgress ? `<div class="progress"><span style="width:${pct}%"></span></div>` : ''}
    </div>`;
  }).join('');
}

function renderNow() {
  const t = nowAbs();
  const banner = $('#campBanner');
  if (t < S.campStart) { banner.hidden = false; banner.textContent = `⏳ השמירות מתחילות בעוד ${fmtDur(S.campStart - t)} (${dayName(Math.floor(S.campStart / 1440))} ${fmtHM(S.campStart)}). אפשר לבחור זמן למעלה כדי לראות את הלוח.`; }
  else if (t >= S.campEnd) { banner.hidden = false; banner.textContent = `✅ השמירות הסתיימו (${dayName(Math.floor((S.campEnd - 1) / 1440))} ${fmtHM(S.campEnd)}). בחרו יום ושעה למעלה כדי לדפדף בלוח.`; }
  else banner.hidden = true;

  const active = S.rows.filter(r => isNow(r, t));
  $('#nowGrid').innerHTML = active.length ? postCards(active, t, true) : '<p class="empty">אין משמרת פעילה בזמן הזה.</p>';

  const next = S.rows.filter(r => r.startMin > t);
  const nextStart = next.length ? next[0].startMin : null;
  const nextRows = next.filter(r => r.startMin === nextStart);
  $('#nextGrid').innerHTML = nextRows.length ? postCards(nextRows, t, false) : '<p class="empty">אין משמרות נוספות.</p>';
  $('#nextIn').textContent = nextStart != null ? `(${dayName(Math.floor(nextStart / 1440))} ${fmtHM(nextStart)}, בעוד ${fmtDur(nextStart - t)})` : '';

  const up = S.rows.filter(r => r.startMin > t && r.startMin <= t + 180);
  const bySlot = new Map();
  up.forEach(r => (bySlot.get(r.startMin) || bySlot.set(r.startMin, []).get(r.startMin)).push(r));
  $('#upcoming').innerHTML = bySlot.size ? [...bySlot.entries()].map(([st, rs]) => `<div class="tl-row">
      <div class="tl-time">${fmtHM(st)}<div class="muted small">${dayName(Math.floor(st / 1440))}</div></div>
      <div class="tl-items">${rs.map(r => `<span class="tl-item ${teamCls(r.team)}"><span class="post">${esc(r.post)}:</span>${nameBtn(r.name)}${teamBadge(r.team)}</span>`).join('')}</div>
    </div>`).join('') : '<p class="empty">אין משמרות בשלוש השעות הקרובות.</p>';
  S.lastNowSlot = active.map(r => r.id).join(',') + '|' + nextStart;
}

function tickClock() {
  const t = nowAbs();
  $('#clockTime').textContent = fmtHM(t);
  const di = Math.floor(t / 1440);
  $('#clockDay').textContent = 'יום ' + dayName(di) + (S.sim != null ? ' · זמן מדומה' : '');
  $('.sim').classList.toggle('simulating', S.sim != null);
  $$('[data-left]').forEach(el => { el.textContent = fmtDur(Number(el.dataset.left) - t); });
  $$('#nowGrid .progress span').forEach((el, i) => {
    const card = el.closest('.post-card'); const b = card.querySelector('[data-left]');
    if (!b) return;
    const end = Number(b.dataset.left); const r = S.rows.find(x => x.endMin === end && isNow(x, t));
    if (r) el.style.width = Math.min(100, (t - r.startMin) / (r.endMin - r.startMin) * 100) + '%';
  });
  // מעבר משמרת → רינדור מחדש
  const active = S.rows.filter(r => isNow(r, t)).map(r => r.id).join(',');
  const next = S.rows.find(r => r.startMin > t);
  if (active + '|' + (next ? next.startMin : null) !== S.lastNowSlot) { renderNow(); renderMine(); markBoardNow(); }
  tickMine(t);
}

/* ---------- המשמרות שלי ---------- */
function currentMe() { return resolveName($('#mineName').value); }
function renderMine() {
  const name = currentMe();
  const body = $('#mineBody');
  if (!name) { body.innerHTML = '<p class="empty">בחרו שם כדי לראות את כל המשמרות, ספירה לאחור למשמרת הבאה, וייצוא ליומן.</p>'; return; }
  const sol = S.soldiers.get(name);
  const mine = S.rows.filter(r => r.name === name);
  if (!sol && !mine.length) {
    const m = findNames(name);
    body.innerHTML = m.length > 1
      ? `<p class="empty">נמצאו ${m.length} חיילים בשם ״${esc(name)}״ — בחרו:</p><div class="suggest-list" style="justify-content:center">${m.map(n => `<button data-person="${esc(n)}"><span class="badge ${teamCls(S.soldiers.get(n).team)}">${teamNum(S.soldiers.get(n).team)}</span>${esc(n)}</button>`).join('')}</div>`
      : `<p class="empty">לא נמצא חייל בשם ״${esc(name)}״.</p>`;
    return;
  }
  const t = nowAbs();
  const hours = mine.reduce((a, r) => a + r.hours, 0);
  const night = mine.filter(r => r.night).reduce((a, r) => a + r.hours, 0);
  const cur = mine.find(r => isNow(r, t));
  const nxt = mine.find(r => r.startMin > t);
  const target = cur || nxt;
  const avg = avgHours();
  const team = sol ? sol.team : (mine[0] || {}).team;
  body.innerHTML = `
    <div class="mine-head">
      <div class="next-card">
        ${target ? `
          <div class="lbl">${cur ? '🟢 את/ה בשמירה עכשיו' : '⏭ המשמרת הבאה שלך'}</div>
          <div class="big">${esc(target.post)} · ${target.day} ${target.from}–${target.to}</div>
          <div class="countdown" id="mineCountdown" data-target="${cur ? cur.endMin : nxt.startMin}" data-mode="${cur ? 'end' : 'start'}"></div>
          <div class="partner">${target.partners.length ? 'עם ' + target.partners.map(p => esc(p.name)).join(', ') : ''}${target.activity ? ' · ' + esc(target.activity) : ''}</div>
        ` : `<div class="lbl">אין עוד משמרות</div><div class="big">סיימת את כל השמירות 💪</div>`}
      </div>
      <div class="stats">
        <div class="stat"><div class="v">${mine.length}</div><div class="k">משמרות</div></div>
        <div class="stat"><div class="v">${fmtHours(hours)}</div><div class="k">שעות שמירה (ממוצע: ${fmtHours(avg)})</div></div>
        <div class="stat"><div class="v">${fmtHours(night)}</div><div class="k">שעות לילה</div></div>
        <div class="stat"><div class="v">${teamBadge(team)}</div><div class="k">${sol && sol.sleepsInField === false ? 'לא ישן/ה בשטח' : 'ישן/ה בשטח'}</div></div>
      </div>
    </div>
    <div class="row-btns" style="margin:0 0 14px">
      <button class="btn small" id="icsBtn">📅 הוספה ליומן</button>
      <button class="btn small ghost-dark" id="shareMine">📤 שיתוף בוואטסאפ</button>
      <button class="btn small ghost-dark" id="copyLink">🔗 קישור אישי</button>
      <button class="btn small ghost-dark" id="mineOnBoard">🗓 הדגשה בלוח</button>
    </div>
    <div class="shift-list">
      ${mine.map(r => {
        const st = r.endMin <= t ? 'past' : isNow(r, t) ? 'now' : '';
        return `<div class="shift-item ${teamCls(r.team)} ${st}">
          <div class="when">${r.from}–${r.to}<small>יום ${r.day}</small></div>
          <div class="what"><b>${esc(r.post)}</b> ${typeBadge(r)}${st === 'now' ? '<span class="status-tag">עכשיו</span>' : st === 'past' ? '<span class="status-tag done">הסתיים</span>' : ''}${r.changed ? ' <span class="sync-tag local">שונה</span>' : ''}
            <div class="partner">${r.partners.length ? 'עם ' + r.partners.map(p => esc(p.name)).join(', ') + ' · ' : ''}${esc(r.activity || '')}</div></div>
          <div>${st === 'past' ? '' : `<button class="btn small ghost-dark" data-swapfrom="${r.id}">🔁 החלפה</button>`}</div>
        </div>`;
      }).join('') || '<p class="empty">אין משמרות משובצות.</p>'}
    </div>`;
  $('#icsBtn').onclick = () => downloadICS(name, mine);
  $('#shareMine').onclick = () => shareText(`🛡 המשמרות של ${name}:\n` + mine.filter(r => r.endMin > t).map(r => `• ${r.day} ${r.from}–${r.to} · ${r.post}${r.partners.length ? ' (עם ' + r.partners.map(p => p.name).join(', ') + ')' : ''}`).join('\n') + '\n\n' + personalLink(name));
  $('#copyLink').onclick = () => copy(personalLink(name), 'הקישור האישי הועתק');
  $('#mineOnBoard').onclick = () => { $('#boardHighlight').value = name; if (target) S.boardDay = target.day; renderBoard(); location.hash = '#board'; };
  tickMine(t);
}
function tickMine(t) {
  const el = $('#mineCountdown'); if (!el) return;
  const secs = (Number(el.dataset.target) - t) * 60;
  el.textContent = (el.dataset.mode === 'end' ? 'נותרו ' : 'בעוד ') + fmtCountdown(secs);
}
function avgHours() {
  const names = [...S.soldiers.keys()];
  return names.length ? names.reduce((a, n) => a + soldierHours(n), 0) / names.length : 0;
}
function personalLink(name) { return location.origin + location.pathname + '?name=' + encodeURIComponent(name) + '#mine'; }

/* ---------- התראה 5 דקות לפני משמרת ---------- */
const NOTIFY_MIN = 5;
// מי יוצא מהעמדה כשהמשמרת מתחילה (השומרים שמסיימים בדיוק אז באותה עמדה)
const outgoing = r => S.rows.filter(x => x.base === r.base && x.endMin === r.startMin && x.name);
function shiftAlert(r) {
  const inn = S.rows.filter(x => x.base === r.base && x.startMin === r.startMin && x.name).map(x => x.name);
  const out = outgoing(r).map(x => x.name);
  return {
    title: `🛡 בעוד ${NOTIFY_MIN} דק׳: ${r.base} ${r.from}–${r.to}`,
    body: `נכנסים: ${inn.join(', ') || '—'}\n` + (out.length ? `מחליפים את: ${out.join(', ')}` : 'פתיחת עמדה — אין שומרים לפניכם') + (r.activity ? `\nפעילות: ${r.activity}` : '')
  };
}
async function showNotice({ title, body }, tag) {
  toast(title + ' · ' + body.split('\n')[0], 8000);
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = { body, tag, renotify: true, requireInteraction: true, vibrate: [300, 120, 300], icon: 'icon.svg', badge: 'icon.svg', data: { url: location.href.split('#')[0] + '#now' } };
  try {
    const reg = 'serviceWorker' in navigator && await navigator.serviceWorker.getRegistration();
    if (reg) return reg.showNotification(title, opts);
    new Notification(title, opts);
  } catch (e) { console.warn(e); }
}
function checkNotify() {
  const mode = S.settings.notify;
  if (!mode || S.sim != null) return;
  const t = nowAbs(), me = currentMe();
  const sent = LS.get('notified', []);
  const due = S.rows.filter(r => r.startMin > t && r.startMin - t <= NOTIFY_MIN && r.name && (mode === 'all' || r.name === me));
  const seen = new Set();
  due.forEach(r => {
    const key = `${r.startMin}|${r.base}|${mode === 'all' ? '' : r.name}`;
    if (seen.has(key) || sent.includes(key)) return;
    seen.add(key); sent.push(key);
    showNotice(shiftAlert(r), 'shift-' + r.startMin + '-' + r.base);
  });
  if (seen.size) LS.set('notified', sent.slice(-300));
}
async function setNotify(mode) {
  if (mode && 'Notification' in window && Notification.permission !== 'granted') {
    const p = await Notification.requestPermission();
    if (p !== 'granted') toast('ההתראות חסומות בדפדפן — יוצגו רק כשהאתר פתוח. אפשר לאשר בהגדרות האתר בדפדפן.', 6000);
  } else if (mode && !('Notification' in window)) {
    toast(/iPhone|iPad/.test(navigator.userAgent) ? 'באייפון: שיתוף ← "הוספה למסך הבית", ואז להפעיל משם' : 'הדפדפן לא תומך בהתראות', 6000);
  }
  S.settings.notify = mode; LS.set('settings', S.settings);
  renderNotifyUI();
  if (mode) toast(mode === 'all' ? '🔔 התראה 5 דק׳ לפני כל משמרת' : '🔔 התראה 5 דק׳ לפני המשמרות של ' + (currentMe() || '— בחרו שם'));
}
function renderNotifyUI() {
  $('#notifyMode').value = S.settings.notify || '';
  const blocked = 'Notification' in window && Notification.permission === 'denied';
  $('#notifyHint').textContent = !S.settings.notify ? '' : blocked ? '⚠️ ההתראות חסומות בדפדפן — תופיע רק הודעה בתוך האתר'
    : 'ההתראה מגיעה כשהאתר פתוח (גם ברקע). ליתר ביטחון — ייצוא ליומן כולל תזכורת 5 דק׳.';
}

/* ---------- ייצוא ליומן (ICS) ---------- */
function downloadICS(name, rows) {
  const base = campStartDate();
  const pad = n => String(n).padStart(2, '0');
  const dt = min => { const d = new Date(base.getTime()); d.setDate(d.getDate() + Math.floor(min / 1440)); const m = min % 1440;
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(Math.floor(m / 60))}${pad(m % 60)}00`; };
  const escI = s => String(s).replace(/[\\;,]/g, c => '\\' + c).replace(/\n/g, '\\n');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//shmirot//HE', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:' + escI('שמירות — ' + name)];
  rows.forEach(r => {
    lines.push('BEGIN:VEVENT', `UID:shmirot-${r.id}-${encodeURIComponent(name).replace(/%/g, '')}@shmirot`,
      'DTSTAMP:' + new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z', 'DTSTART:' + dt(r.startMin), 'DTEND:' + dt(r.endMin),
      'SUMMARY:' + escI(`🛡 שמירה · ${r.post}`),
      'DESCRIPTION:' + escI(`${r.day} ${r.from}–${r.to}\n${r.partners.length ? 'עם ' + r.partners.map(p => p.name).join(', ') + '\n' : ''}${outgoing(r).length ? 'מחליפים את: ' + outgoing(r).map(x => x.name).join(', ') + '\n' : ''}${r.activity || ''}`),
      'BEGIN:VALARM', `TRIGGER:-PT${NOTIFY_MIN}M`, 'ACTION:DISPLAY', 'DESCRIPTION:' + escI(shiftAlert(r).title + '\n' + shiftAlert(r).body), 'END:VALARM', 'END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `shmirot-${name}.ics`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast(`יוצא ליומן לפי יום ראשון = ${base.toLocaleDateString('he-IL')} (ניתן לשנות בהגדרות)`, 5000);
}

/* ---------- לוח שמירות ---------- */
function renderBoard() {
  if (!S.boardDay || !S.days.includes(S.boardDay)) {
    const t = nowAbs(); const di = Math.floor(t / 1440);
    S.boardDay = S.days.includes(dayName(di)) ? dayName(di) : S.days[0];
  }
  const todayName = dayName(Math.floor(nowAbs() / 1440));
  $('#dayTabs').innerHTML = S.days.map(d => `<button role="tab" data-day="${esc(d)}" class="${d === S.boardDay ? 'active' : ''}">${esc(d)}${d === todayName ? '<span class="today-dot" title="היום"></span>' : ''}</button>`).join('');
  $('#board h2').dataset.print = ' — יום ' + S.boardDay;

  const rows = S.rows.filter(r => r.day === S.boardDay);
  const posts = S.posts.filter(p => S.rows.some(r => r.post === p));
  const slots = [...new Set(rows.map(r => r.startMin))].sort((a, b) => a - b);
  const hl = $('#boardHighlight').value.trim(), hlSet = new Set(findNames(hl));
  const tf = $('#boardTeam').value;
  const head = `<thead><tr><th>שעה</th>${posts.map(p => `<th>${esc(p)}</th>`).join('')}<th>לו״ז הצוותים</th></tr></thead>`;
  const body = slots.map(st => {
    const rs = rows.filter(r => r.startMin === st);
    const acts = [...new Map(rs.map(r => [r.team, r.activity])).entries()];
    const distinct = new Set(acts.map(a => a[1]));
    const act = distinct.size <= 1 ? [...distinct][0] || '' : acts.map(([t, a]) => `${t}: ${a}`).join(' · ');
    const end = rs[0].to;
    return `<tr data-start="${st}" data-end="${Math.max(...rs.map(r => r.endMin))}" class="${rs.some(r => r.night) ? 'night' : ''}">
      <td>${fmtHM(st)}<span class="muted small">–${end}</span></td>
      ${posts.map(p => {
        const r = rs.find(x => x.post === p);
        if (!r) return '<td class="cell empty-cell"></td>';
        const cls = [teamCls(r.team), 'chip', r.changed ? 'changed' : '', hl && hlSet.has(r.name) ? 'hl' : '', (hl && !hlSet.has(r.name)) || (tf && r.team !== tf) ? 'dim' : ''].join(' ');
        return `<td class="cell"><button class="${cls}" data-shift="${r.id}" title="${esc(r.team + ' · ' + (r.activity || ''))}">${esc(r.name || '—')}</button></td>`;
      }).join('')}
      <td class="act">${esc(act)}</td></tr>`;
  }).join('');
  $('#boardTable').innerHTML = head + '<tbody>' + body + '</tbody>';
  markBoardNow();
}
function markBoardNow() {
  const t = nowAbs();
  $$('#boardTable tbody tr').forEach(tr => tr.classList.toggle('now-row', Number(tr.dataset.start) <= t && t < Number(tr.dataset.end)));
}

/* ---------- חיפוש ---------- */
function searchRows() {
  let q = $('#q').value.trim();
  const teamTokens = [];
  q = q.replace(/צוות\s*(\d+)/g, (_, n) => { teamTokens.push('צוות ' + n); return ' '; });
  const tokens = q.split(/\s+/).filter(Boolean).map(s => s.replace(/[׳']/g, "'").replace(/[״"]/g, '"'));
  const f = { day: $('#fDay').value, team: $('#fTeam').value, post: $('#fPost').value, type: $('#fType').value, from: $('#fFrom').value, to: $('#fTo').value, future: $('#fFuture').checked };
  const t = nowAbs();
  const norm = s => String(s).replace(/[׳']/g, "'").replace(/[״"]/g, '"');
  return S.rows.filter(r => {
    if (f.day && r.day !== f.day) return false;
    if (f.team && r.team !== f.team) return false;
    if (f.post && r.post !== f.post) return false;
    if (f.type && r.type !== f.type) return false;
    if (f.future && r.endMin <= t) return false;
    if (f.from || f.to) {
      const a = f.from ? hm(f.from) : 0, b = f.to ? hm(f.to) : 1440, x = hm(r.from);
      if (a <= b ? (x < a || x >= b) : (x < a && x >= b)) return false;
    }
    if (teamTokens.some(tt => r.team !== tt)) return false;
    if (tokens.length) {
      const hay = norm([r.day, r.from, r.to, r.post, r.name, r.team, r.type, r.activity, r.note].join(' '));
      if (!tokens.every(tok => hay.includes(tok))) return false;
    }
    return true;
  });
}
function hlText(text, tokens) {
  let s = esc(text);
  tokens.forEach(tok => { if (tok.length > 1) s = s.split(esc(tok)).join(`<mark>${esc(tok)}</mark>`); });
  return s;
}
function renderSearch() {
  const res = searchRows();
  const { key, dir } = S.sort.search;
  const val = r => key === 't' ? r.startMin : r[key] || '';
  res.sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : a.startMin - b.startMin) * dir);
  const tokens = $('#q').value.trim().replace(/צוות\s*\d+/g, ' ').split(/\s+/).filter(Boolean);
  const hours = res.reduce((a, r) => a + r.hours, 0);
  const people = new Set(res.map(r => r.name)).size;
  $('#resultCount').innerHTML = `<b>${res.length}</b> משמרות · <b>${fmtHours(hours)}</b> שעות · <b>${people}</b> שומרים`;
  const t = nowAbs();
  const MAX = 400;
  $('#resultsTable tbody').innerHTML = res.slice(0, MAX).map(r => `<tr class="${r.endMin <= t ? 'past' : isNow(r, t) ? 'now' : ''}">
      <td class="when">${r.day} ${r.from}–${r.to}</td>
      <td>${hlText(r.post, tokens)}</td>
      <td>${r.name ? `<button class="name-btn" data-person="${esc(r.name)}">${hlText(r.name, tokens)}</button>` : '—'}${r.changed ? ' <span class="sync-tag local">שונה</span>' : ''}</td>
      <td>${teamBadge(r.team)}</td><td>${typeBadge(r)}</td>
      <td class="small">${hlText(r.activity || '', tokens)}</td>
      <td><button class="link-btn" data-shift="${r.id}">פרטים</button></td></tr>`).join('') ||
    '<tr><td colspan="7" class="empty">לא נמצאו משמרות מתאימות.</td></tr>';
  $$('#resultsTable th[data-sort]').forEach(th => { th.classList.toggle('sorted-asc', th.dataset.sort === key && dir === 1); th.classList.toggle('sorted-desc', th.dataset.sort === key && dir === -1); });
}
function exportCSV() {
  const res = searchRows();
  const cell = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = [['#', 'יום', 'משעה', 'עד שעה', 'שעות', 'סוג', 'צוות', 'עמדה', 'שומר', 'פעילות'].map(cell).join(',')]
    .concat(res.map(r => [r.id, r.day, r.from, r.to, r.hours, r.type, r.team, r.post, r.name, r.activity].map(cell).join(',')));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'shmirot.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- החלפות ---------- */
function shiftOptions(name, selected, includePast) {
  const t = nowAbs();
  const rows = S.rows.filter(r => r.name === name && (includePast || r.endMin > t));
  return '<option value="">— בחירת משמרת —</option>' + rows.map(r => `<option value="${r.id}" ${String(r.id) === String(selected) ? 'selected' : ''}>${r.day} ${r.from}–${r.to} · ${esc(r.post)}</option>`).join('');
}
function renderSwapForm() {
  const a = resolveName($('#swA').value), b = resolveName($('#swB').value);
  const aSel = $('#swAShift').value, bSel = $('#swBShift').value;
  $('#swAShift').innerHTML = a ? shiftOptions(a, aSel) : '<option value="">— קודם בוחרים שם —</option>';
  $('#swBShift').innerHTML = b ? shiftOptions(b, bSel) : '<option value="">— קודם בוחרים שם —</option>';
  $('#swBShiftWrap').hidden = S.swapMode === 'cover';
  $$('#swapMode button').forEach(x => x.classList.toggle('active', x.dataset.mode === S.swapMode));
  evalSwap();
}
function swapPlan() {
  const a = resolveName($('#swA').value), b = resolveName($('#swB').value);
  const s1 = S.rows.find(r => String(r.id) === $('#swAShift').value);
  const s2 = S.swapMode === 'swap' ? S.rows.find(r => String(r.id) === $('#swBShift').value) : null;
  return { a, b, s1, s2 };
}
function evalSwap() {
  const { a, b, s1, s2 } = swapPlan();
  const box = $('#swapCheck'), sug = $('#swapSuggest'), btn = $('#swapApply');
  btn.disabled = true; box.innerHTML = ''; sug.innerHTML = '';
  if (s1 && !b) {
    const c = candidates(s1, 12);
    sug.innerHTML = `<div class="suggest"><h4>מי פנוי/ה להחליף ב־${s1.day} ${s1.from}–${s1.to}?</h4><div class="suggest-list">${
      c.map(x => `<button data-pick="${esc(x.s.name)}" class="${teamCls(x.s.team)}"><span class="badge ${teamCls(x.s.team)}">${teamNum(x.s.team)}</span>${esc(x.s.name)} <small>${fmtHours(x.hours)} ש׳${x.warns ? ' ⚠' : ''}</small></button>`).join('') || '<span class="muted">אין מועמדים ללא התנגשות</span>'
    }</div></div>`;
  }
  if (!a || !s1 || !b) { box.innerHTML = '<p class="muted small">בחרו חייל/ה ומשמרת, ואז את מי שמחליף/ה. ההחלפה תיבדק אוטומטית.</p>'; return; }
  if (a === b) { box.innerHTML = renderChecks([{ lvl: 'err', msg: 'אותו חייל בשני הצדדים' }]); return; }
  if (S.swapMode === 'swap' && !s2) {
    box.innerHTML = '<p class="muted small">בחרו את המשמרת של ' + esc(b) + ' שתעבור ל' + esc(a) + ' — או עברו ל״מישהו מחליף אותי״.</p>';
    const c = checkAssign(b, s1); box.innerHTML += renderChecks(c); return;
  }
  const c1 = checkAssign(b, s1, s2 ? [s2.id] : []).map(c => ({ ...c, msg: `${b} ← ${s1.day} ${s1.from}: ${c.msg}` }));
  const c2 = s2 ? checkAssign(a, s2, [s1.id]).map(c => ({ ...c, msg: `${a} ← ${s2.day} ${s2.from}: ${c.msg}` })) : [];
  const all = c1.concat(c2);
  box.innerHTML = `<div class="check-item ok" style="color:var(--text);border-color:var(--border);background:var(--surface-2)">
      <b>${esc(b)}</b> ייקח/תיקח את ${s1.day} ${s1.from}–${s1.to} (${esc(s1.post)})${s2 ? `<br><b>${esc(a)}</b> ייקח/תיקח את ${s2.day} ${s2.from}–${s2.to} (${esc(s2.post)})` : ''}</div>` + renderChecks(all);
  btn.disabled = all.some(c => c.lvl === 'err');
}
async function doSwap() {
  const { a, b, s1, s2 } = swapPlan();
  if (!s1 || !b) return;
  const changes = [{ id: s1.id, from: a, to: b }];
  if (s2) changes.push({ id: s2.id, from: b, to: a });
  const warns = $$('#swapCheck .check-item.warn').length;
  if (warns && !confirm('יש אזהרות בהחלפה. לבצע בכל זאת?')) return;
  const ok = await applyChanges(changes, s2 ? `החלפה: ${a} ⇄ ${b}` : `${b} מחליף/ה את ${a}`);
  if (ok) { $('#swB').value = ''; renderSwapForm(); }
}
function renderChanges() {
  const list = S.changes.slice().reverse();
  const script = S.settings.script.trim();
  $('#changesCount').textContent = S.changes.filter(c => c.state === 'local').length;
  $('#syncMode').innerHTML = script
    ? '🟢 מחובר ל-Apps Script: החלפות נשמרות ישירות בגיליון ומתועדות בלשונית "יומן החלפות".'
    : '🟡 מצב מקומי: ההחלפות נשמרות רק במכשיר הזה. כדי שכולם יראו, לחצו "עדכון בגיליון" ליד כל שינוי (הגיליון פתוח לעריכה), או חברו Apps Script בהגדרות ⚙️.';
  const stateTag = c => ({
    local: '<span class="sync-tag local">מקומי</span>',
    'in-sheet': '<span class="sync-tag synced">מעודכן בגיליון</span>',
    synced: '<span class="sync-tag synced">נשמר בגיליון</span>',
    stale: '<span class="sync-tag stale">הגיליון השתנה</span>',
    'stale-synced': '<span class="sync-tag stale">שונה שוב בגיליון</span>'
  }[c.state] || '');
  $('#changesList').innerHTML = list.map(c => `<li class="${c.state === 'local' ? '' : c.state && c.state.startsWith('stale') ? 'stale' : 'synced'}">
      <div><b>${esc(c.from)}</b> → <b>${esc(c.to)}</b> ${stateTag(c)}
        <div class="meta">${esc(c.desc)} · ${new Date(c.at).toLocaleString('he-IL', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</div></div>
      <div class="row-btns" style="margin:0">
        ${c.state === 'local' && c.sheetRow ? `<a class="btn small ghost-dark" target="_blank" rel="noopener" href="${sheetUrl(C.LIST_GID, 'I' + c.sheetRow)}" title="פתיחת התא בגיליון">✎ עדכון בגיליון</a>` : ''}
        ${c.status !== 'synced' ? `<button class="btn small ghost-dark danger" data-undo="${c.at}-${c.id}" title="ביטול">✕</button>` : ''}
      </div></li>`).join('') || '<li class="muted" style="grid-template-columns:1fr">עדיין אין שינויים.</li>';
  $('#syncBtn').hidden = !(script && S.changes.some(c => c.state === 'local'));
}
async function syncLocal() {
  const local = S.changes.filter(c => c.state === 'local');
  if (!local.length) return;
  S.changes = S.changes.filter(c => c.state !== 'local'); saveChanges();
  rebuild();
  const ok = await applyChanges(local.map(c => ({ id: c.id, from: c.from, to: c.to })), 'סנכרון שינויים מקומיים');
  if (!ok) { S.changes.push(...local); saveChanges(); rebuild(); }
}
function changesText() {
  const rel = S.changes.filter(c => c.state === 'local' || c.state === 'in-sheet' || c.state === 'synced');
  if (!rel.length) return '';
  return '🔁 עדכון שמירות:\n' + rel.map(c => `• ${c.desc}: ${c.to} (במקום ${c.from})`).join('\n');
}

/* ---------- חיילים ---------- */
function soldierStats() {
  const t = nowAbs();
  return [...S.soldiers.values()].map(s => {
    const rs = S.rows.filter(r => r.name === s.name);
    const nx = rs.find(r => r.endMin > t);
    return {
      ...s, count: rs.length,
      hours: rs.reduce((a, r) => a + r.hours, 0),
      night: rs.filter(r => r.night).reduce((a, r) => a + r.hours, 0),
      day: rs.filter(r => !r.night).reduce((a, r) => a + r.hours, 0),
      sg: rs.filter(r => r.range).length,
      next: nx ? nx.startMin : Infinity, nextRow: nx, sleeps: s.sleepsInField ? 1 : 0
    };
  });
}
function renderSoldiers() {
  const stats = soldierStats();
  const avg = stats.length ? stats.reduce((a, s) => a + s.hours, 0) / stats.length : 0;
  const maxH = Math.max(1, ...stats.map(s => s.hours));
  // כרטיסי צוות
  $('#teamCards').innerHTML = S.teams.map(team => {
    const ss = stats.filter(s => s.team === team);
    const rs = S.rows.filter(r => r.team === team);
    const h = rs.reduce((a, r) => a + r.hours, 0);
    return `<div class="team-card ${teamCls(team)}"><h4>${esc(team)}</h4><dl>
      <dt>חיילים</dt><dd>${ss.length}</dd>
      <dt>משמרות משובצות</dt><dd>${rs.length}</dd>
      <dt>סה״כ שעות</dt><dd>${fmtHours(h)}</dd>
      <dt>משמרות לילה</dt><dd>${rs.filter(r => r.night).length}</dd>
      <dt>משמרות ש״ג</dt><dd>${rs.filter(r => r.range).length}</dd>
      <dt>ממוצע לחייל</dt><dd>${ss.length ? fmtHours(ss.reduce((a, s) => a + s.hours, 0) / ss.length) : '—'} ש׳</dd>
    </dl></div>`;
  }).join('') + `<div class="team-card"><h4 style="color:var(--heading)">כל הפלוגה</h4><dl>
      <dt>חיילים</dt><dd>${stats.length}</dd><dt>משמרות</dt><dd>${S.rows.length}</dd>
      <dt>סה״כ שעות</dt><dd>${fmtHours(S.rows.reduce((a, r) => a + r.hours, 0))}</dd>
      <dt>ממוצע לחייל</dt><dd>${fmtHours(avg)} ש׳</dd></dl></div>`;

  const q = $('#solQ').value.trim(), tf = $('#solTeam').value, anomOnly = $('#solAnomaly').checked;
  const tol = Math.max(0.5, avg * 0.12);
  let list = stats.filter(s => (!q || s.name.includes(q)) && (!tf || s.team === tf) && (!anomOnly || Math.abs(s.hours - avg) > tol));
  const { key, dir } = S.sort.sol;
  list.sort((a, b) => {
    const va = a[key], vb = b[key];
    const c = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb), 'he');
    return (c || a.name.localeCompare(b.name, 'he')) * dir;
  });
  $('#solTable tbody').innerHTML = list.map(s => {
    const an = s.hours - avg > tol ? 'anomaly-hi' : avg - s.hours > tol ? 'anomaly-lo' : '';
    return `<tr>
      <td><button class="name-btn" data-person="${esc(s.name)}">${esc(s.name)}</button></td>
      <td>${teamBadge(s.team)}</td><td>${s.sleepsInField ? 'כן' : '<b>לא</b>'}</td>
      <td>${s.count}</td>
      <td><div class="bar-cell ${teamCls(s.team)}"><span class="${an}" title="${an ? (an === 'anomaly-hi' ? 'מעל הממוצע' : 'מתחת לממוצע') : ''}">${fmtHours(s.hours)}</span><div class="bar"><span style="width:${s.hours / maxH * 100}%"></span></div></div></td>
      <td>${fmtHours(s.night)}</td><td>${fmtHours(s.day)}</td><td>${s.sg}</td>
      <td class="small">${s.nextRow ? `${s.nextRow.day} ${s.nextRow.from}` : '—'}</td></tr>`;
  }).join('') || '<tr><td colspan="9" class="empty">אין תוצאות.</td></tr>';
  $$('#solTable th[data-sort]').forEach(th => { th.classList.toggle('sorted-asc', th.dataset.sort === key && dir === 1); th.classList.toggle('sorted-desc', th.dataset.sort === key && dir === -1); });
}

/* ---------- חלון פרטי משמרת ---------- */
function openShift(id) {
  const r = S.rows.find(x => String(x.id) === String(id));
  if (!r) return;
  const sol = S.soldiers.get(r.name);
  const t = nowAbs();
  const status = r.endMin <= t ? 'הסתיימה' : isNow(r, t) ? '🟢 פעילה עכשיו' : 'בעוד ' + fmtDur(r.startMin - t);
  const c = candidates(r, 8);
  $('#shiftModalBody').innerHTML = `
    <h3>${esc(r.post)} · ${r.day} ${r.from}–${r.to}</h3>
    <dl class="kv">
      <dt>שומר/ת</dt><dd>${nameBtn(r.name)} ${r.changed ? '<span class="sync-tag local">שונה מקומית</span>' : ''}</dd>
      <dt>בן/בת זוג</dt><dd>${r.partners.map(p => nameBtn(p.name)).join(', ') || '—'}</dd>
      <dt>צוות משובץ</dt><dd>${teamBadge(r.team)} ${sol && sol.team && sol.team !== r.team ? `<span class="muted small">(השומר/ת מ${esc(sol.team)})</span>` : ''}</dd>
      <dt>סוג</dt><dd>${typeBadge(r)} · ${fmtHours(r.hours)} ש׳</dd>
      <dt>סטטוס</dt><dd>${status}</dd>
      <dt>פעילות הצוות</dt><dd>${esc(r.activity || '—')}</dd>
      ${r.note ? `<dt>הערה</dt><dd>${esc(r.note)}</dd>` : ''}
    </dl>
    ${r.endMin > t ? `
    <h4 style="margin:14px 0 4px">🙋 החלפת השומר/ת במשמרת הזו</h4>
    <div class="replace-row">
      <input type="search" id="mReplace" list="namesList" placeholder="מי מחליף/ה?" autocomplete="off">
      <button class="btn small" id="mApply" disabled>החלפה</button>
    </div>
    <div class="checks" id="mChecks"></div>
    <div class="suggest"><h4>מועמדים פנויים (מעט שעות, אותו צוות, בלי התנגשות)</h4><div class="suggest-list">${
      c.map(x => `<button data-mpick="${esc(x.s.name)}"><span class="badge ${teamCls(x.s.team)}">${teamNum(x.s.team)}</span>${esc(x.s.name)} <small>${fmtHours(x.hours)} ש׳${x.warns ? ' ⚠' : ''}</small></button>`).join('') || '<span class="muted">אין</span>'
    }</div></div>` : ''}
    <div class="row-btns">
      ${r.endMin > t ? `<button class="btn small ghost-dark" id="mSwapForm">🔁 החלפת משמרות (הדדית)</button>` : ''}
      <a class="btn small ghost-dark" target="_blank" rel="noopener" href="${sheetUrl(C.LIST_GID, 'I' + (r.sheetRow || r.id + 1))}">📄 פתיחה בגיליון</a>
    </div>`;
  const dlg = $('#shiftModal');
  const inp = $('#mReplace');
  if (inp) {
    const upd = () => {
      const n = resolveName(inp.value);
      const chk = n ? (n === r.name ? [{ lvl: 'err', msg: 'זה כבר השומר/ת במשמרת' }] : checkAssign(n, r)) : [];
      $('#mChecks').innerHTML = n ? renderChecks(chk) : '';
      $('#mApply').disabled = !n || chk.some(x => x.lvl === 'err');
    };
    inp.oninput = upd;
    inp.onchange = () => { nameChoices(inp, upd); upd(); };
    $$('[data-mpick]').forEach(b => b.onclick = () => { inp.value = b.dataset.mpick; upd(); });
    $('#mApply').onclick = async () => {
      const n = resolveName(inp.value);
      if ($$('#mChecks .check-item.warn').length && !confirm('יש אזהרות. לבצע בכל זאת?')) return;
      const ok = await applyChanges([{ id: r.id, from: r.name, to: n }], `${n} מחליף/ה את ${r.name}`);
      if (ok) dlg.close();
    };
    $('#mSwapForm').onclick = () => { dlg.close(); prefillSwap(r); };
  }
  if (!dlg.open) dlg.showModal();
}
function prefillSwap(r) {
  S.swapMode = 'swap';
  $('#swA').value = r.name; $('#swB').value = '';
  renderSwapForm();
  $('#swAShift').value = String(r.id);
  evalSwap();
  location.hash = '#swap';
  $('#swB').focus({ preventScroll: true });
}

/* ---------- שיתוף ---------- */
function shareText(text) {
  if (navigator.share && /Mobi|Android/i.test(navigator.userAgent)) { navigator.share({ text }).catch(() => {}); return; }
  window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
}
function copy(text, msg) {
  (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast(msg), () => prompt('העתיקו:', text));
}
function showPerson(name) {
  $('#mineName').value = name;
  onMineChange(false);
  location.hash = '#mine';
  if ($('#shiftModal').open) $('#shiftModal').close();
}
function onMineChange(remember = true) {
  const n = currentMe();
  if (remember && $('#rememberMe').checked && S.soldiers.has(n)) LS.set('me', n);
  renderMine();
}

/* =======================================================================
   7. אירועים
   ======================================================================= */
function bind() {
  // ערכת נושא
  const tt = $('#themeToggle');
  const setIcon = () => { tt.textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? '☀️' : '🌙'; };
  setIcon();
  tt.onclick = () => {
    const t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('theme', t); } catch (e) {}
    setIcon();
  };

  $('#campName').textContent = C.CAMP_NAME;
  $('#sheetLink').href = sheetUrl(); $('#footSheet').href = sheetUrl();
  $('#refreshBtn').onclick = () => loadData(true);

  // לחיצות כלליות: שם → המשמרות שלו, משמרת → חלון פרטים
  document.addEventListener('click', e => {
    const p = e.target.closest('[data-person]'); if (p) { e.preventDefault(); showPerson(p.dataset.person); return; }
    const s = e.target.closest('[data-shift]'); if (s) { e.preventDefault(); openShift(s.dataset.shift); return; }
    const sw = e.target.closest('[data-swapfrom]'); if (sw) { prefillSwap(S.rows.find(r => String(r.id) === sw.dataset.swapfrom)); return; }
    const pk = e.target.closest('[data-pick]'); if (pk) { $('#swB').value = pk.dataset.pick; if (S.swapMode === 'swap') S.swapMode = 'cover'; renderSwapForm(); return; }
    const un = e.target.closest('[data-undo]'); if (un) {
      S.changes = S.changes.filter(c => `${c.at}-${c.id}` !== un.dataset.undo); saveChanges(); rebuild(); toast('השינוי בוטל'); return;
    }
  });
  // סגירת חלון בלחיצה על הרקע
  $$('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));

  // גיבור
  const go = () => { const n = $('#heroName').value.trim(); if (n && nameChoices($('#heroName'), go)) showPerson($('#heroName').value.trim()); else if (n && !findNames(n).length) showPerson(n); };
  $('#heroGo').onclick = go;
  $('#heroName').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  $('#heroName').addEventListener('change', go);

  // זמן מדומה
  const simSet = () => { const d = Number($('#simDay').value), tm = $('#simTime').value; if (!tm) return; S.sim = d * 1440 + hm(tm); refreshTimeViews(); };
  $('#simDay').onchange = () => { if (!$('#simTime').value) $('#simTime').value = fmtHM(nowAbs()); simSet(); };
  $('#simTime').onchange = simSet;
  $('#simReset').onclick = () => { S.sim = null; syncSimInputs(); refreshTimeViews(); };

  // המשמרות שלי
  $('#mineName').addEventListener('input', () => { if (S.soldiers.has(currentMe()) || !currentMe()) onMineChange(); });
  $('#mineName').addEventListener('change', () => { if (findNames($('#mineName').value).length === 1) $('#mineName').value = currentMe(); onMineChange(); });
  $('#notifyMode').onchange = () => setNotify($('#notifyMode').value);
  $('#notifyTest').onclick = async () => {
    if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    const t = nowAbs(), me = currentMe();
    const r = S.rows.find(x => x.startMin > t && x.name && (!me || x.name === me)) || S.rows.find(x => x.name);
    if (r) showNotice(shiftAlert(r), 'test');
    renderNotifyUI();
  };
  $('#rememberMe').onchange = () => { if (!$('#rememberMe').checked) LS.del('me'); else onMineChange(); };

  // לוח
  $('#dayTabs').addEventListener('click', e => { const b = e.target.closest('[data-day]'); if (b) { S.boardDay = b.dataset.day; renderBoard(); } });
  $('#boardHighlight').addEventListener('input', renderBoard);
  $('#boardTeam').onchange = renderBoard;
  $('#printBtn').onclick = () => window.print();

  // חיפוש
  let qt; $('#q').addEventListener('input', () => { clearTimeout(qt); qt = setTimeout(renderSearch, 120); });
  ['#fDay', '#fTeam', '#fPost', '#fType', '#fFrom', '#fTo', '#fFuture'].forEach(s => $(s).addEventListener('change', renderSearch));
  $('#fClear').onclick = () => { $('#q').value = ''; ['#fDay', '#fTeam', '#fPost', '#fType', '#fFrom', '#fTo'].forEach(s => { $(s).value = ''; }); $('#fFuture').checked = false; renderSearch(); };
  $('#exportCsv').onclick = exportCSV;
  const sortable = (tableSel, which, render) => $(tableSel + ' thead').addEventListener('click', e => {
    const th = e.target.closest('th[data-sort]'); if (!th) return;
    const st = S.sort[which];
    if (st.key === th.dataset.sort) st.dir *= -1; else { st.key = th.dataset.sort; st.dir = 1; }
    render();
  });
  sortable('#resultsTable', 'search', renderSearch);
  sortable('#solTable', 'sol', renderSoldiers);

  // החלפות
  $('#swapMode').addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (b) { S.swapMode = b.dataset.mode; renderSwapForm(); } });
  ['#swA', '#swB'].forEach(s => {
    $(s).addEventListener('change', () => { nameChoices($(s), renderSwapForm); renderSwapForm(); });
    $(s).addEventListener('input', () => { if (findNames($(s).value).length === 1 || !$(s).value.trim()) renderSwapForm(); });
  });
  ['#swAShift', '#swBShift'].forEach(s => $(s).addEventListener('change', evalSwap));
  $('#swapApply').onclick = doSwap;
  $('#syncBtn').onclick = syncLocal;
  $('#shareChanges').onclick = () => { const t = changesText(); if (!t) return toast('אין שינויים לשיתוף'); shareText(t); };
  $('#clearChanges').onclick = () => {
    if (!S.changes.some(c => c.status !== 'synced')) return toast('אין שינויים מקומיים');
    if (!confirm('לבטל את כל השינויים המקומיים?')) return;
    S.changes = S.changes.filter(c => c.status === 'synced'); saveChanges(); rebuild();
  };

  // חיילים
  $('#solQ').addEventListener('input', renderSoldiers);
  $('#solTeam').onchange = renderSoldiers;
  $('#solAnomaly').onchange = renderSoldiers;

  // הגדרות
  $('#settingsBtn').onclick = () => {
    const d = campStartDate();
    $('#setStart').value = S.settings.start || `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    $('#setScript').value = S.settings.script; $('#setBy').value = S.settings.by; $('#setAuto').checked = S.settings.auto;
    $('#settingsModal').showModal();
  };
  $('#setSave').onclick = e => {
    e.preventDefault();
    const scriptChanged = $('#setScript').value.trim() !== S.settings.script;
    S.settings = { ...S.settings, start: $('#setStart').value, script: $('#setScript').value.trim(), by: $('#setBy').value.trim(), auto: $('#setAuto').checked };
    LS.set('settings', S.settings);
    $('#settingsModal').close();
    toast('ההגדרות נשמרו');
    if (scriptChanged) loadData(); else { rebuild(); }
  };

  // הדגשת קישור הניווט הפעיל
  const links = $$('.nav-links a');
  const io = new IntersectionObserver(entries => entries.forEach(en => {
    if (en.isIntersecting) links.forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + en.target.id));
  }), { rootMargin: '-45% 0px -50% 0px' });
  $$('main .section').forEach(s => io.observe(s));
}
function syncSimInputs() {
  const t = nowAbs();
  const di = Math.floor(t / 1440);
  if (C.DAYS[di] && $('#simDay').value !== String(di)) $('#simDay').value = String(di);
  if ($('#simTime').value !== fmtHM(t)) $('#simTime').value = fmtHM(t);
}
function refreshTimeViews() {
  tickClock(); renderNow(); renderMine(); renderBoard(); renderSearch(); renderSoldiers(); renderSwapForm();
}

/* =======================================================================
   8. אתחול
   ======================================================================= */
(function init() {
  bind();
  const params = new URLSearchParams(location.search);
  const me = params.get('name') || LS.get('me', '');
  if (me) { $('#mineName').value = me; $('#heroName').value = me; }
  // רינדור מיידי מהמטמון / תמונת המצב, ואז טעינה מהגיליון
  const cache = LS.get('cache', null);
  if (cache && cache.rows && cache.rows.length) { S.base = cache; }
  else { const snap = window.SNAPSHOT.expand(); snap.rows.forEach(r => { r.sheetRow = r.id + 1; }); S.base = { ...snap, source: 'snapshot', at: Date.parse(window.SNAPSHOT.takenAt) }; }
  rebuild();
  syncSimInputs();
  tickClock();
  loadData();
  renderNotifyUI();
  if ('serviceWorker' in navigator && /^https?:/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(e => console.warn(e));
  setInterval(() => { checkNotify(); tickClock(); if (S.sim == null && $('#simTime') !== document.activeElement) syncSimInputs(); }, 1000);
  setInterval(() => { if (S.settings.auto && document.visibilityState === 'visible') loadData(); }, 120000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.settings.auto && Date.now() - (S.base.at || 0) > 60000) loadData(); });
})();
