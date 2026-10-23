'use strict';

// ---------- constants & helpers ----------
const DAY_START_HOUR = 5;          // a study "day" runs 5:00 to 5:00, like YPT
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const DB_KEY = 'st.db';
const TIMER_KEY = 'st.timer';
const SYNC_KEY = 'st.sync';
const VIEW_KEY = 'st.view';

const $ = (id) => document.getElementById(id);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function fmtHMS(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}
function fmtHM(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  return `${Math.floor(m / 60)}:${pad(m % 60)}`;
}
function fmtLong(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  return `${Math.floor(m / 60)}H ${m % 60}M`;
}
function fmtClock(ts) {
  const d = new Date(ts);
  const h = d.getHours();
  return `${h < 12 ? 'AM' : 'PM'} ${h % 12 || 12}:${pad(d.getMinutes())}`;
}
function fmtTime24(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Day keys are "YYYY-MM-DD" for the study day that a timestamp belongs to.
function dayKey(ts) {
  const d = new Date(ts);
  if (d.getHours() < DAY_START_HOUR) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function keyToDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDays(key, n) {
  const d = keyToDate(key);
  d.setDate(d.getDate() + n);
  return dayKey(d.setHours(12));
}
function dayRange(key) {
  const d = keyToDate(key);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), DAY_START_HOUR).getTime();
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, DAY_START_HOUR).getTime();
  return [start, end];
}

// ---------- data ----------
const DEFAULT_SUBJECTS = [
  { id: 'dsa', name: 'DSA', color: '#bfe9ef' },
  { id: 'system', name: 'System', color: '#f5b961' },
  { id: 'web', name: 'Web', color: '#b9a3e3' },
];

let db = load(DB_KEY, null);
if (!db) {
  const now = Date.now();
  db = { subjects: DEFAULT_SUBJECTS.map((s) => ({ ...s, updated: now })), sessions: [] };
  save(DB_KEY, db);
}
let timer = load(TIMER_KEY, null); // { subjectId, start }
let selectedSubject = timer?.subjectId || load('st.subject', null) || liveSubjects()[0]?.id;

function persist() { save(DB_KEY, db); }
function liveSubjects() { return db.subjects.filter((s) => !s.deleted); }
function liveSessions() { return db.sessions.filter((s) => !s.deleted); }
function subjectById(id) { return db.subjects.find((s) => s.id === id) || { id, name: 'Unknown', color: '#888' }; }

// Sessions plus the running one, so every stat updates live.
function allSessions() {
  const list = liveSessions();
  if (timer) list.push({ id: 'running', subjectId: timer.subjectId, start: timer.start, end: Date.now() });
  return list;
}

// Sessions clipped to [from, to).
function clipped(from, to) {
  const out = [];
  for (const s of allSessions()) {
    const a = Math.max(s.start, from), b = Math.min(s.end, to);
    if (b > a) out.push({ ...s, start: a, end: b });
  }
  return out.sort((x, y) => x.start - y.start);
}

function summarize(from, to) {
  const list = clipped(from, to);
  const bySubject = {};
  let total = 0, max = 0;
  for (const s of list) {
    const len = s.end - s.start;
    total += len;
    max = Math.max(max, len);
    bySubject[s.subjectId] = (bySubject[s.subjectId] || 0) + len;
  }
  return { list, total, max, bySubject, first: list[0]?.start, last: list.length ? Math.max(...list.map((s) => s.end)) : undefined };
}

// ---------- timer ----------
let wakeLock = null;

async function requestWake() {
  try {
    if ('wakeLock' in navigator && timer) wakeLock = await navigator.wakeLock.request('screen');
  } catch {}
}

function startTimer() {
  if (timer || !selectedSubject) return;
  timer = { subjectId: selectedSubject, start: Date.now() };
  save(TIMER_KEY, timer);
  requestWake();
  renderAll();
}

