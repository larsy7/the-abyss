// Firebase REST API — no SDK needed, works everywhere
const FB_URL = 'https://the-abyss-calendar-default-rtdb.firebaseio.com';
const FB_API_KEY = 'AIzaSyAzCyXRPkkegnKVHVM96jWFkBT3UG4CNp4';

// ============================================================
// AUTH — email/password sign-in via Firebase Identity Toolkit.
// The admin creates accounts in the Firebase Console; users sign
// in once per device and stay signed in (tokens auto-refresh).
// ============================================================
let AUTH = null; // { idToken, refreshToken, email, exp }
try { const s = localStorage.getItem('abyssAuth'); if (s) AUTH = JSON.parse(s); } catch(e) {}

function saveAuth() {
  try {
    if (AUTH) localStorage.setItem('abyssAuth', JSON.stringify(AUTH));
    else localStorage.removeItem('abyssAuth');
  } catch(e) {}
}

async function signIn(email, password) {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FB_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  const d = await r.json();
  if (!r.ok) throw new Error((d.error && d.error.message) || 'SIGN_IN_FAILED');
  AUTH = {
    idToken: d.idToken,
    refreshToken: d.refreshToken,
    email: d.email,
    exp: Date.now() + (parseInt(d.expiresIn || '3600') - 300) * 1000
  };
  saveAuth();
}

