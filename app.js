/* Wedding Secretary — Firebase-backed PWA (cloud sync, profiles, shared finance, offline cache) */

import { auth, db } from './firebase-config.js';
import { CLOUDINARY_CLOUD_NAME, CLOUDINARY_UPLOAD_PRESET } from './cloud-config.js';
import {
  signInWithEmailAndPassword, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  doc, setDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const STORE_KEY = 'wedsec_v2_cache';
const WEDDING_DOC_PATH = ['weddings', 'main'];

const DEFAULT_DATA = {
  settings: {
    weddingDate: '2027-03-14',
    receptionDate: '2027-03-17',
    peopleNames: ['Saubhik', 'Tanuka'],
    events: [
      { id: 'ev_haldi', name: 'Haldi', date: '2027-03-13', time: '10:00', venue: '', address: '', audience: 'FULL' },
      { id: 'ev_wedding', name: 'Wedding', date: '2027-03-14', time: '19:00', venue: '', address: '', audience: 'FULL' },
      { id: 'ev_vidaai', name: 'Vidaai', date: '2027-03-15', time: '11:00', venue: '', address: '', audience: 'FULL' },
      { id: 'ev_reception', name: 'Reception', date: '2027-03-17', time: '19:00', venue: '', address: '', audience: 'ALL' }
    ]
  },
  profiles: {},   // { [uid]: profileName }
  tasks: [],
  vendors: [],
  guests: [],
  otherExpenses: []
};

let state = structuredClone(DEFAULT_DATA);
let currentView = 'dashboard';
let currentUser = null;
let weddingDocRef = null;
let applyingRemoteUpdate = false;
let saveTimer = null;
let dashboardAnimated = false;

function loadLocalCache(){
  try{
    const raw = localStorage.getItem(STORE_KEY);
    if(!raw) return null;
    return deepMerge(structuredClone(DEFAULT_DATA), JSON.parse(raw));
  }catch(e){ return null; }
}
function cacheLocally(){ try{ localStorage.setItem(STORE_KEY, JSON.stringify(state)); }catch(e){} }
function deepMerge(base, extra){
  const out = { ...base, ...extra };
  out.settings = { ...base.settings, ...(extra.settings||{}) };
  out.profiles = { ...base.profiles, ...(extra.profiles||{}) };
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

/* ---------------- Auth ---------------- */
const loginScreen = document.getElementById('loginScreen');
const profilePicker = document.getElementById('profilePicker');
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
document.getElementById('signOutBtn').addEventListener('click', ()=> signOut(auth));
document.getElementById('changeProfileBtn').addEventListener('click', showProfilePicker);

function myProfile(){ return currentUser ? (state.profiles[currentUser.uid] || null) : null; }
function peopleNames(){ return state.settings.peopleNames && state.settings.peopleNames.length ? state.settings.peopleNames : ['Saubhik','Tanuka']; }

function showProfilePicker(){
  const list = document.getElementById('profileChoiceList');
  list.innerHTML = peopleNames().map(name=>`<button data-name="${escapeAttr(name)}">${escapeHtml(name)}</button>`).join('');
  list.querySelectorAll('button').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      state.profiles[currentUser.uid] = btn.dataset.name;
      saveData();
      profilePicker.classList.add('hidden');
      renderAll();
      toast(`You're set up as ${btn.dataset.name}`);
    });
  });
  profilePicker.classList.remove('hidden');
}

let unsubscribeSnapshot = null;
onAuthStateChanged(auth, async (user)=>{
  currentUser = user;
  if(user){
    loginScreen.classList.add('hidden');
    document.getElementById('accountEmail').textContent = user.email;
    weddingDocRef = doc(db, ...WEDDING_DOC_PATH);

    const cached = loadLocalCache();
    if(cached){ state = cached; renderAll(); }

    if(unsubscribeSnapshot) unsubscribeSnapshot();
    unsubscribeSnapshot = onSnapshot(weddingDocRef, (snap)=>{
      applyingRemoteUpdate = true;
      if(snap.exists()){
        state = deepMerge(structuredClone(DEFAULT_DATA), snap.data());
      } else {
        state = cached || structuredClone(DEFAULT_DATA);
        setDoc(weddingDocRef, state).catch(()=>{});
      }
      cacheLocally();
      if(!myProfile()) showProfilePicker(); else profilePicker.classList.add('hidden');
      renderAll();
      applyingRemoteUpdate = false;
    }, (err)=>{ console.error('Snapshot error', err); toast('Offline — showing last saved data'); });
  } else {
    if(unsubscribeSnapshot){ unsubscribeSnapshot(); unsubscribeSnapshot = null; }
    weddingDocRef = null;
    state = structuredClone(DEFAULT_DATA);
    loginScreen.classList.remove('hidden');
    profilePicker.classList.add('hidden');
  }
});