function stopTimer() {
  if (!timer) return;
  const end = Date.now();
  if (end - timer.start >= 1000) {
    db.sessions.push({ id: uid(), subjectId: timer.subjectId, start: timer.start, end, updated: end });
    persist();
  }
  timer = null;
  save(TIMER_KEY, null);
  try { wakeLock?.release(); } catch {}
  wakeLock = null;
  renderAll();
  autoSync();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { requestWake(); renderAll(); }
});

// ---------- views ----------
let view = load(VIEW_KEY, 'timer');
let dayCursor = dayKey(Date.now());
let monthCursor = (() => { const d = keyToDate(dayCursor); return new Date(d.getFullYear(), d.getMonth(), 1); })();

function setView(v) {
  view = v;
  save(VIEW_KEY, v);
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  document.querySelectorAll('.view').forEach((s) => s.classList.toggle('active', s.id === `view-${v}`));
  renderAll();
}

function renderStrip() {
  const d = keyToDate(dayKey(Date.now()));
  const from = new Date(d.getFullYear(), d.getMonth(), 1, DAY_START_HOUR).getTime();
  const to = new Date(d.getFullYear(), d.getMonth() + 1, 1, DAY_START_HOUR).getTime();
  const mon = d.toLocaleString('en', { month: 'short' });
  $('monthTotal').textContent = `${mon}: ${fmtLong(summarize(from, to).total)}`;
}

function renderTimer() {
  const today = dayKey(Date.now());
  const [from, to] = dayRange(today);
  const sum = summarize(from, to);

  $('clock').textContent = fmtHMS(timer ? Date.now() - timer.start : 0);
  $('clock').classList.toggle('running', !!timer);
  $('startBtn').disabled = !!timer;
  $('stopBtn').disabled = !timer;
  $('timerLabel').textContent = timer
    ? `Studying ${subjectById(timer.subjectId).name} since ${fmtTime24(timer.start)}`
    : 'Pick a subject and start';
  $('wakeNote').textContent = timer && !('wakeLock' in navigator)
    ? 'Your browser may lock the screen. The timer keeps counting anyway.' : '';
  $('tToday').textContent = fmtHMS(sum.total);
  $('tMax').textContent = fmtHMS(sum.max);
  document.title = timer ? `${fmtHMS(Date.now() - timer.start)} · Study` : 'Study Tracker';

  $('subjectChips').innerHTML = liveSubjects().map((s) =>
    `<button class="chip ${s.id === (timer?.subjectId || selectedSubject) ? 'active' : ''}" data-subject="${esc(s.id)}" ${timer ? 'disabled' : ''}>
      <i class="dot" style="background:${esc(s.color)}"></i>${esc(s.name)}</button>`).join('');

  $('todaySessions').innerHTML = sum.list.slice().reverse().map((s) => {
    const sub = subjectById(s.subjectId);
    const del = s.id === 'running' ? '<span class="muted small">running</span>'
      : `<button class="x" data-del="${esc(s.id)}" aria-label="Delete">×</button>`;
    return `<li><i class="dot" style="background:${esc(sub.color)}"></i>
      <span class="grow">${esc(sub.name)} <span class="muted small">${fmtTime24(s.start)}–${fmtTime24(s.end)}</span></span>
      <span>${fmtHMS(s.end - s.start)}</span>${del}</li>`;
  }).join('') || '<li class="muted">No sessions yet today.</li>';

  const opts = liveSubjects().map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  if ($('mSubject').innerHTML !== opts) $('mSubject').innerHTML = opts;
  if (!$('mDate').value) $('mDate').value = today;
}

// Cumulative minutes across a 5:00–5:00 day.
function cumPoints(key, untilNow) {
  const [from, to] = dayRange(key);
  const stop = untilNow ? Math.min(Date.now(), to) : to;
  const pts = [[from, 0]];
  let acc = 0;
  for (const s of clipped(from, to)) {
    pts.push([s.start, acc]);
    acc += s.end - s.start;
    pts.push([s.end, acc]);
  }
  pts.push([Math.max(stop, pts[pts.length - 1][0]), acc]);
  return { pts, total: acc, from };
}

