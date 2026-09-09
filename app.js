/* Wedding Secretary — Firebase-backed PWA (cloud sync, per-account ownership+sharing, offline cache) */

import { auth, db } from './firebase-config.js';
import { CLOUDINARY_CLOUD_NAME, CLOUDINARY_UPLOAD_PRESET } from './cloud-config.js';
import {
  signInWithEmailAndPassword, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  doc, getDoc, setDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const STORE_KEY = 'wedsec_v3_cache';
const WEDDING_DOC_PATH = ['weddings', 'main'];

const DEFAULT_DATA = {
  settings: {
    weddingDate: '2027-03-14',
    receptionDate: '2027-03-17',
    events: [
      { id: 'ev_haldi', name: 'Haldi', date: '2027-03-13', time: '10:00', venue: '', address: '', isMainWedding: false, ownerId: null, sharedWith: [] },
      { id: 'ev_wedding', name: 'Wedding', date: '2027-03-14', time: '19:00', venue: '', address: '', isMainWedding: true, ownerId: null, sharedWith: [] },
      { id: 'ev_vidaai', name: 'Vidaai', date: '2027-03-15', time: '11:00', venue: '', address: '', isMainWedding: false, ownerId: null, sharedWith: [] },
      { id: 'ev_reception', name: 'Reception', date: '2027-03-17', time: '19:00', venue: '', address: '', isMainWedding: false, ownerId: null, sharedWith: [] }
    ]
  },
  directory: {},     // { [uid]: { name, email } } — everyone who has ever signed in
  tasks: [],         // shared between everyone with access
  vendors: [],        // private by default (ownerId + sharedWith[uid])
  guests: [],         // shared between everyone with access; per-event invite/RSVP
  menus: [],          // event-wise menus
  otherExpenses: []  // private by default (ownerId + sharedWith[uid])
};

let state = structuredClone(DEFAULT_DATA);
let currentView = 'dashboard';
let currentUser = null;
let weddingDocRef = null;
let applyingRemoteUpdate = false;
let saveTimer = null;
let dashboardAnimated = false;

/* ---------------- Local cache (fast paint + offline) ---------------- */
function loadLocalCache(){
  try{
    const raw = localStorage.getItem(STORE_KEY);
    if(!raw) return null;
    return deepMerge(structuredClone(DEFAULT_DATA), JSON.parse(raw));
  }catch(e){ return null; }
}
function cacheLocally(){ try{ localStorage.setItem(STORE_KEY, JSON.stringify(state)); }catch(e){} }
function clearLocalCache(){ try{ localStorage.removeItem(STORE_KEY); }catch(e){} }
function deepMerge(base, extra){
  const out = { ...base, ...extra };
  out.settings = { ...base.settings, ...(extra.settings||{}) };
  out.directory = { ...base.directory, ...(extra.directory||{}) };
  return out;
}

function saveData(){
  cacheLocally();
  if(applyingRemoteUpdate) return;
  if(!weddingDocRef) return;
  showSyncStatus(true);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(()=>{
    setDoc(weddingDocRef, state)
      .then(()=> showSyncStatus(false))
      .catch(err=>{
        console.error('Sync failed', err);
        showSyncStatus(false);
        toast('Saved on this device — will sync once back online');
      });
  }, 350);
}
function showSyncStatus(on){ document.getElementById('syncStatus').classList.toggle('show', on); }

/* ---------------- Migration: fixes data shaped by earlier versions of this app ---------------- */
function normalizeState(s, ownerUidParam){
  s.directory = s.directory || {};
  s.settings = s.settings || {};
  s.settings.events = s.settings.events || [];

  const looksLikeUid = (x) => typeof x === 'string' && x.length >= 20; // real Firebase UIDs are long; old data used short names

  (s.vendors||[]).forEach(v=>{
    if(!v.ownerId) v.ownerId = ownerUidParam; // claim legacy data for whoever opens it first after upgrading
    v.sharedWith = Array.isArray(v.sharedWith) ? v.sharedWith.filter(looksLikeUid) : [];
    v.payments = (v.payments||[]).map(p=>({ documents: [], ...p, status: p.status || 'paid' }));
    v.documents = v.documents || [];
    delete v.createdBy; delete v.visibility;
  });
  (s.otherExpenses||[]).forEach(e=>{
    if(!e.ownerId) e.ownerId = ownerUidParam;
    e.sharedWith = Array.isArray(e.sharedWith) ? e.sharedWith.filter(looksLikeUid) : [];
    delete e.createdBy; delete e.visibility;
  });
  s.menus = Array.isArray(s.menus) ? s.menus : [];
  s.menus.forEach(menu=>{
    menu.eventId = menu.eventId || '';
    menu.sections = Array.isArray(menu.sections) ? menu.sections : [];
    menu.sections.forEach(sec=>{ sec.id = sec.id || uid(); sec.name = sec.name || 'Menu'; sec.items = Array.isArray(sec.items) ? sec.items : []; sec.items.forEach(item=>{ item.id = item.id || uid(); item.name = item.name || ''; item.notes = item.notes || ''; }); });
  });
  s.settings.events.forEach(ev=>{
    if(!ev.ownerId) ev.ownerId = ownerUidParam;
    ev.sharedWith = Array.isArray(ev.sharedWith) ? ev.sharedWith.filter(looksLikeUid) : [];
    if('audience' in ev) delete ev.audience;
    if(ev.isMainWedding === undefined) ev.isMainWedding = /wedding/i.test(ev.name) && !/reception|haldi|vidaai|vidai|sangeet/i.test(ev.name);
  });

  const allEventIds = s.settings.events.map(e=>e.id);
  const receptionEvent = s.settings.events.find(e=>/reception/i.test(e.name));
  (s.guests||[]).forEach(g=>{
    if(!g.events){
      if(g.cohort==='RECEPTION' && receptionEvent) g.events = [receptionEvent.id];
      else g.events = allEventIds.slice();
      delete g.cohort;
    }
    g.events = (g.events||[]).filter(id=>allEventIds.includes(id));
    g.eventStatus = g.eventStatus || {};
    g.events.forEach(id=>{ if(!g.eventStatus[id]) g.eventStatus[id] = g.rsvp || 'pending'; });
    if(g.bashorRaat === undefined) g.bashorRaat = false;
    g.tag = g.tag || '';
    g.family = (g.family||[]).map(m=>({
      id: m.id || uid(),
      name: m.name || '',
      isChild: !!m.isChild,
      events: (m.events||[]).filter(id=>allEventIds.includes(id)),
      eventStatus: m.eventStatus || {},
      bashorRaat: !!m.bashorRaat
    }));
    g.family.forEach(m=>{ m.events.forEach(id=>{ if(!m.eventStatus[id]) m.eventStatus[id] = 'pending'; }); });
    if(!g.ownerId) g.ownerId = ownerUidParam; // claim legacy data for whoever opens it first after upgrading
    g.sharedWith = Array.isArray(g.sharedWith) ? g.sharedWith.filter(looksLikeUid) : [];
  });
  (s.tasks||[]).forEach(t=>{}); // tasks are shared as-is, nothing to migrate
  return s;
}
function deriveName(email){ const local = (email||'?').split('@')[0]; return local.charAt(0).toUpperCase()+local.slice(1); }
function upsertDirectory(s, user){
  const existing = s.directory[user.uid];
  const name = deriveName(user.email);
  if(!existing || existing.name !== name || existing.email !== user.email){
    s.directory[user.uid] = { name, email: user.email };
    return true;
  }
  return false;
}

/* ---------------- Auth ---------------- */
const splash = document.getElementById('appSplash');
const loginScreen = document.getElementById('loginScreen');
let splashHidden = false;
function hideSplash(){ if(!splashHidden){ splash.classList.add('hidden'); splashHidden = true; } }

document.getElementById('loginBtn').addEventListener('click', doLogin);
document.getElementById('login_password').addEventListener('keydown', e=>{ if(e.key==='Enter') doLogin(); });
function doLogin(){
  const email = document.getElementById('login_email').value.trim();
  const password = document.getElementById('login_password').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  if(!email || !password){ errEl.textContent = 'Enter both email and password.'; return; }
  signInWithEmailAndPassword(auth, email, password).catch(err=>{ errEl.textContent = friendlyAuthError(err.code); });
}
function friendlyAuthError(code){
  if(code==='auth/invalid-credential' || code==='auth/wrong-password' || code==='auth/user-not-found') return 'Incorrect email or password.';
  if(code==='auth/too-many-requests') return 'Too many attempts — try again in a bit.';
  if(code==='auth/network-request-failed') return 'No connection — check your internet.';
  return 'Could not sign in. ' + code;
}

document.getElementById('signOutBtn').addEventListener('click', async ()=>{
  if(!confirm('Sign out? This clears cached data from this device (nothing is lost — it stays safely in the cloud).')) return;
  clearLocalCache();
  try{
    if('caches' in window){ const keys = await caches.keys(); await Promise.all(keys.map(k=>caches.delete(k))); }
    if('serviceWorker' in navigator){ const regs = await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map(r=>r.unregister())); }
  }catch(e){ console.warn('Cache clear on sign-out failed', e); }
  await signOut(auth);
  location.reload();
});

function myUid(){ return currentUser ? currentUser.uid : null; }
function directoryList(){ return Object.entries(state.directory||{}).map(([uid, info])=>({ uid, ...info })); }
function otherPeople(){ const me = myUid(); return directoryList().filter(p=>p.uid!==me); }
function nameFor(uid){ return (state.directory[uid]||{}).name || 'Someone'; }

let unsubscribeSnapshot = null;
onAuthStateChanged(auth, async (user)=>{
  currentUser = user;
  hideSplash();
  if(user){
    document.body.classList.add('authenticated');
    document.body.classList.toggle('dashboard-view', currentView === 'dashboard');
    loginScreen.classList.add('hidden');
    document.getElementById('accountEmail').textContent = user.email;
    weddingDocRef = doc(db, ...WEDDING_DOC_PATH);

    const cached = loadLocalCache();
    if(cached){ state = cached; renderAll(); }

    // One-time direct read (NOT a live listener) to decide: does the shared document already exist?
    // This is the key fix for data loss — we only ever create/seed the document here, exactly once,
    // and never from inside the live listener below (a transient "not found" from a live listener
    // must never be treated as "this document doesn't exist yet", or it will overwrite real data).
    try{
      const snap = await getDoc(weddingDocRef);
      if(snap.exists()){
        state = normalizeState(deepMerge(structuredClone(DEFAULT_DATA), snap.data()), user.uid);
      } else {
        state = normalizeState(cached || structuredClone(DEFAULT_DATA), user.uid);
      }
      upsertDirectory(state, user);
      cacheLocally();
      await setDoc(weddingDocRef, state); // persist migration/seed/directory update once, explicitly
      renderAll();
    }catch(err){
      console.error('Initial load failed', err);
      if(cached) toast('Offline — showing last saved data');
    }

    if(unsubscribeSnapshot) unsubscribeSnapshot();
    unsubscribeSnapshot = onSnapshot(weddingDocRef, (snap)=>{
      if(!snap.exists()) return; // never auto-recreate here — see note above
      applyingRemoteUpdate = true;
      state = normalizeState(deepMerge(structuredClone(DEFAULT_DATA), snap.data()), user.uid);
      cacheLocally();
      renderAll();
      applyingRemoteUpdate = false;
    }, (err)=>{ console.error('Snapshot error', err); toast('Offline — showing last saved data'); });
  } else {
    document.body.classList.remove('authenticated');
    if(unsubscribeSnapshot){ unsubscribeSnapshot(); unsubscribeSnapshot = null; }
    weddingDocRef = null;
    state = structuredClone(DEFAULT_DATA);
    loginScreen.classList.remove('hidden');
  }
});