/* ---------------- Helpers ---------------- */
const uid = () => Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4);
const money = (n) => '₹' + Math.round(Number(n)||0).toLocaleString('en-IN');
const todayISO = () => new Date().toISOString().slice(0,10);
function formatDate(iso){ if(!iso) return ''; const d = new Date(iso+'T00:00:00'); return d.toLocaleDateString('en-GB', {day:'numeric', month:'long', year:'numeric'}); }
function formatDateShort(iso){ if(!iso) return ''; const d = new Date(iso+'T00:00:00'); return d.toLocaleDateString('en-GB', {day:'numeric', month:'short'}); }
function emptyState(title, sub){ return `<div class="empty-state"><svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="#6B6459" stroke-width="1.4"><circle cx="12" cy="12" r="9"/><path d="M9 10h.01M15 10h.01M8 15c1.2 1 2.5 1.5 4 1.5s2.8-.5 4-1.5"/></svg><div class="serif">${title}</div><div>${sub}</div></div>`; }
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

/* Finance visibility: a vendor/expense is visible to `who` if they created it,
   or it's explicitly marked shared and `who` is on the shared list. Legacy items
   with no createdBy are treated as visible to everyone (nothing to hide). */
function canSeeFinance(entity, who){
  if(!entity.createdBy) return true;
  if(entity.createdBy === who) return true;
  if(entity.visibility === 'shared' && (entity.sharedWith||[]).includes(who)) return true;
  return false;
}
function visibleVendors(){ const me = myProfile(); return state.vendors.filter(v=> canSeeFinance(v, me)); }
function visibleExpenses(){ const me = myProfile(); return state.otherExpenses.filter(e=> canSeeFinance(e, me)); }
function allPaymentsFlat(){
  const rows = [];
  state.vendors.forEach(v=> (v.payments||[]).forEach(p=> rows.push({ ...p, vendorId: v.id, vendorName: v.name, vendorVisible: canSeeFinance(v, myProfile()) })));
  return rows;
}

/* ---------------- Navigation ---------------- */
document.querySelectorAll('.nav-btn').forEach(btn=>{ btn.addEventListener('click', ()=> switchView(btn.dataset.view)); });
function switchView(view){
  currentView = view;
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById('view-'+view).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active', b.dataset.view===view));
  document.getElementById('fabAdd').style.display = (view==='settings' || view==='finance') ? 'none' : 'flex';
  renderAll();
}

/* ---------------- Sheet ---------------- */
const backdrop = document.getElementById('sheetBackdrop');
const sheetContent = document.getElementById('sheetContent');
function openSheet(html){ sheetContent.innerHTML = `<div class="sheet-handle"></div>` + html; backdrop.classList.add('active'); }
function closeSheet(){ backdrop.classList.remove('active'); }
backdrop.addEventListener('click', e=>{ if(e.target===backdrop) closeSheet(); });

document.getElementById('fabAdd').addEventListener('click', ()=>{
  if(currentView==='tasks') openTaskForm();
  else if(currentView==='vendors') openVendorForm();
  else if(currentView==='guests') openGuestForm();
  else openTaskForm();
});

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

  const totalPeople = state.guests.reduce((s,g)=>s+(Number(g.adults)||0)+(Number(g.children)||0),0);
  document.getElementById('statGuestTotal').textContent = state.guests.length;
  document.getElementById('statGuestPeople').textContent = totalPeople + ' people incl. children';
  document.getElementById('statGuestConfirmed').textContent = state.guests.filter(g=>g.rsvp==='confirmed').length;
  document.getElementById('statGuestPending').textContent = state.guests.filter(g=>g.rsvp==='pending').length;
  document.getElementById('statGuestDeclined').textContent = state.guests.filter(g=>g.rsvp==='declined').length;

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
      if(p.plannedDate && p.plannedDate <= addDays(todayISO(),14)){
        alerts.push({type:'vendor', text:`${v.name}: planned payment of ${money(p.amount)} due ${formatDateShort(p.plannedDate)}`});
      }
    });
  });
  if(days>=0 && days<=14){
    const pendingGuests = state.guests.filter(g=>g.rsvp==='pending').length;
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
  const events = [...(state.settings.events||[])].sort((a,b)=> (a.date||'').localeCompare(b.date||''));
  if(events.length===0){ box.innerHTML = emptyState('No events yet', 'Add Haldi, Wedding, Reception and more in Settings.'); return; }
  const pinIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 21s-6-5.5-6-10a6 6 0 0112 0c0 4.5-6 10-6 10z"/><circle cx="12" cy="11" r="2.2"/></svg>`;
  box.innerHTML = events.map(ev=>{
    const count = guestCountForEvent(ev);
    return `<div class="event-card">
      <div class="event-top">
        <div class="event-name">${escapeHtml(ev.name)}</div>
        <div class="event-when">${ev.date? formatDateShort(ev.date):''}${ev.time? ' · '+ev.time:''}</div>
      </div>
      ${ev.venue || ev.address ? `<div class="event-meta">${pinIcon}<span>${escapeHtml(ev.venue)}${ev.venue && ev.address? ' — ':''}${escapeHtml(ev.address)}</span></div>` : ''}
      <div class="event-count">🎉 ${count} guests expected</div>
    </div>`;
  }).join('');
}
function guestCountForEvent(ev){
  const relevant = state.guests.filter(g=> ev.audience==='ALL' ? true : g.cohort==='FULL');
  return relevant.reduce((s,g)=>s+(Number(g.adults)||0)+(Number(g.children)||0),0);
}

