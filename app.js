'use strict';

// ---------- constants & helpers ----------
const DAY_START_HOUR = 5;          // a study "day" runs 5:00 to 5:00, like YPT
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const DB_KEY = 'st.db';
const SYNC_KEY = 'st.sync';
const VIEW_KEY = 'st.view';
const PREFS_KEY = 'st.prefs';
const IS_TOUCH = matchMedia('(pointer: coarse)').matches;

const $ = (id) => document.getElementById(id);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const setText = (id, t) => { const el = $(id); if (el && el.textContent !== t) el.textContent = t; };

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
}
// The running timer lives in db so it syncs between devices. Older versions kept it under its own key.
if (!db.timer) {
  const old = load('st.timer', null);
  db.timer = old ? { running: true, subjectId: old.subjectId, start: old.start, updated: old.start } : { running: false, updated: 0 };
  try { localStorage.removeItem('st.timer'); } catch {}
}
save(DB_KEY, db);

const prefs = { tilt: true, charger: true, ...load(PREFS_KEY, {}) };
let selectedSubject = load('st.subject', null);

function persist() { save(DB_KEY, db); }
function running() { return db.timer.running ? db.timer : null; }
function liveSubjects() { return db.subjects.filter((s) => !s.deleted); }
function liveSessions() { return db.sessions.filter((s) => !s.deleted); }
function subjectById(id) { return db.subjects.find((s) => s.id === id) || { id, name: 'Unknown', color: '#888' }; }
function currentSubject() {
  const t = running();
  if (t) return t.subjectId;
  if (!liveSubjects().some((s) => s.id === selectedSubject)) selectedSubject = liveSubjects()[0]?.id;
  return selectedSubject;
}

// Sessions plus the running one, so every stat updates live.
function allSessions() {
  const list = liveSessions();
  const t = running();
  if (t) list.push({ id: 'running', subjectId: t.subjectId, start: t.start, end: Date.now() });
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

// Total = all study time. Max focus = the longest stretch between Start/Resume and Pause.
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
const todaySummary = () => summarize(...dayRange(dayKey(Date.now())));

// ---------- timer ----------
function startTimer() {
  if (running()) return;
  const subjectId = currentSubject();
  if (!subjectId) return;
  const now = Date.now();
  db.timer = { running: true, subjectId, start: now, updated: now };
  persist();
  onTimerChanged();
  sync();
}

function pauseTimer() {
  const t = running();
  if (!t) return;
  const end = Date.now();
  if (end - t.start >= 1000) {
    // The id comes from the start time, so if two devices both pause the same stretch they save one session, not two.
    db.sessions.push({ id: `t${t.start.toString(36)}`, subjectId: t.subjectId, start: t.start, end, updated: end });
  }
  db.timer = { running: false, updated: end };
  persist();
  onTimerChanged();
  sync();
}

function toggleTimer() {
  enableMotion(true); // iOS only lets a page ask for the motion sensor from inside a tap
  if (running()) pauseTimer(); else startTimer();
}

function onTimerChanged() {
  keepAwake(!!running() || focusOpen);
  if (!running()) document.title = 'Study Tracker';
  renderAll();
  renderFocus();
}

// ---------- keep the screen on ----------
// The Wake Lock API is the proper way. iOS Home Screen apps ignored it before iOS 18.4,
// so there we also loop a silent 1-pixel video, which iOS treats as "media playing".
let wakeLock = null;
let wantAwake = false;
const awakeVideo = $('keepAwake');

async function keepAwake(on) {
  wantAwake = on;
  if (!on) {
    try { await wakeLock?.release(); } catch {}
    wakeLock = null;
    awakeVideo.pause();
    $('fHint').hidden = true;
    return;
  }
  if (document.visibilityState !== 'visible') return;
  let ok = false;
  if ('wakeLock' in navigator) {
    try {
      if (!wakeLock || wakeLock.released) wakeLock = await navigator.wakeLock.request('screen');
      ok = true;
    } catch {}
  }
  if (!ok || navigator.standalone) {
    try { await awakeVideo.play(); ok = true; } catch {}
  }
  $('fHint').hidden = ok || !focusOpen;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    keepAwake(wantAwake);
    renderAll();
    sync();
  }
});