/* ---------------- Helpers ---------------- */
const uid = () => Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4);
const money = (n) => '₹' + Math.round(Number(n)||0).toLocaleString('en-IN');
const todayISO = () => new Date().toISOString().slice(0,10);
function formatDate(iso){ if(!iso) return ''; const d = new Date(iso+'T00:00:00'); return d.toLocaleDateString('en-GB', {day:'numeric', month:'long', year:'numeric'}); }
function formatDateShort(iso){ if(!iso) return ''; const d = new Date(iso+'T00:00:00'); return d.toLocaleDateString('en-GB', {day:'numeric', month:'short'}); }
function emptyState(title, sub){ return `<div class="empty-state"><svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="#8A7480" stroke-width="1.4"><circle cx="12" cy="12" r="9"/><path d="M9 10h.01M15 10h.01M8 15c1.2 1 2.5 1.5 4 1.5s2.8-.5 4-1.5"/></svg><div class="serif">${title}</div><div>${sub}</div></div>`; }
function escapeHtml(s){ return String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(s){ return escapeHtml(s); }
function vendorName(id){ const v = state.vendors.find(v=>v.id===id); return v ? v.name : ''; }
function animateCount(el, to){
  const from = 0; const dur = 600; const start = performance.now();
  function step(t){
    const p = Math.min(1, (t-start)/dur);
    const eased = 1 - Math.pow(1-p, 3);
    el.textContent = Math.round(from + (to-from)*eased).toLocaleString('en-IN');
    if(p<1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
function toast(msg){
  const t = document.getElementById('toast');
  document.getElementById('toastText').textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(()=>t.classList.remove('show'), 1900);
}

/* Visible to me if I own it, or it's explicitly shared with me. Items with no owner (very old data
   that somehow slipped past migration) are treated as visible to everyone rather than silently hidden. */
function canSee(entity, uid){
  if(!entity.ownerId) return true;
  if(entity.ownerId === uid) return true;
  return (entity.sharedWith||[]).includes(uid);
}
function visibleVendors(){ const me = myUid(); return state.vendors.filter(v=> canSee(v, me)); }
function visibleExpenses(){ const me = myUid(); return state.otherExpenses.filter(e=> canSee(e, me)); }
function visibleEvents(){ const me = myUid(); return (state.settings.events||[]).filter(e=> canSee(e, me)); }
function visibleGuests(){
  // Guests are visible when owned by the signed-in user or explicitly shared with them.
  // Defensive Array.isArray keeps older/partially migrated records from breaking the view.
  const me = myUid();
  const guests = Array.isArray(state.guests) ? state.guests : [];
  return guests.filter(g=>g && canSee(g, me));
}
function allPaymentsFlat(){
  const rows = [];
  state.vendors.forEach(v=> (v.payments||[]).forEach(p=> rows.push({ ...p, vendorId: v.id, vendorName: v.name, vendorVisible: canSee(v, myUid()) })));
  return rows;
}

/* ---------------- Navigation ---------------- */
document.querySelectorAll('.nav-btn').forEach(btn=>{ btn.addEventListener('click', ()=> switchView(btn.dataset.view)); });
function switchView(view){
  currentView = view;
  document.body.classList.toggle('dashboard-view', view === 'dashboard');
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById('view-'+view).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active', b.dataset.view===view));
  renderAll();
}
document.querySelectorAll('.dash-tab').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('.dash-tab').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.dash-pane').forEach(p=>p.classList.remove('active'));
    document.getElementById('dash-'+btn.dataset.dtab).classList.add('active');
  });
});

/* ---------------- Sheet ---------------- */
const backdrop = document.getElementById('sheetBackdrop');
const sheetContent = document.getElementById('sheetContent');
let sheetHistoryPushed = false;
let sheetCloseTimer = null;
function openSheet(html){
  clearTimeout(sheetCloseTimer);
  sheetContent.innerHTML = `<div class="sheet-handle"></div>` + html;
  backdrop.classList.add('active');
  document.body.classList.add('sheet-open');
  if(!sheetHistoryPushed){
    try{ history.pushState({ wedsecSheet: true }, ''); }catch(e){}
    sheetHistoryPushed = true;
  }
}
function closeSheet(){
  backdrop.classList.remove('active');
  document.body.classList.remove('sheet-open');
  // Deferred so a "close this sheet, immediately open a different one" chain (e.g. vendor -> record payment)
  // never actually leaves this history entry — the follow-up openSheet() cancels this timer first.
  if(sheetHistoryPushed){
    clearTimeout(sheetCloseTimer);
    sheetCloseTimer = setTimeout(()=>{
      if(sheetHistoryPushed && !backdrop.classList.contains('active')){
        sheetHistoryPushed = false;
        if(history.state && history.state.wedsecSheet) history.back();
      }
    }, 50);
  }
}
window.addEventListener('popstate', ()=>{
  // Android back button/gesture while a sheet is open: the browser has already consumed the
  // history entry we pushed, so just hide the sheet — never navigate again from here.
  if(backdrop.classList.contains('active')){
    backdrop.classList.remove('active');
    document.body.classList.remove('sheet-open');
    sheetHistoryPushed = false;
    clearTimeout(sheetCloseTimer);
  }
});
backdrop.addEventListener('click', e=>{ if(e.target===backdrop) closeSheet(); });

document.getElementById('fabAdd').addEventListener('click', ()=>{
  if(currentView==='tasks') openTaskForm();
  else if(currentView==='vendors') openVendorForm();
  else if(currentView==='guests') openGuestForm();
});

/* Reusable "share this with specific people" widget used by vendors/expenses/events */
function shareToggleHtml(entity, idPrefix){
  const chips = otherPeople().map(p=>`<button type="button" class="chip ${entity.sharedWith.includes(p.uid)?'active':''}" data-share-uid="${escapeAttr(p.uid)}">${escapeHtml(p.name)}</button>`).join('')
    || '<p class="item-meta">No one else has signed in yet — once they do, you can share with them here.</p>';
  return `
    <div class="toggle-row">
      <div><div class="toggle-label">Share this</div><div class="toggle-sub">Off = only you can see it</div></div>
      <label class="switch"><input type="checkbox" id="${idPrefix}_shared" ${entity.visibility==='shared'||entity.sharedWith.length?'checked':''}><span class="track"></span></label>
    </div>
    <div id="${idPrefix}ShareChipsWrap" style="display:${entity.sharedWith.length?'block':'none'};margin-bottom:8px;"><div class="chip-row">${chips}</div></div>
  `;
}
function wireShareToggle(entity, idPrefix){
  const toggle = document.getElementById(`${idPrefix}_shared`);
  const wrap = document.getElementById(`${idPrefix}ShareChipsWrap`);
  toggle.addEventListener('change', (e)=>{ wrap.style.display = e.target.checked ? 'block' : 'none'; if(!e.target.checked) entity.sharedWith = []; });
  sheetContent.querySelectorAll(`#${idPrefix}ShareChipsWrap [data-share-uid]`).forEach(chip=>{
    chip.addEventListener('click', ()=>{
      const uidVal = chip.dataset.shareUid;
      const idx = entity.sharedWith.indexOf(uidVal);
      if(idx>-1) entity.sharedWith.splice(idx,1); else entity.sharedWith.push(uidVal);
      chip.classList.toggle('active');
    });
  });
}

/* ================= DASHBOARD ================= */
function renderDashboard(){
  const wd = new Date(state.settings.weddingDate+'T00:00:00');
  const now = new Date();
  const days = Math.ceil((wd - now) / 86400000);
  const countEl = document.getElementById('countdownNum');
  if(!dashboardAnimated){ animateCount(countEl, Math.max(0,days)); dashboardAnimated = true; }
  else countEl.textContent = Math.max(0,days).toLocaleString('en-IN');
  document.getElementById('weddingDateLine').textContent = 'until ' + formatDate(state.settings.weddingDate) + (days<0 ? ' · date has passed' : '');
  document.getElementById('receptionDateLine').textContent = formatDate(state.settings.receptionDate);

  renderEventsBox();
  renderBudgetBox();

  const myGuests = visibleGuests();
  const totalPeople = myGuests.reduce((s,g)=>s + peopleBreakdown(g).reduce((x,p)=>x+p.count,0),0);
  const peopleCounts = { confirmed:0, pending:0, declined:0 };
  myGuests.forEach(g=> peopleBreakdown(g).forEach(p=> peopleCounts[p.status] += p.count));
  document.getElementById('statGuestTotal').textContent = totalPeople;
  document.getElementById('statGuestPeople').textContent = `across ${myGuests.length} invitation${myGuests.length===1?'':'s'}`;
  document.getElementById('statGuestConfirmed').textContent = peopleCounts.confirmed;
  document.getElementById('statGuestPending').textContent = peopleCounts.pending;
  document.getElementById('statGuestDeclined').textContent = peopleCounts.declined;

  const openTasks = state.tasks.filter(t=>t.status!=='done');
  const overdue = state.tasks.filter(t=> t.status!=='done' && t.dueDate && t.dueDate < todayISO());
  document.getElementById('statTaskOpen').textContent = openTasks.length;
  document.getElementById('statTaskOverdue').textContent = overdue.length;
  document.getElementById('statTaskDone').textContent = state.tasks.filter(t=>t.status==='done').length;
  document.getElementById('statTaskTotal').textContent = state.tasks.length;

  const alertsBox = document.getElementById('alertsBox');
  const alerts = [];
  overdue.forEach(t=> alerts.push({type:'task', text:`Task overdue: "${t.title}"`}));
  visibleVendors().forEach(v=>{
    const contract = Number(v.contract)||0;
    const paidV = (v.payments||[]).filter(p=>p.status==='paid').reduce((s,x)=>s+Number(x.amount||0),0);
    if(contract>0 && paidV < contract) alerts.push({type:'vendor', text:`${v.name}: ${money(contract-paidV)} still due`});
  });
  visibleVendors().forEach(v=>{
    (v.payments||[]).filter(p=>p.status==='planned').forEach(p=>{
      if(p.plannedDate && p.plannedDate <= addDays(todayISO(),14)) alerts.push({type:'vendor', text:`${v.name}: planned payment of ${money(p.amount)} due ${formatDateShort(p.plannedDate)}`});
    });
  });
  if(days>=0 && days<=14){
    const pendingGuests = visibleGuests().filter(g=>Object.values(g.eventStatus||{}).some(s=>s==='pending')).length;
    if(pendingGuests>0) alerts.push({type:'guests', text:`${pendingGuests} guests haven't responded — wedding is ${days} days away`});
  }
  alertsBox.innerHTML='';
  if(alerts.length===0){ alertsBox.innerHTML = `<div class="alert empty">Nothing urgent — you're on top of things.</div>`; }
  else {
    alerts.slice(0,6).forEach(a=>{
      const div = document.createElement('div');
      div.className='alert';
      div.textContent = '⚠️ ' + a.text;
      div.addEventListener('click', ()=>{ if(a.type==='task') switchView('tasks'); else if(a.type==='vendor') switchView('finance'); else if(a.type==='guests') switchView('guests'); });
      alertsBox.appendChild(div);
    });
  }
}
function addDays(iso, n){ const d = new Date(iso+'T00:00:00'); d.setDate(d.getDate()+n); return d.toISOString().slice(0,10); }

function renderEventsBox(){
  const box = document.getElementById('eventsBox');
  const events = [...visibleEvents()].sort((a,b)=> (a.date||'').localeCompare(b.date||''));
  if(events.length===0){ box.innerHTML = emptyState('No events yet', 'Add Haldi, Wedding, Reception and more in Settings.'); return; }
  const pinIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 21s-6-5.5-6-10a6 6 0 0112 0c0 4.5-6 10-6 10z"/><circle cx="12" cy="11" r="2.2"/></svg>`;
  box.innerHTML = events.map(ev=>{
    const myGuests = visibleGuests();
    const count = eventHeadcount(ev.id);
    const bashorCount = ev.isMainWedding ? eventHeadcount(ev.id, true) : 0;
    return `<div class="event-card">
      <div class="event-top">
        <div class="event-name">${escapeHtml(ev.name)}${ev.sharedWith && ev.sharedWith.length ? ` <span class="event-shared">Shared</span>`:''}</div>
        <div class="event-when">${ev.date? formatDateShort(ev.date):''}${ev.time? ' · '+ev.time:''}</div>
      </div>
      ${ev.venue || ev.address ? `<div class="event-meta">${pinIcon}<span>${escapeHtml(ev.venue)}${ev.venue && ev.address? ' — ':''}${escapeHtml(ev.address)}</span></div>` : ''}
      <div class="event-count" data-show-attendees="${ev.id}">🎉 ${count} guests expected</div>
      ${ev.isMainWedding ? `<span class="event-bashor" data-show-bashor="${ev.id}">🌙 ${bashorCount} staying for Bashor Raat</span>` : ''}
    </div>`;
  }).join('');
  box.querySelectorAll('[data-show-attendees]').forEach(el=>{
    el.addEventListener('click', ()=> openEventAttendeesPopup(el.dataset.showAttendees, false));
  });
  box.querySelectorAll('[data-show-bashor]').forEach(el=>{
    el.addEventListener('click', ()=> openEventAttendeesPopup(el.dataset.showBashor, true));
  });
}
function attendeesForEvent(eventId, bashorOnly){
  const rows = [];
  visibleGuests().forEach(g=>{
    if((g.events||[]).includes(eventId) && (!bashorOnly || g.bashorRaat)){
      rows.push({ guestId:g.id, personId:g.id, isMain:true, name:g.name, count:mainGuestHeadcount(g), tag:g.tag||'', phone:g.phone||'', notes:g.notes||'', status:(g.eventStatus||{})[eventId]||'pending', familyOf:'' });
    }
    (Array.isArray(g.family)?g.family:[]).forEach(m=>{
      if((m.events||[]).includes(eventId) && (!bashorOnly || m.bashorRaat)){
        rows.push({ guestId:g.id, personId:m.id, isMain:false, name:m.name, count:1, tag:g.tag||'', phone:'', notes:'', status:(m.eventStatus||{})[eventId]||'pending', familyOf:g.name });
      }
    });
  });
  const byTag = new Map();
  rows.forEach(r=>{ const tag=r.tag||'No Description Tag'; if(!byTag.has(tag)) byTag.set(tag,[]); byTag.get(tag).push(r); });
  const ordered=[];
  [...byTag.entries()].sort((a,b)=>a[0].localeCompare(b[0])).forEach(([,items])=>{
    const mains=items.filter(r=>r.isMain).sort((a,b)=>a.name.localeCompare(b.name));
    mains.forEach(main=>{ ordered.push(main); items.filter(r=>!r.isMain && r.guestId===main.guestId).forEach(m=>ordered.push(m)); });
  });
  return ordered;
}
function openEventAttendeesPopup(eventId, bashorOnly){
  const ev = eventById(eventId);
  if(!ev) return;
  const rows = attendeesForEvent(eventId, bashorOnly);
  const total = rows.reduce((s,r)=>s+r.count,0);
  const groups = new Map();
  rows.forEach(r=>{ const key=r.tag || 'No Description Tag'; if(!groups.has(key)) groups.set(key,[]); groups.get(key).push(r); });
  const htmlGroups = Array.from(groups.entries()).map(([tag,items])=>`
    <div class="section-title" style="margin-top:14px;">${escapeHtml(tag)} <span style="font-weight:400;">— ${items.reduce((s,r)=>s+r.count,0)}</span></div>
    <div class="list">${items.map(r=>`<div class="item" style="padding:12px 14px;">
      <div class="item-top"><div><div class="item-title">${escapeHtml(r.name)}${r.isMain&&r.count>1?` <span class="tag-badge">${r.count} people</span>`:''}</div>
      ${r.tag?`<div class="item-meta">${escapeHtml(r.tag)}</div>`:''}
      ${!r.isMain?`<div class="item-meta">family member of ${escapeHtml(r.familyOf)}</div>`:''}
      </div><span class="badge ${r.status}">${escapeHtml(r.status)}</span></div>
      ${r.isMain && r.notes?`<div class="item-meta">${escapeHtml(r.notes)}</div>`:''}
    </div>`).join('')}</div>`).join('');
  openSheet(`
    <h3 class="serif">${escapeHtml(ev.name)} guests</h3>
    <p class="sheet-sub">${total} guest${total===1?'':'s'} ${bashorOnly?'staying over':'expected'} · ${rows.length} guest entr${rows.length===1?'y':'ies'}</p>
    ${rows.length ? htmlGroups : emptyState('No one yet', bashorOnly ? 'No guests marked for Bashor Raat.' : 'No guests invited to this event yet.')}
    <div class="sheet-actions"><button class="btn btn-ghost" id="closeAttendeesBtn">Close</button></div>`);
  document.getElementById('closeAttendeesBtn').onclick=closeSheet;
}