// Exchange the refresh token for a fresh id token (1hr lifetime each)
async function refreshAuth() {
  if (!AUTH || !AUTH.refreshToken) return false;
  let r;
  try {
    r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FB_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(AUTH.refreshToken)}`
    });
  } catch(e) { return false; } // network hiccup — keep session, retry later
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    // Token rejected — account was disabled/deleted or session revoked
    AUTH = null; saveAuth();
    if (typeof showLogin === 'function') showLogin('Your session has ended. Please sign in again.');
    return false;
  }
  AUTH.idToken = d.id_token;
  AUTH.refreshToken = d.refresh_token;
  AUTH.exp = Date.now() + (parseInt(d.expires_in || '3600') - 300) * 1000;
  saveAuth();
  return true;
}

async function ensureToken() {
  if (!AUTH) return null;
  if (Date.now() > AUTH.exp) { if (!(await refreshAuth())) return null; }
  return AUTH ? AUTH.idToken : null;
}

const db = {
  _listeners: {},
  _pollIntervals: {},
  _pollFns: {},
  _lastJSON: {},

  // All requests carry the auth token; one automatic refresh+retry on 401
  async _fetch(rawPath, opts) {
    const url = `${FB_URL}/${rawPath}.json`;
    const tok = await ensureToken();
    let r = await fetch(tok ? `${url}?auth=${tok}` : url, opts);
    if (r.status === 401 && AUTH && await refreshAuth()) {
      r = await fetch(`${url}?auth=${AUTH.idToken}`, opts);
    }
    return r;
  },

  async get(path) {
    try {
      const r = await this._fetch(path);
      return r.ok ? await r.json() : null;
    } catch(e) { return null; }
  },

  // Read an absolute legacy path (pre-lockdown root or old passphrase space)
  async getRaw(path) {
    try {
      const r = await this._fetch(path);
      return r.ok ? await r.json() : null;
    } catch(e) { return null; }
  },

  async set(path, data) {
    try {
      const r = await this._fetch(path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      return r.ok;
    } catch(e) { return false; }
  },

  // Polling-based "real-time" listener (polls every 3 seconds).
  // Skips polls while the tab is hidden, and only fires the callback
  // when the data actually changed — no re-render churn.
  on(path, callback) {
    const fire = async () => {
      const val = await this.get(path);
      const j = JSON.stringify(val);
      if (this._lastJSON[path] === j) return;
      this._lastJSON[path] = j;
      callback({ val: () => val });
    };
    // Initial load always fires so the app knows the data arrived
    this.get(path).then(val => {
      this._lastJSON[path] = JSON.stringify(val);
      callback({ val: () => val });
    });
    if (this._pollIntervals[path]) clearInterval(this._pollIntervals[path]);
    this._pollFns[path] = fire;
    this._pollIntervals[path] = setInterval(() => {
      if (document.hidden) return; // don't poll background tabs
      fire();
    }, 3000);
  },

  off(path) {
    if (this._pollIntervals[path]) {
      clearInterval(this._pollIntervals[path]);
      delete this._pollIntervals[path];
      delete this._pollFns[path];
    }
  },

  ref(path) {
    return {
      on: (event, cb, errCb) => db.on(path, cb),
      set: (data) => db.set(path, data),
      get: () => db.get(path)
    };
  }
};

// Catch up immediately when the tab becomes visible again
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) Object.values(db._pollFns).forEach(fn => fn());
});

// ============================================================
// STATE
// ============================================================
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const DAYS_FULL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

let state = {
  view: 'month',
  date: new Date(),
  events: [],
  editingId: null,
  detailId: null,
  mpYear: new Date().getFullYear(),
  activeFilters: [],
  showTasks: true,
  hiddenGroups: [],
};

function save() {
  setSyncStatus('syncing');
  const clean = state.events.filter(Boolean);
  db.set('krakenEvents', clean).then(ok => ok ? setSyncStatus('synced') : setSyncStatus('error'));
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
function saveGroups(groups) {
  db.set('krakenGroups', groups.filter(Boolean));
}
function loadGroups() { return _localGroups || []; }
function saveHiddenGroups() {
  db.set('krakenHiddenGroups', state.hiddenGroups.filter(Boolean));
}
function loadAnnotations() { return _localAnnotations || {}; }
function saveAnnotations(anns) {
  _localAnnotations = anns;
  db.set('krakenAnnotations', anns);
}
function loadMondayNotes() { return _localMondayNotes || []; }
function saveMondayNotes(notes) {
  _localMondayNotes = notes;
  setSyncStatus('syncing');
  return db.set('krakenMondayNotes', notes.filter(Boolean))
    .then(ok => { setSyncStatus(ok ? 'synced' : 'error'); return ok; });
}
function loadMondayMeetings() { return _localMondayMeetings || []; }
function saveMondayMeetings(meetings) {
  _localMondayMeetings = meetings;
  setSyncStatus('syncing');
  return db.set('krakenMondayMeetings', meetings.filter(Boolean))
    .then(ok => { setSyncStatus(ok ? 'synced' : 'error'); return ok; });
}

function setSyncStatus(status) {
  const el = document.getElementById('syncStatus');
  const lbl = document.getElementById('syncLabel');
  if (!el) return;
  el.className = 'sync-status ' + status;
  lbl.textContent = status === 'synced' ? 'Synced' : status === 'syncing' ? 'Syncing…' : 'Sync Error';
}

let _localGroups = [];
let _localAnnotations = {};
let _localPeople = [];
let _localMondayNotes = [];
let _localMondayMeetings = [];
let _firebaseReady = false;
function getGroupById(id) { return loadGroups().find(g => g.id === id) || null; }
function eventIsVisible(ev) {
  if (!ev.groupId) return true;
  return !state.hiddenGroups.includes(ev.groupId);
}

const today = new Date();
today.setHours(0,0,0,0);

function isToday(d) {
  // Parse date strings as local time (appending T00:00:00 avoids UTC interpretation)
  const t = typeof d === 'string' ? new Date(d + 'T00:00:00') : new Date(d);
  t.setHours(0,0,0,0);
  return t.getTime() === today.getTime();
}

// ============================================================
// HELPERS
// ============================================================
function fmtDate(d) {
  const dt = new Date(d + 'T00:00:00');
  return `${DAYS[dt.getDay()]}, ${MONTHS[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`;
}
function fmtTime(t) {
  if (!t) return '';
  const [h,m] = t.split(':');
  const hr = parseInt(h); const ampm = hr >= 12 ? 'PM' : 'AM';
  return `${hr%12||12}:${m} ${ampm}`;
}
// Compact time for tight spaces: "9a", "1:30p"
function fmtTimeShort(t) {
  if (!t) return '';
  const [h,m] = t.split(':');
  const hr = parseInt(h); const ap = hr >= 12 ? 'p' : 'a';
  return `${hr%12||12}${m!=='00'?':'+m:''}${ap}`;
}
function eventMatchesFilter(ev) {
  if (!state.activeFilters.length) return true;
  // event matches if any filter person is an attendee OR has a task assigned to them
  return state.activeFilters.some(name => {
    const isAttendee = (ev.attendees||[]).includes(name);
    const hasTask = (ev.tasks||[]).some(t => t.assignee === name);
    return isAttendee || hasTask;
  });
}
// ============================================================
// RECURRENCE HELPERS
// ============================================================
function recurMatches(ev, dateStr) {
  // Multi-day span check (non-recurring)
  if (ev.endDate && ev.endDate > ev.date) {
    if (dateStr >= ev.date && dateStr <= ev.endDate) {
      // Still check recurrence exceptions
      if (ev.recurrence && ev.recurrence.exceptions && ev.recurrence.exceptions.includes(dateStr)) return false;
      return true;
    }
    return false;
  }
  if (!ev.recurrence || ev.recurrence.freq === 'none') return ev.date === dateStr;
  if (dateStr < ev.date) return false;
  if (ev.recurrence.endDate && dateStr > ev.recurrence.endDate) return false;
  // Check exceptions (moved occurrences)
  if (ev.recurrence.exceptions && ev.recurrence.exceptions.includes(dateStr)) return false;

  if (dateStr === ev.date) return true;

  const start = new Date(ev.date + 'T00:00:00');
  const target = new Date(dateStr + 'T00:00:00');
  const interval = ev.recurrence.interval || 1;
  const freq = ev.recurrence.freq;

  if (freq === 'daily') {
    const diff = Math.round((target - start) / 86400000);
    return diff % interval === 0;
  }
  if (freq === 'weekly') {
    const days = ev.recurrence.days && ev.recurrence.days.length ? ev.recurrence.days : [start.getDay()];
    if (!days.includes(target.getDay())) return false;
    // Align to week boundaries (Sunday=0) so intervals work regardless of start day
    const startSun = new Date(start);
    startSun.setDate(startSun.getDate() - startSun.getDay());
    const targetSun = new Date(target);
    targetSun.setDate(targetSun.getDate() - targetSun.getDay());
    const weekDiff = Math.round((targetSun - startSun) / (7 * 86400000));
    return weekDiff >= 0 && weekDiff % interval === 0;
  }
  if (freq === 'monthly') {
    if (target.getDate() !== start.getDate()) return false;
    const monthDiff = (target.getFullYear() - start.getFullYear()) * 12 + (target.getMonth() - start.getMonth());
    return monthDiff >= 0 && monthDiff % interval === 0;
  }
  if (freq === 'yearly') {
    if (target.getMonth() !== start.getMonth() || target.getDate() !== start.getDate()) return false;
    const yearDiff = target.getFullYear() - start.getFullYear();
    return yearDiff >= 0 && yearDiff % interval === 0;
  }
  return false;
}

function isRecurringInstance(ev, dateStr) {
  // Is this a virtual recurring occurrence (not the original date)?
  return ev.recurrence && ev.recurrence.freq !== 'none' && ev.date !== dateStr;
}

function multidayPos(ev, dateStr) {
  // Returns 'start', 'mid', 'end', or null for single-day events
  if (!ev.endDate || ev.endDate <= ev.date) return null;
  if (dateStr === ev.date) return 'start';
  if (dateStr === ev.endDate) return 'end';
  return 'mid';
}

function eventsForDate(dateStr) {
  return state.events.filter(e => recurMatches(e, dateStr) && eventIsVisible(e));
}
function filteredEventsForDate(dateStr) {
  return state.events.filter(e => recurMatches(e, dateStr) && eventMatchesFilter(e) && eventIsVisible(e));
}
function getParentEvents() {
  // Top-level events (no parentId) — these can be parents
  return state.events.filter(e => !e.parentId);
}
function getSubEvents(parentId) {
  return state.events.filter(e => e.parentId === parentId);
}
function getParent(ev) {
  if (!ev.parentId) return null;
  return state.events.find(e => e.id === ev.parentId) || null;
}
function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ============================================================
// RENDER HEADER
// ============================================================
function renderHeader() {
  const d = state.date;
  let label = '';
  if (state.view === 'month' || state.view === 'list') label = `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  else if (state.view === 'week') {
    const sun = new Date(d); sun.setDate(d.getDate() - d.getDay());
    const sat = new Date(sun); sat.setDate(sun.getDate()+6);
    label = `${MONTHS[sun.getMonth()]} ${sun.getDate()} – ${sun.getMonth()!==sat.getMonth()?MONTHS[sat.getMonth()]+' ':''}${sat.getDate()}, ${sat.getFullYear()}`;
  } else {
    label = `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  }
  document.getElementById('periodLabel').textContent = label;
}

// ============================================================
// MONTH VIEW
// ============================================================
function renderMonth() {
  const d = state.date;
  const firstDay = new Date(d.getFullYear(), d.getMonth(), 1);
  const lastDay = new Date(d.getFullYear(), d.getMonth()+1, 0);
  const startDow = firstDay.getDay();
  const grid = document.getElementById('calGrid');
  grid.innerHTML = '';

  const cells = [];
  // prev month fill
  for (let i = 0; i < startDow; i++) {
    const dd = new Date(firstDay); dd.setDate(dd.getDate() - (startDow - i));
    cells.push({date: dd, other: true});
  }
  for (let i = 1; i <= lastDay.getDate(); i++) {
    cells.push({date: new Date(d.getFullYear(), d.getMonth(), i), other: false});
  }
  // next month fill
  const remaining = 42 - cells.length;
  for (let i = 1; i <= remaining; i++) {
    const dd = new Date(lastDay); dd.setDate(dd.getDate() + i);
    cells.push({date: dd, other: true});
  }

  cells.forEach(({date, other}) => {
    const ds = isoDate(date);
    const allEvs = eventsForDate(ds);
    const evs = state.activeFilters.length ? allEvs.filter(e => eventMatchesFilter(e)) : allEvs;
    const hasAny = allEvs.length > 0;
    const hasMatch = evs.length > 0;

    const cell = document.createElement('div');
    cell.className = 'cal-cell' + (other?' other-month':'') + (isToday(ds)?' today':'');
    if (state.activeFilters.length && hasAny && !hasMatch) cell.classList.add('all-dimmed');

    const annotations = loadAnnotations();
    const note = annotations[ds] || '';

    const header = document.createElement('div');
    header.className = 'day-header';

    const numEl = document.createElement('div');
    numEl.className = 'day-num';
    numEl.textContent = date.getDate();
    header.appendChild(numEl);

    // Annotation — click to edit inline
    const annEl = document.createElement('div');
    annEl.className = 'day-annotation' + (note ? ' has-note' : '');
    annEl.textContent = note || '';
    annEl.title = 'Click to add/edit note';
    annEl.style.minWidth = '20px'; // always clickable even when empty

    const openAnnotationEdit = (e) => {
      e.stopPropagation();
      if (header.querySelector('.day-annotation-input')) return; // already editing
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'day-annotation-input';
      input.value = note;
      input.placeholder = 'Add note…';
      input.maxLength = 60;
      header.replaceChild(input, annEl);
      input.focus();
      input.select();

      // Pause Firebase-triggered re-renders while editing
      state._editingAnnotation = true;

      let committed = false;
      const commit = () => {
        if (committed) return;
        committed = true;
        state._editingAnnotation = false;
        const val = input.value.trim();
        const anns = loadAnnotations();
        if (val) anns[ds] = val; else delete anns[ds];
        saveAnnotations(anns);
        render();
      };

      input.onblur = () => { setTimeout(() => { if (!committed) commit(); }, 150); };
      input.onclick = (ke) => ke.stopPropagation();
      input.onkeydown = (ke) => {
        ke.stopPropagation();
        if (ke.key === 'Enter') { committed = false; commit(); }
        if (ke.key === 'Escape') { committed = true; state._editingAnnotation = false; render(); }
      };
    };

    annEl.onclick = openAnnotationEdit;
    header.appendChild(annEl);
    cell.appendChild(header);

    const max = 3;
    // show all events but dim non-matching ones; indent sub-events
    allEvs.slice(0, max).forEach(ev => {
      const matches = eventMatchesFilter(ev);
      const parent = getParent(ev);
      const pill = document.createElement('div');
      const mdPos = multidayPos(ev, ds);
      pill.className = 'event-pill'
        + (ev.tasks&&ev.tasks.length?' has-tasks':'')
        + (ev.parentId?' sub-event':'')
        + (mdPos ? ` multiday-${mdPos}` : '')
        + (state.activeFilters.length && !matches ? ' dimmed' : '');
      const group = ev.groupId ? getGroupById(ev.groupId) : null;
      const pillColor = (group ? group.color : null) || ev.color || 'var(--kraken-teal)';
      const isNewRow = date.getDay() === 0;   // Sunday — starts a new row

      pill.style.borderLeftColor = mdPos && mdPos !== 'start' ? 'transparent' : pillColor;
      pill.style.setProperty('--ev-color', pillColor);

      if (group || mdPos) {
        if (mdPos === 'mid') {
          // Sundays that are mid-span use 28 opacity (they're the "restart" of a new row)
          pill.style.background = pillColor + (isNewRow ? '28' : 'AA');
        } else if (mdPos === 'end') {
          const startDate = new Date(ev.date + 'T00:00:00');
          const startSunday = new Date(startDate); startSunday.setDate(startDate.getDate() - startDate.getDay());
          const endSunday = new Date(date); endSunday.setDate(date.getDate() - date.getDay());
          const wrappedWeeks = endSunday > startSunday;
          pill.style.background = pillColor + (wrappedWeeks ? '28' : 'AA');
          pill.style.borderRight = `3px solid ${pillColor}`;
          pill.style.borderRadius = '0 4px 4px 0';
        } else {
          // start or no mdPos
          pill.style.background = pillColor + '28';
        }
      }
      if (ev.parentId) pill.style.background = 'rgba(127,206,205,0.07)';
      // build pill content — title on start and on each new week row (Sun col) for mid/end spans
      let pillHTML = '';
      if (!mdPos || mdPos === 'start' || (mdPos && isNewRow)) {
        if (ev.parentId) pillHTML += `<span style="opacity:.5;font-size:13px;margin-right:2px">↳</span>`;
        if (mdPos && isNewRow && mdPos !== 'start') pillHTML += `<span style="opacity:.5;font-size:13px;margin-right:2px">↩</span>`;
        if (!ev.allDay && !mdPos && ev.start) pillHTML += `<span class="pill-time">${fmtTimeShort(ev.start)}</span>`;
        pillHTML += `<span style="flex:1;overflow:hidden;text-overflow:ellipsis">${ev.title}</span>`;
        pillHTML += recurLabel(ev);
      }
      pill.innerHTML = pillHTML;
      // Full details on hover — truncated pills no longer hide information
      const tipParts = [ev.title];
      tipParts.push(ev.allDay ? 'All day' : `${fmtTime(ev.start)} – ${fmtTime(ev.end)}`);
      if (ev.location) tipParts.push('📍 ' + ev.location);
      if (group) tipParts.push('🏷 ' + group.name);
      if (ev.tasks && ev.tasks.length) tipParts.push(`🎯 ${ev.tasks.filter(t=>t.done).length}/${ev.tasks.length} tasks`);
      pill.title = tipParts.join('\n');
      if (matches || !state.activeFilters.length) pill.onclick = e => { e.stopPropagation(); openDetail(ev.id); };
      makeDraggable(pill, ev, ds);
      cell.appendChild(pill);
    });
    if (allEvs.length > max) {
      const more = document.createElement('div');
      more.className = 'more-label';
      more.textContent = `+${allEvs.length - max} more`;
      more.title = 'View all events on this day';
      more.onclick = e => {
        e.stopPropagation();
        state.date = new Date(ds + 'T00:00:00');
        state.view = 'day';
        document.querySelectorAll('.view-tab').forEach(t => t.classList.toggle('active', t.dataset.view === 'day'));
        render();
      };
      cell.appendChild(more);
    }

    // task due-date dots — only when showTasks is on
    if (state.showTasks) {
      const dueTasks = [];
      state.events.forEach(ev => {
        (ev.tasks||[]).forEach(t => {
          if (t.dueDate === ds && !t.done) {
            const taskMatches = !state.activeFilters.length || state.activeFilters.includes(t.assignee);
            if (taskMatches) dueTasks.push({t, ev});
          }
        });
      });
      dueTasks.slice(0,2).forEach(({t, ev}) => {
        const overdue = taskIsOverdue(t);
        const dot = document.createElement('div');
        dot.className = 'task-due-dot' + (overdue?' overdue':'');
        const assignPart = t.assignee ? ` · ${initials(t.assignee)}` : '';
        dot.textContent = `◆ ${t.text.length>18?t.text.slice(0,18)+'…':t.text}${assignPart}`;
        dot.title = `Task: ${t.text}${t.assignee?' — '+t.assignee:''}${overdue?' (OVERDUE)':''}`;
        dot.onclick = e => { e.stopPropagation(); openDetail(ev.id); };
        cell.appendChild(dot);
      });
      if (dueTasks.length > 2) {
        const moreT = document.createElement('div');
        moreT.className = 'task-due-dot'; moreT.style.opacity = '0.6';
        moreT.textContent = `+${dueTasks.length-2} more tasks`;
        cell.appendChild(moreT);
      }
    }

    cell.onclick = (e) => {
      // Only open popup if not clicking on annotation/header area
      if (e.target.classList.contains('day-annotation') || e.target.classList.contains('day-annotation-input') || e.target.classList.contains('day-num')) return;
      openDayPopup(e, ds);
    };
    cell.ondblclick = (e) => openDayPopup(e, ds);
    applyMonthCellDrop(cell, ds);
    grid.appendChild(cell);
  });
}

// ============================================================
// WEEK VIEW
// ============================================================
function renderWeek() {
  const d = state.date;
  const sun = new Date(d); sun.setDate(d.getDate() - d.getDay());

  const headerRow = document.getElementById('weekHeaderRow');
  const layout = document.getElementById('weekLayout');
  headerRow.innerHTML = ''; layout.innerHTML = '';

  // gutter header spacer
  headerRow.appendChild(document.createElement('div'));

  for (let i = 0; i < 7; i++) {
    const day = new Date(sun); day.setDate(sun.getDate()+i);
    const hdr = document.createElement('div');
    hdr.className = 'week-day-header';
    const numEl = document.createElement('div');
    numEl.className = 'week-day-num' + (isToday(isoDate(day))?' today-num':'');
    numEl.textContent = day.getDate();
    const nameEl = document.createElement('div');
    nameEl.className = 'week-day-name';
    nameEl.textContent = DAYS[i];
    hdr.appendChild(nameEl); hdr.appendChild(numEl);
    headerRow.appendChild(hdr);
  }

  // time gutter
  const gutter = document.createElement('div');
  gutter.className = 'week-time-col';
  for (let h = 0; h < 24; h++) {
    const lbl = document.createElement('div');
    lbl.className = 'week-hour-label';
    lbl.textContent = h === 0 ? '' : (h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h-12} PM`);
    gutter.appendChild(lbl);
  }
  layout.appendChild(gutter);

  // All-day / multi-day banner row — use a relative container for spanning banners
  const allDayRow = document.getElementById('weekAllDayRow');
  allDayRow.innerHTML = '';
  allDayRow.style.display = 'grid';
  allDayRow.style.gridTemplateColumns = '52px repeat(7, 1fr)';
  allDayRow.style.gap = '2px';

  const allDayGutter = document.createElement('div');
  allDayGutter.className = 'week-allday-gutter';
  allDayGutter.style.cssText = 'font-size:13px;color:var(--text-dim);text-align:right;padding:4px 6px 0 0;font-family:"Barlow Condensed",sans-serif;letter-spacing:1px';
  allDayRow.appendChild(allDayGutter);

  // Span columns 2-8 (all 7 day columns), relative container for absolute banners
  const bannerGrid = document.createElement('div');
  bannerGrid.style.cssText = 'position:relative;grid-column:2/9;min-height:4px;';
  allDayRow.appendChild(bannerGrid);

  let hasAllDay = false;
  const BANNER_H = 26; // height + gap per row
  const BANNER_TOP = 4;

  // Track occupied column slots per row to avoid overlaps
  // slots[row] = array of [colStart, colEnd] ranges
  const slots = [];
  function findRow(colStart, colEnd) {
    for (let row = 0; ; row++) {
      if (!slots[row]) { slots[row] = []; return row; }
      const conflict = slots[row].some(([s, e]) => colStart <= e && colEnd >= s);
      if (!conflict) return row;
    }
  }

  // Collect unique multi-day/all-day events visible this week
  const seen = new Set();
  for (let i = 0; i < 7; i++) {
    const day = new Date(sun); day.setDate(sun.getDate()+i);
    const ds = isoDate(day);
    const adEvs = eventsForDate(ds).filter(ev => ev.allDay || (ev.endDate && ev.endDate > ev.date));
    adEvs.forEach(ev => {
      if (seen.has(ev.id)) return;
      seen.add(ev.id);
      hasAllDay = true;

      const group = ev.groupId ? getGroupById(ev.groupId) : null;
      const evColor = (group ? group.color : null) || ev.color || '#00B2A9';

      const evStart = new Date(ev.date + 'T00:00:00');
      const evEnd = ev.endDate ? new Date(ev.endDate + 'T00:00:00') : evStart;
      const weekStart = new Date(sun);
      const weekEnd = new Date(sun); weekEnd.setDate(sun.getDate() + 6);

      const colStart = Math.max(0, Math.round((Math.max(evStart, weekStart) - weekStart) / 86400000));
      const colEnd   = Math.min(6, Math.round((Math.min(evEnd,   weekEnd)   - weekStart) / 86400000));
      const spanCols = colEnd - colStart + 1;

      const startsThisWeek = evStart >= weekStart;
      const endsThisWeek   = evEnd   <= weekEnd;

      // Find a non-overlapping vertical row
      const row = findRow(colStart, colEnd);
      slots[row].push([colStart, colEnd]);

      const banner = document.createElement('div');
      banner.className = 'wk-banner';
      banner.style.cssText = `
        position:absolute;
        left:calc(${colStart} / 7 * 100%);
        width:calc(${spanCols} / 7 * 100%);
        top:${BANNER_TOP + row * BANNER_H}px;
        height:22px;
        padding:3px 8px;
        font-size:16px; font-weight:700;
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
        cursor:pointer;
        background:${evColor + (startsThisWeek || endsThisWeek ? '28' : 'AA')};
        --ev-color:${evColor};
        border-left:${startsThisWeek ? `3px solid ${evColor}` : 'none'};
        border-right:${endsThisWeek ? `3px solid ${evColor}` : 'none'};
        border-radius:${startsThisWeek ? '5px' : '0'} ${endsThisWeek ? '5px' : '0'} ${endsThisWeek ? '5px' : '0'} ${startsThisWeek ? '5px' : '0'};
        z-index:2;
        box-sizing:border-box;
        transition:opacity 0.2s;
      `;
      banner.textContent = startsThisWeek || colStart === 0 ? ev.title : '';
      banner.onmouseenter = () => banner.style.opacity = '0.8';
      banner.onmouseleave = () => banner.style.opacity = '1';
      banner.onclick = e => { e.stopPropagation(); openDetail(ev.id); };
      bannerGrid.appendChild(banner);
    });
  }

  const totalRows = slots.length || 0;
  bannerGrid.style.minHeight = hasAllDay ? `${BANNER_TOP + totalRows * BANNER_H}px` : '4px';
  allDayRow.classList.toggle('has-events', hasAllDay);
  if (hasAllDay) allDayGutter.textContent = 'ALL DAY';

  for (let i = 0; i < 7; i++) {
    const day = new Date(sun); day.setDate(sun.getDate()+i);
    const ds = isoDate(day);
    const col = document.createElement('div');
    col.className = 'week-day-col';
    col.onclick = (e) => {
      const rect = col.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const scrollEl = document.querySelector('.week-scroll');
      const scrollY = scrollEl.scrollTop;
      const totalY = y + scrollY - col.getBoundingClientRect().top + rect.top;
      // compute time
      const mins = Math.floor((e.clientY - rect.top + scrollEl.scrollTop) / 60 * 60);
      const h = Math.floor(mins/60); const m = Math.floor((mins%60)/30)*30;
      const startT = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
      const endH = h + 1 < 24 ? h+1 : 23;
      const endT = `${String(endH).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
      openAddModal(ds, startT, endT);
    };
    // hour/half lines
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line'; line.style.top = `${h*60}px`;
      col.appendChild(line);
      if (h < 23) {
        const half = document.createElement('div');
        half.className = 'half-line'; half.style.top = `${h*60+30}px`;
        col.appendChild(half);
      }
    }
    // now line
    if (isToday(ds)) {
      const now = new Date();
      const mins = now.getHours()*60 + now.getMinutes();
      const nl = document.createElement('div');
      nl.className = 'now-line'; nl.style.top = `${mins}px`;
      col.appendChild(nl);
    }
    // events
    const evs = eventsForDate(ds);
    evs.forEach(ev => {
      if (ev.allDay || (ev.endDate && ev.endDate > ev.date)) return; // shown in all-day row
      const matches = eventMatchesFilter(ev);
      const parent = getParent(ev);
      const [sh,sm] = ev.start.split(':').map(Number);
      const [eh,em] = ev.end.split(':').map(Number);
      const top = sh*60+sm; const height = Math.max((eh*60+em)-top, 20);
      const el = document.createElement('div');
      el.className = 'week-event'
        + (ev.tasks&&ev.tasks.length?' has-tasks':'')
        + (ev.parentId?' sub-event':'')
        + (state.activeFilters.length && !matches ? ' dimmed' : '');
      el.style.top = `${top}px`; el.style.height = `${height}px`;
      const weekGroup = ev.groupId ? getGroupById(ev.groupId) : null;
      const evColor = (weekGroup ? weekGroup.color : null) || ev.color || (parent ? parent.color : null) || '#00B2A9';
      el.style.borderLeftColor = evColor;
      el.style.background = evColor + (ev.parentId ? '18' : '28');
      el.style.setProperty('--ev-color', evColor);
      const parentLabel = ev.parentId && parent ? `<div style="font-size:13px;opacity:0.6;margin-bottom:1px">↳ ${parent.title}</div>` : '';
      const groupLabel = weekGroup ? `<span class="group-chip">${weekGroup.name}</span>` : '';
      el.innerHTML = `${parentLabel}<strong>${groupLabel}${ev.title}</strong>${recurLabel(ev)}<br>${fmtTime(ev.start)}`;
      el.title = `${ev.title}\n${fmtTime(ev.start)} – ${fmtTime(ev.end)}${ev.location ? '\n📍 ' + ev.location : ''}${weekGroup ? '\n🏷 ' + weekGroup.name : ''}`;
      if (matches || !state.activeFilters.length) el.onclick = e => { e.stopPropagation(); openDetail(ev.id); };
      makeDraggable(el, ev, ds);
      col.appendChild(el);
    });
    applyWeekDayColDrop(col, ds);
    layout.appendChild(col);
  }
}

// ============================================================
// DAY VIEW
// ============================================================
function renderDay() {
  const d = state.date;
  const ds = isoDate(d);
  const layout = document.getElementById('dayLayout');
  layout.innerHTML = '';

  // All-day / multi-day banner row
  const allDayRow = document.getElementById('dayAllDayRow');
  allDayRow.innerHTML = '';
  const adGutter = document.createElement('div');
  adGutter.style.cssText = 'font-size:13px;color:var(--text-dim);text-align:right;padding:4px 6px 0 0;font-family:"Barlow Condensed",sans-serif;letter-spacing:1px';
  allDayRow.appendChild(adGutter);
  const adCol = document.createElement('div');
  adCol.className = 'week-allday-col';
  const adEvs = eventsForDate(ds).filter(ev => ev.allDay || (ev.endDate && ev.endDate > ev.date));
  adEvs.forEach(ev => {
    const group = ev.groupId ? getGroupById(ev.groupId) : null;
    const evColor = (group ? group.color : null) || ev.color || '#00B2A9';
    const dayMdPos = multidayPos(ev, ds);
    const banner = document.createElement('div');
    banner.className = 'allday-banner';
    banner.style.background = evColor + '28';
    banner.style.borderLeft = (dayMdPos === 'mid' || dayMdPos === 'end') ? 'none' : `3px solid ${evColor}`;
    banner.style.borderRight = (dayMdPos === 'end' || !dayMdPos) ? `3px solid ${evColor}` : 'none';
    banner.style.setProperty('--ev-color', evColor);
    banner.textContent = ev.title;
    banner.onclick = () => openDetail(ev.id);
    adCol.appendChild(banner);
  });
  allDayRow.appendChild(adCol);
  allDayRow.classList.toggle('has-events', adEvs.length > 0);
  if (adEvs.length) adGutter.textContent = 'ALL DAY';

  const gutter = document.createElement('div');
  gutter.className = 'week-time-col';
  for (let h = 0; h < 24; h++) {
    const lbl = document.createElement('div');
    lbl.className = 'week-hour-label';
    lbl.textContent = h === 0 ? '' : (h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h-12} PM`);
    gutter.appendChild(lbl);
  }
  layout.appendChild(gutter);

  const col = document.createElement('div');
  col.className = 'day-col week-day-col';
  col.onclick = (e) => {
    const rect = col.getBoundingClientRect();
    const scrollEl = document.querySelector('.day-scroll');
    const relY = e.clientY - rect.top + scrollEl.scrollTop;
    const h = Math.floor(relY/60); const m = Math.floor((relY%60)/30)*30;
    const startT = `${String(Math.min(h,23)).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
    const endH = Math.min(h+1,23);
    const endT = `${String(endH).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
    openAddModal(ds, startT, endT);
  };
  for (let h = 0; h < 24; h++) {
    const line = document.createElement('div'); line.className = 'hour-line'; line.style.top = `${h*60}px`;
    col.appendChild(line);
    if (h < 23) { const half = document.createElement('div'); half.className = 'half-line'; half.style.top = `${h*60+30}px`; col.appendChild(half); }
  }
  if (isToday(ds)) {
    const now = new Date(); const mins = now.getHours()*60+now.getMinutes();
    const nl = document.createElement('div'); nl.className = 'now-line'; nl.style.top = `${mins}px`;
    col.appendChild(nl);
  }
  const evs = eventsForDate(ds);
  evs.forEach(ev => {
    if (ev.allDay || (ev.endDate && ev.endDate > ev.date)) return; // shown in all-day row
    const matches = eventMatchesFilter(ev);
    const parent = getParent(ev);
    const [sh,sm] = ev.start.split(':').map(Number);
    const [eh,em] = ev.end.split(':').map(Number);
    const top = sh*60+sm; const height = Math.max((eh*60+em)-top,20);
    const el = document.createElement('div');
    el.className = 'week-event'
      + (ev.tasks&&ev.tasks.length?' has-tasks':'')
      + (ev.parentId?' sub-event':'')
      + (state.activeFilters.length && !matches ? ' dimmed' : '');
    el.style.top = `${top}px`; el.style.height = `${height}px`;
    el.style.left = ev.parentId ? '18px' : '4px';
    el.style.right = '4px';
    const dayGroup = ev.groupId ? getGroupById(ev.groupId) : null;
    const evColor = (dayGroup ? dayGroup.color : null) || ev.color || (parent ? parent.color : null) || '#00B2A9';
    el.style.borderLeftColor = evColor;
    el.style.background = evColor + (ev.parentId ? '18' : '22');
    el.style.setProperty('--ev-color', evColor);
    const parentLabel = ev.parentId && parent ? `<div style="font-size:14px;opacity:0.6;margin-bottom:2px">↳ ${parent.title}</div>` : '';
    const groupLabel = dayGroup ? `<span class="group-chip" style="font-size:14px;padding:0 5px;margin-right:4px">${dayGroup.name}</span>` : '';
    el.innerHTML = `${parentLabel}<strong>${groupLabel}${ev.title}</strong>${recurLabel(ev)}<br>${fmtTime(ev.start)} – ${fmtTime(ev.end)}${ev.location?'<br>📍 '+ev.location:''}`;
    if (matches || !state.activeFilters.length) el.onclick = e => { e.stopPropagation(); openDetail(ev.id); };
    makeDraggable(el, ev, ds);
    col.appendChild(el);
  });
  applyWeekDayColDrop(col, ds);
  layout.appendChild(col);
}

// ============================================================
// AGENDA / LIST VIEW
// ============================================================
function renderAgenda() {
  const container = document.getElementById('agendaView');
  container.innerHTML = '';

  const d = state.date;
  const firstDay = new Date(d.getFullYear(), d.getMonth(), 1);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0);

  for (let day = new Date(firstDay); day <= lastDay; day.setDate(day.getDate() + 1)) {
    const ds = isoDate(day);
    const allEvs = eventsForDate(ds);
    const evs = state.activeFilters.length ? allEvs.filter(e => eventMatchesFilter(e)) : allEvs;

    const group = document.createElement('div');
    group.className = 'agenda-day-group';

    const header = document.createElement('div');
    header.className = 'agenda-day-header' + (isToday(ds) ? ' agenda-day-today' : '');

    const dateEl = document.createElement('div');
    dateEl.className = 'agenda-day-date';
    dateEl.textContent = day.getDate();
    header.appendChild(dateEl);

    const meta = document.createElement('div');
    meta.className = 'agenda-day-meta';
    const nameEl = document.createElement('div');
    nameEl.className = 'agenda-day-name';
    nameEl.textContent = DAYS_FULL[day.getDay()];
    meta.appendChild(nameEl);
    const myEl = document.createElement('div');
    myEl.className = 'agenda-day-monthyear';
    myEl.textContent = `${MONTHS[day.getMonth()]} ${day.getFullYear()}`;
    meta.appendChild(myEl);
    header.appendChild(meta);

    const line = document.createElement('div');
    line.className = 'agenda-day-line';
    header.appendChild(line);

    group.appendChild(header);

    if (evs.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'agenda-empty';
      empty.textContent = 'No events';
      group.appendChild(empty);
    } else {
      evs.sort((a, b) => {
        if (a.allDay && !b.allDay) return -1;
        if (!a.allDay && b.allDay) return 1;
        return (a.start || '99') < (b.start || '99') ? -1 : 1;
      });
      const eventsEl = document.createElement('div');
      eventsEl.className = 'agenda-events';

      for (const ev of evs) {
        const evGroup = ev.groupId ? getGroupById(ev.groupId) : null;
        const color = (evGroup ? evGroup.color : null) || ev.color || 'var(--kraken-teal)';
        const dimmed = state.activeFilters.length && !eventMatchesFilter(ev);

        const card = document.createElement('div');
        card.className = 'agenda-event' + (dimmed ? ' dimmed' : '');
        card.onclick = () => openDetail(ev.id);

        const colorBar = document.createElement('div');
        colorBar.className = 'agenda-event-color';
        colorBar.style.background = color;
        card.appendChild(colorBar);

        const body = document.createElement('div');
        body.className = 'agenda-event-body';

        if (ev.allDay) {
          const allDayLabel = document.createElement('div');
          allDayLabel.className = 'agenda-event-allday';
          allDayLabel.textContent = 'All day';
          body.appendChild(allDayLabel);
        }

        const title = document.createElement('div');
        title.className = 'agenda-event-title';
        title.textContent = (ev.parentId ? '↳ ' : '') + ev.title;
        title.style.color = `color-mix(in srgb, ${color} var(--ev-mix), var(--ev-mix-base))`;
        body.appendChild(title);

        if (!ev.allDay && (ev.start || ev.end)) {
          const time = document.createElement('div');
          time.className = 'agenda-event-time';
          let timeText = '';
          if (ev.start) timeText += fmtTime(ev.start);
          if (ev.end) timeText += ' – ' + fmtTime(ev.end);
          time.textContent = timeText;

          const taskCount = (ev.tasks || []).filter(t => !t.done).length;
          if (taskCount > 0) {
            const tasks = document.createElement('span');
            tasks.className = 'agenda-event-tasks';
            tasks.textContent = '◆ ' + taskCount + ' task' + (taskCount > 1 ? 's' : '');
            time.appendChild(tasks);
          }
          body.appendChild(time);
        }

        if ((ev.attendees || []).length > 0) {
          const people = document.createElement('div');
          people.className = 'agenda-event-people';
          people.textContent = ev.attendees.join(', ');
          body.appendChild(people);
        }

        card.appendChild(body);
        eventsEl.appendChild(card);
      }
      group.appendChild(eventsEl);
    }
    container.appendChild(group);
  }
}

// ============================================================
// RENDER ALL
// ============================================================
function render() {
  if (state._editingAnnotation) return; // don't re-render while user is typing a note
  renderHeader();
  renderSidebar();
  renderFilterBanner();
  renderUpNext();
  document.getElementById('agendaView').className = 'agenda-view' + (state.view==='list'?' active':'');
  document.getElementById('monthView').className = 'month-grid' + (state.view==='month'?' active':'');
  document.getElementById('weekView').className = 'week-grid' + (state.view==='week'?' active':'');
  document.getElementById('dayView').className = 'day-view' + (state.view==='day'?' active':'');
  if (state.view === 'list') renderAgenda();
  else if (state.view === 'month') renderMonth();
  else if (state.view === 'week') renderWeek();
  else renderDay();
  renderMondayPageIfOpen();
}

// ============================================================
// UP NEXT — 7-day agenda in the sidebar
// ============================================================
function renderUpNext() {
  const list = document.getElementById('upNextList');
  const overdueBox = document.getElementById('upNextOverdue');
  if (!list || !overdueBox) return;
  list.innerHTML = '';
  overdueBox.innerHTML = '';

  // Overdue task alert across all visible events
  const overdue = [];
  state.events.filter(Boolean).forEach(ev => {
    if (!eventIsVisible(ev)) return;
    (ev.tasks || []).forEach(t => { if (taskIsOverdue(t)) overdue.push({ ev, t }); });
  });
  if (overdue.length) {
    const chip = document.createElement('div');
    chip.className = 'upnext-overdue';
    chip.innerHTML = `<span>⚠</span><span>${overdue.length} overdue task${overdue.length > 1 ? 's' : ''}</span>`;
    chip.title = overdue.slice(0, 8).map(o => `${o.ev.title} — ${o.t.text}`).join('\n')
      + (overdue.length > 8 ? `\n…and ${overdue.length - 8} more` : '')
      + '\n\nClick to open the first one';
    chip.onclick = () => openDetail(overdue[0].ev.id);
    overdueBox.appendChild(chip);
  }

  // Next 7 days of events
  const start = new Date(); start.setHours(0, 0, 0, 0);
  let shown = 0;
  const MAX_ITEMS = 10;
  for (let i = 0; i < 7 && shown < MAX_ITEMS; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const ds = isoDate(d);
    let evs = eventsForDate(ds);
    if (state.activeFilters.length) evs = evs.filter(e => eventMatchesFilter(e));
    if (!evs.length) continue;
    // All-day events first, then by start time
    evs.sort((a, b) => (a.allDay ? '' : a.start || '99') < (b.allDay ? '' : b.start || '99') ? -1 : 1);

    const label = document.createElement('div');
    label.className = 'upnext-day-label' + (i === 0 ? ' is-today' : '');
    label.textContent = i === 0 ? 'Today' : i === 1 ? 'Tomorrow'
      : `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
    list.appendChild(label);

    for (const ev of evs) {
      if (shown >= MAX_ITEMS) break;
      const group = ev.groupId ? getGroupById(ev.groupId) : null;
      const color = (group ? group.color : null) || ev.color || 'var(--kraken-teal)';
      const row = document.createElement('div');
      row.className = 'upnext-item';
      row.innerHTML = `
        <span class="un-dot" style="background:${color}"></span>
        <span class="un-title">${ev.parentId ? '↳ ' : ''}${ev.title}</span>
        <span class="un-time">${ev.allDay ? 'All day' : fmtTimeShort(ev.start)}</span>`;
      row.title = `${ev.title}\n${ev.allDay ? 'All day' : fmtTime(ev.start) + ' – ' + fmtTime(ev.end)}${ev.location ? '\n📍 ' + ev.location : ''}`;
      row.onclick = () => openDetail(ev.id);
      list.appendChild(row);
      shown++;
    }
  }

  if (!shown && !overdue.length) {
    const empty = document.createElement('div');
    empty.className = 'upnext-empty';
    empty.textContent = 'Calm seas — nothing scheduled in the next 7 days. Press N to add an event.';
    list.appendChild(empty);
  }
}

// ============================================================
// NAVIGATION
// ============================================================
// ============================================================
// SIDEBAR & FILTER
// ============================================================
function renderSidebar() {
  const people = _localPeople.length ? JSON.parse(JSON.stringify(_localPeople)) : [];
  const list = document.getElementById('filterPeopleList');
  list.innerHTML = '';

  const allBtn = document.getElementById('filterAllBtn');
  allBtn.classList.toggle('showing-all', !state.activeFilters.length);

  people.forEach(p => {
    const row = document.createElement('div');
    const active = state.activeFilters.includes(p.name);
    row.className = 'filter-person' + (active ? ' active' : '');
    row.title = active ? `Click to remove ${p.name} from filter` : `Click to filter by ${p.name}`;

    const av = document.createElement('div');
    av.className = 'fp-avatar';
    av.style.background = avatarColor(p.name);
    av.textContent = initials(p.name);

    const nm = document.createElement('div');
    nm.className = 'fp-name';
    nm.textContent = p.name;

    row.appendChild(av); row.appendChild(nm);
    row.onclick = () => {
      const idx = state.activeFilters.indexOf(p.name);
      if (idx >= 0) state.activeFilters.splice(idx, 1);
      else state.activeFilters.push(p.name);
      render();
    };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      openPersonCtxMenu(e, p);
    };
    list.appendChild(row);
  });

  if (!people.length) {
    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:15px;color:var(--text-dim);padding:4px 2px;line-height:1.5';
    hint.textContent = 'Add people below to filter events & tasks by person.';
    list.appendChild(hint);
  }

  // update task toggle row style
  const toggleRow = document.getElementById('taskToggleRow');
  const toggleCheck = document.getElementById('taskToggleCheck');
  toggleRow.classList.toggle('active', state.showTasks);
  toggleCheck.textContent = state.showTasks ? '✓' : '';

  // render topic groups (defined later in file, safe to call here at runtime)
  if (typeof renderSidebarGroups === 'function') renderSidebarGroups();
}

function renderFilterBanner() {
  const banner = document.getElementById('filterBanner');
  const names = document.getElementById('filterBannerNames');
  if (state.activeFilters.length) {
    banner.classList.add('visible');
    names.textContent = state.activeFilters.join(', ');
  } else {
    banner.classList.remove('visible');
  }
}

document.getElementById('filterAllBtn').onclick = () => {
  state.activeFilters = [];
  render();
};
document.getElementById('filterBannerClose').onclick = () => {
  state.activeFilters = [];
  render();
};

// ============================================================
// SIDEBAR COLLAPSE & RESIZE
// ============================================================
let sidebarCollapsed = false;

document.getElementById('sidebarCollapseBtn').onclick = () => {
  sidebarCollapsed = !sidebarCollapsed;
  const sidebar = document.getElementById('sidebar');
  const btn = document.getElementById('sidebarCollapseBtn');
  sidebar.classList.toggle('collapsed', sidebarCollapsed);
  btn.textContent = sidebarCollapsed ? '›' : '‹';
  btn.title = sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
};

// Drag-to-resize
const resizeHandle = document.getElementById('sidebarResizeHandle');
let isResizing = false;
let resizeStartX = 0;
let resizeStartWidth = 0;

resizeHandle.addEventListener('mousedown', (e) => {
  if (sidebarCollapsed) return;
  isResizing = true;
  resizeStartX = e.clientX;
  resizeStartWidth = document.getElementById('sidebar').offsetWidth;
  resizeHandle.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!isResizing) return;
  const dx = e.clientX - resizeStartX;
  const newWidth = Math.min(400, Math.max(160, resizeStartWidth + dx));
  document.getElementById('sidebar').style.width = newWidth + 'px';
});

document.addEventListener('mouseup', () => {
  if (!isResizing) return;
  isResizing = false;
  resizeHandle.classList.remove('dragging');
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
});

// People filter collapse
let peopleFilterCollapsed = false;
document.getElementById('peopleFilterToggle').onclick = () => {
  peopleFilterCollapsed = !peopleFilterCollapsed;
  const body = document.getElementById('peopleFilterBody');
  const chevron = document.getElementById('peopleFilterChevron');
  body.style.display = peopleFilterCollapsed ? 'none' : '';
  chevron.style.transform = peopleFilterCollapsed ? 'rotate(-90deg)' : '';
};

document.getElementById('taskToggleRow').onclick = () => {
  state.showTasks = !state.showTasks;
  render();
};

// Sidebar add person — new button/form pattern
document.getElementById('sidebarPersonNewBtn').onclick = () => {
  const form = document.getElementById('sidebarPersonForm');
  form.classList.add('open');
  setTimeout(() => document.getElementById('sidebarPersonInput').focus(), 30);
};
document.getElementById('sidebarPersonCancel').onclick = () => {
  document.getElementById('sidebarPersonForm').classList.remove('open');
  document.getElementById('sidebarPersonInput').value = '';
};
document.getElementById('sidebarPersonAdd').onclick = sidebarAddPerson;
document.getElementById('sidebarPersonInput').onkeydown = (e) => {
  if (e.key === 'Enter') sidebarAddPerson();
  if (e.key === 'Escape') {
    document.getElementById('sidebarPersonForm').classList.remove('open');
    document.getElementById('sidebarPersonInput').value = '';
  }
};
function sidebarAddPerson() {
  const name = document.getElementById('sidebarPersonInput').value.trim();
  if (!name) return;
  const people = _localPeople.length ? JSON.parse(JSON.stringify(_localPeople)) : [];
  if (people.find(p => p.name.toLowerCase() === name.toLowerCase())) {
    document.getElementById('sidebarPersonInput').value = '';
    document.getElementById('sidebarPersonForm').classList.remove('open');
    return;
  }
  people.push({ id: uid(), name });
  db.set('krakenPeople', people);
  document.getElementById('sidebarPersonInput').value = '';
  document.getElementById('sidebarPersonForm').classList.remove('open');
  render();
  currentPeople = people;
  renderPeoplePanel();
  renderAttendeeSelect();
}

// ============================================================
// ATTENDEES
// ============================================================
let currentAttendees = []; // names of people attending this event

function renderAttendeeSelect() {
  const sel = document.getElementById('attendeeSelect');
  const people = _localPeople.length ? JSON.parse(JSON.stringify(_localPeople)) : [];
  const prev = sel.value;
  sel.innerHTML = '<option value="">— Add attendee —</option>';
  people.forEach(p => {
    if (currentAttendees.includes(p.name)) return; // already added
    const opt = document.createElement('option');
    opt.value = p.name; opt.textContent = p.name;
    sel.appendChild(opt);
  });
  sel.value = prev;
}

function renderAttendeeChips() {
  const chips = document.getElementById('attendeeChips');
  chips.innerHTML = '';
  currentAttendees.forEach((name, i) => {
    const chip = document.createElement('div');
    chip.className = 'attendee-chip';
    const av = document.createElement('div');
    av.className = 'assignee-avatar';
    av.style.background = avatarColor(name);
    av.style.width = '20px'; av.style.height = '20px'; av.style.fontSize = '14px';
    av.textContent = initials(name);
    const nm = document.createElement('span'); nm.textContent = name;
    const del = document.createElement('button'); del.textContent = '✕';
    del.onclick = () => { currentAttendees.splice(i, 1); renderAttendeeChips(); renderAttendeeSelect(); };
    chip.appendChild(av); chip.appendChild(nm); chip.appendChild(del);
    chips.appendChild(chip);
  });
}

document.getElementById('attendeeAddBtn').onclick = () => {
  const sel = document.getElementById('attendeeSelect');
  const name = sel.value;
  if (!name || currentAttendees.includes(name)) return;
  currentAttendees.push(name);
  renderAttendeeChips();
  renderAttendeeSelect();
  sel.value = '';
};
document.getElementById('attendeeSelect').onchange = () => {
  const sel = document.getElementById('attendeeSelect');
  if (sel.value) {
    const name = sel.value;
    if (!currentAttendees.includes(name)) {
      currentAttendees.push(name);
      renderAttendeeChips();
      renderAttendeeSelect();
    }
    sel.value = '';
  }
};

document.getElementById('prevBtn').onclick = () => {
  const d = state.date;
  if (state.view==='month' || state.view==='list') state.date = new Date(d.getFullYear(), d.getMonth()-1, 1);
  else if (state.view==='week') { const n = new Date(d); n.setDate(d.getDate()-7); state.date=n; }
  else { const n = new Date(d); n.setDate(d.getDate()-1); state.date=n; }
  render();
};
document.getElementById('nextBtn').onclick = () => {
  const d = state.date;
  if (state.view==='month' || state.view==='list') state.date = new Date(d.getFullYear(), d.getMonth()+1, 1);
  else if (state.view==='week') { const n = new Date(d); n.setDate(d.getDate()+7); state.date=n; }
  else { const n = new Date(d); n.setDate(d.getDate()+1); state.date=n; }
  render();
};
document.getElementById('todayBtn').onclick = () => { state.date = new Date(); render(); };

document.querySelectorAll('.view-tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.view-tab').forEach(t=>t.classList.remove('active'));
    tab.classList.add('active');
    state.view = tab.dataset.view;
    render();
  };
});

// ============================================================
// MONTH PICKER
// ============================================================
document.getElementById('periodLabel').onclick = openMonthPicker;
function openMonthPicker() {
  state.mpYear = state.date.getFullYear();
  renderMonthPicker();
  document.getElementById('monthPickerOverlay').classList.add('open');
}
function renderMonthPicker() {
  document.getElementById('mpYearLabel').textContent = state.mpYear;
  const grid = document.getElementById('mpMonths');
  grid.innerHTML = '';
  MONTHS.forEach((m,i) => {
    const btn = document.createElement('button');
    btn.className = 'mp-month' + (state.mpYear===state.date.getFullYear()&&i===state.date.getMonth()?' current':'');
    btn.textContent = m.slice(0,3);
    btn.onclick = () => {
      state.date = new Date(state.mpYear, i, 1);
      if (state.view !== 'list') {
        state.view = 'month';
        document.querySelectorAll('.view-tab').forEach(t=>{ t.classList.toggle('active', t.dataset.view==='month'); });
      }
      document.getElementById('monthPickerOverlay').classList.remove('open');
      render();
    };
    grid.appendChild(btn);
  });
}
document.getElementById('mpPrevYear').onclick = () => { state.mpYear--; renderMonthPicker(); };
document.getElementById('mpNextYear').onclick = () => { state.mpYear++; renderMonthPicker(); };
document.getElementById('mpClose').onclick = () => document.getElementById('monthPickerOverlay').classList.remove('open');
document.getElementById('monthPickerOverlay').onclick = (e) => { if (e.target.id==='monthPickerOverlay') document.getElementById('monthPickerOverlay').classList.remove('open'); };

// ============================================================
// EVENT MODAL
// ============================================================
let currentTasks = [];
let currentAttachments = [];
let currentPeople = [];
let currentGroupPageId = null;

function openAddModal(dateStr, startT, endT) {
  state.editingId = null;
  currentTasks = [];
  currentAttachments = [];
  currentAttendees = [];
  currentPeople = _localPeople.length ? JSON.parse(JSON.stringify(_localPeople)) : [];
  document.getElementById('eventModalTitle').textContent = 'New Event';
  document.getElementById('evTitle').value = '';
  document.getElementById('evDate').value = dateStr || isoDate(state.date);
  document.getElementById('evStart').value = startT || '09:00';
  document.getElementById('evEnd').value = endT || '10:00';
  document.getElementById('evLocation').value = '';
  document.getElementById('evDesc').value = '';
  document.getElementById('evColor').value = '#00B2A9';
  document.getElementById('evAllDay').checked = false;
  document.getElementById('evMultiDay').checked = false;
  document.getElementById('evEndDate').value = '';
  document.getElementById('endDateRow').classList.remove('visible');
  if (typeof updateAllDayUI === 'function') updateAllDayUI();
  renderTasksList();
  renderAttachList();
  renderPeoplePanel();
  renderAttendeeChips();
  renderAttendeeSelect();
  renderGroupSelect(null);
  resetRecurrenceUI(null);
  renderParentSelect(null, null);
  renderSubeventsPanel(null);
  document.getElementById('newTaskRow').style.display='none';
  document.getElementById('peopleSection').classList.remove('open');
  document.getElementById('addLinkForm').classList.remove('open');
  document.getElementById('fileDropZone').classList.remove('open');
  document.getElementById('eventModalOverlay').classList.add('open');
  setTimeout(()=>document.getElementById('evTitle').focus(),100);
}

function openEditModal(id) {
  const ev = state.events.find(e=>e.id===id);
  if (!ev) return;
  state.editingId = id;
  currentTasks = JSON.parse(JSON.stringify(ev.tasks||[]));
  currentAttachments = JSON.parse(JSON.stringify(ev.attachments||[]));
  currentAttendees = JSON.parse(JSON.stringify(ev.attendees||[]));
  currentPeople = _localPeople.length ? JSON.parse(JSON.stringify(_localPeople)) : [];
  document.getElementById('eventModalTitle').textContent = 'Edit Event';
  document.getElementById('evTitle').value = ev.title;
  document.getElementById('evDate').value = ev.date;
  document.getElementById('evStart').value = ev.start||'09:00';
  document.getElementById('evEnd').value = ev.end||'10:00';
  document.getElementById('evLocation').value = ev.location||'';
  document.getElementById('evDesc').value = ev.desc||'';
  document.getElementById('evColor').value = ev.color||'#00B2A9';
  document.getElementById('evAllDay').checked = !!ev.allDay;
  if (typeof updateAllDayUI === 'function') updateAllDayUI();
  const hasEndDate = !!(ev.endDate && ev.endDate > ev.date);
  document.getElementById('evMultiDay').checked = hasEndDate;
  document.getElementById('evEndDate').value = ev.endDate || '';
  document.getElementById('endDateRow').classList.toggle('visible', hasEndDate);
  renderTasksList();
  renderAttachList();
  renderPeoplePanel();
  renderAttendeeChips();
  renderAttendeeSelect();
  renderGroupSelect(ev.groupId||null);
  resetRecurrenceUI(ev.recurrence||null);
  renderParentSelect(ev.parentId||null, id);
  renderSubeventsPanel(id);
  document.getElementById('newTaskRow').style.display='none';
  document.getElementById('peopleSection').classList.remove('open');
  document.getElementById('addLinkForm').classList.remove('open');
  document.getElementById('fileDropZone').classList.remove('open');
  document.getElementById('detailModalOverlay').classList.remove('open');
  document.getElementById('eventModalOverlay').classList.add('open');
}

function closeEventModal() { document.getElementById('eventModalOverlay').classList.remove('open'); }

document.getElementById('eventModalClose').onclick = closeEventModal;
document.getElementById('eventCancelBtn').onclick = closeEventModal;
document.getElementById('eventModalOverlay').onclick = (e) => { if (e.target.id==='eventModalOverlay') closeEventModal(); };
document.getElementById('addEventBtn').onclick = () => openAddModal();
// FAB menu (mobile)
(function() {
  const fab = document.getElementById('mobileFab');
  const menu = document.getElementById('fabMenu');
  const backdrop = document.getElementById('fabBackdrop');
  if (!fab) return;

  function toggleFab() {
    const open = menu.classList.toggle('open');
    backdrop.classList.toggle('open', open);
    fab.classList.toggle('open', open);
  }
  function closeFab() {
    menu.classList.remove('open');
    backdrop.classList.remove('open');
    fab.classList.remove('open');
  }

  fab.onclick = toggleFab;
  backdrop.onclick = closeFab;

  document.getElementById('fabNewEvent').onclick = () => { closeFab(); openAddModal(); };
  document.getElementById('fabMondayTopic').onclick = () => { closeFab(); openMondayTopicSheet(); };

  const topicOverlay = document.getElementById('mondayTopicOverlay');
  const topicSheet = document.getElementById('mondayTopicSheet');
  const topicClose = document.getElementById('mondayTopicClose');
  const topicInput = document.getElementById('mondayTopicInput');
  const topicSubmit = document.getElementById('mondayTopicSubmit');

  function openMondayTopicSheet() {
    topicOverlay.style.display = 'block';
    topicOverlay.classList.add('open');
    topicSheet.classList.add('open');
    topicInput.value = '';
    setTimeout(() => topicInput.focus(), 350);
  }
  function closeMondayTopicSheet() {
    topicOverlay.style.display = '';
    topicOverlay.classList.remove('open');
    topicSheet.classList.remove('open');
  }

  topicClose.onclick = closeMondayTopicSheet;
  topicOverlay.onclick = closeMondayTopicSheet;

  topicSubmit.onclick = () => {
    const text = topicInput.value.trim();
    if (!text) { topicInput.focus(); return; }
    const name = getMondayName() || (AUTH ? AUTH.email.split('@')[0] : 'Someone');
    const note = { id: uid(), text, createdBy: name, createdAt: new Date().toISOString(), carriedOver: 0 };
    saveMondayNotes([...loadMondayNotes(), note]);
    closeMondayTopicSheet();
  };

  topicInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') topicSubmit.click();
  });
})();

// Mobile sidebar toggle (desktop) / Up Next sheet (mobile)
(function() {
  const menuBtn = document.getElementById('mobileMenuBtn');
  const sidebar = document.getElementById('sidebar');
  const sidebarOverlay = document.getElementById('mobileSidebarOverlay');

  function openSidebar() {
    sidebar.classList.add('mobile-open');
    sidebarOverlay.classList.add('open');
  }
  function closeSidebar() {
    sidebar.classList.remove('mobile-open');
    sidebarOverlay.classList.remove('open');
  }

  const upNextOverlay = document.getElementById('mobileUpNextOverlay');
  const upNextSheet = document.getElementById('mobileUpNextSheet');
  const upNextClose = document.getElementById('mobileUpNextClose');

  function openUpNext() {
    renderMobileUpNext();
    upNextOverlay.classList.add('open');
    upNextOverlay.style.display = 'block';
    upNextSheet.classList.add('open');
  }
  function closeUpNext() {
    upNextOverlay.classList.remove('open');
    upNextOverlay.style.display = '';
    upNextSheet.classList.remove('open');
  }

  menuBtn.onclick = () => {
    if (window.innerWidth <= 768) {
      upNextSheet.classList.contains('open') ? closeUpNext() : openUpNext();
    } else {
      sidebar.classList.contains('mobile-open') ? closeSidebar() : openSidebar();
    }
  };
  sidebarOverlay.onclick = closeSidebar;
  upNextOverlay.onclick = closeUpNext;
  upNextClose.onclick = closeUpNext;

  window._closeMobileUpNext = closeUpNext;

  document.querySelectorAll('.view-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      if (window.innerWidth <= 768) closeSidebar();
    });
  });
})();

// Mobile Groups Menu
(function() {
  const btn = document.getElementById('mobileGroupsBtn');
  const overlay = document.getElementById('mobileGroupsOverlay');
  const sheet = document.getElementById('mobileGroupsSheet');
  const closeBtn = document.getElementById('mobileGroupsClose');

  function openMenu() {
    renderMobileGroupsMenu();
    overlay.classList.add('open');
    overlay.style.display = 'block';
    sheet.classList.add('open');
  }
  function closeMenu() {
    overlay.classList.remove('open');
    overlay.style.display = '';
    sheet.classList.remove('open');
  }
  btn.onclick = openMenu;
  closeBtn.onclick = closeMenu;
  overlay.onclick = closeMenu;

  window._openMobileGroupsMenu = openMenu;
  window._closeMobileGroupsMenu = closeMenu;
})();

function renderMobileUpNext() {
  const todayStr = isoDate(new Date());
  const upNextEl = document.getElementById('mobileUpNext');
  upNextEl.innerHTML = '';
  const upcoming = state.events
    .filter(e => e.date >= todayStr && eventIsVisible(e))
    .sort((a,b) => a.date.localeCompare(b.date) || (a.start||'').localeCompare(b.start||''))
    .slice(0, 6);
  if (!upcoming.length) {
    upNextEl.innerHTML = '<div class="mgs-upnext-empty">No upcoming events</div>';
  } else {
    upcoming.forEach(ev => {
      const g = ev.groupId ? getGroupById(ev.groupId) : null;
      const color = ev.color || (g ? g.color : 'var(--kraken-teal)');
      const item = document.createElement('div');
      item.className = 'mgs-upnext-item';
      const timeStr = ev.allDay ? 'All Day' : (ev.start ? fmtTime(ev.start) : '');
      const dateLabel = ev.date === todayStr ? 'Today' : fmtDate(ev.date);
      item.innerHTML = `<div class="mgs-upnext-dot" style="background:${color}"></div><div class="mgs-upnext-info"><div class="mgs-upnext-title">${ev.title}</div><div class="mgs-upnext-meta">${dateLabel}${timeStr ? ' · ' + timeStr : ''}</div></div>`;
      item.onclick = () => { window._closeMobileUpNext(); openDetail(ev.id); };
      upNextEl.appendChild(item);
    });
  }
}

function renderMobileGroupsMenu() {
  const groups = loadGroups();
  const grid = document.getElementById('mobileGroupsGrid');
  grid.innerHTML = '';

  if (!groups.length) {
    grid.innerHTML = '<div class="mgs-empty">No topic groups yet.<br>Open the sidebar to create groups.</div>';
  } else {
    groups.forEach(g => {
      const evCount = state.events.filter(e => e.groupId === g.id).length;
      const card = document.createElement('div');
      card.className = 'mgs-group-card';
      card.innerHTML = `<div class="mgs-group-bar" style="background:${g.color}"></div><div class="mgs-group-name">${g.name}</div><div class="mgs-group-count">${evCount} event${evCount !== 1 ? 's' : ''}</div>`;
      card.onclick = () => { window._closeMobileGroupsMenu(); openGroupPage(g.id); };
      grid.appendChild(card);
    });
  }

  const viewsEl = document.getElementById('mobileGroupsViews');
  viewsEl.innerHTML = '';
  [{l:'List',v:'list'},{l:'Month',v:'month'},{l:'Week',v:'week'},{l:'Day',v:'day'}].forEach(x => {
    const b = document.createElement('button');
    b.className = 'mgs-view-btn' + (state.view === x.v ? ' active' : '');
    b.textContent = x.l;
    b.onclick = () => {
      state.view = x.v;
      document.querySelectorAll('.view-tab').forEach(t => t.classList.toggle('active', t.dataset.view === x.v));
      window._closeMobileGroupsMenu();
      render();
    };
    viewsEl.appendChild(b);
  });

  const actionsEl = document.getElementById('mobileGroupsActions');
  actionsEl.innerHTML = '';
  const isDark = !document.body.classList.contains('light-mode');
  const actionDefs = [
    { icon: '📌', label: 'Today', fn: () => { state.date = new Date(); window._closeMobileGroupsMenu(); render(); }},
    { icon: isDark ? '☀️' : '🌙', label: isDark ? 'Light' : 'Dark', fn: () => {
      document.getElementById('themeToggle').click();
      window._closeMobileGroupsMenu();
    }},
    { icon: '＋', label: 'New Event', fn: () => { window._closeMobileGroupsMenu(); openAddModal(); }},
    { icon: '👤', label: 'Sign Out', fn: () => { window._closeMobileGroupsMenu(); document.getElementById('signOutBtn').click(); }},
  ];
  actionDefs.forEach(a => {
    const b = document.createElement('button');
    b.className = 'mgs-action-btn';
    b.innerHTML = `<span class="mgs-action-icon">${a.icon}</span>${a.label}`;
    b.onclick = a.fn;
    actionsEl.appendChild(b);
  });
}

// Theme toggle — light/dark mode. First visit follows the OS
// preference; the toggle saves an explicit choice after that.
(function() {
  const btn = document.getElementById('themeToggle');
  const meta = document.querySelector('meta[name=theme-color]');
  const apply = (light, persist = true) => {
    document.body.classList.toggle('light-mode', light);
    btn.textContent = light ? '🌙' : '☀️';
    btn.title = light ? 'Switch to dark mode' : 'Switch to light mode';
    if (meta) meta.content = light ? '#F4FAFB' : '#0A1F33';
    if (persist) localStorage.setItem('krakenTheme', light ? 'light' : 'dark');
  };
  const saved = localStorage.getItem('krakenTheme');
  const osLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  apply(saved ? saved === 'light' : osLight, false);
  // Follow OS changes until the user picks a theme explicitly
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', e => {
      if (!localStorage.getItem('krakenTheme')) apply(e.matches, false);
    });
  }
  btn.onclick = () => apply(!document.body.classList.contains('light-mode'));
})();

document.getElementById('eventSaveBtn').onclick = () => {
  const title = document.getElementById('evTitle').value.trim();
  if (!title) { document.getElementById('evTitle').focus(); return; }
  const selectedParent = document.getElementById('parentSelect').value || null;
  const ev = {
    id: state.editingId || uid(),
    title,
    date: document.getElementById('evDate').value,
    start: document.getElementById('evStart').value,
    end: document.getElementById('evEnd').value,
    location: document.getElementById('evLocation').value.trim(),
    desc: document.getElementById('evDesc').value.trim(),
    color: document.getElementById('evColor').value,
    allDay: document.getElementById('evAllDay').checked,
    endDate: document.getElementById('evMultiDay').checked ? (document.getElementById('evEndDate').value || null) : null,
    tasks: JSON.parse(JSON.stringify(currentTasks)),
    attachments: JSON.parse(JSON.stringify(currentAttachments)),
    attendees: JSON.parse(JSON.stringify(currentAttendees)),
    parentId: selectedParent,
    groupId: document.getElementById('groupSelect').value || null,
    recurrence: {
      freq: document.getElementById('recurFreq').value,
      interval: parseInt(document.getElementById('recurInterval').value) || 1,
      days: Array.from(document.querySelectorAll('.recurrence-day-btn.active')).map(b => parseInt(b.dataset.day)),
      endDate: document.getElementById('recurEnd').value || null,
    },
  };
  if (state.editingId) {
    const idx = state.events.findIndex(e=>e.id===state.editingId);
    if (idx>=0) state.events[idx] = ev;
  } else {
    state.events.push(ev);
  }
  save(); closeEventModal();
  render();
  // refresh group page if open
  if (currentGroupPageId) {
    const g = getGroupById(currentGroupPageId);
    if (g) renderGroupPageBody(g);
  }
};

// ============================================================
// TASKS
// ============================================================
// ============================================================
// PEOPLE PANEL
// ============================================================
const AVATAR_COLORS = ['#00B2A9','#FF6B6B','#FFB84D','#7FCECD','#A78BFA','#34D399','#F472B6','#60A5FA'];
function avatarColor(name) {
  let h = 0; for (let c of name) h = (h*31+c.charCodeAt(0))&0xFFFFFF;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}
function initials(name) { return name.trim().split(/\s+/).map(w=>w[0].toUpperCase()).slice(0,2).join(''); }

function savePeople() {
  _localPeople = JSON.parse(JSON.stringify(currentPeople));
  db.set('krakenPeople', currentPeople);
}

function renderPeoplePanel() {
  currentPeople = _localPeople.length ? JSON.parse(JSON.stringify(_localPeople)) : [];
  const list = document.getElementById('peopleList');
  list.innerHTML = '';
  currentPeople.forEach((p, i) => {
    const chip = document.createElement('div');
    chip.className = 'person-chip';
    const av = document.createElement('div');
    av.className = 'assignee-avatar';
    av.style.background = avatarColor(p.name);
    av.textContent = initials(p.name);
    const nm = document.createElement('span'); nm.textContent = p.name;
    const del = document.createElement('button'); del.textContent = '✕';
    del.title = `Remove ${p.name}`;
    del.onclick = () => {
      currentTasks.forEach(t => { if (t.assignee === p.name) t.assignee = ''; });
      currentAttendees = currentAttendees.filter(n => n !== p.name);
      currentPeople.splice(i, 1);
      savePeople(); renderPeoplePanel(); renderTasksList(); renderAttendeeChips(); renderAttendeeSelect();
      renderSidebar(); // keep sidebar in sync
    };
    chip.appendChild(av); chip.appendChild(nm); chip.appendChild(del);
    list.appendChild(chip);
  });
}

document.getElementById('managePeopleBtn').onclick = () => {
  document.getElementById('peopleSection').classList.toggle('open');
};
document.getElementById('savePersonBtn').onclick = addPerson;
document.getElementById('newPersonInput').onkeydown = (e) => { if (e.key==='Enter') addPerson(); };
function addPerson() {
  const name = document.getElementById('newPersonInput').value.trim();
  if (!name || currentPeople.find(p=>p.name.toLowerCase()===name.toLowerCase())) return;
  currentPeople.push({id: uid(), name});
  document.getElementById('newPersonInput').value = '';
  savePeople(); renderPeoplePanel(); renderTasksList(); renderAttendeeSelect(); renderSidebar();
}

// ============================================================
// TASKS
// ============================================================
function taskIsOverdue(t) {
  if (!t.dueDate || t.done) return false;
  const due = new Date(t.dueDate + 'T23:59:59');
  return due < new Date();
}

function renderTasksList() {
  const list = document.getElementById('tasksList');
  list.innerHTML = '';
  currentTasks.forEach((t, i) => {
    const overdue = taskIsOverdue(t);
    const item = document.createElement('div');
    item.className = 'task-item' + (overdue ? ' overdue' : '');

    // top row: checkbox + text + delete
    const topRow = document.createElement('div');
    topRow.className = 'task-top-row';

    const check = document.createElement('div');
    check.className = 'task-check' + (t.done?' done':'');
    check.onclick = () => { t.done = !t.done; renderTasksList(); };

    const text = document.createElement('div');
    text.className = 'task-text' + (t.done?' done':'');
    text.textContent = t.text;

    const del = document.createElement('button');
    del.className = 'task-del'; del.textContent = '✕';
    del.onclick = () => { currentTasks.splice(i,1); renderTasksList(); };

    topRow.appendChild(check); topRow.appendChild(text); topRow.appendChild(del);
    item.appendChild(topRow);

    // meta row: due date + assignee
    const metaRow = document.createElement('div');
    metaRow.className = 'task-meta-row';

    // due date input
    const dueInput = document.createElement('input');
    dueInput.type = 'date'; dueInput.title = 'Due date';
    dueInput.value = t.dueDate || '';
    dueInput.onchange = () => { t.dueDate = dueInput.value; renderTasksList(); };

    // assignee select
    const assignSel = document.createElement('select');
    assignSel.style.cssText = 'flex:1;min-width:90px;padding:4px 8px;font-size:16px;border-radius:6px;background:rgba(0,0,0,0.3);border:1px solid var(--border-bright);color:var(--silver-ice);';
    const blankOpt = document.createElement('option');
    blankOpt.value = ''; blankOpt.textContent = '— Assign to —';
    assignSel.appendChild(blankOpt);
    currentPeople.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.name; opt.textContent = p.name;
      if (t.assignee === p.name) opt.selected = true;
      assignSel.appendChild(opt);
    });
    assignSel.onchange = () => { t.assignee = assignSel.value; renderTasksList(); };

    metaRow.appendChild(dueInput);
    metaRow.appendChild(assignSel);

    // show badges if set
    if (t.dueDate) {
      const dueBadge = document.createElement('span');
      dueBadge.className = 'task-due';
      const dLabel = overdue ? '⚠ ' : '📅 ';
      const dt = new Date(t.dueDate + 'T00:00:00');
      dueBadge.textContent = dLabel + `${MONTHS[dt.getMonth()].slice(0,3)} ${dt.getDate()}`;
      if (overdue) dueBadge.style.color = 'var(--danger-ink)';
      // already shown via input — skip duplicate text badge in compact form
    }

    if (t.assignee) {
      const badge = document.createElement('div');
      badge.className = 'task-assignee-badge';
      const av = document.createElement('div');
      av.className = 'assignee-avatar';
      av.style.background = avatarColor(t.assignee);
      av.textContent = initials(t.assignee);
      badge.appendChild(av);
      badge.appendChild(document.createTextNode(t.assignee));
      // shown via select — keep for visual flair below inputs
    }

    item.appendChild(metaRow);
    list.appendChild(item);
  });
}

document.getElementById('addTaskBtn').onclick = () => {
  document.getElementById('newTaskRow').style.display='flex';
  document.getElementById('newTaskInput').focus();
};
document.getElementById('saveTaskBtn').onclick = addTask;
document.getElementById('newTaskInput').onkeydown = (e) => { if (e.key==='Enter') addTask(); };
function addTask() {
  const val = document.getElementById('newTaskInput').value.trim();
  if (!val) return;
  currentTasks.push({id:uid(), text:val, done:false, dueDate:'', assignee:''});
  document.getElementById('newTaskInput').value = '';
  renderTasksList();
}


// ============================================================
// PARENT / SUB-EVENTS
// ============================================================
function renderParentSelect(currentParentId, selfId) {
  const sel = document.getElementById('parentSelect');
  sel.innerHTML = '<option value="">— Standalone event —</option>';
  // Only top-level events that aren't self can be parents
  getParentEvents().forEach(ev => {
    if (ev.id === selfId) return; // can't be own parent
    const opt = document.createElement('option');
    opt.value = ev.id;
    const dt = new Date(ev.date + 'T00:00:00');
    opt.textContent = `${ev.title} (${MONTHS[dt.getMonth()].slice(0,3)} ${dt.getDate()})`;
    if (ev.id === currentParentId) opt.selected = true;
    sel.appendChild(opt);
  });
}

function renderSubeventsPanel(selfId) {
  const section = document.getElementById('subeventsSection');
  const list = document.getElementById('subeventsList');
  if (!selfId) { section.style.display = 'none'; return; }
  const subs = getSubEvents(selfId);
  section.style.display = 'block';
  list.innerHTML = '';
  if (!subs.length) {
    list.innerHTML = '<div style="font-size:16px;color:var(--text-dim);padding:4px 0">No sub-events yet. Click "+ Add Sub-Event" to create one.</div>';
    return;
  }
  subs.forEach(sub => {
    const item = document.createElement('div');
    item.className = 'subevent-item';
    item.style.borderLeftColor = sub.color || 'var(--kraken-teal)';

    const titleEl = document.createElement('div');
    titleEl.className = 'subevent-title';
    titleEl.textContent = sub.title;

    const dateEl = document.createElement('div');
    dateEl.className = 'subevent-date';
    const dt = new Date(sub.date + 'T00:00:00');
    dateEl.textContent = `${MONTHS[dt.getMonth()].slice(0,3)} ${dt.getDate()}${!sub.allDay?' · '+fmtTime(sub.start):''}`;

    const openBtn = document.createElement('button');
    openBtn.className = 'subevent-open';
    openBtn.textContent = 'Edit ↗';
    openBtn.onclick = (e) => { e.stopPropagation(); closeEventModal(); openEditModal(sub.id); };

    item.appendChild(titleEl); item.appendChild(dateEl); item.appendChild(openBtn);
    item.onclick = (e) => { if (e.target !== openBtn) { closeEventModal(); openDetail(sub.id); } };
    list.appendChild(item);
  });
}

document.getElementById('clearParentBtn').onclick = () => {
  document.getElementById('parentSelect').value = '';
};

document.getElementById('addSubeventBtn').onclick = () => {
  const parentId = state.editingId;
  if (!parentId) return;
  // Pre-fill date from parent event's date; open a new event modal linked to this parent
  const parent = state.events.find(e => e.id === parentId);
  closeEventModal();
  // Small delay to let modal close first
  setTimeout(() => {
    openAddModal(parent ? parent.date : null);
    // Pre-select this parent in the new modal
    setTimeout(() => {
      const sel = document.getElementById('parentSelect');
      if (sel) sel.value = parentId;
    }, 50);
  }, 50);
};

// ============================================================
// ATTACHMENTS
// ============================================================
function fileIcon(type) {
  if (!type) return '🔗';
  if (type.startsWith('image/')) return '🖼️';
  if (type === 'application/pdf') return '📄';
  if (type.includes('word') || type.includes('document')) return '📝';
  if (type.includes('sheet') || type.includes('excel') || type.includes('csv')) return '📊';
  if (type.includes('presentation') || type.includes('powerpoint')) return '📑';
  if (type.startsWith('video/')) return '🎬';
  if (type.startsWith('audio/')) return '🎵';
  if (type.includes('zip') || type.includes('compressed')) return '🗜️';
  return '📎';
}

function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  return (b/1048576).toFixed(1) + ' MB';
}

function renderAttachList() {
  const list = document.getElementById('attachList');
  list.innerHTML = '';
  currentAttachments.forEach((a, i) => {
    const item = document.createElement('div');
    item.className = 'attach-item';

    const icon = document.createElement('div');
    icon.className = 'attach-icon';
    icon.textContent = a.type === 'link' ? '🔗' : fileIcon(a.mimeType);

    const info = document.createElement('div');
    info.className = 'attach-info';
    const name = document.createElement('div');
    name.className = 'attach-name';
    name.textContent = a.label || a.name || a.url;
    const sub = document.createElement('div');
    sub.className = 'attach-sub';
    sub.textContent = a.type === 'link' ? (a.url.length > 50 ? a.url.slice(0,50)+'…' : a.url) : fmtBytes(a.size||0);
    info.appendChild(name); info.appendChild(sub);

    const openBtn = document.createElement('button');
    openBtn.className = 'attach-open';
    openBtn.textContent = a.type === 'link' ? 'Open ↗' : 'Download';
    openBtn.onclick = () => {
      if (a.type === 'link') {
        let url = a.url;
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        window.open(url, '_blank', 'noopener');
      } else {
        const anchor = document.createElement('a');
        anchor.href = a.data;
        anchor.download = a.name;
        anchor.click();
      }
    };

    const del = document.createElement('button');
    del.className = 'attach-del'; del.textContent = '✕';
    del.onclick = () => { currentAttachments.splice(i,1); renderAttachList(); };

    item.appendChild(icon); item.appendChild(info); item.appendChild(openBtn); item.appendChild(del);
    list.appendChild(item);
  });
}

// Link form
document.getElementById('addLinkBtn').onclick = () => {
  document.getElementById('addLinkForm').classList.toggle('open');
  document.getElementById('fileDropZone').classList.remove('open');
  if (document.getElementById('addLinkForm').classList.contains('open')) {
    document.getElementById('linkLabel').value = '';
    document.getElementById('linkUrl').value = '';
    setTimeout(()=>document.getElementById('linkUrl').focus(), 50);
  }
};
document.getElementById('cancelLinkBtn').onclick = () => document.getElementById('addLinkForm').classList.remove('open');
document.getElementById('saveLinkBtn').onclick = saveLink;
document.getElementById('linkUrl').onkeydown = (e) => { if (e.key==='Enter') saveLink(); };
function saveLink() {
  const url = document.getElementById('linkUrl').value.trim();
  if (!url) { document.getElementById('linkUrl').focus(); return; }
  const label = document.getElementById('linkLabel').value.trim() || url;
  currentAttachments.push({id: uid(), type: 'link', label, url});
  document.getElementById('addLinkForm').classList.remove('open');
  renderAttachList();
}

// File input
document.getElementById('addFileBtn').onclick = () => {
  document.getElementById('fileDropZone').classList.toggle('open');
  document.getElementById('addLinkForm').classList.remove('open');
};
const dropZone = document.getElementById('fileDropZone');
dropZone.onclick = (e) => { if (e.target !== document.getElementById('fileInput')) document.getElementById('fileInput').click(); };
dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); };
dropZone.ondragleave = () => dropZone.classList.remove('drag-over');
dropZone.ondrop = (e) => {
  e.preventDefault(); dropZone.classList.remove('drag-over');
  handleFiles(e.dataTransfer.files);
};
document.getElementById('fileInput').onchange = (e) => handleFiles(e.target.files);

function handleFiles(files) {
  const MAX = 5 * 1024 * 1024;
  Array.from(files).forEach(file => {
    if (file.size > MAX) { alert(`"${file.name}" exceeds 5MB limit.`); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      currentAttachments.push({
        id: uid(), type: 'file', name: file.name,
        mimeType: file.type, size: file.size, data: e.target.result
      });
      renderAttachList();
    };
    reader.readAsDataURL(file);
  });
  document.getElementById('fileDropZone').classList.remove('open');
  document.getElementById('fileInput').value = '';
}

function openDetail(id) {
  closeDayPopup();
  const ev = state.events.find(e=>e.id===id);
  if (!ev) return;
  state.detailId = id;
  const content = document.getElementById('detailContent');
  const parent = getParent(ev);
  const subEvents = getSubEvents(ev.id);
  const attendees = ev.attendees || [];

  function buildAttachHTML(a) {
    const icon = a.type==='link' ? '🔗' : fileIcon(a.mimeType);
    const sub = a.type==='link' ? (a.url.length>50?a.url.slice(0,50)+'…':a.url) : fmtBytes(a.size||0);
    return `<div class="detail-attach-item" data-attach-id="${a.id}">
      <span style="font-size:22px">${icon}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:17px;color:var(--silver-ice);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${a.label||a.name||a.url}</div>
        <div style="font-size:15px;color:var(--text-dim)">${sub}</div>
      </div>
      <span style="font-size:16px;color:var(--kraken-teal);font-family:'Barlow Condensed',sans-serif;font-weight:700">${a.type==='link'?'Open ↗':'Download'}</span>
    </div>`;
  }

  function buildTaskHTML(t, idx) {
    const overdue = taskIsOverdue(t);
    let dueTxt = '';
    if (t.dueDate) {
      const dt = new Date(t.dueDate + 'T00:00:00');
      dueTxt = `<span style="font-size:15px;font-family:'Barlow Condensed',sans-serif;font-weight:700;color:${overdue?'var(--danger-ink)':'var(--gold-ink)'};">${overdue?'⚠':'📅'} ${MONTHS[dt.getMonth()].slice(0,3)} ${dt.getDate()}</span>`;
    }
    let assignTxt = '';
    if (t.assignee) {
      const col = avatarColor(t.assignee);
      const ini = initials(t.assignee);
      assignTxt = `<span class="task-assignee-badge"><span class="assignee-avatar" style="background:${col}">${ini}</span>${t.assignee}</span>`;
    }
    return `<div class="task-item${overdue?' overdue':''}">
      <div class="task-top-row">
        <div class="task-check${t.done?' done':''}" data-task-idx="${idx}" role="checkbox" aria-checked="${!!t.done}" tabindex="0" title="${t.done?'Mark incomplete':'Mark complete'}"></div>
        <div class="task-text${t.done?' done':''}">${t.text}</div>
      </div>
      ${(dueTxt||assignTxt)?`<div class="task-meta-row" style="padding-left:28px;gap:8px;flex-wrap:wrap">${dueTxt}${assignTxt}</div>`:''}
    </div>`;
  }

  // --- Logistics bar (compact, read-only) ---
  let logParts = [];
  logParts.push(`📅 ${fmtDate(ev.date)}${ev.endDate && ev.endDate > ev.date ? ' → '+fmtDate(ev.endDate) : ''}`);
  if (!ev.allDay) logParts.push(`${fmtTime(ev.start)} – ${fmtTime(ev.end)}`);
  else logParts.push('All Day');
  if (ev.recurrence && ev.recurrence.freq !== 'none') {
    const freqMap = {daily:'Daily',weekly:'Weekly',monthly:'Monthly',yearly:'Yearly'};
    const unitMap = {daily:'days',weekly:'weeks',monthly:'months',yearly:'years'};
    let r = '🔁 ' + freqMap[ev.recurrence.freq];
    if (ev.recurrence.interval > 1) r += ' every ' + ev.recurrence.interval + ' ' + unitMap[ev.recurrence.freq];
    logParts.push(r);
  }
  if (ev.location) logParts.push('📍 ' + ev.location);

  // --- Group badge ---
  const group = ev.groupId ? getGroupById(ev.groupId) : null;

  // --- Attendee avatars ---
  const attendeeAvatars = attendees.map(name =>
    `<div class="detail-attendee-av" style="background:${avatarColor(name)}" title="${name}" data-name="${name}">${initials(name)}</div>`
  ).join('');

  // Available people not yet attending
  const availablePeople = _localPeople.filter(p => !attendees.includes(p.name));

  content.innerHTML = `
    ${ev.parentId && parent ? `
      <div style="margin-bottom:6px">
        <span class="parent-badge" id="goToParentBtn" data-parent-id="${parent.id}">
          <span class="ev-ink" style="--ev-color:${parent.color||'var(--kraken-teal)'}">◈</span> ${parent.title}
          <span style="opacity:.6;font-size:14px;margin-left:2px">↗</span>
        </span>
      </div>` : ''}
    <input class="detail-title-input" id="detailTitleInput" value="${(ev.title||'').replace(/"/g,'&quot;')}" placeholder="Event title…">
    <div class="detail-logistics-bar">${logParts.join(' <span style="opacity:0.4">·</span> ')}</div>
    ${group ? `<div style="margin-bottom:12px"><span style="--ev-color:${group.color};background:${group.color}22;border:1px solid ${group.color}44;border-radius:5px;padding:2px 9px;font-size:15px;font-weight:700;cursor:pointer" class="gp-group-link ev-ink" data-gid="${group.id}">${group.name} ↗</span></div>` : ''}
    <div class="detail-attendee-row" style="position:relative">
      ${attendeeAvatars}
      <div class="detail-attendee-add" id="detailAttendeeAdd" title="Add attendee">+</div>
      <div class="detail-attendee-dropdown" id="detailAttendeeDropdown" style="display:none">
        ${availablePeople.length ? availablePeople.map(p =>
          `<div class="detail-attendee-dropdown-item" data-name="${p.name}">
            <span class="assignee-avatar" style="background:${avatarColor(p.name)};width:22px;height:22px;font-size:12px;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;font-weight:800;color:var(--deep-sea)">${initials(p.name)}</span>
            ${p.name}
          </div>`
        ).join('') : '<div style="padding:8px 10px;font-size:14px;color:var(--text-dim)">No people available</div>'}
      </div>
    </div>
    <textarea class="detail-desc-textarea" id="detailDescInput" placeholder="Notes, agenda, details…" rows="3">${(ev.desc||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</textarea>

    ${subEvents.length?`
    <div class="detail-section-header" style="margin-top:6px">
      <span class="detail-section-label">📎 Sub-Events</span>
    </div>
    ${subEvents.map(sub=>{
      const subDt = new Date(sub.date+'T00:00:00');
      return `<div class="subevent-item" data-sub-id="${sub.id}" style="border-left-color:${sub.color||ev.color||'var(--kraken-teal)'}">
        <div class="subevent-title">${sub.title}</div>
        <div class="subevent-date">${MONTHS[subDt.getMonth()].slice(0,3)} ${subDt.getDate()}${!sub.allDay?' · '+fmtTime(sub.start):''}</div>
        <button class="subevent-open" data-sub-id="${sub.id}">View ↗</button>
      </div>`;
    }).join('')}`:''}

    <div class="detail-section-header" style="${subEvents.length?'':'margin-top:6px'}">
      <span class="detail-section-label">🎯 Tasks</span>
      <button class="detail-inline-btn" id="detailAddTaskToggle">+ Add</button>
    </div>
    <div id="detailTasksList">
      ${(ev.tasks||[]).map((t,i)=>buildTaskHTML(t,i)).join('')}
    </div>
    <div class="detail-add-task-row" id="detailAddTaskRow" style="display:none">
      <input type="text" id="detailNewTaskInput" placeholder="Task description…">
      <button id="detailSaveTaskBtn">Add</button>
    </div>

    <div class="detail-section-header">
      <span class="detail-section-label">🔗 Links & Files</span>
      <div style="display:flex;gap:4px">
        <button class="detail-inline-btn" id="detailAddLinkToggle">+ Link</button>
        <button class="detail-inline-btn" id="detailAddFileToggle">+ File</button>
      </div>
    </div>
    <div id="detailAttachList">
      ${(ev.attachments||[]).map(a=>buildAttachHTML(a)).join('')}
    </div>
    <div class="detail-add-link-row" id="detailAddLinkRow" style="display:none">
      <input type="text" id="detailLinkLabel" placeholder="Label">
      <input type="text" id="detailLinkUrl" placeholder="https://…">
      <button id="detailSaveLinkBtn">Add</button>
    </div>
    <div class="detail-file-drop" id="detailFileDrop" style="display:none">
      <div>Drop file or <strong>click to browse</strong></div>
      <input type="file" id="detailFileInput" multiple>
    </div>
  `;

  // --- Wire up inline title save ---
  const titleInput = content.querySelector('#detailTitleInput');
  titleInput.onblur = () => {
    const v = titleInput.value.trim();
    if (v && v !== ev.title) { ev.title = v; save(); render(); }
  };
  titleInput.onkeydown = (e) => { if (e.key === 'Enter') titleInput.blur(); };

  // --- Wire up inline description save ---
  const descInput = content.querySelector('#detailDescInput');
  descInput.onblur = () => {
    const v = descInput.value.trim();
    if (v !== (ev.desc||'')) { ev.desc = v; save(); }
  };

  // --- Wire up attendees ---
  const addBtn = content.querySelector('#detailAttendeeAdd');
  const dropdown = content.querySelector('#detailAttendeeDropdown');
  addBtn.onclick = (e) => { e.stopPropagation(); dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none'; };
  document.addEventListener('click', function closeDD(e) {
    if (!dropdown.contains(e.target) && e.target !== addBtn) { dropdown.style.display = 'none'; document.removeEventListener('click', closeDD); }
  });
  content.querySelectorAll('.detail-attendee-dropdown-item').forEach(el => {
    el.onclick = () => {
      if (!ev.attendees) ev.attendees = [];
      ev.attendees.push(el.dataset.name);
      save(); render(); openDetail(ev.id);
    };
  });
  content.querySelectorAll('.detail-attendee-av').forEach(el => {
    el.onclick = () => {
      ev.attendees = (ev.attendees||[]).filter(n => n !== el.dataset.name);
      save(); render(); openDetail(ev.id);
    };
  });

  // --- Wire up go-to-parent ---
  const parentBtn = content.querySelector('#goToParentBtn');
  if (parentBtn) parentBtn.onclick = () => { document.getElementById('detailModalOverlay').classList.remove('open'); openDetail(parentBtn.dataset.parentId); };

  // --- Wire up group link ---
  content.querySelectorAll('.gp-group-link').forEach(el => {
    el.onclick = () => { document.getElementById('detailModalOverlay').classList.remove('open'); openGroupPage(el.dataset.gid); };
  });

  // --- Wire up sub-event view buttons ---
  content.querySelectorAll('[data-sub-id]').forEach(el => {
    el.onclick = (e) => { e.stopPropagation(); document.getElementById('detailModalOverlay').classList.remove('open'); openDetail(el.dataset.subId); };
  });

  // --- Wire up task checkboxes ---
  content.querySelectorAll('.task-check[data-task-idx]').forEach(el => {
    const toggle = (e) => {
      e.stopPropagation();
      const t = (ev.tasks || [])[parseInt(el.dataset.taskIdx)];
      if (!t) return;
      t.done = !t.done;
      save(); render(); openDetail(ev.id);
    };
    el.onclick = toggle;
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); } };
  });

  // --- Wire up inline add task ---
  const addTaskRow = content.querySelector('#detailAddTaskRow');
  content.querySelector('#detailAddTaskToggle').onclick = () => {
    addTaskRow.style.display = addTaskRow.style.display === 'none' ? 'flex' : 'none';
    if (addTaskRow.style.display === 'flex') content.querySelector('#detailNewTaskInput').focus();
  };
  const saveTask = () => {
    const inp = content.querySelector('#detailNewTaskInput');
    const text = inp.value.trim();
    if (!text) return;
    if (!ev.tasks) ev.tasks = [];
    ev.tasks.push({ id: uid(), text, done: false, dueDate: '', assignee: '' });
    save(); render(); openDetail(ev.id);
  };
  content.querySelector('#detailSaveTaskBtn').onclick = saveTask;
  content.querySelector('#detailNewTaskInput').onkeydown = (e) => { if (e.key === 'Enter') saveTask(); };

  // --- Wire up inline add link ---
  const addLinkRow = content.querySelector('#detailAddLinkRow');
  content.querySelector('#detailAddLinkToggle').onclick = () => {
    addLinkRow.style.display = addLinkRow.style.display === 'none' ? 'flex' : 'none';
    content.querySelector('#detailFileDrop').style.display = 'none';
    if (addLinkRow.style.display === 'flex') content.querySelector('#detailLinkLabel').focus();
  };
  content.querySelector('#detailSaveLinkBtn').onclick = () => {
    const label = content.querySelector('#detailLinkLabel').value.trim();
    const url = content.querySelector('#detailLinkUrl').value.trim();
    if (!url) return;
    if (!ev.attachments) ev.attachments = [];
    ev.attachments.push({ id: uid(), type: 'link', label: label || url, url });
    save(); render(); openDetail(ev.id);
  };

  // --- Wire up inline add file ---
  const fileDrop = content.querySelector('#detailFileDrop');
  const fileInput = content.querySelector('#detailFileInput');
  content.querySelector('#detailAddFileToggle').onclick = () => {
    fileDrop.style.display = fileDrop.style.display === 'none' ? 'block' : 'none';
    addLinkRow.style.display = 'none';
  };
  fileDrop.onclick = () => fileInput.click();
  fileInput.onchange = () => {
    if (!ev.attachments) ev.attachments = [];
    Array.from(fileInput.files).forEach(f => {
      if (f.size > 5*1024*1024) return;
      const reader = new FileReader();
      reader.onload = () => {
        ev.attachments.push({ id: uid(), type: 'file', name: f.name, mimeType: f.type, size: f.size, data: reader.result });
        save(); render(); openDetail(ev.id);
      };
      reader.readAsDataURL(f);
    });
  };

  // --- Wire up attachment clicks ---
  content.querySelectorAll('.detail-attach-item').forEach(el => {
    el.onclick = () => {
      const a = (ev.attachments||[]).find(x=>x.id===el.dataset.attachId);
      if (!a) return;
      if (a.type==='link') {
        let url = a.url; if (!/^https?:\/\//i.test(url)) url='https://'+url;
        window.open(url,'_blank','noopener');
      } else {
        const anchor = document.createElement('a');
        anchor.href = a.data; anchor.download = a.name; anchor.click();
      }
    };
  });

  document.getElementById('detailModalOverlay').classList.add('open');
}

document.getElementById('detailClose').onclick = () => {
  document.getElementById('detailDeleteConfirm').style.display = 'none';
  document.getElementById('detailModalOverlay').classList.remove('open');
};
document.getElementById('detailModalOverlay').onclick = (e) => {
  if (e.target.id==='detailModalOverlay') {
    document.getElementById('detailDeleteConfirm').style.display = 'none';
    document.getElementById('detailModalOverlay').classList.remove('open');
  }
};
document.getElementById('detailEditBtn').onclick = () => openEditModal(state.detailId);
document.getElementById('detailDeleteBtn').onclick = () => {
  document.getElementById('detailDeleteConfirm').style.display = 'block';
};

document.getElementById('detailDeleteNo').onclick = () => {
  document.getElementById('detailDeleteConfirm').style.display = 'none';
};

document.getElementById('detailDeleteYes').onclick = () => {
  const id = state.detailId;
  state.events.forEach(e => { if (e.parentId === id) e.parentId = null; });
  state.events = state.events.filter(e => e.id !== id);
  save();
  document.getElementById('detailDeleteConfirm').style.display = 'none';
  document.getElementById('detailModalOverlay').classList.remove('open');
  render();
};

// ============================================================
// TOPIC GROUPS — core
// ============================================================
function renderSidebarGroups() {
  const groups = loadGroups();
  const list = document.getElementById('sidebarGroupsList');
  list.innerHTML = '';
  if (!groups.length) {
    list.innerHTML = '<div style="font-size:15px;color:var(--text-dim);padding:4px 2px;line-height:1.5">Click "+ New" to create a topic group.</div>';
    return;
  }
  groups.forEach(g => {
    const hidden = state.hiddenGroups.includes(g.id);
    const evCount = state.events.filter(e => e.groupId === g.id).length;

    const row = document.createElement('div');
    row.className = 'group-row' + (hidden ? ' hidden-group' : '');
    row.title = `Open ${g.name} page`;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');

    // Color swatch — clicking opens an inline color picker.
    // Hidden groups render hollow: an outline in the group color, no fill.
    const swatch = document.createElement('div');
    swatch.className = 'group-swatch';
    swatch.title = 'Click to change color';
    if (hidden) {
      swatch.style.background = 'transparent';
      swatch.style.border = `2px solid ${g.color}`;
    } else {
      swatch.style.background = g.color;
    }

    swatch.onmouseenter = () => {
      swatch.style.transform = 'scale(1.12)';
      swatch.style.boxShadow = `0 0 0 3px ${g.color}33`;
    };
    swatch.onmouseleave = () => {
      swatch.style.transform = '';
      swatch.style.boxShadow = '';
    };
    swatch.onclick = (e) => {
      e.stopPropagation();
      const globalPicker = document.getElementById('groupColorPickerGlobal');
      globalPicker.value = g.color;
      // Remove old listeners
      const fresh = globalPicker.cloneNode();
      globalPicker.parentNode.replaceChild(fresh, globalPicker);
      fresh.id = 'groupColorPickerGlobal';
      // Position near the clicked swatch
      const rect = swatch.getBoundingClientRect();
      fresh.style.cssText = `position:fixed;width:0;height:0;opacity:0;pointer-events:none;top:${rect.bottom}px;left:${rect.left}px;`;
      fresh.oninput = () => {
        if (hidden) swatch.style.borderColor = fresh.value;
        else swatch.style.background = fresh.value;
      };
      fresh.onchange = () => {
        const gs = loadGroups();
        const idx = gs.findIndex(x => x.id === g.id);
        if (idx >= 0) { gs[idx].color = fresh.value; g.color = fresh.value; saveGroups(gs); }
        if (currentGroupPageId === g.id) {
          document.getElementById('groupPageSwatch').style.background = fresh.value;
          document.getElementById('groupPageSwatch').style.boxShadow = `0 0 12px ${fresh.value}88`;
        }
        render();
      };
      fresh.click();
    };

    const nm = document.createElement('div');
    nm.className = 'group-row-name';
    nm.textContent = g.name;

    // Right-hand slot: count badge at rest, actions revealed on hover
    const end = document.createElement('div');
    end.className = 'group-row-end';

    const countEl = document.createElement('div');
    countEl.className = 'group-row-count' + (evCount ? '' : ' zero');
    countEl.textContent = evCount;
    countEl.title = `${evCount} event${evCount === 1 ? '' : 's'} on the calendar`;

    const actions = document.createElement('div');
    actions.className = 'group-row-actions';

    const eyeBtn = document.createElement('button');
    eyeBtn.className = 'group-action-btn view-btn';
    eyeBtn.title = hidden ? 'Show group' : 'Hide group';
    eyeBtn.setAttribute('aria-label', hidden ? `Show ${g.name} on calendar` : `Hide ${g.name} from calendar`);
    eyeBtn.setAttribute('aria-pressed', String(hidden));
    eyeBtn.textContent = hidden ? '👁' : '🙈';
    eyeBtn.onclick = (e) => {
      e.stopPropagation();
      if (hidden) state.hiddenGroups = state.hiddenGroups.filter(id => id !== g.id);
      else state.hiddenGroups.push(g.id);
      saveHiddenGroups(); render();
    };

    const menuBtn = document.createElement('button');
    menuBtn.className = 'group-action-btn menu-btn';
    menuBtn.title = 'Rename, recolor, or delete';
    menuBtn.setAttribute('aria-label', `Options for ${g.name}`);
    menuBtn.textContent = '⋯';
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      const rect = menuBtn.getBoundingClientRect();
      openGroupCtxMenu({ clientX: rect.left, clientY: rect.bottom + 4 }, g);
    };

    actions.appendChild(eyeBtn); actions.appendChild(menuBtn);
    end.appendChild(countEl); end.appendChild(actions);
    row.appendChild(swatch); row.appendChild(nm); row.appendChild(end);

    row.onclick = () => openGroupPage(g.id);
    row.onkeydown = (e) => {
      if (e.target !== row) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openGroupPage(g.id); }
    };
    row.oncontextmenu = (e) => { e.preventDefault(); openGroupCtxMenu(e, g); };
    list.appendChild(row);
  });
}

// ============================================================
// GROUP MANAGER MODAL
// ============================================================
document.getElementById('manageGroupsBtn').onclick = openGroupManager;
document.getElementById('groupManagerClose').onclick = () => document.getElementById('groupManagerOverlay').classList.remove('open');
document.getElementById('groupManagerOverlay').onclick = e => { if (e.target.id==='groupManagerOverlay') document.getElementById('groupManagerOverlay').classList.remove('open'); };

function openGroupManager() {
  renderGroupManagerList();
  document.getElementById('groupManagerOverlay').classList.add('open');
  setTimeout(() => document.getElementById('newGroupName').focus(), 100);
}

function renderGroupManagerList() {
  const groups = loadGroups();
  const list = document.getElementById('groupManagerList');
  list.innerHTML = '';
  if (!groups.length) {
    list.innerHTML = '<div style="font-size:16px;color:var(--text-dim);padding:8px 0 12px">No groups yet. Create one below.</div>';
    return;
  }
  groups.forEach((g, i) => {
    const evCount = state.events.filter(e => e.groupId === g.id).length;
    const item = document.createElement('div');
    item.className = 'group-list-item';

    const swatch = document.createElement('div');
    swatch.className = 'group-swatch-lg';
    swatch.style.background = g.color;
    swatch.title = 'Click to change color';
    // inline color picker on swatch click
    const colorPicker = document.createElement('input');
    colorPicker.type = 'color'; colorPicker.value = g.color;
    colorPicker.style.cssText = 'position:absolute;width:0;height:0;opacity:0;pointer-events:none';
    swatch.onclick = () => colorPicker.click();
    colorPicker.oninput = () => { swatch.style.background = colorPicker.value; };
    colorPicker.onchange = () => {
      const gs = loadGroups(); gs[i].color = colorPicker.value; saveGroups(gs);
      renderGroupManagerList(); renderSidebarGroups(); render();
    };
    item.appendChild(colorPicker);

    const nm = document.createElement('div');
    nm.className = 'group-item-name';
    nm.textContent = g.name;
    nm.contentEditable = true;
    nm.style.outline = 'none';
    nm.onblur = () => {
      const newName = nm.textContent.trim();
      if (newName && newName !== g.name) {
        const gs = loadGroups(); gs[i].name = newName; saveGroups(gs);
        renderSidebarGroups(); renderGroupSelect();
      }
    };

    const cnt = document.createElement('div');
    cnt.className = 'group-item-count';
    cnt.textContent = `${evCount} event${evCount!==1?'s':''}`;

    const del = document.createElement('button');
    del.className = 'group-item-del'; del.textContent = '🗑';
    del.title = 'Delete group (events keep their data)';
    del.onclick = () => {
      if (!confirm(`Delete group "${g.name}"? Events in this group will become ungrouped.`)) return;
      state.events.forEach(e => { if (e.groupId === g.id) e.groupId = null; });
      save();
      state.hiddenGroups = state.hiddenGroups.filter(id => id !== g.id);
      saveHiddenGroups();
      const gs = loadGroups(); gs.splice(i, 1); saveGroups(gs);
      renderGroupManagerList(); renderSidebarGroups(); render();
    };

    item.appendChild(swatch); item.appendChild(nm); item.appendChild(cnt); item.appendChild(del);
    list.appendChild(item);
  });
}

document.getElementById('saveGroupBtn').onclick = addGroup;
document.getElementById('newGroupName').onkeydown = e => { if (e.key==='Enter') addGroup(); };
function addGroup() {
  const name = document.getElementById('newGroupName').value.trim();
  const color = document.getElementById('newGroupColor').value;
  if (!name) { document.getElementById('newGroupName').focus(); return; }
  const groups = loadGroups();
  if (groups.find(g => g.name.toLowerCase() === name.toLowerCase())) return;
  groups.push({ id: uid(), name, color });
  saveGroups(groups);
  document.getElementById('newGroupName').value = '';
  document.getElementById('newGroupColor').value = '#00B2A9';
  renderGroupManagerList(); renderSidebarGroups(); renderGroupSelect();
}

// ============================================================
// GROUP SELECT in event modal
// ============================================================
function renderGroupSelect(currentGroupId) {
  const sel = document.getElementById('groupSelect');
  const groups = loadGroups();
  sel.innerHTML = '<option value="">— No group —</option>';
  groups.forEach(g => {
    const opt = document.createElement('option');
    opt.value = g.id; opt.textContent = g.name;
    if (g.id === currentGroupId) opt.selected = true;
    sel.appendChild(opt);
  });
  updateGroupBadge();
}

function updateGroupBadge() {
  const sel = document.getElementById('groupSelect');
  const badge = document.getElementById('groupSelectedBadge');
  const swatch = document.getElementById('groupSelectedSwatch');
  const nameEl = document.getElementById('groupSelectedName');
  if (sel.value) {
    const g = getGroupById(sel.value);
    if (g) {
      badge.classList.add('visible');
      swatch.style.background = g.color;
      nameEl.textContent = g.name;
    }
  } else {
    badge.classList.remove('visible');
  }
}

document.getElementById('groupSelect').onchange = updateGroupBadge;

// ============================================================
// GROUP PAGE
// ============================================================

function openGroupPage(groupId) {
  currentGroupPageId = groupId;
  const g = getGroupById(groupId);
  if (!g) return;

  document.getElementById('groupPageName').textContent = g.name;
  document.getElementById('groupPageSwatch').style.background = g.color;
  document.getElementById('groupPageSwatch').style.boxShadow = `0 0 12px ${g.color}88`;

  renderGroupPageBody(g);
  document.getElementById('groupPage').classList.add('open');
  window.scrollTo(0,0);
}

document.getElementById('groupPageBack').onclick = () => {
  document.getElementById('groupPage').classList.remove('open');
  currentGroupPageId = null;
};

function renderGroupPageBody(g) {
  const body = document.getElementById('groupPageBody');
  const today = isoDate(new Date());
  const allGroupEvents = state.events.filter(e => e.groupId === g.id)
    .sort((a,b) => a.date.localeCompare(b.date));
  const upcomingEvents = allGroupEvents.filter(e => e.date >= today);
  const pastEvents = allGroupEvents.filter(e => e.date < today).reverse(); // newest-first

  // collect all tasks from group events
  const allTasks = [];
  allGroupEvents.forEach(ev => {
    (ev.tasks||[]).forEach(t => allTasks.push({t, ev}));
  });
  const doneTasks = allTasks.filter(x => x.t.done).length;
  const overdueTasks = allTasks.filter(x => taskIsOverdue(x.t)).length;

  // Stats
  const statsHTML = `
    <div class="group-page-stats">
      <div class="gp-stat">
        <div class="gp-stat-num ev-ink" style="--ev-color:${g.color}">${allGroupEvents.length}</div>
        <div class="gp-stat-label">Total Events</div>
      </div>
      <div class="gp-stat">
        <div class="gp-stat-num ev-ink" style="--ev-color:${g.color}">${upcomingEvents.length}</div>
        <div class="gp-stat-label">Upcoming</div>
      </div>
      <div class="gp-stat">
        <div class="gp-stat-num ev-ink" style="--ev-color:${g.color}">${allTasks.length}</div>
        <div class="gp-stat-label">Total Tasks</div>
      </div>
      <div class="gp-stat">
        <div class="gp-stat-num ev-ink" style="--ev-color:${overdueTasks > 0 ? 'var(--danger)' : g.color}">${overdueTasks}</div>
        <div class="gp-stat-label">Overdue Tasks</div>
      </div>
      <div class="gp-stat">
        <div class="gp-stat-num ev-ink" style="--ev-color:${g.color}">${allTasks.length ? Math.round(doneTasks/allTasks.length*100) : 0}%</div>
        <div class="gp-stat-label">Tasks Done</div>
      </div>
    </div>`;

  body.innerHTML = statsHTML;

  // Helper to build an event card element
  function buildEventCard(ev) {
    const parent = getParent(ev);
    const subs = getSubEvents(ev.id);
    const card = document.createElement('div');
    card.className = 'gp-event-card';
    card.style.borderLeftColor = ev.color || g.color;
    card.style.borderColor = (ev.color||g.color)+'55';

    const dot = document.createElement('div');
    dot.className = 'gp-event-dot';
    dot.style.background = ev.color || g.color;

    const info = document.createElement('div');
    info.className = 'gp-event-info';

    const tasksDone = (ev.tasks||[]).filter(t=>t.done).length;
    const tasksTotal = (ev.tasks||[]).length;

    info.innerHTML = `
      <div class="gp-event-title">${ev.parentId && parent ? `<span style="opacity:.5;font-size:15px">↳ ${parent.title} / </span>`:''} ${ev.title}</div>
      <div class="gp-event-meta">
        <span>📅 ${fmtDate(ev.date)}</span>
        ${!ev.allDay?`<span>🕐 ${fmtTime(ev.start)} – ${fmtTime(ev.end)}</span>`:'<span>All Day</span>'}
        ${ev.location?`<span>📍 ${ev.location}</span>`:''}
        ${tasksTotal?`<span>🎯 ${tasksDone}/${tasksTotal} tasks</span>`:''}
        ${subs.length?`<span>📎 ${subs.length} sub-event${subs.length>1?'s':''}</span>`:''}
      </div>
      ${(ev.attendees||[]).length ? `
      <div class="gp-event-badges">
        ${(ev.attendees||[]).map(n=>`<span class="gp-badge">${n}</span>`).join('')}
      </div>` : ''}`;

    card.appendChild(dot); card.appendChild(info);
    card.onclick = () => {
      document.getElementById('groupPage').classList.remove('open');
      openDetail(ev.id);
    };
    return card;
  }

  // Upcoming Events section
  const evSecTitle = document.createElement('div');
  evSecTitle.className = 'group-page-section-title';
  evSecTitle.innerHTML = `<span class="ev-ink" style="--ev-color:${g.color}">◈</span> Upcoming Events`;
  body.appendChild(evSecTitle);

  if (!upcomingEvents.length) {
    const empty = document.createElement('div'); empty.className = 'gp-empty';
    empty.textContent = 'No upcoming events in this group.'; body.appendChild(empty);
  } else {
    upcomingEvents.forEach(ev => body.appendChild(buildEventCard(ev)));
  }

  // Past Events collapsible section
  if (pastEvents.length) {
    const pastSection = document.createElement('div');
    pastSection.className = 'gp-past-section';

    const pastHeader = document.createElement('div');
    pastHeader.className = 'gp-past-header';
    pastHeader.innerHTML = `
      <span class="ev-ink" style="--ev-color:${g.color}">◈</span>
      <span>Past Events</span>
      <span class="gp-past-count">${pastEvents.length}</span>
      <span class="gp-past-chevron">▸</span>`;
    pastSection.appendChild(pastHeader);

    const pastBody = document.createElement('div');
    pastBody.className = 'gp-past-body';

    // Filter bar
    const filterBar = document.createElement('div');
    filterBar.className = 'gp-past-filter-bar';
    filterBar.innerHTML = `
      <input class="gp-past-search" type="text" placeholder="Search past events…" />
      <select class="gp-past-year-select">
        <option value="">All Years</option>
        ${[...new Set(pastEvents.map(e => e.date.slice(0,4)))].sort((a,b)=>b-a)
          .map(y => `<option value="${y}">${y}</option>`).join('')}
      </select>`;
    pastBody.appendChild(filterBar);

    const pastList = document.createElement('div');
    pastList.className = 'gp-past-list';
    pastBody.appendChild(pastList);

    function renderPastList() {
      const query = pastBody.querySelector('.gp-past-search').value.toLowerCase();
      const year = pastBody.querySelector('.gp-past-year-select').value;
      const filtered = pastEvents.filter(ev => {
        if (year && !ev.date.startsWith(year)) return false;
        if (query && !ev.title.toLowerCase().includes(query) && !ev.date.includes(query)) return false;
        return true;
      });
      pastList.innerHTML = '';
      if (!filtered.length) {
        const empty = document.createElement('div'); empty.className = 'gp-empty';
        empty.textContent = 'No past events match the filter.'; pastList.appendChild(empty);
      } else {
        filtered.forEach(ev => pastList.appendChild(buildEventCard(ev)));
      }
    }

    renderPastList();
    pastBody.querySelector('.gp-past-search').addEventListener('input', renderPastList);
    pastBody.querySelector('.gp-past-year-select').addEventListener('change', renderPastList);
    pastSection.appendChild(pastBody);

    // Toggle expand/collapse
    let expanded = false;
    pastHeader.onclick = () => {
      expanded = !expanded;
      pastBody.classList.toggle('open', expanded);
      pastHeader.querySelector('.gp-past-chevron').textContent = expanded ? '▾' : '▸';
    };

    body.appendChild(pastSection);
  }

  // Tasks section
  const taskSecTitle = document.createElement('div');
  taskSecTitle.className = 'group-page-section-title';
  taskSecTitle.innerHTML = `<span class="ev-ink" style="--ev-color:${g.color}">◆</span> All Tasks`;
  body.appendChild(taskSecTitle);

  if (!allTasks.length) {
    const empty = document.createElement('div'); empty.className = 'gp-empty';
    empty.textContent = 'No tasks linked to events in this group.'; body.appendChild(empty);
  } else {
    // Group by done/not done
    const pending = allTasks.filter(x => !x.t.done);
    const done = allTasks.filter(x => x.t.done);
    [...pending, ...done].forEach(({t, ev}) => {
      const overdue = taskIsOverdue(t);
      const row = document.createElement('div');
      row.className = 'gp-task-row';

      const check = document.createElement('div');
      check.className = 'gp-task-check' + (t.done?' done':'');
      if (t.done) check.textContent = '✓';

      const taskInfo = document.createElement('div');
      taskInfo.className = 'gp-task-info';
      const dt2 = t.dueDate ? new Date(t.dueDate+'T00:00:00') : null;
      taskInfo.innerHTML = `
        <div class="gp-task-text${t.done?' done':''}">${t.text}</div>
        <div class="gp-task-meta">
          ${t.assignee?`<span>👤 ${t.assignee}</span>`:''}
          ${dt2?`<span style="color:${overdue?'var(--danger-ink)':'var(--gold-ink)'}">${overdue?'⚠':''} Due ${MONTHS[dt2.getMonth()].slice(0,3)} ${dt2.getDate()}</span>`:''}
          <span class="gp-task-event-link" data-ev-id="${ev.id}">→ ${ev.title}</span>
        </div>`;

      row.appendChild(check); row.appendChild(taskInfo);
      body.appendChild(row);
    });

    // wire task event links
    body.querySelectorAll('.gp-task-event-link').forEach(el => {
      el.onclick = e => {
        e.stopPropagation();
        document.getElementById('groupPage').classList.remove('open');
        openDetail(el.dataset.evId);
      };
    });
  }
}

// ============================================================
// ============================================================
// DAY CLICK POPUP
// ============================================================
let dayPopupDate = null;

function openDayPopup(e, dateStr) {
  e.stopPropagation();
  dayPopupDate = dateStr;
  const popup = document.getElementById('dayPopup');
  const dt = new Date(dateStr + 'T00:00:00');
  document.getElementById('dayPopupHeader').textContent =
    `${DAYS[dt.getDay()]}, ${MONTHS[dt.getMonth()].slice(0,3)} ${dt.getDate()}`;

  popup.classList.add('open');
  const pw = 168, ph = 110;
  let x = e.clientX, y = e.clientY;
  if (x + pw > window.innerWidth) x = window.innerWidth - pw - 8;
  if (y + ph > window.innerHeight) y = window.innerHeight - ph - 8;
  popup.style.left = x + 'px';
  popup.style.top = y + 'px';
}

function closeDayPopup() {
  document.getElementById('dayPopup').classList.remove('open');
  dayPopupDate = null;
}

document.addEventListener('click', (e) => {
  const popup = document.getElementById('dayPopup');
  if (popup.classList.contains('open') && !popup.contains(e.target)) closeDayPopup();
});

document.getElementById('dayPopupViewDay').onclick = () => {
  if (!dayPopupDate) return;
  state.date = new Date(dayPopupDate + 'T00:00:00');
  state.view = 'day';
  document.querySelectorAll('.view-tab').forEach(t => t.classList.toggle('active', t.dataset.view === 'day'));
  closeDayPopup();
  render();
  setTimeout(() => { const el = document.querySelector('.day-scroll'); if (el) el.scrollTop = 8 * 60; }, 60);
};

document.getElementById('dayPopupAddEvent').onclick = () => {
  const ds = dayPopupDate;
  closeDayPopup();
  openAddModal(ds);
};

// ============================================================
// PERSON CONTEXT MENU
// ============================================================
let ctxPerson = null; // the person object being right-clicked

function openPersonCtxMenu(e, person) {
  ctxPerson = person;
  const menu = document.getElementById('personCtxMenu');

  // Set header
  document.getElementById('ctxAvatar').textContent = initials(person.name);
  document.getElementById('ctxAvatar').style.background = avatarColor(person.name);
  document.getElementById('ctxName').textContent = person.name;

  // Reset edit row
  document.getElementById('ctxEditRow').classList.remove('open');
  document.getElementById('ctxEditInput').value = '';

  // Position the menu — keep it on screen
  menu.classList.add('open');
  const menuW = 180, menuH = 140;
  let x = e.clientX, y = e.clientY;
  if (x + menuW > window.innerWidth) x = window.innerWidth - menuW - 8;
  if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 8;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

function closePersonCtxMenu() {
  document.getElementById('personCtxMenu').classList.remove('open');
  document.getElementById('ctxEditRow').classList.remove('open');
  document.getElementById('ctxDeleteConfirm').style.display = 'none';
  ctxPerson = null;
}

// Close on outside click
document.addEventListener('click', (e) => {
  const menu = document.getElementById('personCtxMenu');
  if (menu.classList.contains('open') && !menu.contains(e.target)) {
    closePersonCtxMenu();
  }
});

// Rename button — show inline input
document.getElementById('ctxEditBtn').onclick = () => {
  const editRow = document.getElementById('ctxEditRow');
  editRow.classList.add('open');
  const input = document.getElementById('ctxEditInput');
  input.value = ctxPerson ? ctxPerson.name : '';
  setTimeout(() => { input.focus(); input.select(); }, 30);
};

// Save rename
document.getElementById('ctxEditSave').onclick = savePersonRename;
document.getElementById('ctxEditInput').onkeydown = (e) => {
  if (e.key === 'Enter') savePersonRename();
  if (e.key === 'Escape') closePersonCtxMenu();
};

function savePersonRename() {
  const newName = document.getElementById('ctxEditInput').value.trim();
  if (!newName || !ctxPerson) { closePersonCtxMenu(); return; }
  if (newName === ctxPerson.name) { closePersonCtxMenu(); return; }

  const oldName = ctxPerson.name;
  const people = _localPeople.length ? JSON.parse(JSON.stringify(_localPeople)) : [];

  // Check for duplicate
  if (people.find(p => p.name.toLowerCase() === newName.toLowerCase() && p.id !== ctxPerson.id)) {
    document.getElementById('ctxEditInput').style.borderColor = 'var(--danger)';
    setTimeout(() => { document.getElementById('ctxEditInput').style.borderColor = ''; }, 1200);
    return;
  }

  // Update people list
  const idx = people.findIndex(p => p.id === ctxPerson.id);
  if (idx >= 0) people[idx].name = newName;
  db.set('krakenPeople', people);

  // Update all event attendees and task assignees that reference the old name
  state.events.forEach(ev => {
    ev.attendees = (ev.attendees||[]).map(n => n === oldName ? newName : n);
    (ev.tasks||[]).forEach(t => { if (t.assignee === oldName) t.assignee = newName; });
  });
  save();

  // Update active filters if this person was being filtered
  const fi = state.activeFilters.indexOf(oldName);
  if (fi >= 0) state.activeFilters[fi] = newName;

  closePersonCtxMenu();
  render();
}

// Delete person
document.getElementById('ctxDeleteBtn').onclick = () => {
  if (!ctxPerson) return;
  document.getElementById('ctxDeleteConfirm').style.display = 'block';
};

document.getElementById('ctxDeleteNo').onclick = () => {
  document.getElementById('ctxDeleteConfirm').style.display = 'none';
};

document.getElementById('ctxDeleteYes').onclick = () => {
  if (!ctxPerson) return;
  const name = ctxPerson.name;
  const people = _localPeople.length ? JSON.parse(JSON.stringify(_localPeople)) : [];
  const filtered = people.filter(p => p.id !== ctxPerson.id);
  db.set('krakenPeople', filtered);

  // Remove from event attendees and task assignees
  state.events.forEach(ev => {
    ev.attendees = (ev.attendees||[]).filter(n => n !== name);
    (ev.tasks||[]).forEach(t => { if (t.assignee === name) t.assignee = ''; });
  });
  save();

  // Remove from active filters
  state.activeFilters = state.activeFilters.filter(n => n !== name);

  closePersonCtxMenu();
  render();
};

// ============================================================
// GROUP CONTEXT MENU
// ============================================================
let ctxGroup = null;

function openGroupCtxMenu(e, group) {
  ctxGroup = group;
  const menu = document.getElementById('groupCtxMenu');
  const hidden = state.hiddenGroups.includes(group.id);

  // Header
  document.getElementById('gctxSwatch').style.background = group.color;
  document.getElementById('gctxName').textContent = group.name;

  // Toggle button label
  document.getElementById('gctxToggleIcon').textContent = hidden ? '👁' : '🙈';
  document.getElementById('gctxToggleLabel').textContent = hidden ? 'Show group' : 'Hide group';

  // Reset edit row
  document.getElementById('gctxEditRow').classList.remove('open');
  document.getElementById('gctxNameInput').value = group.name;
  document.getElementById('gctxColorInput').value = group.color;

  // Position
  menu.classList.add('open');
  const menuW = 190, menuH = 190;
  let x = e.clientX, y = e.clientY;
  if (x + menuW > window.innerWidth) x = window.innerWidth - menuW - 8;
  if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 8;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

function closeGroupCtxMenu() {
  document.getElementById('groupCtxMenu').classList.remove('open');
  document.getElementById('gctxEditRow').classList.remove('open');
  document.getElementById('gctxDeleteConfirm').style.display = 'none';
  ctxGroup = null;
}

// Close on outside click
document.addEventListener('click', (e) => {
  const menu = document.getElementById('groupCtxMenu');
  if (menu.classList.contains('open') && !menu.contains(e.target)) {
    closeGroupCtxMenu();
  }
});

// Rename & recolor — show inline row
document.getElementById('gctxEditBtn').onclick = () => {
  const row = document.getElementById('gctxEditRow');
  row.classList.add('open');
  const input = document.getElementById('gctxNameInput');
  setTimeout(() => { input.focus(); input.select(); }, 30);
};

// Live-preview color change in header swatch
document.getElementById('gctxColorInput').oninput = () => {
  document.getElementById('gctxSwatch').style.background = document.getElementById('gctxColorInput').value;
};

// Save rename/recolor
document.getElementById('gctxEditSave').onclick = saveGroupEdit;
document.getElementById('gctxNameInput').onkeydown = (e) => {
  if (e.key === 'Enter') saveGroupEdit();
  if (e.key === 'Escape') closeGroupCtxMenu();
};

function saveGroupEdit() {
  const newName = document.getElementById('gctxNameInput').value.trim();
  const newColor = document.getElementById('gctxColorInput').value;
  if (!newName || !ctxGroup) { closeGroupCtxMenu(); return; }

  const groups = loadGroups();
  const idx = groups.findIndex(g => g.id === ctxGroup.id);
  if (idx < 0) { closeGroupCtxMenu(); return; }

  // Check duplicate name (ignoring self)
  if (newName !== ctxGroup.name && groups.find(g => g.name.toLowerCase() === newName.toLowerCase() && g.id !== ctxGroup.id)) {
    const inp = document.getElementById('gctxNameInput');
    inp.style.borderColor = 'var(--danger)';
    setTimeout(() => { inp.style.borderColor = ''; }, 1200);
    return;
  }

  groups[idx].name = newName;
  groups[idx].color = newColor;
  saveGroups(groups);

  // Refresh group page header if it's open for this group
  if (currentGroupPageId === ctxGroup.id) {
    document.getElementById('groupPageName').textContent = newName;
    document.getElementById('groupPageSwatch').style.background = newColor;
    renderGroupPageBody(groups[idx]);
  }

  closeGroupCtxMenu();
  render();
}

// Open group page
document.getElementById('gctxViewBtn').onclick = () => {
  if (!ctxGroup) return;
  const id = ctxGroup.id;
  closeGroupCtxMenu();
  openGroupPage(id);
};

// Toggle visibility
document.getElementById('gctxToggleBtn').onclick = () => {
  if (!ctxGroup) return;
  const hidden = state.hiddenGroups.includes(ctxGroup.id);
  if (hidden) state.hiddenGroups = state.hiddenGroups.filter(id => id !== ctxGroup.id);
  else state.hiddenGroups.push(ctxGroup.id);
  saveHiddenGroups();
  closeGroupCtxMenu();
  render();
};

// Delete group — show inline confirm
document.getElementById('gctxDeleteBtn').onclick = () => {
  if (!ctxGroup) return;
  document.getElementById('gctxDeleteConfirm').style.display = 'block';
};

document.getElementById('gctxDeleteNo').onclick = () => {
  document.getElementById('gctxDeleteConfirm').style.display = 'none';
};

document.getElementById('gctxDeleteYes').onclick = () => {
  if (!ctxGroup) return;
  const g = ctxGroup;

  // Ungroup events
  state.events.forEach(e => { if (e.groupId === g.id) e.groupId = null; });
  save();

  // Remove hidden state
  state.hiddenGroups = state.hiddenGroups.filter(id => id !== g.id);
  saveHiddenGroups();

  // Remove from groups list
  const groups = loadGroups().filter(gr => gr.id !== g.id);
  saveGroups(groups);

  // Close group page if open for this group
  if (currentGroupPageId === g.id) {
    document.getElementById('groupPage').classList.remove('open');
    currentGroupPageId = null;
  }

  closeGroupCtxMenu();
  render();
};

// ============================================================
// RECURRENCE UI
// ============================================================
const FREQ_UNITS = { daily: 'days', weekly: 'weeks', monthly: 'months', yearly: 'years' };

function resetRecurrenceUI(recurrence) {
  const freq = recurrence ? recurrence.freq : 'none';
  document.getElementById('recurFreq').value = freq;
  document.getElementById('recurInterval').value = recurrence ? (recurrence.interval || 1) : 1;
  document.getElementById('recurEnd').value = recurrence ? (recurrence.endDate || '') : '';
  // Reset day buttons
  document.querySelectorAll('.recurrence-day-btn').forEach(b => b.classList.remove('active'));
  if (recurrence && recurrence.days) {
    recurrence.days.forEach(d => {
      const btn = document.querySelector(`.recurrence-day-btn[data-day="${d}"]`);
      if (btn) btn.classList.add('active');
    });
  }
  updateRecurrenceUI();
}

// Multi-day toggle
document.getElementById('evMultiDay').onchange = () => {
  const checked = document.getElementById('evMultiDay').checked;
  document.getElementById('endDateRow').classList.toggle('visible', checked);
  if (checked && !document.getElementById('evEndDate').value) {
    // Default end date to start date
    document.getElementById('evEndDate').value = document.getElementById('evDate').value;
  }
};

// All-day toggle — grey out time fields
function updateAllDayUI() {
  const allDay = document.getElementById('evAllDay').checked;
  const timeFields = document.getElementById('timeFields');
  timeFields.style.opacity = allDay ? '0.35' : '1';
  timeFields.style.pointerEvents = allDay ? 'none' : '';
}
document.getElementById('evAllDay').onchange = updateAllDayUI;

function updateRecurrenceUI() {
  const freq = document.getElementById('recurFreq').value;
  const intervalWrap = document.getElementById('recurIntervalWrap');
  const daysWrap = document.getElementById('recurDaysWrap');
  const endWrap = document.getElementById('recurEndWrap');
  const unitEl = document.getElementById('recurIntervalUnit');

  const hasRecur = freq !== 'none';
  intervalWrap.style.display = hasRecur ? 'flex' : 'none';
  endWrap.style.display = hasRecur ? 'block' : 'none';
  daysWrap.style.display = freq === 'weekly' ? 'flex' : 'none';
  if (FREQ_UNITS[freq]) unitEl.textContent = FREQ_UNITS[freq];
}

document.getElementById('recurFreq').onchange = () => {
  updateRecurrenceUI();
  // Auto-select the event's day for weekly
  if (document.getElementById('recurFreq').value === 'weekly') {
    const dateVal = document.getElementById('evDate').value;
    if (dateVal) {
      const dow = new Date(dateVal + 'T00:00:00').getDay();
      const btn = document.querySelector(`.recurrence-day-btn[data-day="${dow}"]`);
      if (btn && !btn.classList.contains('active')) btn.classList.add('active');
    }
  }
};
document.querySelectorAll('.recurrence-day-btn').forEach(btn => {
  btn.onclick = () => btn.classList.toggle('active');
});

// Show recur badge on event pills (called from renderMonth/Week/Day inline)
function recurLabel(ev) {
  if (!ev.recurrence || ev.recurrence.freq === 'none') return '';
  const map = { daily:'Daily', weekly:'Weekly', monthly:'Monthly', yearly:'Yearly' };
  return `<span class="recur-badge">${map[ev.recurrence.freq]||''}</span>`;
}

// ============================================================
// DRAG AND DROP
// ============================================================
let dragState = null; // { evId, origDate, offsetMins }

function makeDraggable(el, ev, dateStr) {
  el.draggable = true;
  el.ondragstart = (e) => {
    dragState = { evId: ev.id, origDate: ev.date, isRecurring: isRecurringInstance(ev, dateStr), instanceDate: dateStr };
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', ev.id);
  };
  el.ondragend = () => {
    el.classList.remove('dragging');
    document.querySelectorAll('.drag-over').forEach(x => x.classList.remove('drag-over'));
    document.querySelectorAll('.drag-time-indicator').forEach(x => x.remove());
  };
}

function applyMonthCellDrop(cell, dateStr) {
  cell.ondragover = (e) => {
    if (!dragState) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.cal-cell.drag-over').forEach(x => x.classList.remove('drag-over'));
    cell.classList.add('drag-over');
  };
  cell.ondragleave = () => cell.classList.remove('drag-over');
  cell.ondrop = (e) => {
    e.preventDefault(); e.stopPropagation();
    cell.classList.remove('drag-over');
    if (!dragState) return;
    const ev = state.events.find(x => x.id === dragState.evId);
    if (!ev || ev.date === dateStr) { dragState = null; return; }

    if (dragState.isRecurring) {
      const newEv = { ...JSON.parse(JSON.stringify(ev)), id: uid(), date: dateStr, recurrence: { freq: 'none' }, parentId: ev.id };
      ev.recurrence.exceptions = ev.recurrence.exceptions || [];
      ev.recurrence.exceptions.push(dragState.instanceDate);
      state.events.push(newEv);
    } else if (ev.endDate && ev.endDate > ev.date) {
      const draggedFrom = new Date(dragState.instanceDate + 'T00:00:00');
      const droppedOn = new Date(dateStr + 'T00:00:00');
      const offsetMs = droppedOn - draggedFrom;
      ev.date = isoDate(new Date(new Date(ev.date + 'T00:00:00').getTime() + offsetMs));
      ev.endDate = isoDate(new Date(new Date(ev.endDate + 'T00:00:00').getTime() + offsetMs));
    } else {
      ev.date = dateStr;
    }
    save(); dragState = null; render();
  };
}

function applyWeekDayColDrop(col, dateStr) {
  col.ondragover = (e) => {
    if (!dragState) return;
    e.preventDefault();
    col.classList.add('drag-over');
    // Show time indicator
    const rect = col.getBoundingClientRect();
    const scrollEl = document.querySelector('.week-scroll') || document.querySelector('.day-scroll');
    const relY = e.clientY - rect.top + (scrollEl ? scrollEl.scrollTop : 0);
    const totalMins = Math.max(0, Math.min(1439, Math.floor(relY)));
    const h = Math.floor(totalMins / 60);
    const m = Math.floor((totalMins % 60) / 30) * 30;
    const timeStr = `${h%12||12}:${String(m).padStart(2,'0')} ${h<12?'AM':'PM'}`;
    let indicator = col.querySelector('.drag-time-indicator');
    if (!indicator) { indicator = document.createElement('div'); indicator.className = 'drag-time-indicator'; col.appendChild(indicator); }
    indicator.style.top = `${totalMins}px`;
    indicator.dataset.time = timeStr;
  };
  col.ondragleave = (e) => {
    if (!col.contains(e.relatedTarget)) {
      col.classList.remove('drag-over');
      col.querySelector('.drag-time-indicator')?.remove();
    }
  };
  col.ondrop = (e) => {
    e.preventDefault(); e.stopPropagation();
    col.classList.remove('drag-over');
    col.querySelector('.drag-time-indicator')?.remove();
    if (!dragState) return;
    const ev = state.events.find(x => x.id === dragState.evId);
    if (!ev) { dragState = null; return; }

    const rect = col.getBoundingClientRect();
    const scrollEl = document.querySelector('.week-scroll') || document.querySelector('.day-scroll');
    const relY = e.clientY - rect.top + (scrollEl ? scrollEl.scrollTop : 0);
    const snappedMins = Math.max(0, Math.min(1410, Math.floor(relY / 30) * 30));
    const newH = Math.floor(snappedMins / 60);
    const newM = snappedMins % 60;

    // Calculate duration
    const [sh, sm] = (ev.start || '09:00').split(':').map(Number);
    const [eh, em] = (ev.end || '10:00').split(':').map(Number);
    const dur = (eh * 60 + em) - (sh * 60 + sm);

    const newStart = `${String(newH).padStart(2,'0')}:${String(newM).padStart(2,'0')}`;
    const endMins = snappedMins + Math.max(dur, 30);
    const newEnd = `${String(Math.floor(endMins/60)%24).padStart(2,'0')}:${String(endMins%60).padStart(2,'0')}`;

    if (dragState.isRecurring) {
      const newEv = { ...JSON.parse(JSON.stringify(ev)), id: uid(), date: dateStr, start: newStart, end: newEnd, recurrence: { freq: 'none' }, parentId: ev.id };
      ev.recurrence.exceptions = ev.recurrence.exceptions || [];
      ev.recurrence.exceptions.push(dragState.instanceDate);
      state.events.push(newEv);
    } else {
      if (ev.endDate && ev.endDate > ev.date) {
        const draggedFrom = new Date(dragState.instanceDate + 'T00:00:00');
        const droppedOn = new Date(dateStr + 'T00:00:00');
        const offsetMs = droppedOn - draggedFrom;
        ev.date = isoDate(new Date(new Date(ev.date + 'T00:00:00').getTime() + offsetMs));
        ev.endDate = isoDate(new Date(new Date(ev.endDate + 'T00:00:00').getTime() + offsetMs));
      } else {
        ev.date = dateStr;
      }
      ev.start = newStart; ev.end = newEnd;
    }
    save(); dragState = null; render();
  };
}

// ============================================================
// GLOBAL EVENT SEARCH
// ============================================================
(function() {
  const input = document.getElementById('searchInput');
  const resultsEl = document.getElementById('searchResults');
  if (!input || !resultsEl) return;
  let results = [];
  let selectedIdx = -1;

  // For recurring events, find the next occurrence on/after today (within a year);
  // otherwise fall back to the event's own date.
  function bestDateFor(ev) {
    if (!ev.recurrence || ev.recurrence.freq === 'none') return ev.date;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    for (let i = 0; i < 366; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const ds = isoDate(d);
      if (recurMatches(ev, ds)) return ds;
    }
    return ev.date;
  }

  function runSearch(q) {
    q = q.trim().toLowerCase();
    results = [];
    selectedIdx = -1;
    if (q.length < 2) { resultsEl.classList.remove('open'); return; }

    results = state.events.filter(Boolean).filter(ev => {
      const group = ev.groupId ? getGroupById(ev.groupId) : null;
      const hay = [ev.title, ev.location, ev.desc, (ev.attendees || []).join(' '), group ? group.name : '']
        .join(' ').toLowerCase();
      return hay.includes(q);
    }).map(ev => ({ ev, ds: bestDateFor(ev) }))
      .sort((a, b) => a.ds < b.ds ? -1 : 1)
      .slice(0, 8);

    resultsEl.innerHTML = '';
    if (!results.length) {
      resultsEl.innerHTML = `<div class="search-empty">No events match "${q.replace(/</g,'&lt;')}"</div>`;
      resultsEl.classList.add('open');
      return;
    }
    results.forEach((r, i) => {
      const { ev, ds } = r;
      const group = ev.groupId ? getGroupById(ev.groupId) : null;
      const color = (group ? group.color : null) || ev.color || 'var(--kraken-teal)';
      const dt = new Date(ds + 'T00:00:00');
      const row = document.createElement('div');
      row.className = 'search-result';
      row.setAttribute('role', 'option');
      row.innerHTML = `
        <span class="sr-dot" style="background:${color};color:${color}"></span>
        <span class="sr-body">
          <span class="sr-title">${ev.title}</span>
          <span class="sr-meta" style="display:block">${DAYS[dt.getDay()]}, ${MONTHS[dt.getMonth()].slice(0,3)} ${dt.getDate()}, ${dt.getFullYear()}${ev.allDay ? ' · All day' : ev.start ? ' · ' + fmtTime(ev.start) : ''}${ev.location ? ' · 📍 ' + ev.location : ''}${ev.recurrence && ev.recurrence.freq !== 'none' ? ' · 🔁' : ''}</span>
        </span>`;
      row.onmousedown = (e) => { e.preventDefault(); goTo(i); };
      resultsEl.appendChild(row);
    });
    resultsEl.classList.add('open');
  }

  function goTo(i) {
    const r = results[i];
    if (!r) return;
    state.date = new Date(r.ds + 'T00:00:00');
    closeSearch();
    render();
    openDetail(r.ev.id);
  }

  function closeSearch() {
    resultsEl.classList.remove('open');
    input.blur();
    input.value = '';
  }

  function highlight() {
    resultsEl.querySelectorAll('.search-result').forEach((el, i) =>
      el.classList.toggle('selected', i === selectedIdx));
  }

  input.addEventListener('input', () => runSearch(input.value));
  input.addEventListener('focus', () => { if (input.value.trim().length >= 2) runSearch(input.value); });
  input.addEventListener('blur', () => setTimeout(() => resultsEl.classList.remove('open'), 150));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { closeSearch(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); selectedIdx = Math.min(selectedIdx + 1, results.length - 1); highlight(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); selectedIdx = Math.max(selectedIdx - 1, 0); highlight(); }
    if (e.key === 'Enter' && results.length) { goTo(selectedIdx >= 0 ? selectedIdx : 0); }
  });

  window._focusSearch = () => { input.focus(); input.select(); };
})();

// ============================================================
// MONDAY MEETINGS — department agenda, quick notes, meeting
// mode with carry-over, history, and new/changed badges
// ============================================================
const MONDAY_WINDOW_DAYS = 30;  // how far ahead the agenda looks
const MONDAY_VERIFY_DAYS = 14;  // done tasks due within this window get a "verify" check-in
// Tweak this list to change what counts as an away-from-the-rink event title
const AWAY_RE = /\b(away|out|ooo|vacation|pto|sick|on leave|day off|out of office|holiday|absent)\b/i;

let mondayState = { tab: 'agenda', draft: null, openHistory: {}, _editingInput: false };

function getMondayName() { try { return localStorage.getItem('abyssMondayName') || ''; } catch(e) { return ''; } }
function setMondayName(name) { try { localStorage.setItem('abyssMondayName', name.trim()); } catch(e) {} }

// FNV-1a over the fields that matter for "changed since last meeting"
function eventHash(ev) {
  const s = JSON.stringify([ev.title, ev.date, ev.start, ev.end, ev.desc, ev.location,
    ev.groupId, ev.endDate, ev.allDay, ev.recurrence || null,
    (ev.tasks || []).map(t => [t.text, !!t.done, t.dueDate || '', t.assignee || ''])]);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

// The meeting reviews everything — ignore the per-device hidden-group display filter
function mondayEventsForDate(ds) {
  return state.events.filter(e => e && recurMatches(e, ds));
}

function nextMondayDate() {
  const d = new Date(); d.setHours(0,0,0,0);
  while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
  return d;
}

function fmtShortDs(ds) {
  const dt = new Date(ds + 'T00:00:00');
  return MONTHS[dt.getMonth()].slice(0,3) + ' ' + dt.getDate();
}

function relAge(iso) {
  if (!iso) return '';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return days + 'd ago';
  return Math.floor(days / 7) + 'w ago';
}

function ordinal(n) { const s = ['th','st','nd','rd'], v = n % 100; return n + (s[(v-20)%10] || s[v] || s[0]); }

function lastArchivedMeeting() {
  const ms = loadMondayMeetings();
  if (!ms.length) return null;
  return ms.reduce((a, b) => ((a.endedAt || '') > (b.endedAt || '') ? a : b));
}

function getAgendaData() {
  const todayD = new Date(); todayD.setHours(0,0,0,0);
  const todayDs = isoDate(todayD);
  const verifyEnd = new Date(todayD); verifyEnd.setDate(verifyEnd.getDate() + MONDAY_VERIFY_DAYS);
  const verifyEndDs = isoDate(verifyEnd);

  // one pass over the window, collecting occurrences per event
  const occ = new Map();        // event id → [dates it occurs on]
  const byId = new Map();       // event id → event
  const dayEvents = new Map();  // date → [events]
  for (let i = 0; i < MONDAY_WINDOW_DAYS; i++) {
    const d = new Date(todayD); d.setDate(todayD.getDate() + i);
    const ds = isoDate(d);
    const evs = mondayEventsForDate(ds);
    dayEvents.set(ds, evs);
    for (const ev of evs) {
      if (!occ.has(ev.id)) { occ.set(ev.id, []); byId.set(ev.id, ev); }
      occ.get(ev.id).push(ds);
    }
  }

  // needs attention — one card per event with three task buckets
  const attMap = new Map();
  const bucketFor = ev => {
    if (!attMap.has(ev.id)) attMap.set(ev.id, {
      ev,
      firstDs: (occ.get(ev.id) || [])[0] || ev.date,
      dates: occ.get(ev.id) || [],
      openTasks: [], overdueTasks: [], verifyTasks: []
    });
    return attMap.get(ev.id);
  };
  state.events.filter(Boolean).forEach(ev => {
    (ev.tasks || []).forEach(t => {
      if (taskIsOverdue(t)) bucketFor(ev).overdueTasks.push(t);
      else if (!t.done && occ.has(ev.id)) bucketFor(ev).openTasks.push(t);
      else if (t.done && t.dueDate && t.dueDate >= todayDs && t.dueDate <= verifyEndDs) bucketFor(ev).verifyTasks.push(t);
    });
  });
  const attention = [...attMap.values()].sort((a, b) =>
    (b.overdueTasks.length - a.overdueTasks.length) || a.firstDs.localeCompare(b.firstDs));

  // away from the rink — keyword match on titles
  const away = [];
  for (const [id, dates] of occ) {
    const ev = byId.get(id);
    if (AWAY_RE.test(ev.title || '')) away.push({ ev, dates });
  }
  away.sort((a, b) => a.dates[0].localeCompare(b.dates[0]));
  const awayIds = new Set(away.map(a => a.ev.id));

  // everything else, grouped by week
  const weeks = [];
  let wk = null;
  for (let i = 0; i < MONDAY_WINDOW_DAYS; i++) {
    const d = new Date(todayD); d.setDate(todayD.getDate() + i);
    const ds = isoDate(d);
    if (!wk || d.getDay() === 0) { wk = { startDs: ds, rows: [], seen: new Set() }; weeks.push(wk); }
    for (const ev of dayEvents.get(ds) || []) {
      if (attMap.has(ev.id) || awayIds.has(ev.id) || wk.seen.has(ev.id)) continue;
      wk.seen.add(ev.id);
      wk.rows.push({ ev, ds, recurring: (occ.get(ev.id) || []).length > 1 && !(ev.endDate && ev.endDate > ev.date) });
    }
  }
  weeks.forEach((w, i) => {
    w.label = i === 0 ? 'This week' : i === 1 ? 'Next week' : 'Week of ' + fmtShortDs(w.startDs);
  });

  // what's new / changed since the last archived meeting
  const lastMeeting = lastArchivedMeeting();
  const badges = new Map();
  if (lastMeeting && lastMeeting.snapshot) {
    const check = ev => {
      if (badges.has(ev.id)) return;
      const h = lastMeeting.snapshot[ev.id];
      if (h === undefined) badges.set(ev.id, 'new');
      else if (h !== eventHash(ev)) badges.set(ev.id, 'changed');
    };
    byId.forEach(check);
    attention.forEach(a => check(a.ev));
  }

  const notes = loadMondayNotes().slice().sort((a, b) =>
    ((b.carriedOver || 0) - (a.carriedOver || 0)) || (a.createdAt || '').localeCompare(b.createdAt || ''));

  return { todayDs, attention, away, weeks, notes, badges, lastMeeting };
}

// ---- meeting draft (in memory + localStorage so a refresh can't lose a live meeting) ----
function draftKeyFor(type, refId) { return type + ':' + refId; }
function getDraftItem(key) { return (mondayState.draft && mondayState.draft.items[key]) || null; }
function setDraftItem(type, refId, title, patch) {
  if (!mondayState.draft) return;
  const key = draftKeyFor(type, refId);
  const cur = mondayState.draft.items[key] || { type, refId, title, discussed: false, outcome: '' };
  cur.title = title;
  Object.assign(cur, patch);
  mondayState.draft.items[key] = cur;
  saveMondayDraft();
}
function saveMondayDraft() {
  try {
    if (mondayState.draft) localStorage.setItem('abyssMondayDraft', JSON.stringify(mondayState.draft));
    else localStorage.removeItem('abyssMondayDraft');
  } catch(e) {}
}
function restoreMondayDraft() {
  try {
    const raw = localStorage.getItem('abyssMondayDraft');
    if (raw) mondayState.draft = JSON.parse(raw);
  } catch(e) {}
}

function startMeeting() {
  mondayState.draft = {
    id: uid(),
    date: isoDate(new Date()),
    startedAt: new Date().toISOString(),
    facilitator: getMondayName() || '',
    items: {}
  };
  saveMondayDraft();
  renderMondayBody();
}

async function endMeeting() {
  if (!mondayState.draft) return;
  if (!confirm('End the meeting and archive this agenda?\n\nQuick notes marked discussed will be cleared; the rest carry over to next week.')) return;
  const draft = mondayState.draft;
  const data = getAgendaData();

  const items = [];
  const seen = new Set();
  const pushItem = (type, refId, title) => {
    const key = draftKeyFor(type, refId);
    seen.add(key);
    const d = draft.items[key];
    items.push({ type, refId, title, discussed: !!(d && d.discussed), outcome: ((d && d.outcome) || '').trim() });
  };
  data.attention.forEach(a => pushItem('event', a.ev.id, a.ev.title));
  data.attention.forEach(a => a.verifyTasks.forEach(t =>
    pushItem('verify', a.ev.id + '::' + (t.id || t.text), (t.text || '') + ' (' + a.ev.title + ')')));
  data.away.forEach(a => pushItem('away', a.ev.id, a.ev.title));
  data.notes.forEach(n => pushItem('note', n.id, n.text));
  // anything ticked during the meeting whose row has since disappeared (e.g. event deleted)
  Object.entries(draft.items).forEach(([key, d]) => {
    if (!seen.has(key) && (d.discussed || d.outcome)) {
      items.push({ type: d.type, refId: d.refId, title: d.title, discussed: !!d.discussed, outcome: (d.outcome || '').trim() });
    }
  });

  const record = {
    id: draft.id,
    date: draft.date,
    startedAt: draft.startedAt,
    endedAt: new Date().toISOString(),
    facilitator: draft.facilitator || getMondayName() || '',
    items,
    snapshot: Object.fromEntries(state.events.filter(Boolean).map(e => [e.id, eventHash(e)]))
  };

  const ok = await saveMondayMeetings([...loadMondayMeetings(), record]);
  if (!ok) {
    alert('Could not save the meeting — check the connection and try End Meeting again.');
    return; // stay in meeting mode; nothing is lost
  }

  // carry-over: discussed notes retire with the meeting, the rest stick around
  const discussedNoteIds = new Set(items.filter(it => it.type === 'note' && it.discussed).map(it => it.refId));
  const remaining = loadMondayNotes()
    .filter(n => !discussedNoteIds.has(n.id))
    .map(n => (n.createdAt && n.createdAt < draft.startedAt) ? { ...n, carriedOver: (n.carriedOver || 0) + 1 } : n);
  await saveMondayNotes(remaining);

  mondayState.draft = null;
  saveMondayDraft();
  renderMondayBody();
}

// ---- quick notes ----
function addMondayNote() {
  const input = document.getElementById('mondayNoteInput');
  const text = input.value.trim();
  if (!text) { input.focus(); return; }
  const name = (document.getElementById('mondayNameInput').value || '').trim();
  if (name) setMondayName(name);
  const note = { id: uid(), text, createdBy: name || 'Someone', createdAt: new Date().toISOString(), carriedOver: 0 };
  input.value = '';
  saveMondayNotes([...loadMondayNotes(), note]);
  renderMondayBody();
  input.focus();
}
function updateMondayNote(id, text) {
  saveMondayNotes(loadMondayNotes().map(n => n.id === id ? { ...n, text } : n));
  renderMondayBody();
}
function deleteMondayNote(id) {
  saveMondayNotes(loadMondayNotes().filter(n => n.id !== id));
  renderMondayBody();
}

// ---- small DOM builders (user text always goes in via textContent) ----
function mmBadgeEl(cls, text) {
  const b = document.createElement('span');
  b.className = 'mm-badge ' + cls;
  b.textContent = text;
  return b;
}
function mmSectionTitle(icon, color, text, hint) {
  const el = document.createElement('div');
  el.className = 'group-page-section-title';
  const ic = document.createElement('span'); ic.style.color = color; ic.textContent = icon;
  const tx = document.createElement('span'); tx.textContent = text;
  el.appendChild(ic); el.appendChild(tx);
  if (hint) { const h = document.createElement('span'); h.className = 'mm-hint'; h.textContent = '— ' + hint; el.appendChild(h); }
  return el;
}
function mmEmpty(text) {
  const el = document.createElement('div');
  el.className = 'gp-empty';
  el.textContent = text;
  return el;
}
function mmAssigneeChip(name) {
  const av = document.createElement('span');
  av.className = 'mm-assignee';
  av.style.background = avatarColor(name || '?');
  av.textContent = initials(name || '?');
  av.title = name || '';
  return av;
}
function mmDiscussRow(type, refId, title, withOutcome) {
  const key = draftKeyFor(type, refId);
  const cur = getDraftItem(key);
  const row = document.createElement('div');
  row.className = 'mm-discuss';
  row.onclick = e => e.stopPropagation();
  const check = document.createElement('div');
  check.className = 'mm-discuss-check' + (cur && cur.discussed ? ' done' : '');
  check.textContent = cur && cur.discussed ? '✓' : '';
  check.title = 'Mark as discussed';
  check.onclick = e => {
    e.stopPropagation();
    setDraftItem(type, refId, title, { discussed: !(cur && cur.discussed) });
    renderMondayBody();
  };
  const lbl = document.createElement('span');
  lbl.className = 'mm-discuss-label';
  lbl.textContent = 'Discussed';
  row.appendChild(check); row.appendChild(lbl);
  if (withOutcome) {
    const inp = document.createElement('input');
    inp.className = 'monday-outcome';
    inp.placeholder = 'Outcome / decision…';
    inp.maxLength = 140;
    inp.value = (cur && cur.outcome) || '';
    inp.oninput = () => setDraftItem(type, refId, title, { outcome: inp.value });
    inp.onfocus = () => { mondayState._editingInput = true; };
    inp.onblur = () => { mondayState._editingInput = false; setTimeout(renderMondayBody, 150); };
    inp.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); };
    row.appendChild(inp);
  }
  return row;
}
function mmTaskLine(t, kind, ev) {
  const line = document.createElement('div');
  line.className = 'mm-task' + (kind ? ' ' + kind : '');
  const mark = document.createElement('span');
  mark.textContent = kind === 'overdue' ? '⚠' : kind === 'verify' ? '✔?' : '○';
  const txt = document.createElement('span');
  txt.textContent = t.text;
  line.appendChild(mark); line.appendChild(txt);
  if (t.dueDate) {
    const due = document.createElement('span');
    due.className = 'mm-task-due';
    due.textContent = (kind === 'overdue' ? 'was due ' : 'due ') + fmtShortDs(t.dueDate);
    line.appendChild(due);
  }
  if (t.assignee) line.appendChild(mmAssigneeChip(t.assignee));
  // in meeting mode, "verify" tasks get their own tick: yes, this is really done
  if (kind === 'verify' && mondayState.draft && ev) {
    const refId = ev.id + '::' + (t.id || t.text);
    const cur = getDraftItem(draftKeyFor('verify', refId));
    const chk = document.createElement('span');
    chk.className = 'mm-discuss-check' + (cur && cur.discussed ? ' done' : '');
    chk.style.width = '15px'; chk.style.height = '15px';
    chk.title = 'Verified — really done';
    chk.textContent = cur && cur.discussed ? '✓' : '';
    chk.onclick = e => {
      e.stopPropagation();
      setDraftItem('verify', refId, (t.text || '') + ' (' + ev.title + ')', { discussed: !(cur && cur.discussed) });
      renderMondayBody();
    };
    line.appendChild(chk);
  }
  return line;
}
function mmEventCard(a, badges) {
  const ev = a.ev;
  const group = ev.groupId ? getGroupById(ev.groupId) : null;
  const color = (group && group.color) || ev.color || '#00B2A9';
  const card = document.createElement('div');
  card.className = 'gp-event-card' + (a.overdueTasks.length ? ' mm-overdue' : '');
  card.style.borderLeftColor = color;
  const dot = document.createElement('div');
  dot.className = 'gp-event-dot';
  dot.style.background = color;
  const info = document.createElement('div');
  info.className = 'gp-event-info';

  const titleRow = document.createElement('div');
  titleRow.className = 'gp-event-title';
  titleRow.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap';
  const tspan = document.createElement('span');
  tspan.textContent = ev.title;
  titleRow.appendChild(tspan);
  const b = badges.get(ev.id);
  if (b) titleRow.appendChild(mmBadgeEl(b, b === 'new' ? 'New' : 'Changed'));
  if (a.overdueTasks.length) titleRow.appendChild(mmBadgeEl('overdue', a.overdueTasks.length + ' overdue'));
  info.appendChild(titleRow);

  const meta = document.createElement('div');
  meta.className = 'gp-event-meta';
  const bits = ['📅 ' + fmtDate(a.firstDs)];
  if (a.dates.length > 1) bits.push('↻ ' + a.dates.length + '× in the next ' + MONDAY_WINDOW_DAYS + ' days');
  if (!ev.allDay && ev.start) bits.push('🕐 ' + fmtTime(ev.start));
  if (ev.location) bits.push('📍 ' + ev.location);
  if (group) bits.push('◈ ' + group.name);
  bits.forEach(x => { const s = document.createElement('span'); s.textContent = x; meta.appendChild(s); });
  info.appendChild(meta);

  a.overdueTasks.forEach(t => info.appendChild(mmTaskLine(t, 'overdue', ev)));
  a.openTasks.forEach(t => info.appendChild(mmTaskLine(t, '', ev)));
  a.verifyTasks.forEach(t => info.appendChild(mmTaskLine(t, 'verify', ev)));
  if (mondayState.draft) info.appendChild(mmDiscussRow('event', ev.id, ev.title, true));

  card.appendChild(dot); card.appendChild(info);
  // keep the agenda open underneath — the detail modal floats above it
  card.onclick = () => openDetail(ev.id);
  return card;
}
function mmAwayRow(a, badges) {
  const ev = a.ev;
  const row = document.createElement('div');
  row.className = 'mm-row';
  const title = document.createElement('span');
  title.className = 'mm-row-title';
  title.textContent = ev.title;
  row.appendChild(title);
  const meta = document.createElement('span');
  meta.className = 'mm-row-meta';
  let range;
  if (ev.endDate && ev.endDate > ev.date) range = fmtShortDs(ev.date) + ' → ' + fmtShortDs(ev.endDate);
  else if (a.dates.length > 1) range = a.dates.slice(0,3).map(fmtShortDs).join(', ') + (a.dates.length > 3 ? ' +' + (a.dates.length - 3) + ' more' : '');
  else range = fmtDate(a.dates[0]);
  const rs = document.createElement('span');
  rs.textContent = '📅 ' + range;
  meta.appendChild(rs);
  (ev.attendees || []).forEach(n => meta.appendChild(mmAssigneeChip(n)));
  row.appendChild(meta);
  const b = badges.get(ev.id);
  if (b) row.appendChild(mmBadgeEl(b, b === 'new' ? 'New' : 'Changed'));
  if (mondayState.draft) row.appendChild(mmDiscussRow('away', ev.id, ev.title, false));
  row.onclick = () => openDetail(ev.id);
  return row;
}
function mmWeekRow(r, badges) {
  const ev = r.ev;
  const group = ev.groupId ? getGroupById(ev.groupId) : null;
  const color = (group && group.color) || ev.color || '#00B2A9';
  const row = document.createElement('div');
  row.className = 'mm-row';
  const dot = document.createElement('span');
  dot.className = 'gp-event-dot';
  dot.style.background = color;
  row.appendChild(dot);
  const title = document.createElement('span');
  title.className = 'mm-row-title';
  title.textContent = (ev.parentId ? '↳ ' : '') + ev.title;
  row.appendChild(title);
  const meta = document.createElement('span');
  meta.className = 'mm-row-meta';
  const dt = new Date(r.ds + 'T00:00:00');
  const bits = [DAYS[dt.getDay()] + ' ' + fmtShortDs(r.ds)];
  if (ev.endDate && ev.endDate > ev.date) bits.push('→ ' + fmtShortDs(ev.endDate));
  bits.push(ev.allDay ? 'All day' : fmtTimeShort(ev.start));
  if (r.recurring) bits.push('↻ recurring');
  if (ev.location) bits.push('📍 ' + ev.location);
  bits.forEach(x => { const s = document.createElement('span'); s.textContent = x; meta.appendChild(s); });
  row.appendChild(meta);
  const b = badges.get(ev.id);
  if (b) row.appendChild(mmBadgeEl(b, b === 'new' ? 'New' : 'Changed'));
  row.onclick = () => openDetail(ev.id);
  return row;
}
function mmNoteRow(n) {
  const row = document.createElement('div');
  row.className = 'monday-note-row';
  row.appendChild(mmAssigneeChip(n.createdBy));
  const text = document.createElement('span');
  text.className = 'monday-note-text';
  text.textContent = n.text;
  text.title = 'Click to edit';
  text.onclick = () => mondayNoteEditInline(n, text, row);
  row.appendChild(text);
  const meta = document.createElement('span');
  meta.className = 'monday-note-meta';
  meta.textContent = (n.createdBy || 'Someone') + ' · ' + relAge(n.createdAt);
  row.appendChild(meta);
  if ((n.carriedOver || 0) >= 1) row.appendChild(mmBadgeEl('carry', ordinal((n.carriedOver || 0) + 1) + ' week'));
  if (mondayState.draft) row.appendChild(mmDiscussRow('note', n.id, n.text, true));
  const del = document.createElement('button');
  del.className = 'monday-note-del';
  del.textContent = '✕';
  del.title = 'Remove note';
  del.onclick = e => {
    e.stopPropagation();
    if (confirm('Remove this note?\n\n“' + n.text + '”')) deleteMondayNote(n.id);
  };
  row.appendChild(del);
  return row;
}
function mondayNoteEditInline(note, textEl, row) {
  const inp = document.createElement('input');
  inp.className = 'monday-note-edit';
  inp.value = note.text;
  inp.maxLength = 200;
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    mondayState._editingInput = false;
    const v = inp.value.trim();
    if (v && v !== note.text) updateMondayNote(note.id, v);
    else renderMondayBody();
  };
  inp.onkeydown = e => {
    e.stopPropagation();
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') { done = true; mondayState._editingInput = false; renderMondayBody(); }
  };
  inp.onblur = () => setTimeout(commit, 150);
  mondayState._editingInput = true;
  row.replaceChild(inp, textEl);
  inp.focus();
  inp.select();
}

// ---- page rendering ----
function renderMondayBody() {
  const body = document.getElementById('mondayAgendaBody');
  const notesList = document.getElementById('mondayNotesList');
  if (!body || !notesList) return;
  if (mondayState._editingInput) return; // someone is mid-keystroke in an outcome/edit field

  const data = getAgendaData();
  const meeting = !!mondayState.draft;

  document.getElementById('mondaySubtitle').textContent = 'Agenda for ' + fmtDate(isoDate(nextMondayDate()));
  const btn = document.getElementById('mondayMeetingBtn');
  btn.textContent = meeting ? '■ End meeting' : '▶ Start meeting';
  btn.classList.toggle('live', meeting);
  const banner = document.getElementById('mondayMeetingBanner');
  banner.style.display = meeting ? '' : 'none';
  banner.textContent = '● Meeting in progress — tick items as you cover them. Quick notes marked discussed are cleared when the meeting ends; the rest carry over to next week.';

  body.innerHTML = '';

  // stat strip
  const overdueCount = data.attention.reduce((n, a) => n + a.overdueTasks.length, 0);
  const openCount = data.attention.reduce((n, a) => n + a.openTasks.length, 0);
  const verifyCount = data.attention.reduce((n, a) => n + a.verifyTasks.length, 0);
  const stats = document.createElement('div');
  stats.className = 'group-page-stats';
  const statDefs = [
    [overdueCount, 'Overdue tasks', overdueCount ? 'var(--danger-ink)' : null],
    [openCount, 'Open tasks', null],
    [verifyCount, 'To verify', verifyCount ? 'var(--gold-ink)' : null],
    [data.away.length, 'Away', null],
  ];
  if (data.lastMeeting) statDefs.push([data.badges.size, 'New / changed', null]);
  statDefs.forEach(([num, label, color]) => {
    const s = document.createElement('div'); s.className = 'gp-stat';
    const nEl = document.createElement('div'); nEl.className = 'gp-stat-num'; nEl.textContent = num;
    if (color) nEl.style.color = color;
    const l = document.createElement('div'); l.className = 'gp-stat-label'; l.textContent = label;
    s.appendChild(nEl); s.appendChild(l); stats.appendChild(s);
  });
  body.appendChild(stats);

  // needs attention
  body.appendChild(mmSectionTitle('⚠', 'var(--danger-ink)', 'Needs Attention', '⚠ overdue · ○ open · ✔? done, confirm it · click an item to view or edit'));
  if (!data.attention.length) body.appendChild(mmEmpty('No open or overdue tasks in the next ' + MONDAY_WINDOW_DAYS + ' days — smooth sailing.'));
  else data.attention.forEach(a => body.appendChild(mmEventCard(a, data.badges)));

  // away from the rink
  body.appendChild(mmSectionTitle('🏒', 'var(--cyan-ink)', 'Away From The Rink', null));
  if (!data.away.length) body.appendChild(mmEmpty('Nobody away in the next ' + MONDAY_WINDOW_DAYS + ' days.'));
  else data.away.forEach(a => body.appendChild(mmAwayRow(a, data.badges)));

  // everything else coming up
  body.appendChild(mmSectionTitle('📅', 'var(--teal-ink)', 'Coming Up', 'everything else in the next ' + MONDAY_WINDOW_DAYS + ' days'));
  const weeksWithRows = data.weeks.filter(w => w.rows.length);
  if (!weeksWithRows.length) body.appendChild(mmEmpty('Nothing else on the calendar.'));
  weeksWithRows.forEach(w => {
    const lbl = document.createElement('div');
    lbl.className = 'mm-week-label';
    lbl.textContent = w.label;
    body.appendChild(lbl);
    w.rows.forEach(r => body.appendChild(mmWeekRow(r, data.badges)));
  });

  // quick notes
  notesList.innerHTML = '';
  if (!data.notes.length) notesList.appendChild(mmEmpty('No quick notes yet — add one below.'));
  else data.notes.forEach(n => notesList.appendChild(mmNoteRow(n)));
}

function renderMondayHistory() {
  const view = document.getElementById('mondayHistoryView');
  if (!view) return;
  view.innerHTML = '';
  view.appendChild(mmSectionTitle('🗃', 'var(--teal-ink)', 'Meeting History', 'what got covered, week by week'));
  const ms = loadMondayMeetings().slice().sort((a, b) => (b.endedAt || '').localeCompare(a.endedAt || ''));
  if (!ms.length) {
    view.appendChild(mmEmpty('No meetings archived yet — run one from the Agenda tab and it will show up here.'));
    return;
  }
  const ICONS = { event: '◈', task: '◆', verify: '✔', away: '🏒', note: '✎' };
  ms.forEach(m => {
    const det = document.createElement('details');
    det.className = 'mm-history';
    det.open = !!mondayState.openHistory[m.id];
    det.addEventListener('toggle', () => { mondayState.openHistory[m.id] = det.open; });
    const sum = document.createElement('summary');
    const items = m.items || [];
    const done = items.filter(i => i.discussed).length;
    const t1 = document.createElement('span');
    t1.textContent = '📋 ' + fmtDate(m.date);
    const t2 = document.createElement('span');
    t2.className = 'mm-history-meta';
    t2.textContent = done + ' of ' + items.length + ' items discussed' + (m.facilitator ? ' · run by ' + m.facilitator : '');
    sum.appendChild(t1); sum.appendChild(t2);
    det.appendChild(sum);
    const box = document.createElement('div');
    box.className = 'mm-history-items';
    items.forEach(it => {
      const r = document.createElement('div');
      r.className = 'mm-history-item' + (it.discussed ? '' : ' skipped');
      const mark = document.createElement('span');
      mark.textContent = it.discussed ? '✓' : '—';
      mark.style.color = it.discussed ? 'var(--teal-ink)' : 'var(--text-dim)';
      const ic = document.createElement('span');
      ic.textContent = ICONS[it.type] || '·';
      ic.style.opacity = '0.6';
      const tt = document.createElement('span');
      tt.textContent = it.title;
      r.appendChild(mark); r.appendChild(ic); r.appendChild(tt);
      if (it.outcome) {
        const oc = document.createElement('span');
        oc.className = 'mm-history-outcome';
        oc.textContent = '→ ' + it.outcome;
        r.appendChild(oc);
      }
      box.appendChild(r);
    });
    if (!items.length) box.appendChild(mmEmpty('(empty agenda)'));
    det.appendChild(box);
    view.appendChild(det);
  });
}

function setMondayTab(tab) {
  mondayState.tab = tab;
  document.getElementById('mondayTabAgenda').classList.toggle('active', tab === 'agenda');
  document.getElementById('mondayTabHistory').classList.toggle('active', tab === 'history');
  document.getElementById('mondayAgendaView').style.display = tab === 'agenda' ? '' : 'none';
  document.getElementById('mondayHistoryView').style.display = tab === 'history' ? '' : 'none';
  if (tab === 'agenda') renderMondayBody();
  else renderMondayHistory();
}

// Hook called from render() — keeps the page live for local edits AND Firebase polls
function renderMondayPageIfOpen() {
  const page = document.getElementById('mondayPage');
  if (!page || !page.classList.contains('open')) return;
  if (mondayState.tab === 'agenda') renderMondayBody();
  else renderMondayHistory();
}

function openMondayPage() {
  const nameInput = document.getElementById('mondayNameInput');
  if (!nameInput.value) nameInput.value = getMondayName();
  const dl = document.getElementById('mondayNameList');
  dl.innerHTML = '';
  _localPeople.forEach(p => {
    const o = document.createElement('option');
    o.value = p.name;
    dl.appendChild(o);
  });
  setMondayTab(mondayState.tab || 'agenda');
  document.getElementById('mondayPage').classList.add('open');
  window.scrollTo(0, 0);
}
function closeMondayPage() {
  // a live meeting draft survives close/reopen (and refresh, via localStorage)
  document.getElementById('mondayPage').classList.remove('open');
}

document.getElementById('mondayBtn').onclick = openMondayPage;
document.getElementById('mondayPageBack').onclick = closeMondayPage;
document.getElementById('mondayTabAgenda').onclick = () => setMondayTab('agenda');
document.getElementById('mondayTabHistory').onclick = () => setMondayTab('history');
document.getElementById('mondayMeetingBtn').onclick = () => { mondayState.draft ? endMeeting() : startMeeting(); };
document.getElementById('mondayNoteAddBtn').onclick = addMondayNote;
document.getElementById('mondayNoteInput').addEventListener('keydown', e => {
  e.stopPropagation(); // keep global shortcuts (and Esc-close) out of the way while typing
  if (e.key === 'Enter') addMondayNote();
});
document.getElementById('mondayNameInput').addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter') e.target.blur();
});
document.getElementById('mondayNameInput').addEventListener('change', e => setMondayName(e.target.value));
restoreMondayDraft();

// ============================================================
// KEYBOARD SHORTCUTS OVERLAY
// ============================================================
function openShortcuts() { document.getElementById('shortcutsOverlay').classList.add('open'); }
document.getElementById('shortcutsClose').onclick = () => document.getElementById('shortcutsOverlay').classList.remove('open');
document.getElementById('shortcutsOverlay').onclick = (e) => { if (e.target.id === 'shortcutsOverlay') e.target.classList.remove('open'); };
document.getElementById('shortcutHint').onclick = openShortcuts;

// ============================================================
// KEYBOARD
// ============================================================
document.addEventListener('keydown', e => {
  // Ctrl/Cmd+K focuses search from anywhere
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (window._focusSearch) window._focusSearch();
    return;
  }
  if (e.key==='Escape') {
    document.getElementById('eventModalOverlay').classList.remove('open');
    document.getElementById('detailModalOverlay').classList.remove('open');
    document.getElementById('monthPickerOverlay').classList.remove('open');
    document.getElementById('groupManagerOverlay').classList.remove('open');
    document.getElementById('groupPage').classList.remove('open');
    document.getElementById('mondayPage').classList.remove('open');
    document.getElementById('shortcutsOverlay').classList.remove('open');
  }
  // Don't fire shortcuts when typing in any input/textarea/select/contenteditable
  const tag = document.activeElement && document.activeElement.tagName;
  const isEditing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    || (document.activeElement && document.activeElement.isContentEditable);
  if (isEditing) return;

  if (document.getElementById('eventModalOverlay').classList.contains('open')) return;
  if (document.getElementById('detailModalOverlay').classList.contains('open')) return;
  if (e.key==='ArrowLeft') document.getElementById('prevBtn').click();
  if (e.key==='ArrowRight') document.getElementById('nextBtn').click();
  if (e.key==='l') { document.querySelector('[data-view=list]').click(); }
  if (e.key==='m') { document.querySelector('[data-view=month]').click(); }
  if (e.key==='w') { document.querySelector('[data-view=week]').click(); }
  if (e.key==='d') { document.querySelector('[data-view=day]').click(); }
  if (e.key==='t') document.getElementById('todayBtn').click();
  if (e.key==='n') openAddModal();
  if (e.key==='a') openMondayPage();
  if (e.key==='/') { e.preventDefault(); if (window._focusSearch) window._focusSearch(); }
  if (e.key==='?') openShortcuts();
});

// ============================================================
// TOUCH SWIPE NAVIGATION (mobile)
// ============================================================
(function() {
  let touchStartX = 0;
  let touchStartY = 0;
  const SWIPE_THRESHOLD = 60;
  const ANGLE_THRESHOLD = 35; // degrees — must be mostly horizontal

  const main = document.querySelector('main');
  if (!main) return;

  main.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  main.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    const angle = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI);
    // Only trigger if gesture is mostly horizontal
    if (Math.abs(dx) < SWIPE_THRESHOLD) return;
    if (angle > ANGLE_THRESHOLD && angle < (180 - ANGLE_THRESHOLD)) return;
    // Don't fire if a modal is open
    if (document.getElementById('eventModalOverlay').classList.contains('open')) return;
    if (document.getElementById('detailModalOverlay').classList.contains('open')) return;
    if (dx < 0) {
      document.getElementById('nextBtn').click(); // swipe left = next
    } else {
      document.getElementById('prevBtn').click(); // swipe right = prev
    }
  }, { passive: true });
})();


function scrollToHour(h) {
  setTimeout(()=>{
    const el = document.querySelector('.week-scroll, .day-scroll');
    if (el) el.scrollTop = h * 60;
  }, 50);
}

// Wrap view tab click to scroll
document.querySelectorAll('.view-tab').forEach(tab => {
  const orig = tab.onclick;
  tab.onclick = (e) => {
    orig && orig.call(tab, e);
    if (tab.dataset.view==='week'||tab.dataset.view==='day') scrollToHour(8);
  };
});

// ============================================================
// INIT — load all data from Firebase then render
// ============================================================
function toArr(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter(Boolean);
  return Object.values(val).filter(Boolean);
}

function initFirebase() {
  setSyncStatus('syncing');

  let loaded = { events: false, groups: false, hidden: false, annotations: false, people: false, mondayNotes: false, mondayMeetings: false };

  function checkAllLoaded() {
    if (Object.values(loaded).every(Boolean)) {
      _firebaseReady = true;
      setSyncStatus('synced');
      render();
      scrollToHour(8);
    }
  }

  db.on('krakenEvents', snap => {
    state.events = toArr(snap.val());
    loaded.events = true;
    checkAllLoaded();
    if (_firebaseReady) render();
  });

  db.on('krakenGroups', snap => {
    _localGroups = toArr(snap.val());
    loaded.groups = true;
    checkAllLoaded();
    if (_firebaseReady) render();
  });

  db.on('krakenHiddenGroups', snap => {
    state.hiddenGroups = toArr(snap.val());
    loaded.hidden = true;
    checkAllLoaded();
    if (_firebaseReady) render();
  });

  db.on('krakenAnnotations', snap => {
    _localAnnotations = snap.val() || {};
    loaded.annotations = true;
    checkAllLoaded();
    if (_firebaseReady) render();
  });

  db.on('krakenPeople', snap => {
    _localPeople = toArr(snap.val());
    loaded.people = true;
    checkAllLoaded();
    if (_firebaseReady) render();
  });

  db.on('krakenMondayNotes', snap => {
    _localMondayNotes = toArr(snap.val());
    loaded.mondayNotes = true;
    checkAllLoaded();
    if (_firebaseReady) render();
  });

  db.on('krakenMondayMeetings', snap => {
    _localMondayMeetings = toArr(snap.val());
    loaded.mondayMeetings = true;
    checkAllLoaded();
    if (_firebaseReady) render();
  });
}

// ============================================================
// SIGN-IN FLOW — authenticate, migrate any legacy data once,
// then start syncing. Sessions persist per device.
// ============================================================
async function migrateLegacyData() {
  try {
    const existing = await db.get('krakenEvents');
    if (existing) return; // data already in place
    // If this device used the interim passphrase version, pull from its space
    let spaceKey = null;
    try { spaceKey = localStorage.getItem('abyssSpaceKey'); } catch(e) {}
    if (!spaceKey) return;
    const keys = ['krakenEvents', 'krakenGroups', 'krakenHiddenGroups', 'krakenAnnotations', 'krakenPeople', 'krakenMondayNotes', 'krakenMondayMeetings'];
    for (const k of keys) {
      const old = await db.getRaw(`spaces/${spaceKey}/${k}`);
      if (old != null) await db.set(k, old);
    }
  } catch(e) {}
}

const LOGIN_ERRORS = {
  'EMAIL_NOT_FOUND': "No account with that email. Ask the admin to add you.",
  'INVALID_PASSWORD': "Email or password doesn't match.",
  'INVALID_LOGIN_CREDENTIALS': "Email or password doesn't match.",
  'USER_DISABLED': "This account has been disabled by the admin.",
  'TOO_MANY_ATTEMPTS_TRY_LATER': "Too many attempts — wait a few minutes and try again.",
  'OPERATION_NOT_ALLOWED': "Email sign-in isn't enabled yet in the Firebase console.",
  'INVALID_EMAIL': "That doesn't look like a valid email address."
};

function showLogin(message) {
  document.getElementById('loginOverlay').classList.add('open');
  const errEl = document.getElementById('loginError');
  if (message) { errEl.textContent = message; errEl.style.display = 'block'; }
  setTimeout(() => document.getElementById('loginEmail').focus(), 150);
}

async function startApp() {
  document.getElementById('loginOverlay').classList.remove('open');
  document.getElementById('accountEmail').textContent = AUTH.email || '';
  document.getElementById('accountEmail').title = AUTH.email || '';
  // Default the Monday quick-note name to the signed-in identity (still editable)
  if (!getMondayName() && AUTH.email) setMondayName(AUTH.email.split('@')[0]);
  await migrateLegacyData();
  if (window.innerWidth <= 768) {
    state.view = 'list';
    document.querySelectorAll('.view-tab').forEach(t => t.classList.toggle('active', t.dataset.view === 'list'));
  }
  initFirebase();
}

async function attemptSignIn() {
  const email = document.getElementById('loginEmail').value.trim();
  const pass = document.getElementById('loginPass').value;
  const errEl = document.getElementById('loginError');
  if (!email || !pass) { errEl.textContent = 'Enter your email and password.'; errEl.style.display = 'block'; return; }
  const btn = document.getElementById('loginBtn');
  btn.disabled = true; btn.textContent = 'Diving…';
  errEl.style.display = 'none';
  try {
    await signIn(email, pass);
    document.getElementById('loginPass').value = '';
    startApp();
  } catch(e) {
    const code = (e.message || '').split(' ')[0].split(':')[0];
    errEl.textContent = LOGIN_ERRORS[code] || "Couldn't sign in — check your connection and try again.";
    errEl.style.display = 'block';
  }
  btn.disabled = false; btn.textContent = 'Dive In';
}

document.getElementById('loginBtn').onclick = attemptSignIn;
['loginEmail', 'loginPass'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') attemptSignIn();
  });
});

document.getElementById('signOutBtn').onclick = () => {
  if (!confirm('Sign out of The Abyss on this device?')) return;
  AUTH = null; saveAuth();
  location.reload();
};

if (AUTH) {
  // Validate the stored session; fall back to login if it's no longer good
  ensureToken().then(tok => { if (tok) startApp(); else if (!document.getElementById('loginOverlay').classList.contains('open')) showLogin(); });
} else {
  showLogin();
}