function renderCumChart(key) {
  const isToday = key === dayKey(Date.now());
  const a = cumPoints(key, isToday);
  const b = cumPoints(addDays(key, -1), false);
  const W = 300, H = 140, top = 12;
  const maxY = Math.max(a.total, b.total, HOUR);
  const line = (c) => c.pts.map(([t, v]) =>
    `${((t - c.from) / DAY * W).toFixed(1)},${(top + H - v / maxY * H).toFixed(1)}`).join(' ');
  const last = a.pts[a.pts.length - 1];
  const lx = ((last[0] - a.from) / DAY * W).toFixed(1);
  const ly = (top + H - last[1] / maxY * H).toFixed(1);
  const lbl = (x, t, anchor) => `<text x="${x}" y="${top + H + 16}" fill="#a0a0a5" font-size="11" text-anchor="${anchor}">${t}</text>`;
  $('cumChart').innerHTML = `
    <polyline points="${line(b)}" fill="none" stroke="#d1d1d6" stroke-width="3" opacity=".8"/>
    <polyline points="${line(a)}" fill="none" stroke="#f0843a" stroke-width="3" stroke-linejoin="round"/>
    <circle cx="${lx}" cy="${ly}" r="6" fill="#1c1c1e" stroke="#f0843a" stroke-width="3"/>
    ${lbl(0, '5:00', 'start')}${lbl(W / 2, '17:00', 'middle')}${lbl(W, '5:00', 'end')}`;
  const upTo = isToday ? new Date().getHours() : 4;
  $('dUpTo').textContent = isToday ? `Up to ${upTo % 12 || 12} ${upTo < 12 ? 'AM' : 'PM'}` : 'Whole day';
  $('dUpToVal').textContent = `+${fmtHMS(a.total)}`;
}

function breakdownHTML(bySubject, total) {
  const rows = Object.entries(bySubject).sort((x, y) => y[1] - x[1]);
  if (!rows.length) return '<li class="muted">Nothing logged.</li>';
  return rows.map(([id, ms]) => {
    const s = subjectById(id);
    return `<li><i class="bar" style="background:${esc(s.color)}"></i><span class="name">${esc(s.name)}</span>
      <span class="amt">${fmtHM(ms)} · ${Math.round(ms / total * 100)}%</span></li>`;
  }).join('');
}

function renderDonut(bySubject, total) {
  const r = 55, c = 2 * Math.PI * r;
  if (!total) {
    $('donut').innerHTML = `<circle cx="80" cy="80" r="${r}" fill="none" stroke="#2c2c2e" stroke-width="40"/>`;
    return;
  }
  let off = 0, arcs = '', labels = '';
  for (const [id, ms] of Object.entries(bySubject).sort((x, y) => y[1] - x[1])) {
    const frac = ms / total;
    arcs += `<circle cx="80" cy="80" r="${r}" fill="none" stroke="${esc(subjectById(id).color)}" stroke-width="40"
      stroke-dasharray="${(frac * c).toFixed(2)} ${c.toFixed(2)}" stroke-dashoffset="${(-off * c).toFixed(2)}"
      transform="rotate(-90 80 80)"/>`;
    if (frac >= 0.08) {
      const ang = (off + frac / 2) * 2 * Math.PI - Math.PI / 2;
      labels += `<text x="${(80 + r * Math.cos(ang)).toFixed(1)}" y="${(84 + r * Math.sin(ang)).toFixed(1)}"
        font-size="11" font-weight="600" fill="#fff" text-anchor="middle">${Math.round(frac * 100)}%</text>`;
    }
    off += frac;
  }
  $('donut').innerHTML = arcs + labels;
}