function renderBudgetBox(){
  const box = document.getElementById('budgetBox');
  const vendors = visibleVendors();
  let contracted=0, paid=0, scheduled=0;
  vendors.forEach(v=>{
    contracted += Number(v.contract)||0;
    (v.payments||[]).forEach(p=> p.status==='paid' ? paid += Number(p.amount||0) : scheduled += Number(p.amount||0));
  });
  const hiddenCount = state.vendors.length - vendors.length;
  box.innerHTML = `
    <div class="hero-stat">
      <div class="label">Remaining to pay${hiddenCount? ' (visible to you)':''}</div>
      <div class="value">${money(contracted-paid)}</div>
    </div>
    <div class="stat-strip">
      <div><div class="label">Contracted</div><div class="value">${money(contracted)}</div></div>
      <div><div class="label">Paid</div><div class="value">${money(paid)}</div></div>
      <div><div class="label">Planned</div><div class="value">${money(scheduled)}</div></div>
    </div>
    ${hiddenCount ? `<div class="item-meta" style="margin-top:8px;">${hiddenCount} vendor${hiddenCount===1?'':'s'} not shared with you aren't included above.</div>` : ''}
  `;
}

/* ================= TASKS (shared between everyone) ================= */
let taskFilter = 'all';
document.querySelectorAll('#taskFilter .seg-btn').forEach(b=>{
  b.addEventListener('click', ()=>{
    taskFilter = b.dataset.f;
    document.querySelectorAll('#taskFilter .seg-btn').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    renderTasks();
  });
});
function taskStatusOf(t){
  if(t.status==='done') return 'done';
  if(t.status==='progress') return 'progress';
  if(t.dueDate && t.dueDate < todayISO()) return 'overdue';
  return 'pending';
}
function renderTasks(){
  const list = document.getElementById('taskList');
  let items = [...state.tasks].sort((a,b)=> (a.dueDate||'9999').localeCompare(b.dueDate||'9999'));
  if(taskFilter!=='all') items = items.filter(t=> taskStatusOf(t)===taskFilter);
  list.innerHTML='';
  if(items.length===0){ list.innerHTML = emptyState('No tasks here', 'Tap + to add your first task.'); return; }
  items.forEach(t=>{
    const st = taskStatusOf(t);
    const el = document.createElement('div');
    el.className='item';
    el.innerHTML = `
      <div class="item-row">
        <div class="check-circle ${t.status==='done'?'checked':''}" data-check="${t.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3"><path d="M4 12l5 5L20 6"/></svg>
        </div>
        <div class="item-body">
          <div class="item-top">
            <div>
              <div class="item-title ${t.status==='done'?'is-done':''}"><span class="priority-dot p-${t.priority}"></span>${escapeHtml(t.title)}</div>
              <div class="item-meta">${t.dueDate ? formatDate(t.dueDate) : 'No due date'}${t.vendorId? ' · '+escapeHtml(vendorName(t.vendorId)) : ''}</div>
            </div>
            <span class="badge ${st}">${statusLabel(st)}</span>
          </div>
        </div>
      </div>`;
    el.addEventListener('click', (e)=>{ if(e.target.closest('[data-check]')) return; openTaskForm(t); });
    el.querySelector('[data-check]').addEventListener('click', (e)=>{
      e.stopPropagation();
      t.status = t.status==='done' ? 'pending' : 'done';
      t.completedDate = t.status==='done' ? todayISO() : '';
      saveData(); renderAll();
    });
    list.appendChild(el);
  });
}
function statusLabel(s){ return {pending:'Pending', progress:'In Progress', overdue:'Overdue', done:'Completed'}[s] || s; }

function openTaskForm(task){
  const isEdit = !!task;
  task = task || { id: uid(), title:'', notes:'', status:'pending', priority:'medium', dueDate:'', vendorId:'' };
  const vendorOptions = ['<option value="">— none —</option>'].concat(
    state.vendors.map(v=>`<option value="${v.id}" ${v.id===task.vendorId?'selected':''}>${escapeHtml(v.name)}</option>`)
  ).join('');
  openSheet(`
    <h3 class="serif">${isEdit?'Edit task':'New task'}</h3>
    <div class="field"><label>Title</label><input id="f_title" value="${escapeAttr(task.title)}" placeholder="e.g. Confirm photographer arrival time"></div>
    <div class="field-row">
      <div class="field"><label>Priority</label>
        <select id="f_priority">${['low','medium','high','critical'].map(p=>`<option value="${p}" ${p===task.priority?'selected':''}>${p[0].toUpperCase()+p.slice(1)}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Status</label>
        <select id="f_status">
          <option value="pending" ${task.status==='pending'?'selected':''}>Pending</option>
          <option value="progress" ${task.status==='progress'?'selected':''}>In Progress</option>
          <option value="done" ${task.status==='done'?'selected':''}>Completed</option>
        </select>
      </div>
    </div>
    <div class="field-row">
      <div class="field"><label>Due date</label><input type="date" id="f_due" value="${task.dueDate||''}"></div>
      <div class="field"><label>Related vendor</label><select id="f_vendor">${vendorOptions}</select></div>
    </div>
    <div class="field"><label>Notes</label><textarea id="f_notes" placeholder="Optional">${escapeHtml(task.notes||'')}</textarea></div>
    <div class="sheet-actions">
      ${isEdit? '<button class="btn btn-danger" id="deleteBtn">Delete</button>' : ''}
      <button class="btn btn-ghost" id="cancelBtn">Cancel</button>
      <button class="btn btn-primary" id="saveBtn">Save</button>
    </div>
  `);
  document.getElementById('cancelBtn').onclick = closeSheet;
  if(isEdit) document.getElementById('deleteBtn').onclick = ()=>{
    state.tasks = state.tasks.filter(t=>t.id!==task.id);
    saveData(); closeSheet(); renderAll(); toast('Task deleted');
  };
  document.getElementById('saveBtn').onclick = ()=>{
    const title = document.getElementById('f_title').value.trim();
    if(!title){ toast('Please enter a title'); return; }
    task.title = title;
    task.priority = document.getElementById('f_priority').value;
    task.status = document.getElementById('f_status').value;
    task.dueDate = document.getElementById('f_due').value;
    task.vendorId = document.getElementById('f_vendor').value;
    task.notes = document.getElementById('f_notes').value;
    if(!isEdit) state.tasks.push(task);
    saveData(); closeSheet(); renderAll(); toast('Task saved');
  };
}

/* ================= VENDORS (private by default, shareable) ================= */
function renderVendors(){
  const list = document.getElementById('vendorList');
  list.innerHTML='';
  if(state.vendors.length===0){ list.innerHTML = emptyState('No vendors yet', 'Tap + to add a photographer, venue, caterer...'); return; }
  const me = myUid();
  state.vendors.forEach(v=>{
    const canSeeIt = canSee(v, me);
    const paid = (v.payments||[]).filter(p=>p.status==='paid').reduce((s,p)=>s+Number(p.amount||0),0);
    const contract = Number(v.contract)||0;
    const pct = contract>0 ? Math.min(100, Math.round(paid/contract*100)) : 0;
    const el = document.createElement('div');
    el.className='item';
    el.innerHTML = `
      <div class="item-top">
        <div>
          <div class="item-title">${escapeHtml(v.name)}</div>
          <div class="item-meta">${escapeHtml(v.category||'Uncategorized')}${v.phone? ' · '+escapeHtml(v.phone):''}</div>
        </div>
        ${v.sharedWith && v.sharedWith.length ? `<span class="badge" style="background:#DFF3EC;color:var(--sage);">Shared</span>` : ''}
      </div>
      ${canSeeIt ? `
        <div class="vendor-money">
          <div>Contract<b>${money(contract)}</b></div>
          <div>Paid<b>${money(paid)}</b></div>
          <div>Remaining<b>${money(contract-paid)}</b></div>
        </div>
        <div class="progress-bar"><div style="width:${pct}%;"></div></div>
      ` : `<div class="item-meta" style="margin-top:8px;">🔒 Finance details are private</div>`}
    `;
    el.addEventListener('click', ()=> openVendorForm(v));
    list.appendChild(el);
  });
}
function openVendorForm(vendor){
  const isEdit = !!vendor;
  vendor = vendor || { id: uid(), name:'', category:'', contact:'', phone:'', contract:0, payments:[], documents:[], sharedWith:[], ownerId: myUid() };
  vendor.documents = vendor.documents || [];
  vendor.payments = vendor.payments || [];
  vendor.sharedWith = vendor.sharedWith || [];
  if(!vendor.ownerId) vendor.ownerId = myUid();

  const canSeeIt = canSee(vendor, myUid());
  const paid = vendor.payments.filter(p=>p.status==='paid').reduce((s,p)=>s+Number(p.amount||0),0);

  const paymentsHtml = vendor.payments.length ? vendor.payments.slice(0,5).map(p=>`
    <div class="item" style="padding:10px 12px;" data-open-payment="${p.id}">
      <div class="item-top">
        <div class="item-meta">${escapeHtml(p.payer||'—')} · ${p.status==='paid' ? formatDateShort(p.date) : 'Planned · '+formatDateShort(p.plannedDate)}</div>
        <b>${money(p.amount)}</b>
      </div>
    </div>`).join('') + (vendor.payments.length>5 ? `<div class="item-meta">+${vendor.payments.length-5} more — see Finance tab</div>` : '')
    : '<div class="item-meta" style="margin-bottom:8px;">No payments recorded yet.</div>';

  const docsHtml = vendor.documents.length ? vendor.documents.map(d=>`
    <div class="doc-item">
      <a href="${d.url}" target="_blank" rel="noopener">${escapeHtml(d.name)}</a>
      <button type="button" class="btn btn-danger btn-sm" data-doc-id="${escapeAttr(d.publicId)}">Delete</button>
    </div>
  `).join('') : '<div class="item-meta" style="margin-bottom:8px;">No documents yet — add a bill, contract, or screenshot below.</div>';

  openSheet(`
    <h3 class="serif">${isEdit?'Edit vendor':'New vendor'}</h3>
    ${isEdit && vendor.ownerId!==myUid() ? `<p class="sheet-sub">Added by ${escapeHtml(nameFor(vendor.ownerId))}, shared with you.</p>` : ''}
    <div class="field"><label>Name</label><input id="v_name" value="${escapeAttr(vendor.name)}" placeholder="e.g. Sharma Studios"></div>
    <div class="field-row">
      <div class="field"><label>Category</label><input id="v_category" value="${escapeAttr(vendor.category)}" placeholder="Photography, Catering..."></div>
      <div class="field"><label>Phone</label><input id="v_phone" value="${escapeAttr(vendor.phone)}"></div>
    </div>
    <div class="field"><label>Contact person</label><input id="v_contact" value="${escapeAttr(vendor.contact)}"></div>
    <div class="field"><label>Contract amount (₹)</label><input type="number" id="v_contract" value="${vendor.contract||0}"></div>

    <div class="section-title" style="margin-top:16px;">Sharing</div>
    ${shareToggleHtml(vendor, 'v')}

    ${isEdit && canSeeIt ? `
    <div class="section-title" style="margin-top:16px;">Payments — ${money(paid)} of ${money(vendor.contract)} paid</div>
    ${paymentsHtml}
    <button class="btn btn-gold" id="goRecordPaymentBtn" style="width:100%;margin-top:8px;">Record a payment for this vendor →</button>
    ` : isEdit ? `<div class="section-title" style="margin-top:16px;">Payments</div><div class="item-meta">🔒 Private to ${escapeHtml(nameFor(vendor.ownerId))}</div>` : ''}

    ${isEdit ? `
    <div class="section-title" style="margin-top:16px;">Documents</div>
    <div id="docsList">${docsHtml}</div>
    <label class="btn btn-ghost" id="docUploadLabel" style="width:100%;display:block;text-align:center;margin-top:8px;">
      Add document (photo, PDF, screenshot)
      <input type="file" id="docFileInput" accept="image/*,application/pdf" style="display:none;">
    </label>
    <div class="login-error" id="docError" style="color:var(--danger);"></div>
    ` : ''}

    <div class="sheet-actions">
      ${isEdit? '<button class="btn btn-danger" id="deleteBtn">Delete</button>' : ''}
      <button class="btn btn-ghost" id="cancelBtn">Cancel</button>
      <button class="btn btn-primary" id="saveBtn">Save</button>
    </div>
  `);
  document.getElementById('cancelBtn').onclick = closeSheet;
  wireShareToggle(vendor, 'v');
  sheetContent.querySelectorAll('[data-open-payment]').forEach(row=>{
    row.addEventListener('click', ()=>{ const p = vendor.payments.find(x=>x.id===row.dataset.openPayment); if(p) openPaymentDetail(p, vendor); });
  });
  const goBtn = document.getElementById('goRecordPaymentBtn');
  if(goBtn) goBtn.onclick = ()=>{ closeSheet(); openRecordPaymentSheet(vendor.id); };
  if(isEdit){
    document.getElementById('deleteBtn').onclick = ()=>{
      state.vendors = state.vendors.filter(x=>x.id!==vendor.id);
      saveData(); closeSheet(); renderAll(); toast('Vendor deleted');
    };
    document.getElementById('docFileInput').addEventListener('change', (e)=> handleDocUpload(e, vendor));
    document.querySelectorAll('[data-doc-id]').forEach(btn=>{ btn.addEventListener('click', ()=> handleDocDelete(btn.dataset.docId, vendor)); });
  }
  document.getElementById('saveBtn').onclick = ()=>{
    const name = document.getElementById('v_name').value.trim();
    if(!name){ toast('Please enter a name'); return; }
    vendor.name = name;
    vendor.category = document.getElementById('v_category').value;
    vendor.phone = document.getElementById('v_phone').value;
    vendor.contact = document.getElementById('v_contact').value;
    vendor.contract = Number(document.getElementById('v_contract').value)||0;
    if(!isEdit) state.vendors.push(vendor);
    saveData(); closeSheet(); renderAll(); toast('Vendor saved');
  };
}

const MAX_DOC_SIZE = 8 * 1024 * 1024;
function handleDocUpload(e, vendor){
  const file = e.target.files[0];
  e.target.value = '';
  if(!file) return;
  const errEl = document.getElementById('docError');
  errEl.textContent = '';
  if(file.size > MAX_DOC_SIZE){ errEl.textContent = 'That file is too large — please keep uploads under 8MB.'; return; }
  if(CLOUDINARY_CLOUD_NAME.startsWith('PASTE_')){ errEl.textContent = 'Document uploads need Cloudinary set up first — see README.md.'; return; }
  const label = document.getElementById('docUploadLabel');
  label.textContent = 'Uploading…';
  uploadToCloudinary(file)
    .then(data => {
      vendor.documents = vendor.documents || [];
      vendor.documents.push({ name: file.name, url: data.secure_url, publicId: data.public_id, bytes: data.bytes, uploadedAt: todayISO() });
      saveData(); toast('Document added');
      openVendorForm(vendor);
    })
    .catch(err => {
      console.error(err); errEl.textContent = 'Upload failed — check your connection and Cloudinary setup.';
      label.textContent = 'Add document (photo, PDF, screenshot)';
    });
}
function uploadToCloudinary(file){
  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
  return fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/auto/upload`, { method: 'POST', body: formData })
    .then(res => res.ok ? res.json() : res.json().then(j => Promise.reject(new Error(j.error?.message || 'Upload failed'))));
}
function handleDocDelete(publicId, vendor){
  if(!confirm('Remove this document from the vendor? (It stays stored on Cloudinary, but will no longer show here.)')) return;
  vendor.documents = (vendor.documents||[]).filter(d=>d.publicId!==publicId);
  saveData(); toast('Document removed'); openVendorForm(vendor);
}

/* ---------------- Storage usage (tracked app-side; Cloudinary's real usage API needs a
   secret key, which can't be called safely from the browser) ---------------- */
const CLOUDINARY_FREE_LIMIT_BYTES = 25 * 1024 * 1024 * 1024; // 25GB free tier
function bytesToSize(bytes){
  if(!bytes) return 'size unknown';
  const units = ['B','KB','MB','GB'];
  let n = bytes, i = 0;
  while(n >= 1024 && i < units.length-1){ n/=1024; i++; }
  return `${n.toFixed(i===0?0:1)} ${units[i]}`;
}
function allDocuments(){
  const docs = [];
  state.vendors.forEach(v=>{
    (v.documents||[]).forEach(d=> docs.push({ ...d, context: v.name, url:d.url, deleteFn: ()=>{ v.documents = v.documents.filter(x=>x.publicId!==d.publicId); saveData(); renderAll(); toast('Document removed'); } }));
    (v.payments||[]).forEach(p=> (p.documents||[]).forEach(d=> docs.push({ ...d, context: `${v.name} — ${money(p.amount)} (${p.status})`, url:d.url, deleteFn: ()=>{ p.documents = p.documents.filter(x=>x.publicId!==d.publicId); saveData(); renderAll(); toast('Receipt removed'); } })));
  });
  return docs;
}
function renderStorage(){
  const box = document.getElementById('storageBox');
  if(!box) return;
  const docs = allDocuments();
  const totalBytes = docs.reduce((s,d)=>s+(Number(d.bytes)||0),0);
  const pct = Math.min(100, (totalBytes/CLOUDINARY_FREE_LIMIT_BYTES)*100);
  const unknownCount = docs.filter(d=>!d.bytes).length;
  box.innerHTML = `
    <div class="hero-stat" style="margin-top:0;">
      <div class="label">Used of 25 GB free tier</div>
      <div class="value">${bytesToSize(totalBytes)}</div>
    </div>
    <div class="progress-bar" style="margin-top:10px;height:8px;"><div style="width:${pct.toFixed(2)}%;"></div></div>
    ${unknownCount ? `<div class="item-meta" style="margin-top:8px;">${unknownCount} file${unknownCount===1?'':'s'} uploaded before this feature existed don't have a recorded size — they're not counted above but still use real Cloudinary storage.</div>` : ''}
    <div class="section-title" style="margin-top:18px;">Files (${docs.length})</div>
    <div class="list" id="storageFileList"></div>
  `;
  const list = document.getElementById('storageFileList');
  if(docs.length===0){ list.innerHTML = emptyState('No files yet','Documents attached to vendors or payments will show up here.'); return; }
  docs.sort((a,b)=> (b.bytes||0)-(a.bytes||0));
  docs.forEach(d=>{
    const el = document.createElement('div');
    el.className='item';
    el.innerHTML = `
      <div class="item-top">
        <div style="min-width:0;"><div class="item-title" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(d.name)}</div><div class="item-meta">${escapeHtml(d.context)}</div></div>
        <div style="text-align:right;flex:none;"><div style="font-weight:700;font-size:13px;">${bytesToSize(d.bytes)}</div></div>
      </div>`;
    el.addEventListener('click', ()=> window.open(d.url, '_blank', 'noopener'));
    list.appendChild(el);
  });
}

/* ================= FINANCE ================= */
document.getElementById('recordPaymentBtn').addEventListener('click', ()=> openRecordPaymentSheet());
document.getElementById('addOtherExpenseBtn').addEventListener('click', ()=> openExpenseForm());

function renderFinance(){
  const me = myUid();
  const vendors = visibleVendors();
  let contracted=0, paid=0, scheduled=0;
  vendors.forEach(v=>{
    contracted += Number(v.contract)||0;
    (v.payments||[]).forEach(p=> p.status==='paid' ? paid += Number(p.amount||0) : scheduled += Number(p.amount||0));
  });

  document.getElementById('financeOverviewBox').innerHTML = `
    <div class="stat-grid">
      <div class="stat-card"><div class="label">Contracted</div><div class="value">${money(contracted)}</div></div>
      <div class="stat-card"><div class="label">Paid</div><div class="value">${money(paid)}</div></div>
      <div class="stat-card"><div class="label">Planned</div><div class="value">${money(scheduled)}</div></div>
      <div class="stat-card"><div class="label">Remaining</div><div class="value">${money(contracted-paid)}</div></div>
    </div>
  `;

  const payments = allPaymentsFlat().filter(p=>p.vendorVisible).sort((a,b)=>{
    const da = a.status==='paid'? a.date : a.plannedDate;
    const db = b.status==='paid'? b.date : b.plannedDate;
    return (db||'').localeCompare(da||'');
  });
  const pList = document.getElementById('paymentsList');
  pList.innerHTML='';
  if(payments.length===0){ pList.innerHTML = emptyState('No payments yet', 'Tap "Record payment" above to log one.'); }
  payments.forEach(p=>{
    const el = document.createElement('div');
    el.className='item';
    el.innerHTML = `
      <div class="item-top">
        <div>
          <div class="item-title">${escapeHtml(p.vendorName)}</div>
          <div class="item-meta">${p.status==='paid' ? `Paid by ${escapeHtml(p.payer||'—')} · ${formatDateShort(p.date)}` : `Planned for ${formatDateShort(p.plannedDate)}`}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-family:'Fraunces',serif;font-weight:600;">${money(p.amount)}</div>
          <span class="badge ${p.status}">${p.status==='paid'?'Paid':'Planned'}</span>
        </div>
      </div>`;
    el.addEventListener('click', ()=>{
      const vendor = state.vendors.find(v=>v.id===p.vendorId);
      const payment = vendor.payments.find(x=>x.id===p.id);
      openPaymentDetail(payment, vendor);
    });
    pList.appendChild(el);
  });

  const vlist = document.getElementById('financeVendorList');
  vlist.innerHTML='';
  if(state.vendors.length===0){ vlist.innerHTML = emptyState('No vendors yet','Add vendors in the Vendors tab to track contracts.'); }
  state.vendors.forEach(v=>{
    const canSeeIt = canSee(v, me);
    const p = (v.payments||[]).filter(x=>x.status==='paid').reduce((s,x)=>s+Number(x.amount||0),0);
    const el = document.createElement('div');
    el.className='item';
    el.innerHTML = `<div class="item-top"><div class="item-title">${escapeHtml(v.name)}</div><b>${canSeeIt ? money(p)+' / '+money(v.contract) : '🔒 Private'}</b></div>`;
    el.addEventListener('click', ()=> openVendorForm(v));
    vlist.appendChild(el);
  });

  const olist = document.getElementById('otherExpenseList');
  olist.innerHTML='';
  const others = visibleExpenses();
  if(others.length===0){ olist.innerHTML = emptyState('No other expenses','Things not tied to a vendor — e.g. mehndi artist, small purchases.'); }
  others.forEach(e=>{
    const el = document.createElement('div');
    el.className='item';
    el.innerHTML = `<div class="item-top"><div><div class="item-title">${escapeHtml(e.name)}</div><div class="item-meta">${e.date? formatDateShort(e.date):''}</div></div><b>${money(e.amount)}</b></div>`;
    el.addEventListener('click', ()=> openExpenseForm(e));
    olist.appendChild(el);
  });
}

function openRecordPaymentSheet(preselectVendorId){
  if(state.vendors.length===0){ toast('Add a vendor first'); return; }
  const vendorOptions = state.vendors.map(v=>`<option value="${v.id}" ${v.id===preselectVendorId?'selected':''}>${escapeHtml(v.name)}</option>`).join('');
  const payerOptions = directoryList().map(p=>`<option value="${escapeAttr(p.name)}">${escapeHtml(p.name)}</option>`).join('');
  openSheet(`
    <h3 class="serif">Record a payment</h3>
    <p class="sheet-sub">This logs a transaction against a vendor's contract — mark it as already paid, or planned for later.</p>
    <div class="field"><label>Vendor</label><select id="p_vendor">${vendorOptions}</select></div>
    <div class="field"><label>Amount (₹)</label><input type="number" id="p_amount" placeholder="0"></div>
    <div class="status-toggle">
      <button type="button" class="paid active" data-status="paid">Already paid</button>
      <button type="button" class="planned" data-status="planned">Planned for later</button>
    </div>
    <div id="paidFields">
      <div class="field-row">
        <div class="field"><label>Paid by</label><select id="p_payer">${payerOptions}</select></div>
        <div class="field"><label>Date paid</label><input type="date" id="p_date" value="${todayISO()}"></div>
      </div>
    </div>
    <div id="plannedFields" style="display:none;"><div class="field"><label>Expected date</label><input type="date" id="p_planned_date" value="${todayISO()}"></div></div>
    <div class="field"><label>Note</label><input id="p_note" placeholder="Optional"></div>
    <div class="sheet-actions">
      <button class="btn btn-ghost" id="cancelBtn">Cancel</button>
      <button class="btn btn-primary" id="saveBtn">Save payment</button>
    </div>
  `);
  document.getElementById('cancelBtn').onclick = closeSheet;
  let status = 'paid';
  sheetContent.querySelectorAll('.status-toggle button').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      status = btn.dataset.status;
      sheetContent.querySelectorAll('.status-toggle button').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('paidFields').style.display = status==='paid' ? 'block' : 'none';
      document.getElementById('plannedFields').style.display = status==='planned' ? 'block' : 'none';
    });
  });
  document.getElementById('saveBtn').onclick = ()=>{
    const vendorId = document.getElementById('p_vendor').value;
    const vendor = state.vendors.find(v=>v.id===vendorId);
    const amount = Number(document.getElementById('p_amount').value);
    if(!amount){ toast('Enter an amount'); return; }
    const payment = {
      id: uid(), amount, status,
      payer: status==='paid' ? document.getElementById('p_payer').value : '',
      date: status==='paid' ? document.getElementById('p_date').value : '',
      plannedDate: status==='planned' ? document.getElementById('p_planned_date').value : '',
      note: document.getElementById('p_note').value,
      documents: []
    };
    vendor.payments = vendor.payments || [];
    vendor.payments.push(payment);
    saveData(); closeSheet(); renderAll();
    toast(status==='paid' ? 'Payment recorded' : 'Planned payment added');
  };
}

function openPaymentDetail(payment, vendor){
  const docsHtml = (payment.documents||[]).length ? payment.documents.map(d=>`
    <div class="doc-item"><a href="${d.url}" target="_blank" rel="noopener">${escapeHtml(d.name)}</a>
      <button type="button" class="btn btn-danger btn-sm" data-pdoc-id="${escapeAttr(d.publicId)}">Delete</button></div>`).join('')
    : '<div class="item-meta" style="margin-bottom:8px;">No receipt attached yet.</div>';

  openSheet(`
    <h3 class="serif">${escapeHtml(vendor.name)}</h3>
    <p class="sheet-sub">${money(payment.amount)} · ${payment.status==='paid' ? 'Paid' : 'Planned'}</p>
    ${payment.status==='planned' ? `
      <div class="field"><label>Expected date</label><input type="date" id="pd_planned" value="${payment.plannedDate||''}"></div>
      <button class="btn btn-gold" id="markPaidBtn" style="width:100%;margin-bottom:14px;">Mark as paid now</button>
    ` : `
      <div class="field-row">
        <div class="field"><label>Paid by</label><select id="pd_payer">${directoryList().map(p=>`<option value="${escapeAttr(p.name)}" ${p.name===payment.payer?'selected':''}>${escapeHtml(p.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Date paid</label><input type="date" id="pd_date" value="${payment.date||''}"></div>
      </div>
    `}
    <div class="field"><label>Amount (₹)</label><input type="number" id="pd_amount" value="${payment.amount}"></div>
    <div class="field"><label>Note</label><input id="pd_note" value="${escapeAttr(payment.note||'')}"></div>
    <div class="section-title" style="margin-top:4px;">Receipt / bill</div>
    <div id="paymentDocsList">${docsHtml}</div>
    <label class="btn btn-ghost" id="paymentDocUploadLabel" style="width:100%;display:block;text-align:center;margin-top:4px;">
      Attach receipt (photo or PDF)
      <input type="file" id="paymentDocInput" accept="image/*,application/pdf" style="display:none;">
    </label>
    <div class="login-error" id="paymentDocError"></div>
    <div class="sheet-actions">
      <button class="btn btn-danger" id="deletePaymentBtn">Delete</button>
      <button class="btn btn-ghost" id="cancelBtn">Close</button>
      <button class="btn btn-primary" id="savePaymentBtn">Save</button>
    </div>
  `);
  document.getElementById('cancelBtn').onclick = closeSheet;
  document.getElementById('deletePaymentBtn').onclick = ()=>{
    vendor.payments = vendor.payments.filter(p=>p.id!==payment.id);
    saveData(); closeSheet(); renderAll(); toast('Payment deleted');
  };
  const markPaidBtn = document.getElementById('markPaidBtn');
  if(markPaidBtn) markPaidBtn.onclick = ()=>{
    payment.status = 'paid'; payment.date = todayISO(); payment.payer = nameFor(myUid());
    saveData(); closeSheet(); renderAll(); toast('Marked as paid');
  };
  document.getElementById('savePaymentBtn').onclick = ()=>{
    payment.amount = Number(document.getElementById('pd_amount').value) || payment.amount;
    payment.note = document.getElementById('pd_note').value;
    if(payment.status==='planned'){ payment.plannedDate = document.getElementById('pd_planned').value; }
    else { payment.payer = document.getElementById('pd_payer').value; payment.date = document.getElementById('pd_date').value; }
    saveData(); closeSheet(); renderAll(); toast('Payment updated');
  };
  document.getElementById('paymentDocInput').addEventListener('change', (e)=>{
    const file = e.target.files[0];
    e.target.value = '';
    if(!file) return;
    const errEl = document.getElementById('paymentDocError');
    errEl.textContent = '';
    if(file.size > MAX_DOC_SIZE){ errEl.textContent = 'Please keep files under 8MB.'; return; }
    if(CLOUDINARY_CLOUD_NAME.startsWith('PASTE_')){ errEl.textContent = 'Uploads need Cloudinary set up first — see README.md.'; return; }
    const label = document.getElementById('paymentDocUploadLabel');
    label.textContent = 'Uploading…';
    uploadToCloudinary(file).then(data=>{
      payment.documents = payment.documents || [];
      payment.documents.push({ name:file.name, url:data.secure_url, publicId:data.public_id, bytes: data.bytes, uploadedAt: todayISO() });
      saveData(); toast('Receipt attached');
      openPaymentDetail(payment, vendor);
    }).catch(err=>{
      console.error(err); errEl.textContent = 'Upload failed — check your connection.';
      label.textContent = 'Attach receipt (photo or PDF)';
    });
  });
  sheetContent.querySelectorAll('[data-pdoc-id]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      payment.documents = (payment.documents||[]).filter(d=>d.publicId!==btn.dataset.pdocId);
      saveData(); toast('Receipt removed'); openPaymentDetail(payment, vendor);
    });
  });
}

