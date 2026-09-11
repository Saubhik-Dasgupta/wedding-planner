/* Wedding Secretary — Firebase-backed PWA (cloud sync, per-account ownership+sharing, offline cache) */

import { auth, db } from './firebase-config.js';
import { CLOUDINARY_CLOUD_NAME, CLOUDINARY_UPLOAD_PRESET } from './cloud-config.js';
import {
  signInWithEmailAndPassword, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  doc, getDoc, getDocFromCache, setDoc, onSnapshot
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
  guests: [],         // flat list, one entry per event: { id, eventId, tag, name, adults, invited, bashorRaat }
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

  // Guests are now a flat, per-event list: { id, eventId, tag, name, adults, invited, bashorRaat }.
  // Convert any old-shape guests (multi-event + family sub-records) into this simpler shape once;
  // after this runs, no old-shape guests remain, so it becomes a no-op on every later load.
  const hasOldShapeGuests = (s.guests||[]).some(g=>Array.isArray(g.events));
  if(hasOldShapeGuests){
    const newGuests = [];
    (s.guests||[]).forEach(g=>{
      if(!Array.isArray(g.events)){
        newGuests.push({
          id: g.id || uid(), eventId: g.eventId, tag: (g.tag||'General').trim() || 'General',
          name: g.name || 'Guest', adults: Number(g.adults)||1, invited: !!g.invited, bashorRaat: !!g.bashorRaat
        });
        return;
      }
      const gEvents = g.events || [];
      const family = Array.isArray(g.family) ? g.family : [];
      const allIds = new Set(gEvents);
      family.forEach(m=> (m.events||[]).forEach(id=>allIds.add(id)));
      allIds.forEach(eventId=>{
        const peopleNames = [];
        let adultsCount = 0;
        let bashor = false;
        if(gEvents.includes(eventId)){
          peopleNames.push(g.name || 'Guest');
          adultsCount += ((Number(g.adults)||0) + (Number(g.children)||0)) || 1;
          if(g.bashorRaat) bashor = true;
        }
        family.forEach(m=>{
          if((m.events||[]).includes(eventId)){
            peopleNames.push(m.name || 'Family member');
            adultsCount += 1;
            if(m.bashorRaat) bashor = true;
          }
        });
        if(peopleNames.length===0) return;
        newGuests.push({
          id: uid(), eventId, tag: (g.tag||'General').trim() || 'General',
          name: peopleNames.join(' + '), adults: adultsCount, invited: true, bashorRaat: bashor
        });
      });
    });
    s.guests = newGuests;
  } else {
    (s.guests||[]).forEach(g=>{
      g.tag = (g.tag||'General').trim() || 'General';
      g.adults = Number(g.adults) || 1;
      g.invited = !!g.invited;
      g.bashorRaat = !!g.bashorRaat;
    });
  }
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
      toast(cached ? 'Offline — showing last saved data' : 'Could not load your data — check your connection or try Settings → Recover from device cache');
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
function visibleGuests(eventId){
  // A guest belongs to exactly one event's list; it's visible whenever that event is visible to you.
  const visibleEventIds = new Set(visibleEvents().map(e=>e.id));
  const guests = Array.isArray(state.guests) ? state.guests : [];
  return guests.filter(g=> g && visibleEventIds.has(g.eventId) && (!eventId || g.eventId===eventId));
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
  const fabEl = document.getElementById('fabAdd');
  if(fabEl) fabEl.style.display = (view==='settings' || view==='finance' || view==='dashboard') ? 'none' : 'flex';
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
  const totalPeople = myGuests.reduce((s,g)=>s+(Number(g.adults)||0),0);
  const invitedPeople = myGuests.filter(g=>g.invited).reduce((s,g)=>s+(Number(g.adults)||0),0);
  const notInvitedPeople = totalPeople - invitedPeople;
  document.getElementById('statGuestTotal').textContent = totalPeople;
  document.getElementById('statGuestPeople').textContent = `across ${myGuests.length} entr${myGuests.length===1?'y':'ies'}`;
  document.getElementById('statGuestConfirmed').textContent = invitedPeople;
  document.getElementById('statGuestPending').textContent = notInvitedPeople;

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
    const notInvitedCount = visibleGuests().filter(g=>!g.invited).length;
    if(notInvitedCount>0) alerts.push({type:'guests', text:`${notInvitedCount} guest entries haven't been invited yet — wedding is ${days} days away`});
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
    const evGuests = visibleGuests(ev.id);
    const count = evGuests.reduce((s,g)=>s+(Number(g.adults)||0),0);
    const bashorCount = ev.isMainWedding ? evGuests.filter(g=>g.bashorRaat).reduce((s,g)=>s+(Number(g.adults)||0),0) : 0;
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
  let rows = visibleGuests(eventId);
  if(bashorOnly) rows = rows.filter(g=>g.bashorRaat);
  return [...rows].sort((a,b)=> (a.tag||'').localeCompare(b.tag||'') || a.name.localeCompare(b.name));
}
function openEventAttendeesPopup(eventId, bashorOnly){
  const ev = eventById(eventId);
  if(!ev) return;
  const rows = attendeesForEvent(eventId, bashorOnly);
  const total = rows.reduce((s,r)=>s+(Number(r.adults)||0),0);
  const groups = new Map();
  rows.forEach(r=>{ const key=r.tag || 'General'; if(!groups.has(key)) groups.set(key,[]); groups.get(key).push(r); });
  const htmlGroups = Array.from(groups.entries()).map(([tag,items])=>`
    <div class="section-title" style="margin-top:14px;">${escapeHtml(tag)} <span style="font-weight:400;">— ${items.reduce((s,r)=>s+(Number(r.adults)||0),0)}</span></div>
    <div class="list">${items.map(r=>`<div class="item" style="padding:12px 14px;">
      <div class="item-top">
        <div><div class="item-title">${escapeHtml(r.name)}${r.bashorRaat && !bashorOnly?' 🌙':''}</div><div class="item-meta">${Number(r.adults)||1} ${(Number(r.adults)||1)===1?'person':'people'}</div></div>
        <span class="badge ${r.invited?'confirmed':'pending'}">${r.invited?'Invited':'Not yet'}</span>
      </div>
    </div>`).join('')}</div>`).join('');
  openSheet(`
    <h3 class="serif">${escapeHtml(ev.name)} guests</h3>
    <p class="sheet-sub">${total} guest${total===1?'':'s'} ${bashorOnly?'staying over':'expected'} · ${rows.length} entr${rows.length===1?'y':'ies'}</p>
    ${rows.length ? htmlGroups : emptyState('No one yet', bashorOnly ? 'No guests marked for Bashor Raat.' : 'No guests added to this event yet.')}
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

/* ================= GUESTS (simple per-event lists, grouped by tag) ================= */
// Each guest is one row: which event's list it belongs to, a Tag for grouping (e.g. "Family",
// "Baba's Invitee"), a Name (can be a combined name like "Shantanu + Wife"), an Adults
// headcount, and whether they've been Invited yet. Wedding-list guests can also be marked as
// staying for Bashor Raat — there's no separate "Bashor Raat" event, it's part of that list.
let activeGuestEventId = null;
let guestStatusFilter = 'all'; // all | invited | notinvited
let collapsedTags = new Set();

function activeGuestEvent(){
  const events = visibleEvents();
  if(!events.length) return null;
  if(activeGuestEventId && events.some(e=>e.id===activeGuestEventId)) return events.find(e=>e.id===activeGuestEventId);
  return events[0];
}
function renderGuestEventTabs(){
  const wrap = document.getElementById('guestEventTabs');
  if(!wrap) return;
  const events = [...visibleEvents()].sort((a,b)=>(a.date||'').localeCompare(b.date||''));
  if(events.length===0){ wrap.innerHTML = ''; return; }
  const current = activeGuestEvent();
  if(current && !activeGuestEventId) activeGuestEventId = current.id;
  wrap.innerHTML = events.map(ev=>`<button type="button" class="seg-btn ${ev.id===activeGuestEventId?'active':''}" data-guest-event-tab="${ev.id}">${escapeHtml(ev.name)}${ev.isMainWedding?' + Bashor':''}</button>`).join('');
  wrap.querySelectorAll('[data-guest-event-tab]').forEach(btn=>{
    btn.addEventListener('click', ()=>{ activeGuestEventId = btn.dataset.guestEventTab; renderGuests(); });
  });
}
document.querySelectorAll('#guestFilter .seg-btn').forEach(b=>{
  b.addEventListener('click', ()=>{
    guestStatusFilter = b.dataset.f;
    document.querySelectorAll('#guestFilter .seg-btn').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    renderGuests();
  });
});

function renderGuests(){
  renderGuestEventTabs();
  const list = document.getElementById('guestList');
  const ev = activeGuestEvent();
  if(!ev){ list.innerHTML = emptyState('No events yet', 'Add an event in Settings first — guest lists live under each event.'); return; }

  let guests = visibleGuests(ev.id);
  if(guestStatusFilter==='invited') guests = guests.filter(g=>g.invited);
  if(guestStatusFilter==='notinvited') guests = guests.filter(g=>!g.invited);

  list.innerHTML = '';
  if(guests.length===0){ list.innerHTML = emptyState('No guests yet', `Tap + to add someone to the ${escapeHtml(ev.name)} list.`); return; }

  const groups = new Map();
  guests.forEach(g=>{ const tag=g.tag||'General'; if(!groups.has(tag)) groups.set(tag, []); groups.get(tag).push(g); });
  const sortedTags = [...groups.keys()].sort((a,b)=>a.localeCompare(b));

  sortedTags.forEach(tag=>{
    const items = groups.get(tag).sort((a,b)=>a.name.localeCompare(b.name));
    const sum = items.reduce((s,g)=>s+(Number(g.adults)||0),0);
    const collapsed = collapsedTags.has(tag);
    const groupEl = document.createElement('div');
    groupEl.className = 'tag-group';
    groupEl.innerHTML = `
      <div class="tag-group-header" data-toggle-tag="${escapeAttr(tag)}">
        <span class="tag-chevron ${collapsed?'collapsed':''}">▾</span>
        <span class="tag-group-name">${escapeHtml(tag)}</span>
        <span class="tag-group-sum">${sum}</span>
      </div>
      <div class="tag-group-body" style="display:${collapsed?'none':'block'};"></div>
    `;
    const body = groupEl.querySelector('.tag-group-body');
    items.forEach(g=>{
      const row = document.createElement('div');
      row.className = 'guest-row-simple';
      row.innerHTML = `
        <div class="guest-row-main">
          <div class="guest-row-name">${escapeHtml(g.name)}${g.bashorRaat?' 🌙':''}</div>
          <div class="guest-row-adults">${Number(g.adults)||1}</div>
        </div>
        <button type="button" class="badge tappable ${g.invited?'confirmed':'pending'}" data-toggle-invited="${g.id}">${g.invited?'Invited':'Not yet'}</button>
      `;
      row.addEventListener('click', (e)=>{ if(e.target.closest('[data-toggle-invited]')) return; openGuestForm(g); });
      row.querySelector('[data-toggle-invited]').addEventListener('click', (e)=>{
        e.stopPropagation();
        g.invited = !g.invited;
        saveData(); renderAll();
      });
      body.appendChild(row);
    });
    groupEl.querySelector('[data-toggle-tag]').addEventListener('click', ()=>{
      if(collapsedTags.has(tag)) collapsedTags.delete(tag); else collapsedTags.add(tag);
      renderGuests();
    });
    list.appendChild(groupEl);
  });
}

function openGuestForm(guest){
  const isEdit = !!guest;
  const ev = activeGuestEvent();
  if(!isEdit && !ev){ toast('Add an event first'); return; }
  guest = guest || { id: uid(), eventId: ev.id, tag:'General', name:'', adults:1, invited:false, bashorRaat:false };
  const guestEvent = eventById(guest.eventId) || ev;
  const existingTags = [...new Set(visibleGuests(guest.eventId).map(g=>g.tag||'General'))].sort((a,b)=>a.localeCompare(b));

  openSheet(`
    <h3 class="serif">${isEdit?'Edit guest':'New guest'}</h3>
    <p class="sheet-sub">${escapeHtml(guestEvent ? guestEvent.name : '')}</p>
    <div class="field">
      <label>Tag / group</label>
      <input id="g_tag" list="g_tag_options" value="${escapeAttr(guest.tag||'General')}" placeholder="e.g. Family, Baba's Invitee">
      <datalist id="g_tag_options">${existingTags.map(t=>`<option value="${escapeAttr(t)}">`).join('')}</datalist>
    </div>
    <div class="field"><label>Name</label><input id="g_name" value="${escapeAttr(guest.name)}" placeholder="e.g. Shantanu + Wife"></div>
    <div class="field"><label>Adults (headcount)</label><input type="number" min="1" id="g_adults" value="${guest.adults||1}"></div>
    <div class="toggle-row">
      <div><div class="toggle-label">Invited</div><div class="toggle-sub">Has the invite been sent?</div></div>
      <label class="switch"><input type="checkbox" id="g_invited" ${guest.invited?'checked':''}><span class="track"></span></label>
    </div>
    ${guestEvent && guestEvent.isMainWedding ? `
    <div class="toggle-row">
      <div><div class="toggle-label">Staying for Bashor Raat?</div></div>
      <label class="switch"><input type="checkbox" id="g_bashor" ${guest.bashorRaat?'checked':''}><span class="track"></span></label>
    </div>` : ''}
    <div class="sheet-actions">
      ${isEdit? '<button class="btn btn-danger" id="deleteBtn">Delete</button>' : ''}
      <button class="btn btn-ghost" id="cancelBtn">Cancel</button>
      <button class="btn btn-primary" id="saveBtn">Save</button>
    </div>
  `);
  document.getElementById('cancelBtn').onclick = closeSheet;
  if(isEdit) document.getElementById('deleteBtn').onclick = ()=>{
    state.guests = state.guests.filter(x=>x.id!==guest.id);
    saveData(); closeSheet(); renderAll(); toast('Guest deleted');
  };
  document.getElementById('saveBtn').onclick = ()=>{
    const name = document.getElementById('g_name').value.trim();
    if(!name){ toast('Please enter a name'); return; }
    guest.name = name;
    guest.tag = document.getElementById('g_tag').value.trim() || 'General';
    guest.adults = Number(document.getElementById('g_adults').value) || 1;
    guest.invited = document.getElementById('g_invited').checked;
    const bashorEl = document.getElementById('g_bashor');
    guest.bashorRaat = bashorEl ? bashorEl.checked : false;
    if(!isEdit) state.guests.push(guest);
    saveData(); closeSheet(); renderAll(); toast('Guest saved');
  };
}

/* ---- Import: XLSX/CSV/JSON, always into the currently selected event's list ---- */
function normalizeHeader(h){ return String(h||'').toLowerCase().replace(/[^a-z0-9]/g,''); }
function findColumn(headers, synonyms){ const normSyns = synonyms.map(normalizeHeader); return headers.find(h => normSyns.includes(normalizeHeader(h))); }

document.getElementById('importGuestsBtn').addEventListener('click', openImportPicker);

function openImportPicker(){
  const ev = activeGuestEvent();
  if(!ev){ toast('Add an event in Settings first'); return; }
  openSheet(`
    <h3 class="serif">Import guests</h3>
    <p class="sheet-sub">Into: ${escapeHtml(ev.name)}</p>
    <p style="font-size:13px;color:var(--text-soft);line-height:1.5;">
      Choose an .xlsx, .xls, .csv, or .json file. For spreadsheets, use column headers Tags, Name, Adults, Invited — matching columns are detected automatically (Tags is optional; a blank Tags cell continues the group above it, matching a grouped spreadsheet export). For JSON, see the format described in the app's README.
    </p>
    <label class="btn btn-primary" id="importFileLabel" style="width:100%;display:block;text-align:center;margin-top:6px;">
      Choose file
      <input type="file" id="importFileInput" accept=".xlsx,.xls,.csv,.json" style="display:none;">
    </label>
    <div class="login-error" id="importError"></div>
    <div class="sheet-actions"><button class="btn btn-ghost" id="cancelBtn" style="width:100%;">Cancel</button></div>
  `);
  document.getElementById('cancelBtn').onclick = closeSheet;
  document.getElementById('importFileInput').addEventListener('change', handleImportFile);
}
function handleImportFile(e){
  const file = e.target.files[0];
  if(!file) return;
  const errEl = document.getElementById('importError');
  document.getElementById('importFileLabel').textContent = 'Reading file…';
  const isJson = /\.json$/i.test(file.name);
  const reader = new FileReader();
  reader.onload = (evt) => {
    try{
      if(isJson){
        const parsed = JSON.parse(evt.target.result);
        const rows = jsonToRows(parsed);
        if(!rows.length){ errEl.textContent = 'No guests found in that JSON file.'; return; }
        processImportRows(rows, true);
      } else {
        const wb = XLSX.read(evt.target.result, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
        if(rows.length === 0){ errEl.textContent = 'No rows found in that file.'; return; }
        processImportRows(rows, false);
      }
    }catch(err){ console.error(err); errEl.textContent = 'Could not read that file — check it matches the expected format.'; }
  };
  if(isJson) reader.readAsText(file); else reader.readAsArrayBuffer(file);
}
// Accepts { "tags": [ { "name": "Family", "guests": [ {"name":"...","adults":2,"invited":true}, ... ] }, ... ] }
// or a flat array [ {"tag":"Family","name":"...","adults":2,"invited":true}, ... ]
function jsonToRows(parsed){
  const rows = [];
  if(Array.isArray(parsed)){
    parsed.forEach(r=> rows.push({ tag: r.tag||r.Tags||'General', name: r.name||r.Name||'', adults: r.adults||r.Adults||1, invited: !!(r.invited||r.Invited) }));
  } else if(parsed && Array.isArray(parsed.tags)){
    parsed.tags.forEach(group=>{
      (group.guests||[]).forEach(g=> rows.push({ tag: group.name||'General', name: g.name||'', adults: g.adults||1, invited: !!g.invited }));
    });
  }
  return rows;
}
function processImportRows(rows, alreadyNormalized){
  let col = null;
  if(!alreadyNormalized){
    const headers = Object.keys(rows[0]);
    col = {
      tag: findColumn(headers, ['tags','tag','category','group','description tag']),
      name: findColumn(headers, ['name','guest name','full name']),
      adults: findColumn(headers, ['adults','adult','headcount','no of adults','number of adults']),
      invited: findColumn(headers, ['invited','invited?','invite sent','sent'])
    };
    if(!col.name){ document.getElementById('importError').textContent = 'Could not find a "Name" column in that file.'; return; }
  }

  const ev = activeGuestEvent();
  const existingNames = new Set(visibleGuests(ev.id).map(g=>g.name.trim().toLowerCase()));
  const toImport = [];
  let skippedBlank = 0, skippedDup = 0;
  let lastTag = 'General';

  rows.forEach(row=>{
    const name = alreadyNormalized ? String(row.name||'').trim() : String(row[col.name]||'').trim();
    if(!name){ skippedBlank++; return; }
    if(existingNames.has(name.toLowerCase())){ skippedDup++; return; }
    let tag = String(alreadyNormalized ? row.tag : (col.tag ? row[col.tag] : '') || '').trim();
    if(tag) lastTag = tag; else tag = lastTag; // carry forward, matching a grouped-spreadsheet export
    const adultsRaw = alreadyNormalized ? row.adults : (col.adults ? row[col.adults] : '');
    const invitedRaw = alreadyNormalized ? row.invited : (col.invited ? row[col.invited] : '');
    const invited = alreadyNormalized ? !!invitedRaw : /^(yes|y|true|1|✓|invited)$/i.test(String(invitedRaw||'').trim());
    toImport.push({ id: uid(), eventId: ev.id, tag: tag || 'General', name, adults: Number(adultsRaw)||1, invited, bashorRaat:false });
    existingNames.add(name.toLowerCase());
  });
  renderImportPreview(toImport, skippedBlank, skippedDup);
}
function renderImportPreview(toImport, skippedBlank, skippedDup){
  const ev = activeGuestEvent();
  const previewNames = toImport.slice(0,8).map(g=>escapeHtml(g.name)).join(', ') + (toImport.length>8 ? `, +${toImport.length-8} more` : '');
  openSheet(`
    <h3 class="serif">Ready to import</h3>
    <p class="sheet-sub">Into: ${escapeHtml(ev.name)}</p>
    <div class="item" style="margin-bottom:8px;"><div class="item-title">${toImport.length} new guest${toImport.length===1?'':'s'}</div>${toImport.length ? `<div class="item-meta">${previewNames}</div>` : ''}</div>
    ${skippedDup ? `<div class="item-meta" style="margin-bottom:8px;">${skippedDup} skipped — already in this event's list.</div>` : ''}
    ${skippedBlank ? `<div class="item-meta" style="margin-bottom:8px;">${skippedBlank} row(s) skipped — no name found.</div>` : ''}
    <div class="sheet-actions">
      <button class="btn btn-ghost" id="cancelBtn">Cancel</button>
      <button class="btn btn-primary" id="confirmImportBtn" ${toImport.length?'':'disabled'}>Import ${toImport.length}</button>
    </div>
  `);
  document.getElementById('cancelBtn').onclick = closeSheet;
  document.getElementById('confirmImportBtn').onclick = ()=>{
    state.guests.push(...toImport);
    saveData(); closeSheet(); renderAll();
    toast(`${toImport.length} guest${toImport.length===1?'':'s'} imported`);
  };
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

/* Recovery tool: your phone's Firestore SDK keeps its own local offline copy of the last
   successfully-synced document (separate from this app's own cache, which "Sign out" clears).
   If the live cloud document was ever wiped by a bug, THIS device's copy — untouched by our own
   cache-clearing — may still hold the last good version. This reads that local copy only
   (never touches the server) and lets you compare it before deciding whether to restore it. */
function countUp(s){
  return {
    vendors: (s.vendors||[]).length,
    guests: (s.guests||[]).length,
    tasks: (s.tasks||[]).length,
    events: (s.settings && s.settings.events || []).length,
    expenses: (s.otherExpenses||[]).length
  };
}
document.getElementById('recoverCacheBtn').addEventListener('click', async ()=>{
  if(!weddingDocRef){ toast('Sign in first'); return; }
  let cachedSnap;
  try{
    cachedSnap = await getDocFromCache(weddingDocRef);
  }catch(err){
    toast('No older data found cached on this device.');
    return;
  }
  if(!cachedSnap || !cachedSnap.exists()){
    toast('No older data found cached on this device.');
    return;
  }
  const cachedData = cachedSnap.data();
  const cachedCounts = countUp(cachedData);
  const liveCounts = countUp(state);

  openSheet(`
    <h3 class="serif">Data found on this device</h3>
    <p class="sheet-sub">This is a snapshot from the last time this device successfully synced — it may be older or newer than what's live right now. Compare before deciding.</p>
    <div class="item" style="margin-bottom:8px;">
      <div class="item-title">Currently showing (live)</div>
      <div class="item-meta">${liveCounts.vendors} vendors · ${liveCounts.guests} guests · ${liveCounts.tasks} tasks · ${liveCounts.events} events · ${liveCounts.expenses} expenses</div>
    </div>
    <div class="item" style="margin-bottom:8px;">
      <div class="item-title">Found on this device</div>
      <div class="item-meta">${cachedCounts.vendors} vendors · ${cachedCounts.guests} guests · ${cachedCounts.tasks} tasks · ${cachedCounts.events} events · ${cachedCounts.expenses} expenses</div>
    </div>
    <p style="font-size:12.5px;color:var(--text-soft,#8A7480);">If the device numbers look like your real data and the live numbers look empty or wrong, restoring will overwrite the live cloud document with this device's copy — for everyone.</p>
    <div class="sheet-actions">
      <button class="btn btn-ghost" id="cancelRecoverBtn">Cancel</button>
      <button class="btn btn-primary" id="doRecoverBtn">Restore this to the cloud</button>
    </div>
  `);
  document.getElementById('cancelRecoverBtn').onclick = closeSheet;
  document.getElementById('doRecoverBtn').onclick = async ()=>{
    if(!confirm('This will overwrite the live cloud data with the copy found on this device, for everyone. Continue?')) return;
    state = normalizeState(deepMerge(structuredClone(DEFAULT_DATA), cachedData), myUid());
    try{
      await setDoc(weddingDocRef, state);
      cacheLocally();
      closeSheet(); renderAll();
      toast('Restored from this device — check everything looks right');
    }catch(err){
      console.error(err);
      toast('Could not save the restore — check your connection and try again');
    }
  };
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