function renderDay() {
  const [from, to] = dayRange(dayCursor);
  const sum = summarize(from, to);
  $('dayTitle').textContent = keyToDate(dayCursor).toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' });
  $('dTotal').textContent = fmtHMS(sum.total);
  $('dMax').textContent = fmtHMS(sum.max);
  $('dStart').textContent = sum.first ? fmtClock(sum.first) : '–';
  $('dEnd').textContent = sum.last ? fmtClock(sum.last) : '–';
  renderCumChart(dayCursor);
  renderDonut(sum.bySubject, sum.total);
  $('dBreak').innerHTML = breakdownHTML(sum.bySubject, sum.total);
}

function weekStart(key) {
  const day = keyToDate(key).getDay(); // 0 = Sunday
  return addDays(key, -((day + 6) % 7));
}

function renderWeek() {
  const start = weekStart(dayCursor);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const sums = days.map((k) => summarize(...dayRange(k)));
  const total = sums.reduce((a, s) => a + s.total, 0);
  const bySubject = {};
  sums.forEach((s) => Object.entries(s.bySubject).forEach(([id, ms]) => { bySubject[id] = (bySubject[id] || 0) + ms; }));

  const today = dayKey(Date.now());
  const elapsed = days.filter((k) => k <= today).length || 7;
  const fmtD = (k) => keyToDate(k).toLocaleDateString('en', { month: 'short', day: 'numeric' });
  $('weekTitle').textContent = `${fmtD(days[0])} – ${fmtD(days[6])}`;
  $('wTotal').textContent = fmtLong(total);
  $('wAvg').textContent = fmtLong(total / elapsed);

  const W = 320, H = 160, top = 14, bw = 30, gap = (W - 7 * bw) / 7;
  const maxY = Math.max(...sums.map((s) => s.total), 2 * HOUR);
  let svg = '';
  sums.forEach((s, i) => {
    const x = gap / 2 + i * (bw + gap);
    let y = top + H;
    for (const [id, ms] of Object.entries(s.bySubject)) {
      const h = ms / maxY * H;
      y -= h;
      svg += `<rect x="${x}" y="${y.toFixed(1)}" width="${bw}" height="${h.toFixed(1)}" fill="${esc(subjectById(id).color)}"/>`;
    }
    if (s.total) svg += `<text x="${x + bw / 2}" y="${(y - 4).toFixed(1)}" font-size="10" fill="#f2f2f2" text-anchor="middle">${fmtHM(s.total)}</text>`;
    const lbl = keyToDate(days[i]).toLocaleDateString('en', { weekday: 'narrow' });
    svg += `<text x="${x + bw / 2}" y="${top + H + 18}" font-size="12" fill="${days[i] === today ? '#f0843a' : '#a0a0a5'}" text-anchor="middle">${lbl}</text>`;
  });
  svg += `<line x1="0" x2="${W}" y1="${top + H}" y2="${top + H}" stroke="#2c2c2e"/>`;
  $('weekChart').innerHTML = svg;
  $('wBreak').innerHTML = breakdownHTML(bySubject, total);
}

function level(ms) {
  const h = ms / HOUR;
  if (h >= 12) return 'l5';
  if (h >= 10) return 'l4';
  if (h >= 7) return 'l3';
  if (h >= 4) return 'l2';
  if (ms > 0) return 'l1';
  return '';
}

function renderMonth() {
  const y = monthCursor.getFullYear(), m = monthCursor.getMonth();
  const n = new Date(y, m + 1, 0).getDate();
  const today = dayKey(Date.now());
  const lead = (new Date(y, m, 1).getDay() + 6) % 7;
  let html = ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => `<div class="hd">${d}</div>`).join('');
  html += '<div></div>'.repeat(lead);
  let total = 0, studied = 0;
  const bySubject = {};
  for (let d = 1; d <= n; d++) {
    const key = `${y}-${pad(m + 1)}-${pad(d)}`;
    const s = summarize(...dayRange(key));
    total += s.total;
    if (s.total) studied++;
    Object.entries(s.bySubject).forEach(([id, ms]) => { bySubject[id] = (bySubject[id] || 0) + ms; });
    html += `<button class="d ${level(s.total)} ${key === today ? 'today' : ''}" data-day="${key}">${d}${s.total ? `<small>${fmtHM(s.total)}</small>` : ''}</button>`;
  }
  $('calendar').innerHTML = html;
  $('monthTitle').textContent = monthCursor.toLocaleDateString('en', { month: 'long', year: 'numeric' });
  $('mTotal').textContent = fmtLong(total);
  $('mDays').textContent = studied;
  $('mBreak').innerHTML = breakdownHTML(bySubject, total);
}