function openExpenseForm(expense){
  const isEdit = !!expense;
  expense = expense || { id: uid(), name:'', amount:0, date: todayISO(), ownerId: myUid(), sharedWith:[] };
  expense.sharedWith = expense.sharedWith || [];
  if(!expense.ownerId) expense.ownerId = myUid();
  openSheet(`
    <h3 class="serif">${isEdit?'Edit expense':'New expense'}</h3>
    <div class="field"><label>Description</label><input id="e_name" value="${escapeAttr(expense.name)}" placeholder="e.g. Mehndi artist"></div>
    <div class="field-row">
      <div class="field"><label>Amount (₹)</label><input type="number" id="e_amount" value="${expense.amount||0}"></div>
      <div class="field"><label>Date</label><input type="date" id="e_date" value="${expense.date||todayISO()}"></div>
    </div>
    <div class="section-title" style="margin-top:8px;">Sharing</div>
    ${shareToggleHtml(expense, 'e')}
    <div class="sheet-actions">
      ${isEdit? '<button class="btn btn-danger" id="deleteBtn">Delete</button>' : ''}
      <button class="btn btn-ghost" id="cancelBtn">Cancel</button>
      <button class="btn btn-primary" id="saveBtn">Save</button>
    </div>
  `);
  document.getElementById('cancelBtn').onclick = closeSheet;
  wireShareToggle(expense, 'e');
  if(isEdit) document.getElementById('deleteBtn').onclick = ()=>{
    state.otherExpenses = state.otherExpenses.filter(x=>x.id!==expense.id);
    saveData(); closeSheet(); renderAll(); toast('Expense deleted');
  };
  document.getElementById('saveBtn').onclick = ()=>{
    const name = document.getElementById('e_name').value.trim();
    if(!name){ toast('Please enter a description'); return; }
    expense.name = name;
    expense.amount = Number(document.getElementById('e_amount').value)||0;
    expense.date = document.getElementById('e_date').value;
    if(!isEdit) state.otherExpenses.push(expense);
    saveData(); closeSheet(); renderAll(); toast('Expense saved');
  };
}