// ---------- focus screen ----------
let focusOpen = false;
let focusReason = null;        // 'manual' | 'tilt' | 'charger' | 'url'
let dismissedWhileSideways = false;
let controlsTimer = null;
let driftTimer = null;

function openFocus(reason) {
  if (focusOpen) return;
  focusOpen = true;
  focusReason = reason;
  const el = $('focus');
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  renderFocus();
  keepAwake(true);
  showControls();
  drift();
  driftTimer = setInterval(drift, 60e3);
}

function closeFocus() {
  if (!focusOpen) return;
  focusOpen = false;
  focusReason = null;
  clearInterval(driftTimer);
  const el = $('focus');
  el.classList.remove('show', 'controls');
  setTimeout(() => { if (!focusOpen) el.hidden = true; }, 450);
  keepAwake(!!running());
  renderAll();
}

// Move the clock a few pixels every minute so a static image never burns into an OLED screen.
function drift() {
  const r = () => Math.round((Math.random() - 0.5) * 24);
  $('fBody').style.transform = `translate(${r()}px, ${r()}px)`;
}

function showControls() {
  $('focus').classList.add('controls');
  clearTimeout(controlsTimer);
  controlsTimer = setTimeout(() => $('focus').classList.remove('controls'), 4000);
}

function renderFocus() {
  if (!focusOpen) return;
  const t = running();
  const sum = todaySummary();
  $('focus').classList.toggle('paused', !t);
  setText('fClock', fmtHMS(sum.total));
  setText('fSubject', t ? subjectById(t.subjectId).name : 'Paused');
  setText('fSub', t ? `This stretch ${fmtHMS(Date.now() - t.start)}` : `Max focus ${fmtHMS(sum.max)}`);
  setText('fToggle', t ? 'Pause' : (sum.total ? 'Resume' : 'Start'));
}

$('focus').addEventListener('click', (e) => {
  keepAwake(true); // a tap counts as permission to play the keep-awake video
  if (e.target.closest('#fToggle')) { toggleTimer(); showControls(); return; }
  if (e.target.closest('#fExit')) { if (focusReason === 'tilt') dismissedWhileSideways = true; closeFocus(); return; }
  if ($('focus').classList.contains('controls')) $('focus').classList.remove('controls'); else showControls();
});

document.addEventListener('keydown', (e) => {
  if (!focusOpen) return;
  if (e.key === 'Escape') closeFocus();
  if (e.key === ' ') { e.preventDefault(); toggleTimer(); }
});

// --- turned sideways: the landscape media query covers phones without rotation lock,
//     the motion sensor covers phones with rotation lock on.
const landscapeMQ = matchMedia('(orientation: landscape) and (pointer: coarse)');
let motionSideways = false;
let motionCandidate = null;
let motionSince = 0;
let motionOn = false;

function isSideways() { return landscapeMQ.matches || motionSideways; }

function checkTilt() {
  if (!isSideways()) {
    dismissedWhileSideways = false;
    if (focusOpen && focusReason === 'tilt') closeFocus();
    return;
  }
  if (prefs.tilt && !focusOpen && !dismissedWhileSideways) openFocus('tilt');
}
landscapeMQ.addEventListener?.('change', checkTilt);

function onMotion(e) {
  const g = e.accelerationIncludingGravity;
  if (!g || g.x == null) return;
  const ax = Math.abs(g.x), ay = Math.abs(g.y);
  let s = motionSideways;
  if (ax > 7 && ax > ay * 1.5) s = true;          // gravity along the long edge: on its side
  else if (ay > 7 && ay > ax * 1.5) s = false;    // upright again; lying flat keeps the last state
  if (s !== motionCandidate) { motionCandidate = s; motionSince = Date.now(); return; }
  if (s !== motionSideways && Date.now() - motionSince > 600) { motionSideways = s; checkTilt(); }
}