function renderSettings() {
  $('subjectList').innerHTML = liveSubjects().map((s) =>
    `<li><input type="color" value="${esc(s.color)}" data-color="${esc(s.id)}"><span class="grow">${esc(s.name)}</span>
     <button class="x" data-delsub="${esc(s.id)}" aria-label="Remove">×</button></li>`).join('');
  const cfg = load(SYNC_KEY, {});
  for (const [k, id] of [['owner', 'gOwner'], ['repo', 'gRepo'], ['path', 'gPath'], ['token', 'gToken']]) {
    if (document.activeElement !== $(id)) $(id).value = cfg[k] || '';
  }
}

function renderAll() {
  renderStrip();
  if (view === 'timer') renderTimer();
  if (view === 'day') renderDay();
  if (view === 'week') renderWeek();
  if (view === 'month') renderMonth();
  if (view === 'settings') renderSettings();
}

// ---------- events ----------
$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (!b) return;
  if (b.dataset.view === 'day' || b.dataset.view === 'week') dayCursor = dayKey(Date.now());
  setView(b.dataset.view);
});

$('subjectChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-subject]');
  if (!b || timer) return;
  selectedSubject = b.dataset.subject;
  save('st.subject', selectedSubject);
  renderTimer();
});
$('startBtn').onclick = startTimer;
$('stopBtn').onclick = stopTimer;

$('todaySessions').addEventListener('click', (e) => {
  const id = e.target.closest('[data-del]')?.dataset.del;
  if (!id || !confirm('Delete this session?')) return;
  const s = db.sessions.find((x) => x.id === id);
  if (s) { s.deleted = true; s.updated = Date.now(); persist(); renderAll(); autoSync(); }
});

$('manualForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const [y, mo, d] = $('mDate').value.split('-').map(Number);
  const at = (t) => { const [h, mi] = t.split(':').map(Number); return new Date(y, mo - 1, d, h, mi).getTime(); };
  const start = at($('mStart').value);
  let end = at($('mEnd').value);
  if (end <= start) end += DAY; // crosses midnight
  if (end - start > 16 * HOUR) { alert('That session is longer than 16 hours. Check the times.'); return; }
  db.sessions.push({ id: uid(), subjectId: $('mSubject').value, start, end, updated: Date.now() });
  persist();
  e.target.reset();
  renderAll();
  autoSync();
});

document.querySelectorAll('[data-shift]').forEach((b) => b.onclick = () => {
  dayCursor = addDays(dayCursor, Number(b.dataset.shift)); renderDay();
});
document.querySelectorAll('[data-wshift]').forEach((b) => b.onclick = () => {
  dayCursor = addDays(dayCursor, Number(b.dataset.wshift)); renderWeek();
});
document.querySelectorAll('[data-mshift]').forEach((b) => b.onclick = () => {
  monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + Number(b.dataset.mshift), 1); renderMonth();
});
$('calendar').addEventListener('click', (e) => {
  const k = e.target.closest('[data-day]')?.dataset.day;
  if (k) { dayCursor = k; setView('day'); }
});