function renderBudgetBox(){
  const box = document.getElementById('budgetBox');
  const me = myProfile();
  const vendors = visibleVendors();
  let contracted=0, paid=0, scheduled=0;
  vendors.forEach(v=>{
    contracted += Number(v.contract)||0;
    (v.payments||[]).forEach(p=>{
      if(p.status==='paid') paid += Number(p.amount||0);
      else scheduled += Number(p.amount||0);
    });
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
    ${hiddenCount ? `<div class="item-meta" style="margin-top:8px;">${hiddenCount} vendor${hiddenCount===1?'':'s'} kept private aren't included above.</div>` : ''}
  `;
}

/* ================= TASKS ================= */
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

/* ================= VENDORS ================= */
function renderVendors(){
  const list = document.getElementById('vendorList');
  list.innerHTML='';
  if(state.vendors.length===0){ list.innerHTML = emptyState('No vendors yet', 'Tap + to add a photographer, venue, caterer...'); return; }
  const me = myProfile();
  state.vendors.forEach(v=>{
    const canSee = canSeeFinance(v, me);
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
        ${v.visibility==='shared' ? `<span class="badge tappable" style="background:#EAF1EE;color:var(--sage);">Shared</span>` : ''}
      </div>
      ${canSee ? `
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
  vendor = vendor || { id: uid(), name:'', category:'', contact:'', phone:'', contract:0, payments:[], documents:[], visibility:'private', sharedWith:[], createdBy: myProfile() };
  vendor.documents = vendor.documents || [];
  vendor.payments = vendor.payments || [];
  vendor.sharedWith = vendor.sharedWith || [];
  if(!vendor.createdBy) vendor.createdBy = myProfile();

  const canSee = canSeeFinance(vendor, myProfile());
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

  const shareChips = peopleNames().map(name=>`<button type="button" class="chip ${vendor.sharedWith.includes(name)?'active':''}" data-share-name="${escapeAttr(name)}">${escapeHtml(name)}</button>`).join('');

  openSheet(`
    <h3 class="serif">${isEdit?'Edit vendor':'New vendor'}</h3>
    <div class="field"><label>Name</label><input id="v_name" value="${escapeAttr(vendor.name)}" placeholder="e.g. Sharma Studios"></div>
    <div class="field-row">
      <div class="field"><label>Category</label><input id="v_category" value="${escapeAttr(vendor.category)}" placeholder="Photography, Catering..."></div>
      <div class="field"><label>Phone</label><input id="v_phone" value="${escapeAttr(vendor.phone)}"></div>
    </div>
    <div class="field"><label>Contact person</label><input id="v_contact" value="${escapeAttr(vendor.contact)}"></div>
    <div class="field"><label>Contract amount (₹)</label><input type="number" id="v_contract" value="${vendor.contract||0}"></div>

    <div class="section-title" style="margin-top:16px;">Sharing</div>
    <div class="toggle-row">
      <div><div class="toggle-label">Share this vendor's finances</div><div class="toggle-sub">Off = only you (${escapeHtml(vendor.createdBy||myProfile()||'you')}) can see amounts</div></div>
      <label class="switch"><input type="checkbox" id="v_shared" ${vendor.visibility==='shared'?'checked':''}><span class="track"></span></label>
    </div>
    <div id="shareChipsWrap" style="display:${vendor.visibility==='shared'?'block':'none'};margin-bottom:8px;">
      <div class="chip-row">${shareChips}</div>
    </div>

    ${isEdit && canSee ? `
    <div class="section-title" style="margin-top:16px;">Payments — ${money(paid)} of ${money(vendor.contract)} paid</div>
    ${paymentsHtml}
    <button class="btn btn-gold" id="goRecordPaymentBtn" style="width:100%;margin-top:8px;">Record a payment for this vendor →</button>
    ` : isEdit ? `<div class="section-title" style="margin-top:16px;">Payments</div><div class="item-meta">🔒 Private to ${escapeHtml(vendor.createdBy||'the owner')}</div>` : ''}

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
  document.getElementById('v_shared').addEventListener('change', (e)=>{
    document.getElementById('shareChipsWrap').style.display = e.target.checked ? 'block' : 'none';
  });
  sheetContent.querySelectorAll('[data-share-name]').forEach(chip=>{
    chip.addEventListener('click', ()=>{
      const name = chip.dataset.shareName;
      const idx = vendor.sharedWith.indexOf(name);
      if(idx>-1) vendor.sharedWith.splice(idx,1); else vendor.sharedWith.push(name);
      chip.classList.toggle('active');
    });
  });
  sheetContent.querySelectorAll('[data-open-payment]').forEach(row=>{
    row.addEventListener('click', ()=>{
      const p = vendor.payments.find(x=>x.id===row.dataset.openPayment);
      if(p) openPaymentDetail(p, vendor);
    });
  });
  const goBtn = document.getElementById('goRecordPaymentBtn');
  if(goBtn) goBtn.onclick = ()=>{ closeSheet(); openRecordPaymentSheet(vendor.id); };

  if(isEdit){
    document.getElementById('deleteBtn').onclick = ()=>{
      state.vendors = state.vendors.filter(x=>x.id!==vendor.id);
      saveData(); closeSheet(); renderAll(); toast('Vendor deleted');
    };
    document.getElementById('docFileInput').addEventListener('change', (e)=> handleDocUpload(e, vendor));
    document.querySelectorAll('[data-doc-id]').forEach(btn=>{
      btn.addEventListener('click', ()=> handleDocDelete(btn.dataset.docId, vendor));
    });
  }
  document.getElementById('saveBtn').onclick = ()=>{
    const name = document.getElementById('v_name').value.trim();
    if(!name){ toast('Please enter a name'); return; }
    vendor.name = name;
    vendor.category = document.getElementById('v_category').value;
    vendor.phone = document.getElementById('v_phone').value;
    vendor.contact = document.getElementById('v_contact').value;
    vendor.contract = Number(document.getElementById('v_contract').value)||0;
    vendor.visibility = document.getElementById('v_shared').checked ? 'shared' : 'private';
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
      vendor.documents.push({ name: file.name, url: data.secure_url, publicId: data.public_id, uploadedAt: todayISO() });
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

/* ================= FINANCE ================= */
document.getElementById('recordPaymentBtn').addEventListener('click', ()=> openRecordPaymentSheet());
document.getElementById('addOtherExpenseBtn').addEventListener('click', ()=> openExpenseForm());

function renderFinance(){
  const me = myProfile();
  const vendors = visibleVendors();
  let contracted=0, paid=0, scheduled=0;
  vendors.forEach(v=>{
    contracted += Number(v.contract)||0;
    (v.payments||[]).forEach(p=> p.status==='paid' ? paid += Number(p.amount||0) : scheduled += Number(p.amount||0));
  });
  const otherTotal = visibleExpenses().reduce((s,e)=>s+Number(e.amount||0),0);

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
    const canSee = canSeeFinance(v, me);
    const p = (v.payments||[]).filter(x=>x.status==='paid').reduce((s,x)=>s+Number(x.amount||0),0);
    const el = document.createElement('div');
    el.className='item';
    el.innerHTML = `<div class="item-top">
        <div class="item-title">${escapeHtml(v.name)}</div>
        <b>${canSee ? money(p)+' / '+money(v.contract) : '🔒 Private'}</b>
      </div>`;
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
    el.innerHTML = `<div class="item-top">
        <div><div class="item-title">${escapeHtml(e.name)}</div><div class="item-meta">${e.date? formatDateShort(e.date):''}</div></div>
        <b>${money(e.amount)}</b>
      </div>`;
    el.addEventListener('click', ()=> openExpenseForm(e));
    olist.appendChild(el);
  });
}

function openRecordPaymentSheet(preselectVendorId){
  if(state.vendors.length===0){ toast('Add a vendor first'); return; }
  const vendorOptions = state.vendors.map(v=>`<option value="${v.id}" ${v.id===preselectVendorId?'selected':''}>${escapeHtml(v.name)}</option>`).join('');
  const payerOptions = peopleNames().map(n=>`<option value="${escapeAttr(n)}">${escapeHtml(n)}</option>`).join('');
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
    <div id="plannedFields" style="display:none;">
      <div class="field"><label>Expected date</label><input type="date" id="p_planned_date" value="${todayISO()}"></div>
    </div>
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
    <div class="doc-item">
      <a href="${d.url}" target="_blank" rel="noopener">${escapeHtml(d.name)}</a>
      <button type="button" class="btn btn-danger btn-sm" data-pdoc-id="${escapeAttr(d.publicId)}">Delete</button>
    </div>`).join('') : '<div class="item-meta" style="margin-bottom:8px;">No receipt attached yet.</div>';

  openSheet(`
    <h3 class="serif">${escapeHtml(vendor.name)}</h3>
    <p class="sheet-sub">${money(payment.amount)} · ${payment.status==='paid' ? 'Paid' : 'Planned'}</p>

    ${payment.status==='planned' ? `
      <div class="field"><label>Expected date</label><input type="date" id="pd_planned" value="${payment.plannedDate||''}"></div>
      <button class="btn btn-gold" id="markPaidBtn" style="width:100%;margin-bottom:14px;">Mark as paid now</button>
    ` : `
      <div class="field-row">
        <div class="field"><label>Paid by</label><select id="pd_payer">${peopleNames().map(n=>`<option value="${escapeAttr(n)}" ${n===payment.payer?'selected':''}>${escapeHtml(n)}</option>`).join('')}</select></div>
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
    payment.status = 'paid';
    payment.date = todayISO();
    payment.payer = peopleNames()[0] || '';
    saveData(); closeSheet(); renderAll(); toast('Marked as paid');
  };
  document.getElementById('savePaymentBtn').onclick = ()=>{
    payment.amount = Number(document.getElementById('pd_amount').value) || payment.amount;
    payment.note = document.getElementById('pd_note').value;
    if(payment.status==='planned'){
      payment.plannedDate = document.getElementById('pd_planned').value;
    } else {
      payment.payer = document.getElementById('pd_payer').value;
      payment.date = document.getElementById('pd_date').value;
    }
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
      payment.documents.push({ name:file.name, url:data.secure_url, publicId:data.public_id, uploadedAt: todayISO() });
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
  expense = expense || { id: uid(), name:'', amount:0, date: todayISO(), createdBy: myProfile(), visibility:'private', sharedWith:[] };
  expense.sharedWith = expense.sharedWith || [];
  const shareChips = peopleNames().map(name=>`<button type="button" class="chip ${expense.sharedWith.includes(name)?'active':''}" data-share-name="${escapeAttr(name)}">${escapeHtml(name)}</button>`).join('');
  openSheet(`
    <h3 class="serif">${isEdit?'Edit expense':'New expense'}</h3>
    <div class="field"><label>Description</label><input id="e_name" value="${escapeAttr(expense.name)}" placeholder="e.g. Mehndi artist"></div>
    <div class="field-row">
      <div class="field"><label>Amount (₹)</label><input type="number" id="e_amount" value="${expense.amount||0}"></div>
      <div class="field"><label>Date</label><input type="date" id="e_date" value="${expense.date||todayISO()}"></div>
    </div>
    <div class="toggle-row">
      <div><div class="toggle-label">Share this expense</div></div>
      <label class="switch"><input type="checkbox" id="e_shared" ${expense.visibility==='shared'?'checked':''}><span class="track"></span></label>
    </div>
    <div id="eShareChipsWrap" style="display:${expense.visibility==='shared'?'block':'none'};margin-bottom:8px;"><div class="chip-row">${shareChips}</div></div>
    <div class="sheet-actions">
      ${isEdit? '<button class="btn btn-danger" id="deleteBtn">Delete</button>' : ''}
      <button class="btn btn-ghost" id="cancelBtn">Cancel</button>
      <button class="btn btn-primary" id="saveBtn">Save</button>
    </div>
  `);
  document.getElementById('cancelBtn').onclick = closeSheet;
  document.getElementById('e_shared').addEventListener('change', (e)=>{ document.getElementById('eShareChipsWrap').style.display = e.target.checked?'block':'none'; });
  sheetContent.querySelectorAll('[data-share-name]').forEach(chip=>{
    chip.addEventListener('click', ()=>{
      const name = chip.dataset.shareName;
      const idx = expense.sharedWith.indexOf(name);
      if(idx>-1) expense.sharedWith.splice(idx,1); else expense.sharedWith.push(name);
      chip.classList.toggle('active');
    });
  });
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
    expense.visibility = document.getElementById('e_shared').checked ? 'shared' : 'private';
    if(!expense.createdBy) expense.createdBy = myProfile();
    if(!isEdit) state.otherExpenses.push(expense);
    saveData(); closeSheet(); renderAll(); toast('Expense saved');
  };
}

/* ================= GUESTS ================= */
let guestFilter='all';
document.querySelectorAll('#guestFilter .seg-btn').forEach(b=>{
  b.addEventListener('click', ()=>{
    guestFilter = b.dataset.f;
    document.querySelectorAll('#guestFilter .seg-btn').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    renderGuests();
  });
});
document.getElementById('importGuestsBtn').addEventListener('click', openImportPicker);

function normalizeHeader(h){ return String(h||'').toLowerCase().replace(/[^a-z0-9]/g,''); }
function findColumn(headers, synonyms){ const normSyns = synonyms.map(normalizeHeader); return headers.find(h => normSyns.includes(normalizeHeader(h))); }
function openImportPicker(){
  openSheet(`
    <h3 class="serif">Import guests</h3>
    <p style="font-size:13.5px;color:var(--text-soft);line-height:1.5;">
      Choose an .xlsx, .xls, or .csv file. The first row should be column headers
      (e.g. Name, Phone, Adults, Children, Cohort, RSVP, Notes) — matching columns are detected automatically.
    </p>
    <label class="btn btn-primary" id="importFileLabel" style="width:100%;display:block;text-align:center;margin-top:10px;">
      Choose file
      <input type="file" id="importFileInput" accept=".xlsx,.xls,.csv" style="display:none;">
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
  const reader = new FileReader();
  reader.onload = (evt) => {
    try{
      const wb = XLSX.read(evt.target.result, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      if(rows.length === 0){ errEl.textContent = 'No rows found in that file.'; return; }
      processImportRows(rows);
    }catch(err){ console.error(err); errEl.textContent = 'Could not read that file — make sure it\'s a valid Excel or CSV file.'; }
  };
  reader.readAsArrayBuffer(file);
}
function processImportRows(rows){
  const headers = Object.keys(rows[0]);
  const col = {
    name: findColumn(headers, ['name','guest name','full name']),
    phone: findColumn(headers, ['phone','mobile','contact','phone number','mobile number']),
    cohort: findColumn(headers, ['cohort','invited to','event','invitation','category']),
    rsvp: findColumn(headers, ['rsvp','status','rsvp status']),
    adults: findColumn(headers, ['adults','adult','no of adults','number of adults']),
    children: findColumn(headers, ['children','child','kids','no of children','number of children']),
    notes: findColumn(headers, ['notes','note','remarks','comments','comment'])
  };
  if(!col.name){ document.getElementById('importError').textContent = 'Could not find a "Name" column in that file.'; return; }
  const existingNames = new Set(state.guests.map(g=>g.name.trim().toLowerCase()));
  const toImport = []; const duplicates = []; let skippedBlank = 0;
  rows.forEach(row=>{
    const name = String(row[col.name]||'').trim();
    if(!name){ skippedBlank++; return; }
    if(existingNames.has(name.toLowerCase())){ duplicates.push(name); return; }
    const cohortRaw = String(col.cohort ? row[col.cohort] : '').toLowerCase();
    const rsvpRaw = String(col.rsvp ? row[col.rsvp] : '').toLowerCase();
    const guest = {
      id: uid(), name,
      phone: col.phone ? String(row[col.phone]||'').trim() : '',
      cohort: cohortRaw.includes('reception') ? 'RECEPTION' : 'FULL',
      rsvp: rsvpRaw.includes('confirm') ? 'confirmed' : rsvpRaw.includes('declin') ? 'declined' : 'pending',
      adults: col.adults ? (Number(row[col.adults]) || 1) : 1,
      children: col.children ? (Number(row[col.children]) || 0) : 0,
      notes: col.notes ? String(row[col.notes]||'').trim() : ''
    };
    toImport.push(guest);
    existingNames.add(name.toLowerCase());
  });
  renderImportPreview(toImport, duplicates, skippedBlank);
}
function renderImportPreview(toImport, duplicates, skippedBlank){
  const previewNames = toImport.slice(0,8).map(g=>escapeHtml(g.name)).join(', ') + (toImport.length>8 ? `, +${toImport.length-8} more` : '');
  const dupNames = duplicates.slice(0,8).map(escapeHtml).join(', ') + (duplicates.length>8 ? `, +${duplicates.length-8} more` : '');
  openSheet(`
    <h3 class="serif">Ready to import</h3>
    <div class="item" style="margin-bottom:8px;"><div class="item-title">${toImport.length} new guest${toImport.length===1?'':'s'}</div>
      ${toImport.length ? `<div class="item-meta">${previewNames}</div>` : ''}</div>
    ${duplicates.length ? `<div class="item" style="margin-bottom:8px;"><div class="item-title">${duplicates.length} skipped (already in your list)</div><div class="item-meta">${dupNames}</div></div>` : ''}
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

function renderGuests(){
  const list = document.getElementById('guestList');
  let items = [...state.guests].sort((a,b)=>a.name.localeCompare(b.name));
  if(guestFilter==='confirmed') items = items.filter(g=>g.rsvp==='confirmed');
  if(guestFilter==='pending') items = items.filter(g=>g.rsvp==='pending');
  if(guestFilter==='declined') items = items.filter(g=>g.rsvp==='declined');
  if(guestFilter==='full') items = items.filter(g=>g.cohort==='FULL');
  if(guestFilter==='reception') items = items.filter(g=>g.cohort==='RECEPTION');
  list.innerHTML='';
  if(items.length===0){ list.innerHTML = emptyState('No guests here','Tap + to add a guest.'); return; }
  const cycle = { pending:'confirmed', confirmed:'declined', declined:'pending' };
  items.forEach(g=>{
    const el = document.createElement('div');
    el.className='item';
    el.innerHTML = `
      <div class="item-top">
        <div>
          <div class="item-title">${escapeHtml(g.name)}</div>
          <div class="item-meta">${g.cohort==='FULL'?'Full wedding':'Reception only'} · ${(Number(g.adults)||0)+(Number(g.children)||0)} people</div>
        </div>
        <span class="badge tappable ${g.rsvp==='confirmed'?'confirmed':g.rsvp==='declined'?'declined':'pending'}" data-cycle-rsvp="${g.id}">${g.rsvp[0].toUpperCase()+g.rsvp.slice(1)}</span>
      </div>`;
    el.addEventListener('click', (e)=>{ if(e.target.closest('[data-cycle-rsvp]')) return; openGuestForm(g); });
    el.querySelector('[data-cycle-rsvp]').addEventListener('click', (e)=>{
      e.stopPropagation();
      g.rsvp = cycle[g.rsvp] || 'pending';
      saveData(); renderAll();
    });
    list.appendChild(el);
  });
}
function openGuestForm(guest){
  const isEdit = !!guest;
  guest = guest || { id: uid(), name:'', phone:'', cohort:'FULL', rsvp:'pending', adults:1, children:0, notes:'' };
  openSheet(`
    <h3 class="serif">${isEdit?'Edit guest':'New guest'}</h3>
    <div class="field"><label>Name</label><input id="g_name" value="${escapeAttr(guest.name)}" placeholder="e.g. Debashish Roy"></div>
    <div class="field-row">
      <div class="field"><label>Phone</label><input id="g_phone" value="${escapeAttr(guest.phone)}"></div>
      <div class="field"><label>Invited to</label>
        <select id="g_cohort">
          <option value="FULL" ${guest.cohort==='FULL'?'selected':''}>Full Wedding</option>
          <option value="RECEPTION" ${guest.cohort==='RECEPTION'?'selected':''}>Reception Only</option>
        </select>
      </div>
    </div>
    <div class="field-row">
      <div class="field"><label>Adults</label><input type="number" min="0" id="g_adults" value="${guest.adults||0}"></div>
      <div class="field"><label>Children</label><input type="number" min="0" id="g_children" value="${guest.children||0}"></div>
    </div>
    <div class="field"><label>RSVP</label>
      <select id="g_rsvp">
        <option value="pending" ${guest.rsvp==='pending'?'selected':''}>Pending</option>
        <option value="confirmed" ${guest.rsvp==='confirmed'?'selected':''}>Confirmed</option>
        <option value="declined" ${guest.rsvp==='declined'?'selected':''}>Declined</option>
      </select>
    </div>
    <div class="field"><label>Notes</label><textarea id="g_notes">${escapeHtml(guest.notes||'')}</textarea></div>
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
    guest.phone = document.getElementById('g_phone').value;
    guest.cohort = document.getElementById('g_cohort').value;
    guest.adults = Number(document.getElementById('g_adults').value)||0;
    guest.children = Number(document.getElementById('g_children').value)||0;
    guest.rsvp = document.getElementById('g_rsvp').value;
    guest.notes = document.getElementById('g_notes').value;
    if(!isEdit) state.guests.push(guest);
    saveData(); closeSheet(); renderAll(); toast('Guest saved');
  };
}

/* ================= SETTINGS ================= */
document.getElementById('saveSettingsBtn').addEventListener('click', ()=>{
  state.settings.weddingDate = document.getElementById('settingWeddingDate').value || state.settings.weddingDate;
  state.settings.receptionDate = document.getElementById('settingReceptionDate').value || state.settings.receptionDate;
  dashboardAnimated = false;
  saveData(); renderAll(); toast('Settings saved');
});
document.getElementById('addEventBtn').addEventListener('click', ()=> openEventForm());
document.getElementById('addPersonBtn').addEventListener('click', ()=>{
  const name = prompt('Name to add:');
  if(!name || !name.trim()) return;
  if(!state.settings.peopleNames) state.settings.peopleNames = [];
  state.settings.peopleNames.push(name.trim());
  saveData(); renderAll(); toast('Person added');
});
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
      state = deepMerge(structuredClone(DEFAULT_DATA), parsed);
      saveData(); renderAll(); toast('Backup restored');
    }catch(err){ toast('Could not read that file'); }
  };
  reader.readAsText(file);
  e.target.value = '';
});
document.getElementById('resetBtn').addEventListener('click', ()=>{
  if(!confirm('This permanently erases all tasks, vendors, guests and expenses on this device. This cannot be undone. Continue?')) return;
  state = structuredClone(DEFAULT_DATA);
  saveData(); renderAll(); toast('All data erased');
});

function renderEventsSettingsList(){
  const list = document.getElementById('eventsSettingsList');
  const events = [...(state.settings.events||[])].sort((a,b)=>(a.date||'').localeCompare(b.date||''));
  list.innerHTML='';
  if(events.length===0){ list.innerHTML = emptyState('No events yet','Add Haldi, Wedding, Reception, etc.'); return; }
  events.forEach(ev=>{
    const el = document.createElement('div');
    el.className='item';
    el.innerHTML = `<div class="item-top">
        <div><div class="item-title">${escapeHtml(ev.name)}</div><div class="item-meta">${ev.date?formatDate(ev.date):''}${ev.venue?' · '+escapeHtml(ev.venue):''}</div></div>
      </div>`;
    el.addEventListener('click', ()=> openEventForm(ev));
    list.appendChild(el);
  });
}
function openEventForm(ev){
  const isEdit = !!ev;
  ev = ev || { id: uid(), name:'', date:'', time:'', venue:'', address:'', audience:'FULL' };
  openSheet(`
    <h3 class="serif">${isEdit?'Edit event':'New event'}</h3>
    <div class="field"><label>Event name</label><input id="ev_name" value="${escapeAttr(ev.name)}" placeholder="e.g. Sangeet"></div>
    <div class="field-row">
      <div class="field"><label>Date</label><input type="date" id="ev_date" value="${ev.date||''}"></div>
      <div class="field"><label>Time</label><input type="time" id="ev_time" value="${ev.time||''}"></div>
    </div>
    <div class="field"><label>Venue name</label><input id="ev_venue" value="${escapeAttr(ev.venue)}" placeholder="e.g. Taj Bengal"></div>
    <div class="field"><label>Address</label><input id="ev_address" value="${escapeAttr(ev.address)}" placeholder="Optional"></div>
    <div class="field"><label>Who's invited</label>
      <select id="ev_audience">
        <option value="FULL" ${ev.audience==='FULL'?'selected':''}>Full Wedding guests</option>
        <option value="ALL" ${ev.audience==='ALL'?'selected':''}>Everyone (Full Wedding + Reception Only)</option>
      </select>
    </div>
    <div class="sheet-actions">
      ${isEdit? '<button class="btn btn-danger" id="deleteBtn">Delete</button>' : ''}
      <button class="btn btn-ghost" id="cancelBtn">Cancel</button>
      <button class="btn btn-primary" id="saveBtn">Save</button>
    </div>
  `);
  document.getElementById('cancelBtn').onclick = closeSheet;
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
    ev.audience = document.getElementById('ev_audience').value;
    if(!state.settings.events) state.settings.events = [];
    if(!isEdit) state.settings.events.push(ev);
    saveData(); closeSheet(); renderAll(); toast('Event saved');
  };
}
function renderPeopleList(){
  const list = document.getElementById('peopleList');
  list.innerHTML='';
  peopleNames().forEach((name, idx)=>{
    const el = document.createElement('div');
    el.className='item';
    el.style.display='flex'; el.style.justifyContent='space-between'; el.style.alignItems='center';
    el.innerHTML = `<div class="item-title">${escapeHtml(name)}</div>`;
    const delBtn = document.createElement('button');
    delBtn.className='btn btn-danger btn-sm';
    delBtn.textContent='Remove';
    delBtn.addEventListener('click', ()=>{
      if(!confirm(`Remove ${name}? This won't change past records that mention them.`)) return;
      state.settings.peopleNames.splice(idx,1);
      saveData(); renderAll();
    });
    el.appendChild(delBtn);
    list.appendChild(el);
  });
}

/* ---------------- Master render ---------------- */
function renderAll(){
  renderDashboard();
  renderTasks();
  renderVendors();
  renderFinance();
  renderGuests();
  renderEventsSettingsList();
  renderPeopleList();
  document.getElementById('settingWeddingDate').value = state.settings.weddingDate;
  document.getElementById('settingReceptionDate').value = state.settings.receptionDate;
  document.getElementById('accountProfile').textContent = myProfile() || 'Not set';
}
renderAll();

/* ---------------- Service worker registration ---------------- */
if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{ navigator.serviceWorker.register('sw.js').catch(()=>{}); });
}