/* ================= GUESTS (shared; per-event invite + RSVP) ================= */
let guestFilter='all';
let guestEventFilter = []; // event IDs to filter the guest list by; empty = show all
let guestTagFilter = '';
let guestSearch = '';
document.querySelectorAll('#guestFilter .seg-btn').forEach(b=>{
  b.addEventListener('click', ()=>{
    guestFilter = b.dataset.f;
    document.querySelectorAll('#guestFilter .seg-btn').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    renderGuests();
  });
});
function updateEventFilterBadge(){
  const badge = document.getElementById('eventFilterBadge');
  if(guestEventFilter.length){ badge.textContent = guestEventFilter.length; badge.style.display='inline-flex'; }
  else badge.style.display = 'none';
}
function openEventFilterSheet(){
  const events = visibleEvents();
  if(events.length===0){ toast('Add an event in Settings first'); return; }
  const selected = new Set(guestEventFilter);
  openSheet(`
    <h3 class="serif">Filter by event</h3>
    <p class="sheet-sub">Show guests invited to any of the selected events (main guest or a family member).</p>
    <div class="chip-row" id="filterEventChips">${events.map(ev=>`<button type="button" class="chip ${selected.has(ev.id)?'active':''}" data-filter-event="${ev.id}">${escapeHtml(ev.name)}</button>`).join('')}</div>
    <div class="sheet-actions">
      <button class="btn btn-ghost" id="clearFilterBtn">Clear</button>
      <button class="btn btn-primary" id="applyFilterBtn">Apply</button>
    </div>
  `);
  sheetContent.querySelectorAll('[data-filter-event]').forEach(chip=>{
    chip.addEventListener('click', ()=>{
      const id = chip.dataset.filterEvent;
      if(selected.has(id)){ selected.delete(id); chip.classList.remove('active'); }
      else { selected.add(id); chip.classList.add('active'); }
    });
  });
  document.getElementById('clearFilterBtn').onclick = ()=>{ guestEventFilter = []; updateEventFilterBadge(); closeSheet(); renderGuests(); };
  document.getElementById('applyFilterBtn').onclick = ()=>{ guestEventFilter = Array.from(selected); updateEventFilterBadge(); closeSheet(); renderGuests(); };
}
function exportFilteredGuestsXLS(){
  const q=guestSearch.trim().toLowerCase();
  const rows=[];
  visibleGuests().sort((a,b)=>a.name.localeCompare(b.name)).forEach(g=>{
    const hay=[g.name,g.phone,g.tag,g.notes,...(g.family||[]).map(m=>m.name)].join(' ').toLowerCase();
    if(q&&!hay.includes(q))return; if(guestTagFilter&&(g.tag||'')!==guestTagFilter)return;
    let persons=personRowsForGuest(g); if(guestFilter!=='all')persons=persons.filter(p=>p.status===guestFilter); if(guestEventFilter.length)persons=persons.filter(p=>p.events.some(id=>guestEventFilter.includes(id))); if(!persons.length)return;
    persons.forEach(p=>rows.push({Name:p.name,'Family Member Of':p.isMain?'':g.name,'Description Tag':g.tag||'',Phone:p.isMain?(g.phone||''):'',Adults:p.isMain?(Number(g.adults)||0):0,Children:p.isMain?(Number(g.children)||0):0,Events:p.events.map(id=>eventById(id)?.name||'').filter(Boolean).join(', '),Status:p.status,Notes:p.isMain?(g.notes||''):''}));
  });
  if(!rows.length){toast('No guests match the current filters');return;}
  const wb=XLSX.utils.book_new(),ws=XLSX.utils.json_to_sheet(rows); XLSX.utils.book_append_sheet(wb,ws,'Filtered Guests'); XLSX.writeFile(wb,`guest-list-${todayISO()}.xlsx`); toast(`${rows.length} guest rows exported`);
}
document.getElementById('importGuestsBtn').addEventListener('click', openImportPicker);

function eventById(id){ return (state.settings.events||[]).find(e=>e.id===id); }
function overallStatus(eventStatusMap){
  const statuses = Object.values(eventStatusMap||{});
  if(statuses.length===0) return 'pending';
  if(statuses.every(s=>s==='confirmed')) return 'confirmed';
  if(statuses.every(s=>s==='declined')) return 'declined';
  return 'pending';
}
function overallGuestStatus(g){ return overallStatus(g.eventStatus); }
/* Every individual person this guest entry represents: the main guest counts as
   (adults+children) people at the guest's own overall status, and each named family
   member counts as 1 person at their own independent status. */