$('subjectForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('newSubject').value.trim();
  if (!name) return;
  db.subjects.push({ id: uid(), name, color: $('newColor').value, updated: Date.now() });
  persist(); e.target.reset(); renderAll(); autoSync();
});
$('subjectList').addEventListener('change', (e) => {
  const id = e.target.dataset.color;
  const s = id && db.subjects.find((x) => x.id === id);
  if (s) { s.color = e.target.value; s.updated = Date.now(); persist(); autoSync(); }
});
$('subjectList').addEventListener('click', (e) => {
  const id = e.target.closest('[data-delsub]')?.dataset.delsub;
  if (!id || !confirm('Remove this subject? Its past sessions stay in your stats.')) return;
  const s = db.subjects.find((x) => x.id === id);
  s.deleted = true; s.updated = Date.now();
  if (selectedSubject === id) selectedSubject = liveSubjects()[0]?.id;
  persist(); renderAll(); autoSync();
});

$('exportBtn').onclick = () => {
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `study-tracker-${dayKey(Date.now())}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};
$('importFile').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    db = merge(db, JSON.parse(await f.text()));
    persist(); renderAll(); alert('Imported.'); autoSync();
  } catch { alert('That file is not a valid export.'); }
  e.target.value = '';
};

// ---------- GitHub sync ----------
// Both sides are merged by id; the newer "updated" wins, and deletes are kept as tombstones.
function mergeList(a = [], b = []) {
  const map = new Map();
  for (const x of [...a, ...b]) {
    const cur = map.get(x.id);
    if (!cur || (x.updated || 0) > (cur.updated || 0)) map.set(x.id, x);
  }
  return [...map.values()];
}
function merge(a, b) {
  return {
    subjects: mergeList(a.subjects, b.subjects),
    sessions: mergeList(a.sessions, b.sessions).sort((x, y) => x.start - y.start),
  };
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

let syncing = false;

async function sync() {
  const cfg = load(SYNC_KEY, {});
  if (!cfg.owner || !cfg.repo || !cfg.token) return;
  if (syncing) return;
  syncing = true;
  const status = (t) => { $('syncStatus').textContent = t; };
  const url = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${(cfg.path || 'sessions.json').split('/').map(encodeURIComponent).join('/')}`;
  const headers = { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json' };
  try {
    status('Syncing…');
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url, { headers, cache: 'no-store' });
      let sha, remote = { subjects: [], sessions: [] };
      if (res.ok) {
        const j = await res.json();
        sha = j.sha;
        remote = JSON.parse(b64decode(j.content));
      } else if (res.status !== 404) {
        throw new Error(`GitHub said ${res.status} when reading. Check owner, repo and token.`);
      }
      const merged = merge(db, remote);
      db = merged;
      persist();
      const body = JSON.stringify(merged, null, 1);
      if (sha && body === JSON.stringify(remote, null, 1)) break; // nothing new to push
      const put = await fetch(url, {
        method: 'PUT', headers,
        body: JSON.stringify({ message: `Sync ${new Date().toISOString()}`, content: b64encode(body), sha }),
      });
      if (put.ok) break;
      if (put.status !== 409 && put.status !== 422) throw new Error(`GitHub said ${put.status} when saving.`);
      // someone else pushed in between: loop and merge again
    }
    const t = new Date();
    save(SYNC_KEY, { ...cfg, last: t.getTime() });
    status(`Last synced ${t.toLocaleString()}`);
    renderAll();
  } catch (err) {
    status(`Sync failed: ${err.message}`);
  } finally {
    syncing = false;
  }
}
function autoSync() { sync(); }

$('syncForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const cfg = {
    owner: $('gOwner').value.trim(),
    repo: $('gRepo').value.trim(),
    path: $('gPath').value.trim() || 'sessions.json',
    token: $('gToken').value.trim(),
  };
  save(SYNC_KEY, cfg);
  sync();
});
$('syncNow').onclick = sync;

// ---------- boot ----------
setView(view);
{
  const last = load(SYNC_KEY, {}).last;
  if (last) $('syncStatus').textContent = `Last synced ${new Date(last).toLocaleString()}`;
}
sync();
requestWake();
setInterval(() => {
  if (timer) renderAll();          // live ticking
  else if (view === 'timer') renderStrip();
}, 1000);
window.addEventListener('focus', () => sync());

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