async function enableMotion(fromTap) {
  if (motionOn || !prefs.tilt || !IS_TOUCH) return;
  if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    if (!fromTap) return;
    try { if (await DeviceMotionEvent.requestPermission() !== 'granted') return; } catch { return; }
  }
  window.addEventListener('devicemotion', onMotion);
  motionOn = true;
}
// iOS needs a tap before it shows the motion permission (silently granted if allowed before).
document.addEventListener('click', () => enableMotion(true), { once: true, capture: true });

// --- on the charger: only Chromium browsers expose battery state; Safari does not.
if (IS_TOUCH && navigator.getBattery) {
  navigator.getBattery().then((b) => {
    const check = () => {
      if (b.charging && prefs.charger && running() && !focusOpen) openFocus('charger');
      else if (!b.charging && focusOpen && focusReason === 'charger') closeFocus();
    };
    b.addEventListener('chargingchange', check);
    check();
  }).catch(() => {});
}

// ---------- views ----------
let view = load(VIEW_KEY, 'timer');
let dayCursor = dayKey(Date.now());
let monthCursor = (() => { const d = keyToDate(dayCursor); return new Date(d.getFullYear(), d.getMonth(), 1); })();

function movePill() {
  const b = document.querySelector('#tabs button.active');
  if (!b) return;
  const pill = $('pill');
  pill.style.left = `${b.offsetLeft}px`;
  pill.style.width = `${b.offsetWidth}px`;
  pill.style.top = `${b.offsetTop}px`;
  pill.style.height = `${b.offsetHeight}px`;
}

function setView(v) {
  view = v;
  save(VIEW_KEY, v);
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  document.querySelectorAll('.view').forEach((s) => s.classList.toggle('active', s.id === `view-${v}`));
  movePill();
  renderAll();
}
window.addEventListener('resize', movePill);