function mainGuestHeadcount(g){
  const n = (Number(g.adults)||0) + (Number(g.children)||0);
  return n > 0 ? n : 1;
}
function peopleBreakdown(g, eventId=null){
  const people = [];
  if(eventId===null || (g.events||[]).includes(eventId)){
    people.push({ count: mainGuestHeadcount(g), status: eventId===null ? overallGuestStatus(g) : ((g.eventStatus||{})[eventId]||'pending'), isMain:true, guest:g });
  }
  (g.family||[]).forEach(m=>{
    if(eventId===null || (m.events||[]).includes(eventId)){
      people.push({ count:1, status:eventId===null ? overallStatus(m.eventStatus) : ((m.eventStatus||{})[eventId]||'pending'), isMain:false, guest:g, member:m });
    }
  });
  return people;
}
function eventHeadcount(eventId, bashorOnly=false){
  return visibleGuests().reduce((sum,g)=>{
    let n=0;
    if((g.events||[]).includes(eventId) && (!bashorOnly || g.bashorRaat)) n += mainGuestHeadcount(g);
    (g.family||[]).forEach(m=>{ if((m.events||[]).includes(eventId) && (!bashorOnly || m.bashorRaat)) n += 1; });
    return sum+n;
  },0);
}

function normalizeHeader(h){ return String(h||'').toLowerCase().replace(/[^a-z0-9]/g,''); }
function findColumn(headers, synonyms){ const normSyns = synonyms.map(normalizeHeader); return headers.find(h => normSyns.includes(normalizeHeader(h))); }

function openImportPicker(){
  const events = visibleEvents();
  if(events.length===0){ toast('Add an event in Settings first'); return; }
  const chips = events.map(ev=>`<button type="button" class="chip" data-import-event="${ev.id}">${escapeHtml(ev.name)}</button>`).join('');
  openSheet(`
    <h3 class="serif">Import guests</h3>
    <p class="sheet-sub">Which event(s) is this guest list for? Everyone in the file will be marked as invited to whichever you pick.</p>
    <div class="chip-row" id="importEventChips">${chips}</div>
    <p style="font-size:13px;color:var(--text-soft);line-height:1.5;margin-top:14px;">
      Then choose an .xlsx, .xls, or .csv file with a header row (Name, Phone, Adults, Children, RSVP, Notes — matching columns are detected automatically).
    </p>
    <label class="btn btn-primary" id="importFileLabel" style="width:100%;display:block;text-align:center;margin-top:6px;">
      Choose file
      <input type="file" id="importFileInput" accept=".xlsx,.xls,.csv" style="display:none;">
    </label>
    <div class="login-error" id="importError"></div>
    <div class="sheet-actions"><button class="btn btn-ghost" id="cancelBtn" style="width:100%;">Cancel</button></div>
  `);
  document.getElementById('cancelBtn').onclick = closeSheet;
  const selectedEvents = new Set();
  sheetContent.querySelectorAll('[data-import-event]').forEach(chip=>{
    chip.addEventListener('click', ()=>{
      const id = chip.dataset.importEvent;
      if(selectedEvents.has(id)){ selectedEvents.delete(id); chip.classList.remove('active'); }
      else { selectedEvents.add(id); chip.classList.add('active'); }
    });
  });
  document.getElementById('importFileInput').addEventListener('change', (e)=>{
    if(selectedEvents.size===0){ document.getElementById('importError').textContent = 'Pick at least one event first.'; e.target.value=''; return; }
    handleImportFile(e, Array.from(selectedEvents));
  });
}
function handleImportFile(e, targetEventIds){
  const file = e.target.files[0];
  if(!file) return;
  const errEl = document.getElementById('importError');
  document.getElementById('importFileLabel').textContent = 'Reading file…';
  const reader = new FileReader();
  reader.onload = (evt) => {
    try{
      const wb = XLSX.read(evt.target.result, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      if(rows.length === 0){ errEl.textContent = 'No rows found in that file.'; return; }
      processImportRows(rows, targetEventIds);
    }catch(err){ console.error(err); errEl.textContent = 'Could not read that file — make sure it\'s a valid Excel or CSV file.'; }
  };
  reader.readAsArrayBuffer(file);
}
function processImportRows(rows, targetEventIds){
  const headers = Object.keys(rows[0]);
  const col = {
    name: findColumn(headers, ['name','guest name','full name']),
    phone: findColumn(headers, ['phone','mobile','contact','phone number','mobile number']),
    rsvp: findColumn(headers, ['rsvp','status','rsvp status']),
    adults: findColumn(headers, ['adults','adult','no of adults','number of adults']),
    children: findColumn(headers, ['children','child','kids','no of children','number of children']),
    notes: findColumn(headers, ['notes','note','remarks','comments','comment'])
  };
  if(!col.name){ document.getElementById('importError').textContent = 'Could not find a "Name" column in that file.'; return; }
  const existingByName = new Map(visibleGuests().map(g=>[g.name.trim().toLowerCase(), g]));
  const toImport = []; const toUpdate = []; let skippedBlank = 0;
  rows.forEach(row=>{
    const name = String(row[col.name]||'').trim();
    if(!name){ skippedBlank++; return; }
    const rsvpRaw = String(col.rsvp ? row[col.rsvp] : '').toLowerCase();
    const rsvpStatus = rsvpRaw.includes('confirm') ? 'confirmed' : rsvpRaw.includes('declin') ? 'declined' : 'pending';
    const existing = existingByName.get(name.toLowerCase());
    if(existing){
      const newEvents = targetEventIds.filter(id=>!(existing.events||[]).includes(id));
      if(newEvents.length) toUpdate.push({ guest: existing, newEvents, rsvpStatus });
    } else {
      const guest = {
        id: uid(), name,
        phone: col.phone ? String(row[col.phone]||'').trim() : '',
        events: targetEventIds.slice(),
        eventStatus: Object.fromEntries(targetEventIds.map(id=>[id, rsvpStatus])),
        adults: col.adults ? (Number(row[col.adults]) || 1) : 1,
        children: col.children ? (Number(row[col.children]) || 0) : 0,
        notes: col.notes ? String(row[col.notes]||'').trim() : '',
        bashorRaat: false,
        tag: '',
        family: [],
        ownerId: myUid(),
        sharedWith: []
      };
      toImport.push(guest);
      existingByName.set(name.toLowerCase(), guest);
    }
  });
  renderImportPreview(toImport, toUpdate, skippedBlank, targetEventIds);
}
function renderImportPreview(toImport, toUpdate, skippedBlank, targetEventIds){
  const eventNames = targetEventIds.map(id=>eventById(id)?.name||'?').join(', ');
  const previewNames = toImport.slice(0,8).map(g=>escapeHtml(g.name)).join(', ') + (toImport.length>8 ? `, +${toImport.length-8} more` : '');
  const updateNames = toUpdate.slice(0,8).map(u=>escapeHtml(u.guest.name)).join(', ') + (toUpdate.length>8 ? `, +${toUpdate.length-8} more` : '');
  openSheet(`
    <h3 class="serif">Ready to import</h3>
    <p class="sheet-sub">Marking guests as invited to: ${escapeHtml(eventNames)}</p>
    <div class="item" style="margin-bottom:8px;"><div class="item-title">${toImport.length} new guest${toImport.length===1?'':'s'}</div>${toImport.length ? `<div class="item-meta">${previewNames}</div>` : ''}</div>
    ${toUpdate.length ? `<div class="item" style="margin-bottom:8px;"><div class="item-title">${toUpdate.length} existing guest${toUpdate.length===1?'':'s'} will be updated</div><div class="item-meta">${updateNames} — adding this event to their invitation</div></div>` : ''}
    ${skippedBlank ? `<div class="item-meta" style="margin-bottom:8px;">${skippedBlank} row(s) skipped — no name found.</div>` : ''}
    <div class="sheet-actions">
      <button class="btn btn-ghost" id="cancelBtn">Cancel</button>
      <button class="btn btn-primary" id="confirmImportBtn" ${toImport.length||toUpdate.length?'':'disabled'}>Import &amp; update</button>
    </div>
  `);
  document.getElementById('cancelBtn').onclick = closeSheet;
  document.getElementById('confirmImportBtn').onclick = ()=>{
    state.guests.push(...toImport);
    toUpdate.forEach(u=>{
      u.guest.events = [...(u.guest.events||[]), ...u.newEvents];
      u.guest.eventStatus = u.guest.eventStatus || {};
      u.newEvents.forEach(id=>{ u.guest.eventStatus[id] = u.rsvpStatus; });
    });
    saveData(); closeSheet(); renderAll();
    toast(`${toImport.length} added, ${toUpdate.length} updated`);
  };
}

function personRowsForGuest(g){
  const rows = [
    {
      guestId: g.id, personId: g.id, isMain: true, name: g.name,
      count: (Number(g.adults)||0)+(Number(g.children)||0),
      events: g.events||[], eventStatus: g.eventStatus||{},
      status: overallGuestStatus(g), bashorRaat: !!g.bashorRaat, tag: g.tag||''
    }
  ];
  (g.family||[]).forEach(m=>{
    rows.push({
      guestId: g.id, personId: m.id, isMain: false, name: m.name,
      count: 1, events: m.events||[], eventStatus: m.eventStatus||{},
      status: overallStatus(m.eventStatus), bashorRaat: !!m.bashorRaat, tag: ''
    });
  });
  return rows;
}
function renderGuests(){
  const list = document.getElementById('guestList');
  const q = guestSearch.trim().toLowerCase();
  const households = [...visibleGuests()].sort((a,b)=>a.name.localeCompare(b.name));
  list.innerHTML='';
  const cycle = { pending:'confirmed', confirmed:'declined', declined:'pending' };
  let anyRendered=false;
  households.forEach(g=>{
    const haystack=[g.name,g.phone,g.tag,g.notes,...(g.family||[]).map(m=>m.name)].join(' ').toLowerCase();
    if(q && !haystack.includes(q)) return;
    if(guestTagFilter && (g.tag||'')!==guestTagFilter) return;
    let persons=personRowsForGuest(g);
    if(guestFilter!=='all') persons=persons.filter(p=>p.status===guestFilter);
    if(guestEventFilter.length) persons=persons.filter(p=>p.events.some(id=>guestEventFilter.includes(id)));
    if(persons.length===0) return;
    anyRendered=true;
    const group=document.createElement('div'); group.className='guest-group';
    persons.forEach(p=>{
      const dots=p.events.map(id=>{const ev=eventById(id); if(!ev)return ''; const st=p.eventStatus[id]||'pending'; return `<span class="event-dot ${st}" data-cycle-guest="${p.guestId}" data-cycle-person="${p.personId}" data-cycle-eventid="${id}" title="${escapeAttr(ev.name)}"><span class="dot"></span>${escapeHtml(ev.name)}</span>`;}).join('');
      const row=document.createElement('div'); row.className='guest-person-row';
      row.innerHTML=`<div class="item-top"><div><div class="item-title">${escapeHtml(p.name)}${p.bashorRaat?' 🌙':''}${p.tag?` <span class="tag-badge">${escapeHtml(p.tag)}</span>`:''}${p.isMain&&g.sharedWith&&g.sharedWith.length?` <span class="badge" style="background:var(--teal-soft);color:var(--teal-2);">Shared</span>`:''}</div><div class="item-meta">${p.count>1?p.count+' people':''}${!p.isMain?(p.count>1?' · ':'')+'family member of '+escapeHtml(g.name):''}</div></div></div><div class="event-dots">${dots}</div>`;
      row.addEventListener('click',e=>{if(e.target.closest('[data-cycle-guest]'))return;openGuestForm(g,p.isMain?null:p.personId);});
      row.querySelectorAll('[data-cycle-guest]').forEach(dot=>dot.addEventListener('click',e=>{e.stopPropagation();const guest=state.guests.find(x=>x.id===dot.dataset.cycleGuest);const evId=dot.dataset.cycleEventid;if(!guest)return;if(dot.dataset.cyclePerson===guest.id)guest.eventStatus[evId]=cycle[guest.eventStatus[evId]]||'pending';else{const m=guest.family.find(x=>x.id===dot.dataset.cyclePerson);if(m)m.eventStatus[evId]=cycle[m.eventStatus[evId]]||'pending';}saveData();renderAll();}));
      group.appendChild(row);
    }); list.appendChild(group);
  });
  if(!anyRendered) list.innerHTML=emptyState('No guests here','Tap + to add a guest, or clear your filters.');
}
function guestTagOptions(){ return [...new Set(visibleGuests().map(g=>(g.tag||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b)); }
function openGuestAdvancedFilterSheet(){
  const tags=guestTagOptions(); const selectedTag=guestTagFilter;
  openSheet(`<h3 class="serif">Guest filters</h3><p class="sheet-sub">Combine status, event and Description Tag filters.</p><div class="field"><label>Description Tag</label><select id="guestTagSelect"><option value="">All tags</option>${tags.map(t=>`<option value="${escapeAttr(t)}" ${t===selectedTag?'selected':''}>${escapeHtml(t)}</option>`).join('')}</select></div><div class="sheet-actions"><button class="btn btn-ghost" id="clearGuestFiltersBtn">Clear all</button><button class="btn btn-primary" id="applyGuestFiltersBtn">Apply</button></div>`);
  document.getElementById('clearGuestFiltersBtn').onclick=()=>{guestTagFilter='';guestEventFilter=[];guestFilter='all';document.querySelectorAll('#guestFilter .seg-btn').forEach(b=>b.classList.toggle('active',b.dataset.f==='all'));updateEventFilterBadge();closeSheet();renderGuests();};
  document.getElementById('applyGuestFiltersBtn').onclick=()=>{guestTagFilter=document.getElementById('guestTagSelect').value;closeSheet();renderGuests();};
}
document.getElementById('filterByEventBtn').addEventListener('click', openEventFilterSheet);
document.getElementById('guestAdvancedFilterBtn').addEventListener('click', openGuestAdvancedFilterSheet);
document.getElementById('exportGuestsBtn').addEventListener('click', exportFilteredGuestsXLS);
document.getElementById('guestSearchInput').addEventListener('input', e=>{ guestSearch=e.target.value; renderGuests(); });

function openGuestForm(guest, expandFamilyId){
  const isEdit = !!guest;
  guest = guest || { id: uid(), ownerId: myUid(), sharedWith:[], name:'', phone:'', events:[], eventStatus:{}, adults:1, children:0, notes:'', bashorRaat:false, tag:'', family:[] };
  guest.events = guest.events || [];
  guest.eventStatus = guest.eventStatus || {};
  guest.family = guest.family || [];
  guest.tag = guest.tag || '';
  const events = visibleEvents();
  let expandedFamilyId = expandFamilyId || null;

  function statusRowsHtml(){
    return guest.events.map(id=>{
      const ev = eventById(id);
      if(!ev) return '';
      const st = guest.eventStatus[id]||'pending';
      return `<div class="event-status-row">
        <div class="ev-label">${escapeHtml(ev.name)}</div>
        <div class="status-pills">
          <button type="button" class="status-pill pending ${st==='pending'?'active':''}" data-status-for="${id}" data-status-val="pending">Pending</button>
          <button type="button" class="status-pill confirmed ${st==='confirmed'?'active':''}" data-status-for="${id}" data-status-val="confirmed">Confirmed</button>
          <button type="button" class="status-pill declined ${st==='declined'?'active':''}" data-status-for="${id}" data-status-val="declined">Declined</button>
        </div>
      </div>`;
    }).join('') || '<p class="item-meta">Select at least one event above.</p>';
  }
  function bashorHtml(){
    const invitedToMain = guest.events.some(id=> eventById(id)?.isMainWedding);
    return invitedToMain ? `
      <div class="toggle-row">
        <div><div class="toggle-label">Staying for Bashor Raat?</div></div>
        <label class="switch"><input type="checkbox" id="g_bashor" ${guest.bashorRaat?'checked':''}><span class="track"></span></label>
      </div>` : '';
  }
  function familyMemberDotsHtml(m){
    return (m.events||[]).map(id=>{
      const ev = eventById(id); if(!ev) return '';
      const st = (m.eventStatus||{})[id] || 'pending';
      return `<span class="event-dot ${st}"><span class="dot"></span>${escapeHtml(ev.name)}</span>`;
    }).join('') || '<span class="item-meta">Not invited to any event yet</span>';
  }
  function familySectionHtml(){
    if(guest.family.length===0) return '<p class="item-meta" style="margin-bottom:8px;">No family members added yet — e.g. a spouse or child invited to different events than the main guest.</p>';
    return guest.family.map(m=>{
      const expanded = expandedFamilyId===m.id;
      return `<div class="item family-row" data-family-card="${m.id}">
        <div class="item-top">
          <div class="item-title" style="cursor:pointer;" data-toggle-family="${m.id}">${escapeHtml(m.name)}${m.isChild?' (child)':''}</div>
          <div style="display:flex;gap:6px;flex:none;">
            <button type="button" class="btn btn-ghost btn-sm" data-rename-family="${m.id}">Rename</button>
            <button type="button" class="btn btn-danger btn-sm" data-remove-family="${m.id}">Remove</button>
          </div>
        </div>
        <div class="event-dots" data-toggle-family="${m.id}" style="cursor:pointer;">${familyMemberDotsHtml(m)}</div>
        ${expanded ? `
          <div class="section-title" style="margin-top:12px;">Invited to</div>
          <div class="chip-row">${events.map(ev=>`<button type="button" class="chip maroon ${m.events.includes(ev.id)?'active':''}" data-fam-event="${m.id}|${ev.id}">${escapeHtml(ev.name)}</button>`).join('')}</div>
          <div style="margin-top:10px;">${
            m.events.map(id=>{
              const ev = eventById(id); if(!ev) return '';
              const st = m.eventStatus[id]||'pending';
              return `<div class="event-status-row">
                <div class="ev-label">${escapeHtml(ev.name)}</div>
                <div class="status-pills">
                  <button type="button" class="status-pill pending ${st==='pending'?'active':''}" data-fam-status="${m.id}|${id}|pending">Pending</button>
                  <button type="button" class="status-pill confirmed ${st==='confirmed'?'active':''}" data-fam-status="${m.id}|${id}|confirmed">Confirmed</button>
                  <button type="button" class="status-pill declined ${st==='declined'?'active':''}" data-fam-status="${m.id}|${id}|declined">Declined</button>
                </div>
              </div>`;
            }).join('') || '<p class="item-meta">Pick at least one event above.</p>'
          }</div>
          ${m.events.some(id=>eventById(id)?.isMainWedding) ? `
          <div class="toggle-row">
            <div><div class="toggle-label">Staying for Bashor Raat?</div></div>
            <label class="switch"><input type="checkbox" data-fam-bashor="${m.id}" ${m.bashorRaat?'checked':''}><span class="track"></span></label>
          </div>` : ''}
          <div class="toggle-row">
            <div><div class="toggle-label">Child</div></div>
            <label class="switch"><input type="checkbox" data-fam-ischild="${m.id}" ${m.isChild?'checked':''}><span class="track"></span></label>
          </div>
        ` : `<button type="button" class="btn btn-ghost btn-sm" style="margin-top:9px;" data-toggle-family="${m.id}">Edit invitations</button>`}
      </div>`;
    }).join('');
  }

  function draw(){
    openSheet(`
      <h3 class="serif">${isEdit?'Edit guest':'New guest'}</h3>
      <div class="field"><label>Name</label><input id="g_name" value="${escapeAttr(guest.name)}" placeholder="e.g. Debashish Roy"></div>
      <div class="field-row">
        <div class="field"><label>Phone</label><input id="g_phone" value="${escapeAttr(guest.phone)}"></div>
        <div class="field"><label>Description Tag <span style="font-weight:400;color:var(--text-soft);">(optional)</span></label><input id="g_tag" value="${escapeAttr(guest.tag)}" placeholder="e.g. Dad, College friends, Office"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Adults</label><input type="number" min="0" id="g_adults" value="${guest.adults||0}"></div>
        <div class="field"><label>Children</label><input type="number" min="0" id="g_children" value="${guest.children||0}"></div>
      </div>
      <div class="section-title" style="margin-top:4px;">Invited to</div>
      <div class="chip-row" id="eventChips">${events.map(ev=>`<button type="button" class="chip maroon ${guest.events.includes(ev.id)?'active':''}" data-guest-event="${ev.id}">${escapeHtml(ev.name)}</button>`).join('')}</div>
      <div class="section-title" style="margin-top:14px;">RSVP by event</div>
      <div id="eventStatusRows">${statusRowsHtml()}</div>
      <div id="bashorWrap">${bashorHtml()}</div>

      <div class="section-title" style="margin-top:18px;">Family &amp; relatives <span class="action" id="addFamilyBtn">+ Add</span></div>
      <div id="familySection">${familySectionHtml()}</div>

      <div class="section-title" style="margin-top:18px;">Sharing</div>
      ${shareToggleHtml(guest, 'g')}

      <div class="field" style="margin-top:14px;"><label>Notes</label><textarea id="g_notes">${escapeHtml(guest.notes||'')}</textarea></div>
      <div class="sheet-actions">
        ${isEdit? '<button class="btn btn-danger" id="deleteBtn">Delete</button>' : ''}
        <button class="btn btn-ghost" id="cancelBtn">Cancel</button>
        <button class="btn btn-primary" id="saveBtn">Save</button>
      </div>
    `);
    document.getElementById('cancelBtn').onclick = closeSheet;
    wireShareToggle(guest, 'g');
    sheetContent.querySelectorAll('[data-guest-event]').forEach(chip=>{
      chip.addEventListener('click', ()=>{
        const id = chip.dataset.guestEvent;
        const idx = guest.events.indexOf(id);
        if(idx>-1) guest.events.splice(idx,1); else { guest.events.push(id); if(!guest.eventStatus[id]) guest.eventStatus[id]='pending'; }
        readFormIntoGuest();
        draw();
      });
    });
    sheetContent.querySelectorAll('[data-status-for]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        readFormIntoGuest();
        guest.eventStatus[btn.dataset.statusFor] = btn.dataset.statusVal;
        draw();
      });
    });
    document.getElementById('addFamilyBtn').onclick = ()=>{
      const name = prompt('Name of family member / relative:');
      if(!name || !name.trim()) return;
      readFormIntoGuest();
      const member = { id: uid(), name: name.trim(), isChild:false, events:[], eventStatus:{}, bashorRaat:false };
      guest.family.push(member);
      expandedFamilyId = member.id;
      draw();
    };
    sheetContent.querySelectorAll('[data-toggle-family]').forEach(elx=>{
      elx.addEventListener('click', ()=>{
        readFormIntoGuest();
        const id = elx.dataset.toggleFamily;
        expandedFamilyId = expandedFamilyId===id ? null : id;
        draw();
      });
    });
    sheetContent.querySelectorAll('[data-rename-family]').forEach(btn=>{
      btn.addEventListener('click', (e)=>{
        e.stopPropagation();
        const m = guest.family.find(x=>x.id===btn.dataset.renameFamily);
        const newName = prompt('Rename:', m.name);
        if(newName && newName.trim()){ readFormIntoGuest(); m.name = newName.trim(); draw(); }
      });
    });
    sheetContent.querySelectorAll('[data-remove-family]').forEach(btn=>{
      btn.addEventListener('click', (e)=>{
        e.stopPropagation();
        if(!confirm('Remove this family member?')) return;
        readFormIntoGuest();
        const removedId = btn.dataset.removeFamily;
        guest.family = guest.family.filter(x=>x.id!==removedId);
        if(expandedFamilyId===removedId) expandedFamilyId = null;
        draw();
      });
    });
    sheetContent.querySelectorAll('[data-fam-event]').forEach(chip=>{
      chip.addEventListener('click', ()=>{
        const [mid, evId] = chip.dataset.famEvent.split('|');
        const m = guest.family.find(x=>x.id===mid);
        const idx = m.events.indexOf(evId);
        if(idx>-1) m.events.splice(idx,1); else { m.events.push(evId); if(!m.eventStatus[evId]) m.eventStatus[evId]='pending'; }
        readFormIntoGuest();
        draw();
      });
    });
    sheetContent.querySelectorAll('[data-fam-status]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const [mid, evId, val] = btn.dataset.famStatus.split('|');
        const m = guest.family.find(x=>x.id===mid);
        m.eventStatus[evId] = val;
        readFormIntoGuest();
        draw();
      });
    });
    sheetContent.querySelectorAll('[data-fam-bashor]').forEach(cb=>{
      cb.addEventListener('change', ()=>{
        readFormIntoGuest();
        const m = guest.family.find(x=>x.id===cb.dataset.famBashor);
        m.bashorRaat = cb.checked;
      });
    });
    sheetContent.querySelectorAll('[data-fam-ischild]').forEach(cb=>{
      cb.addEventListener('change', ()=>{
        readFormIntoGuest();
        const m = guest.family.find(x=>x.id===cb.dataset.famIschild);
        m.isChild = cb.checked;
      });
    });
    if(isEdit) document.getElementById('deleteBtn').onclick = ()=>{
      state.guests = state.guests.filter(x=>x.id!==guest.id);
      saveData(); closeSheet(); renderAll(); toast('Guest deleted');
    };
    document.getElementById('saveBtn').onclick = ()=>{
      readFormIntoGuest();
      if(!guest.name.trim()){ toast('Please enter a name'); return; }
      if(!isEdit) state.guests.push(guest);
      saveData(); closeSheet(); renderAll(); toast('Guest saved');
    };
  }
  function readFormIntoGuest(){
    const nameEl = document.getElementById('g_name');
    if(nameEl) guest.name = nameEl.value.trim() || guest.name;
    const phoneEl = document.getElementById('g_phone'); if(phoneEl) guest.phone = phoneEl.value;
    const tagEl = document.getElementById('g_tag'); if(tagEl) guest.tag = tagEl.value.trim();
    const adultsEl = document.getElementById('g_adults'); if(adultsEl) guest.adults = Number(adultsEl.value)||0;
    const childrenEl = document.getElementById('g_children'); if(childrenEl) guest.children = Number(childrenEl.value)||0;
    const notesEl = document.getElementById('g_notes'); if(notesEl) guest.notes = notesEl.value;
    const bashorEl = document.getElementById('g_bashor'); if(bashorEl) guest.bashorRaat = bashorEl.checked;
  }
  draw();
}