// A small slide when moving between days, weeks or months.
function slide(dir) {
  const el = document.querySelector('.view.active');
  el?.animate?.([{ opacity: 0.3, transform: `translateX(${dir * 24}px)` }, { opacity: 1, transform: 'none' }],
    { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
}

function renderStrip() {
  const d = keyToDate(dayKey(Date.now()));
  const from = new Date(d.getFullYear(), d.getMonth(), 1, DAY_START_HOUR).getTime();
  const to = new Date(d.getFullYear(), d.getMonth() + 1, 1, DAY_START_HOUR).getTime();
  const mon = d.toLocaleString('en', { month: 'short' });
  setText('monthTotal', `${mon}: ${fmtLong(summarize(from, to).total)}`);
}

// Builds the timer view. Called on events only; tickTimer() updates the numbers every second.
function renderTimer() {
  const t = running();
  const sum = todaySummary();
  const active = currentSubject();

  $('subjectChips').innerHTML = liveSubjects().map((s) =>
    `<button class="chip ${s.id === active ? 'active' : ''}" data-subject="${esc(s.id)}" ${t ? 'disabled' : ''}>
      <i class="dot" style="background:${esc(s.color)}"></i>${esc(s.name)}
      <small data-chip-time="${esc(s.id)}">${fmtHM(sum.bySubject[s.id] || 0)}</small></button>`).join('');

  $('todaySessions').innerHTML = sum.list.slice().reverse().map((s) => {
    const sub = subjectById(s.subjectId);
    const live = s.id === 'running';
    const right = live ? '<span class="live">● live</span>'
      : `<button class="x" data-del="${esc(s.id)}" aria-label="Delete">×</button>`;
    return `<li><i class="dot" style="background:${esc(sub.color)}"></i>
      <span class="grow">${esc(sub.name)} <span class="muted small">${fmtTime24(s.start)}–${live ? 'now' : fmtTime24(s.end)}</span></span>
      <span ${live ? 'id="runningLen"' : ''}>${fmtHMS(s.end - s.start)}</span>${right}</li>`;
  }).join('') || '<li class="muted">No sessions yet today.</li>';

  const btn = $('toggleBtn');
  btn.textContent = t ? 'Pause' : (sum.total ? 'Resume' : 'Start');
  btn.classList.toggle('pause', !!t);

  const opts = liveSubjects().map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  if ($('mSubject').innerHTML !== opts) $('mSubject').innerHTML = opts;
  if (!$('mDate').value) $('mDate').value = dayKey(Date.now());
  tickTimer(sum);
}

function tickTimer(sum = todaySummary()) {
  const t = running();
  setText('clock', fmtHMS(sum.total));
  $('clock').classList.toggle('running', !!t);
  setText('tStretch', fmtHMS(t ? Date.now() - t.start : 0));
  setText('tMax', fmtHMS(sum.max));
  setText('timerLabel', t ? `Studying ${subjectById(t.subjectId).name} since ${fmtTime24(t.start)}`
    : sum.total ? 'Paused' : 'Pick a subject and start');
  if (t) {
    const chip = document.querySelector(`[data-chip-time="${CSS.escape(t.subjectId)}"]`);
    if (chip) chip.textContent = fmtHM(sum.bySubject[t.subjectId] || 0);
    const run = $('runningLen');
    if (run) run.textContent = fmtHMS(Date.now() - t.start);
  }
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
  const upTo = new Date().getHours();
  setText('dUpTo', isToday ? `Up to ${upTo % 12 || 12} ${upTo < 12 ? 'AM' : 'PM'}` : 'Whole day');
  setText('dUpToVal', `+${fmtHMS(a.total)}`);
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
  setText('dayTitle', keyToDate(dayCursor).toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' }));
  setText('dTotal', fmtHMS(sum.total));
  setText('dMax', fmtHMS(sum.max));
  setText('dStart', sum.first ? fmtClock(sum.first) : '–');
  setText('dEnd', sum.last ? fmtClock(sum.last) : '–');
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
  setText('weekTitle', `${fmtD(days[0])} – ${fmtD(days[6])}`);
  setText('wTotal', fmtLong(total));
  setText('wAvg', fmtLong(total / elapsed));

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
  setText('monthTitle', monthCursor.toLocaleDateString('en', { month: 'long', year: 'numeric' }));
  setText('mTotal', fmtLong(total));
  setText('mDays', String(studied));
  $('mBreak').innerHTML = breakdownHTML(bySubject, total);
}

function renderSettings() {
  $('subjectList').innerHTML = liveSubjects().map((s) =>
    `<li><input type="color" value="${esc(s.color)}" data-color="${esc(s.id)}"><span class="grow">${esc(s.name)}</span>
     <button class="x" data-delsub="${esc(s.id)}" aria-label="Remove">×</button></li>`).join('');
  const cfg = { ...SYNC_DEFAULTS, ...load(SYNC_KEY, {}) };
  for (const [k, id] of [['owner', 'gOwner'], ['repo', 'gRepo'], ['path', 'gPath'], ['token', 'gToken']]) {
    if (document.activeElement !== $(id)) $(id).value = cfg[k] || '';
  }
  $('pTilt').checked = prefs.tilt;
  $('pCharger').checked = prefs.charger;
  setText('focusUrl', `${location.origin}${location.pathname}?focus=1`);
}

function renderAll() {
  renderStrip();
  if (view === 'timer') renderTimer();
  if (view === 'day') renderDay();
  if (view === 'week') renderWeek();
  if (view === 'month') renderMonth();
  if (view === 'settings') renderSettings();
}

// Every second, change only the numbers that move. Rebuilding whole views every second made taps and scrolling stutter.
let ticks = 0;
let lastDay = dayKey(Date.now());
function tick() {
  ticks++;
  const today = dayKey(Date.now());
  if (today !== lastDay) { lastDay = today; renderAll(); return; } // crossed 5:00
  if (!running()) return;
  const t = running();
  document.title = `${fmtHMS(Date.now() - t.start)} · Study`;
  renderFocus();
  if (view === 'timer') tickTimer();
  if (view === 'day' && dayCursor === today) {
    const sum = todaySummary();
    setText('dTotal', fmtHMS(sum.total));
    setText('dMax', fmtHMS(sum.max));
    setText('dEnd', fmtClock(Date.now()));
    setText('dUpToVal', `+${fmtHMS(sum.total)}`);
  }
  if (ticks % 30 === 0) { renderStrip(); if (view !== 'timer' && view !== 'settings') renderAll(); }
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
  if (!b || running()) return;
  selectedSubject = b.dataset.subject;
  save('st.subject', selectedSubject);
  document.querySelectorAll('#subjectChips .chip').forEach((c) => c.classList.toggle('active', c === b));
});
$('toggleBtn').onclick = toggleTimer;
$('focusBtn').onclick = () => { enableMotion(true); openFocus('manual'); };

$('todaySessions').addEventListener('click', (e) => {
  const id = e.target.closest('[data-del]')?.dataset.del;
  if (!id || !confirm('Delete this session?')) return;
  const s = db.sessions.find((x) => x.id === id);
  if (s) { s.deleted = true; s.updated = Date.now(); persist(); renderAll(); sync(); }
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
  sync();
});

function shiftDay(n) { dayCursor = addDays(dayCursor, n); renderDay(); slide(-Math.sign(n)); }
function shiftWeek(n) { dayCursor = addDays(dayCursor, n); renderWeek(); slide(-Math.sign(n)); }
function shiftMonth(n) {
  monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + n, 1);
  renderMonth(); slide(-Math.sign(n));
}
document.querySelectorAll('[data-shift]').forEach((b) => b.onclick = () => shiftDay(Number(b.dataset.shift)));
document.querySelectorAll('[data-wshift]').forEach((b) => b.onclick = () => shiftWeek(Number(b.dataset.wshift)));
document.querySelectorAll('[data-mshift]').forEach((b) => b.onclick = () => shiftMonth(Number(b.dataset.mshift)));

// Swipe left or right on Day, Week and Month to move through time.
let touchX = null, touchY = null;
$('main').addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; touchY = e.touches[0].clientY; }, { passive: true });
$('main').addEventListener('touchend', (e) => {
  if (touchX == null) return;
  const dx = e.changedTouches[0].clientX - touchX, dy = e.changedTouches[0].clientY - touchY;
  touchX = null;
  if (Math.abs(dx) < 60 || Math.abs(dy) > 40) return;
  const dir = dx < 0 ? 1 : -1; // swipe left → forward in time
  if (view === 'day') shiftDay(dir);
  if (view === 'week') shiftWeek(7 * dir);
  if (view === 'month') shiftMonth(dir);
}, { passive: true });