/* ================= MENU ================= */
function menuForEvent(eventId){
  let m=(state.menus||[]).find(x=>x.eventId===eventId);
  if(!m){ m={id:uid(),eventId,sections:[],ownerId:myUid()}; state.menus.push(m); }
  return m;
}
function renderMenu(){
  const list=document.getElementById('menuList'); if(!list)return;
  const events=visibleEvents();
  if(!events.length){list.innerHTML=emptyState('No events yet','Add an event in Settings first.');return;}
  list.innerHTML=events.map(ev=>{const m=(state.menus||[]).find(x=>x.eventId===ev.id);const sections=m?.sections||[];const itemCount=sections.reduce((n,s)=>n+s.items.length,0);return `<div class="item" data-menu-event="${ev.id}"><div class="item-top"><div><div class="item-title">${escapeHtml(ev.name)}</div><div class="item-meta">${itemCount} item${itemCount===1?'':'s'} · ${sections.length} section${sections.length===1?'':'s'}</div></div><span class="badge ${itemCount?'confirmed':'pending'}">${itemCount?'Menu added':'Not set'}</span></div>${sections.slice(0,3).map(sec=>`<div class="item-meta"><strong>${escapeHtml(sec.name)}</strong>: ${escapeHtml(sec.items.map(i=>i.name).join(', '))}</div>`).join('')}${sections.length>3?`<div class="item-meta">+${sections.length-3} more sections</div>`:''}</div>`;}).join('');
  list.querySelectorAll('[data-menu-event]').forEach(el=>el.addEventListener('click',()=>openMenuEditor(el.dataset.menuEvent)));
}
function openMenuEditor(eventId){
  const ev=eventById(eventId); if(!ev)return; const menu=menuForEvent(eventId);
  function draw(){
    openSheet(`<h3 class="serif">${escapeHtml(ev.name)} menu</h3><p class="sheet-sub">Create a separate menu for this event. Add sections such as Starters, Main Course, Desserts, Beverages, etc.</p><div id="menuSections">${menu.sections.length?menu.sections.map(sec=>`<div class="item" style="margin-bottom:9px;"><div class="item-top"><input data-section-name="${sec.id}" value="${escapeAttr(sec.name)}" placeholder="Section name" style="flex:1;padding:9px 10px;border:1.5px solid var(--line);border-radius:10px;font-size:14px;font-weight:700;background:#FCFAFA;color:var(--ink);"><button class="btn btn-danger btn-sm" data-remove-section="${sec.id}">Remove</button></div><div style="margin-top:8px;">${sec.items.map(item=>`<div style="display:flex;gap:6px;align-items:center;margin:6px 0;"><input data-item-name="${sec.id}|${item.id}" value="${escapeAttr(item.name)}" placeholder="Dish / item" style="flex:1;padding:9px 10px;border:1.5px solid var(--line);border-radius:10px;font-size:13px;"><button class="btn btn-danger btn-sm" data-remove-item="${sec.id}|${item.id}">×</button></div>`).join('')}</div><button class="btn btn-ghost btn-sm" data-add-item="${sec.id}" style="margin-top:4px;">+ Add item</button></div>`).join(''):'<p class="item-meta">No menu sections yet.</p>'}</div><button class="btn btn-ghost" id="addMenuSectionBtn" style="width:100%;margin-top:6px;">+ Add menu section</button><div class="sheet-actions"><button class="btn btn-ghost" id="cancelMenuBtn">Cancel</button><button class="btn btn-primary" id="saveMenuBtn">Save menu</button></div>`);
    sheetContent.querySelectorAll('[data-remove-section]').forEach(b=>b.onclick=()=>{menu.sections=menu.sections.filter(s=>s.id!==b.dataset.removeSection);draw();});
    sheetContent.querySelectorAll('[data-add-item]').forEach(b=>b.onclick=()=>{const sec=menu.sections.find(s=>s.id===b.dataset.addItem);if(sec){sec.items.push({id:uid(),name:'',notes:''});draw();}});
    sheetContent.querySelectorAll('[data-remove-item]').forEach(b=>b.onclick=()=>{const [sid,iid]=b.dataset.removeItem.split('|');const sec=menu.sections.find(s=>s.id===sid);if(sec)sec.items=sec.items.filter(i=>i.id!==iid);draw();});
    document.getElementById('addMenuSectionBtn').onclick=()=>{menu.sections.push({id:uid(),name:'New section',items:[]});draw();};
    sheetContent.querySelectorAll('[data-section-name]').forEach(input=>input.addEventListener('input',()=>{const sec=menu.sections.find(s=>s.id===input.dataset.sectionName);if(sec)sec.name=input.value;}));
    sheetContent.querySelectorAll('[data-item-name]').forEach(input=>input.addEventListener('input',()=>{const [sid,iid]=input.dataset.itemName.split('|');const sec=menu.sections.find(s=>s.id===sid);const item=sec?.items.find(i=>i.id===iid);if(item)item.name=input.value;}));
    document.getElementById('cancelMenuBtn').onclick=closeSheet;
    document.getElementById('saveMenuBtn').onclick=()=>{menu.sections=menu.sections.filter(sec=>sec.name.trim()||sec.items.some(i=>i.name.trim()));menu.sections.forEach(sec=>{sec.name=sec.name.trim()||'Menu';sec.items=sec.items.filter(i=>i.name.trim());});saveData();closeSheet();renderAll();toast('Menu saved');};
  }
  draw();
}

/* ================= SETTINGS ================= */
document.getElementById('saveSettingsBtn').addEventListener('click', ()=>{
  state.settings.weddingDate = document.getElementById('settingWeddingDate').value || state.settings.weddingDate;
  state.settings.receptionDate = document.getElementById('settingReceptionDate').value || state.settings.receptionDate;
  dashboardAnimated = false;
  saveData(); renderAll(); toast('Settings saved');
});
document.getElementById('addEventBtn').addEventListener('click', ()=> openEventForm());
document.getElementById('exportBtn').addEventListener('click', ()=>{
  const blob = new Blob([JSON.stringify(state, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `wedding-secretary-backup-${todayISO()}.json`;
  a.click(); URL.revokeObjectURL(url);
  toast('Backup downloaded');
});
document.getElementById('importInput').addEventListener('change', (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try{
      const parsed = JSON.parse(reader.result);
      if(!confirm('This will replace all current data with the backup file. Continue?')) return;
      state = normalizeState(deepMerge(structuredClone(DEFAULT_DATA), parsed), myUid());
      saveData(); renderAll(); toast('Backup restored');
    }catch(err){ toast('Could not read that file'); }
  };
  reader.readAsText(file);
  e.target.value = '';
});
document.getElementById('resetBtn').addEventListener('click', ()=>{
  if(!confirm('This permanently erases all tasks, vendors, guests and expenses. This cannot be undone. Continue?')) return;
  const dir = state.directory;
  state = structuredClone(DEFAULT_DATA);
  state.directory = dir;
  saveData(); renderAll(); toast('All data erased');
});

function renderEventsSettingsList(){
  const list = document.getElementById('eventsSettingsList');
  const events = [...visibleEvents()].sort((a,b)=>(a.date||'').localeCompare(b.date||''));
  list.innerHTML='';
  if(events.length===0){ list.innerHTML = emptyState('No events yet','Add Haldi, Wedding, Reception, etc. — each can be shared or kept private, e.g. separate Haldi ceremonies per family.'); return; }
  events.forEach(ev=>{
    const el = document.createElement('div');
    el.className='item';
    el.innerHTML = `<div class="item-top"><div><div class="item-title">${escapeHtml(ev.name)}${ev.isMainWedding?' 👑':''}${ev.sharedWith && ev.sharedWith.length ? ` <span class="event-shared">Shared</span>`:''}</div><div class="item-meta">${ev.date?formatDate(ev.date):''}${ev.venue?' · '+escapeHtml(ev.venue):''}</div></div></div>`;
    el.addEventListener('click', ()=> openEventForm(ev));
    list.appendChild(el);
  });
}
function openEventForm(ev){
  const isEdit = !!ev;
  ev = ev || { id: uid(), name:'', date:'', time:'', venue:'', address:'', isMainWedding:false, ownerId: myUid(), sharedWith:[] };
  ev.sharedWith = ev.sharedWith || [];
  if(!ev.ownerId) ev.ownerId = myUid();
  openSheet(`
    <h3 class="serif">${isEdit?'Edit event':'New event'}</h3>
    ${isEdit && ev.ownerId && ev.ownerId!==myUid() ? `<p class="sheet-sub">Added by ${escapeHtml(nameFor(ev.ownerId))}, shared with you.</p>` : ''}
    <div class="field"><label>Event name</label><input id="ev_name" value="${escapeAttr(ev.name)}" placeholder="e.g. Sangeet"></div>
    <div class="field-row">
      <div class="field"><label>Date</label><input type="date" id="ev_date" value="${ev.date||''}"></div>
      <div class="field"><label>Time</label><input type="time" id="ev_time" value="${ev.time||''}"></div>
    </div>
    <div class="field"><label>Venue name</label><input id="ev_venue" value="${escapeAttr(ev.venue)}" placeholder="e.g. Taj Bengal"></div>
    <div class="field"><label>Address</label><input id="ev_address" value="${escapeAttr(ev.address)}" placeholder="Optional"></div>
    <div class="toggle-row">
      <div><div class="toggle-label">This is the main Wedding day</div><div class="toggle-sub">Enables the Bashor Raat option for its guests</div></div>
      <label class="switch"><input type="checkbox" id="ev_main" ${ev.isMainWedding?'checked':''}><span class="track"></span></label>
    </div>
    <div class="section-title" style="margin-top:12px;">Sharing</div>
    ${shareToggleHtml(ev, 'ev')}
    <div class="sheet-actions">
      ${isEdit? '<button class="btn btn-danger" id="deleteBtn">Delete</button>' : ''}
      <button class="btn btn-ghost" id="cancelBtn">Cancel</button>
      <button class="btn btn-primary" id="saveBtn">Save</button>
    </div>
  `);
  document.getElementById('cancelBtn').onclick = closeSheet;
  wireShareToggle(ev, 'ev');
  if(isEdit) document.getElementById('deleteBtn').onclick = ()=>{
    state.settings.events = state.settings.events.filter(x=>x.id!==ev.id);
    saveData(); closeSheet(); renderAll(); toast('Event deleted');
  };
  document.getElementById('saveBtn').onclick = ()=>{
    const name = document.getElementById('ev_name').value.trim();
    if(!name){ toast('Please enter an event name'); return; }
    ev.name = name;
    ev.date = document.getElementById('ev_date').value;
    ev.time = document.getElementById('ev_time').value;
    ev.venue = document.getElementById('ev_venue').value;
    ev.address = document.getElementById('ev_address').value;
    ev.isMainWedding = document.getElementById('ev_main').checked;
    if(!state.settings.events) state.settings.events = [];
    if(!isEdit) state.settings.events.push(ev);
    saveData(); closeSheet(); renderAll(); toast('Event saved');
  };
}
function renderPeopleList(){
  const list = document.getElementById('peopleList');
  list.innerHTML='';
  directoryList().forEach(p=>{
    const el = document.createElement('div');
    el.className='item';
    el.innerHTML = `<div class="item-title">${escapeHtml(p.name)}${p.uid===myUid()?' (you)':''}</div><div class="item-meta">${escapeHtml(p.email)}</div>`;
    list.appendChild(el);
  });
  if(directoryList().length===0) list.innerHTML = emptyState('No one yet','You\'ll appear here after signing in.');
}

/* ---------------- Master render ---------------- */
function safeRender(name, fn){
  try{ fn(); }
  catch(err){
    console.error(`[Wedding Secretary] ${name} render failed`, err);
  }
}
function renderAll(){
  // Keep every tab independently renderable. A malformed legacy record in one module
  // must never prevent Guests, Menu, Settings, etc. from painting.
  safeRender('dashboard', renderDashboard);
  safeRender('tasks', renderTasks);
  safeRender('vendors', renderVendors);
  safeRender('finance', renderFinance);
  safeRender('guests', renderGuests);
  safeRender('menu', renderMenu);
  safeRender('events settings', renderEventsSettingsList);
  safeRender('people', renderPeopleList);
  safeRender('storage', renderStorage);
  const weddingDate = document.getElementById('settingWeddingDate');
  const receptionDate = document.getElementById('settingReceptionDate');
  if(weddingDate) weddingDate.value = state.settings.weddingDate || '';
  if(receptionDate) receptionDate.value = state.settings.receptionDate || '';
}
renderAll();
setTimeout(hideSplash, 2500); // safety net in case auth check is ever unusually slow

if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{ navigator.serviceWorker.register('sw.js').catch(()=>{}); });
}