$('calendar').addEventListener('click', (e) => {
  const k = e.target.closest('[data-day]')?.dataset.day;
  if (k) { dayCursor = k; setView('day'); }
});

$('subjectForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('newSubject').value.trim();
  if (!name) return;
  db.subjects.push({ id: uid(), name, color: $('newColor').value, updated: Date.now() });
  persist(); e.target.reset(); renderAll(); sync();
});
$('subjectList').addEventListener('change', (e) => {
  const id = e.target.dataset.color;
  const s = id && db.subjects.find((x) => x.id === id);
  if (s) { s.color = e.target.value; s.updated = Date.now(); persist(); sync(); }
});
$('subjectList').addEventListener('click', (e) => {
  const id = e.target.closest('[data-delsub]')?.dataset.delsub;
  if (!id || !confirm('Remove this subject? Its past sessions stay in your stats.')) return;
  const s = db.subjects.find((x) => x.id === id);
  s.deleted = true; s.updated = Date.now();
  persist(); renderAll(); sync();
});

$('pTilt').onchange = (e) => {
  prefs.tilt = e.target.checked; save(PREFS_KEY, prefs);
  if (prefs.tilt) enableMotion(true);
};
$('pCharger').onchange = (e) => { prefs.charger = e.target.checked; save(PREFS_KEY, prefs); };

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
    persist(); onTimerChanged(); alert('Imported.'); sync();
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
function newer(a, b) {
  if (!a) return b || { running: false, updated: 0 };
  if (!b) return a;
  return (b.updated || 0) > (a.updated || 0) ? b : a;
}
function merge(a, b) {
  return {
    subjects: mergeList(a.subjects, b.subjects),
    sessions: mergeList(a.sessions, b.sessions).sort((x, y) => x.start - y.start),
    timer: newer(a.timer, b.timer),
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
let syncAgain = false;
const SYNC_DEFAULTS = { owner: 'VasanthKumarD1248', repo: 'study-tracker-data', path: 'sessions.json' };
const SYNC_ERRORS = {
  401: 'GitHub rejected the token (401). Paste it again, or make a new one.',
  403: 'The token is missing a permission (403). It needs Contents: Read and write.',
  404: 'GitHub cannot see that repo (404). Check owner and repo, and that the token includes this repo.',
};

async function sync() {
  const status = (t) => { $('syncStatus').textContent = t; };
  const cfg = load(SYNC_KEY, {});
  if (!cfg.owner || !cfg.repo || !cfg.token) {
    status('Sync is not set up in this app yet. On iPhone, Safari and the Home Screen app keep separate settings, so enter the token here too.');
    return;
  }
  if (syncing) { syncAgain = true; return; } // a change came in mid-sync; run once more afterwards
  syncing = true;
  const url = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${(cfg.path || 'sessions.json').split('/').map(encodeURIComponent).join('/')}`;
  const headers = { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json' };
  const timerBefore = JSON.stringify(db.timer);
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
        throw new Error(SYNC_ERRORS[res.status] || `GitHub said ${res.status} when reading.`);
      } else {
        // 404 can mean "file not created yet" or "repo not visible"; tell them apart.
        const repo = await fetch(url.split('/contents/')[0], { headers, cache: 'no-store' });
        if (!repo.ok) throw new Error(SYNC_ERRORS[repo.status] || `GitHub said ${repo.status} when reading the repo.`);
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
      if (put.status !== 409 && put.status !== 422) throw new Error(SYNC_ERRORS[put.status] || `GitHub said ${put.status} when saving.`);
      // another device saved in between: loop and merge again
    }
    const t = new Date();
    save(SYNC_KEY, { ...cfg, last: t.getTime() });
    status(`Last synced ${t.toLocaleString()}`);
    if (JSON.stringify(db.timer) !== timerBefore) onTimerChanged(); // started or paused on another device
    else renderAll();
  } catch (err) {
    const msg = err instanceof TypeError ? 'Could not reach GitHub. Check your connection.' : err.message;
    status(`Sync failed: ${msg}`);
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; sync(); }
  }
}

$('syncForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const cfg = {
    owner: $('gOwner').value.trim() || SYNC_DEFAULTS.owner,
    repo: $('gRepo').value.trim() || SYNC_DEFAULTS.repo,
    path: $('gPath').value.trim() || SYNC_DEFAULTS.path,
    token: $('gToken').value.replace(/\s+/g, ''), // pasted tokens can carry spaces or line breaks
  };
  save(SYNC_KEY, cfg);
  sync();
});
$('syncNow').onclick = sync;

// ---------- boot ----------
setView(view);
requestAnimationFrame(movePill); // fonts and layout settle after the first frame
{
  const last = load(SYNC_KEY, {}).last;
  if (last) $('syncStatus').textContent = `Last synced ${new Date(last).toLocaleString()}`;
}
const params = new URLSearchParams(location.search);
if (params.has('focus')) {
  history.replaceState(null, '', location.pathname);
  openFocus('url');
}
keepAwake(!!running() || focusOpen);
checkTilt();
enableMotion(false);
sync();
setInterval(tick, 1000);
setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 120e3); // pick up a start or pause from another device
window.addEventListener('focus', () => sync());

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
