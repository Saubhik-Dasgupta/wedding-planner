/* Wedding Secretary Lite — Firebase-backed PWA (cloud sync + offline cache) */

import { auth, db } from './firebase-config.js';
import { CLOUDINARY_CLOUD_NAME, CLOUDINARY_UPLOAD_PRESET } from './cloud-config.js';
import {
  signInWithEmailAndPassword, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  doc, getDoc, setDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const STORE_KEY = 'wedsec_v1_cache'; // local cache only — source of truth is Firestore
const WEDDING_DOC_PATH = ['weddings', 'main']; // single shared document for both accounts

const DEFAULT_DATA = {
  settings: { weddingDate: '2027-03-14', receptionDate: '2027-03-17' },
  tasks: [],
  vendors: [],
  guests: [],
  otherExpenses: []
};

let state = structuredClone(DEFAULT_DATA);
let currentView = 'dashboard';
let currentUser = null;
let weddingDocRef = null;
let applyingRemoteUpdate = false; // guards against re-saving data we just received
let saveTimer = null;

function loadLocalCache(){
  try{
    const raw = localStorage.getItem(STORE_KEY);
    if(!raw) return null;
    return { ...structuredClone(DEFAULT_DATA), ...JSON.parse(raw) };
  }catch(e){ return null; }
}
function cacheLocally(){
  try{ localStorage.setItem(STORE_KEY, JSON.stringify(state)); }catch(e){}
}

/* Called by every add/edit/delete action. Saves locally instantly, then
   pushes to Firestore (debounced) so multiple quick edits become one write. */
function saveData(){
  cacheLocally();
  if(applyingRemoteUpdate) return; // don't echo back a change we just received
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
function showSyncStatus(on){
  document.getElementById('syncStatus').classList.toggle('show', on);
}

/* ---------------- Auth ---------------- */
const loginScreen = document.getElementById('loginScreen');
document.getElementById('loginBtn').addEventListener('click', doLogin);
document.getElementById('login_password').addEventListener('keydown', e=>{ if(e.key==='Enter') doLogin(); });
function doLogin(){
  const email = document.getElementById('login_email').value.trim();
  const password = document.getElementById('login_password').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  if(!email || !password){ errEl.textContent = 'Enter both email and password.'; return; }
  signInWithEmailAndPassword(auth, email, password).catch(err=>{
    errEl.textContent = friendlyAuthError(err.code);
  });
}
function friendlyAuthError(code){
  if(code==='auth/invalid-credential' || code==='auth/wrong-password' || code==='auth/user-not-found') return 'Incorrect email or password.';
  if(code==='auth/too-many-requests') return 'Too many attempts — try again in a bit.';
  if(code==='auth/network-request-failed') return 'No connection — check your internet.';
  return 'Could not sign in. ' + code;
}
document.getElementById('signOutBtn').addEventListener('click', ()=> signOut(auth));

let unsubscribeSnapshot = null;
onAuthStateChanged(auth, async (user)=>{
  currentUser = user;
  if(user){
    loginScreen.classList.add('hidden');
    document.getElementById('accountEmail').textContent = user.email;
    weddingDocRef = doc(db, ...WEDDING_DOC_PATH);

    // Show cached data immediately so the UI isn't blank while we connect.
    const cached = loadLocalCache();
    if(cached){ state = cached; renderAll(); }

    if(unsubscribeSnapshot) unsubscribeSnapshot();
    unsubscribeSnapshot = onSnapshot(weddingDocRef, (snap)=>{
      applyingRemoteUpdate = true;
      if(snap.exists()){
        state = { ...structuredClone(DEFAULT_DATA), ...snap.data() };
      } else {
        // First time ever — seed the cloud doc from whatever we have locally (or defaults).
        state = cached || structuredClone(DEFAULT_DATA);
        setDoc(weddingDocRef, state).catch(()=>{});
      }
      cacheLocally();
      renderAll();
      applyingRemoteUpdate = false;
    }, (err)=>{
      console.error('Snapshot error', err);
      toast('Offline — showing last saved data');
    });
  } else {
    if(unsubscribeSnapshot){ unsubscribeSnapshot(); unsubscribeSnapshot = null; }
    weddingDocRef = null;
    state = structuredClone(DEFAULT_DATA);
    loginScreen.classList.remove('hidden');
  }
});

const uid = () => Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4);
const money = (n) => '₹' + Math.round(Number(n)||0).toLocaleString('en-IN');
const todayISO = () => new Date().toISOString().slice(0,10);

function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(()=>t.classList.remove('show'), 1800);
}

/* ---------------- Navigation ---------------- */
document.querySelectorAll('.nav-btn').forEach(btn=>{
  btn.addEventListener('click', ()=> switchView(btn.dataset.view));
});
function switchView(view){
  currentView = view;
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById('view-'+view).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active', b.dataset.view===view));
  document.getElementById('fabAdd').style.display = (view==='settings') ? 'none' : 'flex';
  renderAll();
}

/* ---------------- Sheet (modal) helpers ---------------- */
const backdrop = document.getElementById('sheetBackdrop');
const sheetContent = document.getElementById('sheetContent');
function openSheet(html){
  sheetContent.innerHTML = `<div class="sheet-handle"></div>` + html;
  backdrop.classList.add('active');
}
function closeSheet(){ backdrop.classList.remove('active'); }
backdrop.addEventListener('click', e=>{ if(e.target===backdrop) closeSheet(); });

/* ---------------- FAB (context-aware add) ---------------- */
document.getElementById('fabAdd').addEventListener('click', ()=>{
  if(currentView==='tasks') openTaskForm();
  else if(currentView==='vendors') openVendorForm();
  else if(currentView==='guests') openGuestForm();
  else if(currentView==='finance') openExpenseForm();
  else openTaskForm();
});

/* ================= DASHBOARD ================= */
function renderDashboard(){
  const wd = new Date(state.settings.weddingDate+'T00:00:00');
  const now = new Date();
  const days = Math.ceil((wd - now) / 86400000);
  document.getElementById('countdownNum').textContent = days >= 0 ? days : 0;
  document.getElementById('weddingDateLine').textContent = 'until ' + formatDate(state.settings.weddingDate) + (days<0 ? ' · date has passed' : '');
  document.getElementById('receptionDateLine').textContent = formatDate(state.settings.receptionDate);

  // budget
  let contracted=0, paid=0;
  state.vendors.forEach(v=>{
    contracted += Number(v.contract)||0;
    paid += (v.payments||[]).reduce((s,p)=>s+Number(p.amount||0),0);
  });
  document.getElementById('statContracted').textContent = money(contracted);
  document.getElementById('statPaid').textContent = money(paid);
  document.getElementById('statRemaining').textContent = money(contracted-paid);
  document.getElementById('statVendorCount').textContent = state.vendors.length;

  // guests
  const totalPeople = state.guests.reduce((s,g)=>s+(Number(g.adults)||0)+(Number(g.children)||0),0);
  document.getElementById('statGuestTotal').textContent = state.guests.length;
  document.getElementById('statGuestPeople').textContent = totalPeople + ' people incl. children';
  document.getElementById('statGuestConfirmed').textContent = state.guests.filter(g=>g.rsvp==='confirmed').length;
  document.getElementById('statGuestPending').textContent = state.guests.filter(g=>g.rsvp==='pending').length;
  document.getElementById('statGuestDeclined').textContent = state.guests.filter(g=>g.rsvp==='declined').length;

  // tasks
  const openTasks = state.tasks.filter(t=>t.status!=='done');
  const overdue = state.tasks.filter(t=> t.status!=='done' && t.dueDate && t.dueDate < todayISO());
  document.getElementById('statTaskOpen').textContent = openTasks.length;
  document.getElementById('statTaskOverdue').textContent = overdue.length;
  document.getElementById('statTaskDone').textContent = state.tasks.filter(t=>t.status==='done').length;
  document.getElementById('statTaskTotal').textContent = state.tasks.length;

  // alerts
  const alertsBox = document.getElementById('alertsBox');
  const alerts = [];
  overdue.forEach(t=> alerts.push({type:'task', id:t.id, text:`Task overdue: "${t.title}"`}));
  state.vendors.forEach(v=>{
    const p = Number(v.contract)||0;
    const paidV = (v.payments||[]).reduce((s,x)=>s+Number(x.amount||0),0);
    if(p>0 && paidV < p){
      alerts.push({type:'vendor', id:v.id, text:`${v.name}: ${money(p-paidV)} still due`});
    }
  });
  if(days>=0 && days<=14){
    const pendingGuests = state.guests.filter(g=>g.rsvp==='pending').length;
    if(pendingGuests>0) alerts.push({type:'guests', id:null, text:`${pendingGuests} guests haven't responded — wedding is ${days} days away`});
  }
  alertsBox.innerHTML='';
  if(alerts.length===0){
    alertsBox.innerHTML = `<div class="alert empty">Nothing urgent — you're on top of things.</div>`;
  } else {
    alerts.slice(0,6).forEach(a=>{
      const div = document.createElement('div');
      div.className='alert';
      div.textContent = '⚠️ ' + a.text;
      div.addEventListener('click', ()=>{
        if(a.type==='task') { switchView('tasks'); }
        else if(a.type==='vendor'){ switchView('vendors'); }
        else if(a.type==='guests'){ switchView('guests'); }
      });
      alertsBox.appendChild(div);
    });
  }
}
function formatDate(iso){
  if(!iso) return '';
  const d = new Date(iso+'T00:00:00');
  return d.toLocaleDateString('en-GB', {day:'numeric', month:'long', year:'numeric'});
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
  if(items.length===0){
    list.innerHTML = emptyState('No tasks here', 'Tap + to add your first task.');
    return;
  }
  items.forEach(t=>{
    const st = taskStatusOf(t);
    const el = document.createElement('div');
    el.className='item';
    el.innerHTML = `
      <div class="item-top">
        <div>
          <div class="item-title"><span class="priority-dot p-${t.priority}"></span>${escapeHtml(t.title)}</div>
          <div class="item-meta">${t.dueDate ? formatDate(t.dueDate) : 'No due date'}${t.vendorId? ' · '+escapeHtml(vendorName(t.vendorId)) : ''}</div>
        </div>
        <span class="badge ${st}">${statusLabel(st)}</span>
      </div>`;
    el.addEventListener('click', ()=> openTaskForm(t));
    list.appendChild(el);
  });
}
function statusLabel(s){ return {pending:'Pending', progress:'In Progress', overdue:'Overdue', done:'Completed'}[s] || s; }
function vendorName(id){ const v = state.vendors.find(v=>v.id===id); return v ? v.name : ''; }

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
        <select id="f_priority">
          ${['low','medium','high','critical'].map(p=>`<option value="${p}" ${p===task.priority?'selected':''}>${p[0].toUpperCase()+p.slice(1)}</option>`).join('')}
        </select>
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
  if(state.vendors.length===0){
    list.innerHTML = emptyState('No vendors yet', 'Tap + to add a photographer, venue, caterer...');
    return;
  }
  state.vendors.forEach(v=>{
    const paid = (v.payments||[]).reduce((s,p)=>s+Number(p.amount||0),0);
    const contract = Number(v.contract)||0;
    const el = document.createElement('div');
    el.className='item';
    el.innerHTML = `
      <div class="item-top">
        <div>
          <div class="item-title">${escapeHtml(v.name)}</div>
          <div class="item-meta">${escapeHtml(v.category||'Uncategorized')}${v.phone? ' · '+escapeHtml(v.phone):''}</div>
        </div>
      </div>
      <div class="vendor-money">
        <div>Contract<b>${money(contract)}</b></div>
        <div>Paid<b>${money(paid)}</b></div>
        <div>Remaining<b>${money(contract-paid)}</b></div>
      </div>`;
    el.addEventListener('click', ()=> openVendorForm(v));
    list.appendChild(el);
  });
}
function openVendorForm(vendor){
  const isEdit = !!vendor;
  vendor = vendor || { id: uid(), name:'', category:'', contact:'', phone:'', contract:0, payments:[], documents:[] };
  vendor.documents = vendor.documents || [];
  const paymentsHtml = (vendor.payments||[]).map((p,i)=>`
    <div class="item" style="padding:10px 12px;">
      <div class="item-top">
        <div class="item-meta">${escapeHtml(p.payer||'—')} · ${p.date? formatDate(p.date):''}</div>
        <b>${money(p.amount)}</b>
      </div>
    </div>`).join('') || '<div class="item-meta" style="margin-bottom:8px;">No payments recorded yet.</div>';

  const docsHtml = vendor.documents.length ? vendor.documents.map(d=>`
    <div class="item" style="padding:10px 12px;display:flex;align-items:center;justify-content:space-between;gap:8px;">
      <a href="${d.url}" target="_blank" rel="noopener" style="color:var(--ink);font-size:13.5px;text-decoration:underline;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">${escapeHtml(d.name)}</a>
      <button type="button" class="btn btn-danger" style="padding:5px 10px;font-size:12px;" data-doc-id="${escapeAttr(d.publicId)}">Delete</button>
    </div>
  `).join('') : '<div class="item-meta" style="margin-bottom:8px;">No documents yet — add a bill, contract, or screenshot below.</div>';

  openSheet(`
    <h3 class="serif">${isEdit?'Edit vendor':'New vendor'}</h3>
    <div class="field"><label>Name</label><input id="v_name" value="${escapeAttr(vendor.name)}" placeholder="e.g. Sharma Studios"></div>
    <div class="field-row">
      <div class="field"><label>Category</label><input id="v_category" value="${escapeAttr(vendor.category)}" placeholder="Photography, Catering..."></div>
      <div class="field"><label>Phone</label><input id="v_phone" value="${escapeAttr(vendor.phone)}"></div>
    </div>
    <div class="field"><label>Contact person</label><input id="v_contact" value="${escapeAttr(vendor.contact)}"></div>
    <div class="field"><label>Contract amount (₹)</label><input type="number" id="v_contract" value="${vendor.contract||0}"></div>

    ${isEdit ? `
    <div class="section-title" style="margin-top:16px;">Payments</div>
    ${paymentsHtml}
    <div class="field-row" style="margin-top:8px;">
      <div class="field"><label>Amount</label><input type="number" id="p_amount" placeholder="0"></div>
      <div class="field"><label>Paid by</label><input id="p_payer" placeholder="Saubhik / Tanuka"></div>
    </div>
    <div class="field"><label>Date</label><input type="date" id="p_date" value="${todayISO()}"></div>
    <button class="btn btn-ghost" id="addPaymentBtn" style="width:100%;margin-bottom:6px;">Add payment</button>

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
  if(isEdit){
    document.getElementById('deleteBtn').onclick = ()=>{
      state.vendors = state.vendors.filter(x=>x.id!==vendor.id);
      saveData(); closeSheet(); renderAll(); toast('Vendor deleted');
    };
    document.getElementById('addPaymentBtn').onclick = ()=>{
      const amount = Number(document.getElementById('p_amount').value);
      if(!amount){ toast('Enter an amount'); return; }
      vendor.payments = vendor.payments || [];
      vendor.payments.push({ amount, payer: document.getElementById('p_payer').value, date: document.getElementById('p_date').value });
      saveData();
      openVendorForm(vendor); // re-render sheet with updated payments
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
    if(!isEdit) state.vendors.push(vendor);
    saveData(); closeSheet(); renderAll(); toast('Vendor saved');
  };
}

const MAX_DOC_SIZE = 8 * 1024 * 1024; // 8MB — comfortable for phone photos/PDFs, under Cloudinary's free-tier per-file limit

function handleDocUpload(e, vendor){
  const file = e.target.files[0];
  e.target.value = '';
  if(!file) return;
  const errEl = document.getElementById('docError');
  errEl.textContent = '';
  if(file.size > MAX_DOC_SIZE){
    errEl.textContent = 'That file is too large — please keep uploads under 8MB.';
    return;
  }
  if(CLOUDINARY_CLOUD_NAME.startsWith('PASTE_')){
    errEl.textContent = 'Document uploads need Cloudinary set up first — see README.md.';
    return;
  }
  const label = document.getElementById('docUploadLabel');
  label.textContent = 'Uploading…';
  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);

  fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/auto/upload`, { method: 'POST', body: formData })
    .then(res => res.ok ? res.json() : res.json().then(j => Promise.reject(new Error(j.error?.message || 'Upload failed'))))
    .then(data => {
      vendor.documents = vendor.documents || [];
      vendor.documents.push({ name: file.name, url: data.secure_url, publicId: data.public_id, uploadedAt: todayISO() });
      saveData();
      toast('Document added');
      openVendorForm(vendor); // re-render sheet with the new document listed
    })
    .catch(err => {
      console.error(err);
      errEl.textContent = 'Upload failed — check your connection and Cloudinary setup.';
      label.textContent = 'Add document (photo, PDF, screenshot)';
    });
}

function handleDocDelete(publicId, vendor){
  if(!confirm('Remove this document from the vendor? (It stays stored on Cloudinary, but will no longer show here — free tier storage is generous, so this is not a concern.)')) return;
  vendor.documents = (vendor.documents||[]).filter(d=>d.publicId!==publicId);
  saveData();
  toast('Document removed');
  openVendorForm(vendor);
}

/* ================= FINANCE ================= */
function renderFinance(){
  let contracted=0, paid=0;
  state.vendors.forEach(v=>{
    contracted += Number(v.contract)||0;
    paid += (v.payments||[]).reduce((s,p)=>s+Number(p.amount||0),0);
  });
  const otherTotal = state.otherExpenses.reduce((s,e)=>s+Number(e.amount||0),0);
  document.getElementById('finContracted').textContent = money(contracted);
  document.getElementById('finPaid').textContent = money(paid);
  document.getElementById('finRemaining').textContent = money(contracted-paid);
  document.getElementById('finOtherTotal').textContent = money(otherTotal);

  const vlist = document.getElementById('financeVendorList');
  vlist.innerHTML='';
  if(state.vendors.length===0){ vlist.innerHTML = emptyState('No vendors yet','Add vendors to track contracts and payments.'); }
  state.vendors.forEach(v=>{
    const p = (v.payments||[]).reduce((s,x)=>s+Number(x.amount||0),0);
    const el = document.createElement('div');
    el.className='item';
    el.innerHTML = `<div class="item-top">
        <div class="item-title">${escapeHtml(v.name)}</div>
        <b>${money(p)} / ${money(v.contract)}</b>
      </div>`;
    el.addEventListener('click', ()=> { switchView('vendors'); setTimeout(()=>openVendorForm(v),0); });
    vlist.appendChild(el);
  });

  const olist = document.getElementById('otherExpenseList');
  olist.innerHTML='';
  if(state.otherExpenses.length===0){ olist.innerHTML = emptyState('No other expenses','Things not tied to a vendor — e.g. mehndi artist, small purchases.'); }
  state.otherExpenses.forEach(e=>{
    const el = document.createElement('div');
    el.className='item';
    el.innerHTML = `<div class="item-top">
        <div><div class="item-title">${escapeHtml(e.name)}</div><div class="item-meta">${e.date? formatDate(e.date):''}</div></div>
        <b>${money(e.amount)}</b>
      </div>`;
    el.addEventListener('click', ()=> openExpenseForm(e));
    olist.appendChild(el);
  });
}
function openExpenseForm(expense){
  const isEdit = !!expense;
  expense = expense || { id: uid(), name:'', amount:0, date: todayISO() };
  openSheet(`
    <h3 class="serif">${isEdit?'Edit expense':'New expense'}</h3>
    <div class="field"><label>Description</label><input id="e_name" value="${escapeAttr(expense.name)}" placeholder="e.g. Mehndi artist"></div>
    <div class="field-row">
      <div class="field"><label>Amount (₹)</label><input type="number" id="e_amount" value="${expense.amount||0}"></div>
      <div class="field"><label>Date</label><input type="date" id="e_date" value="${expense.date||todayISO()}"></div>
    </div>
    <div class="sheet-actions">
      ${isEdit? '<button class="btn btn-danger" id="deleteBtn">Delete</button>' : ''}
      <button class="btn btn-ghost" id="cancelBtn">Cancel</button>
      <button class="btn btn-primary" id="saveBtn">Save</button>
    </div>
  `);
  document.getElementById('cancelBtn').onclick = closeSheet;
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

function normalizeHeader(h){
  return String(h||'').toLowerCase().replace(/[^a-z0-9]/g,'');
}
function findColumn(headers, synonyms){
  const normSyns = synonyms.map(normalizeHeader);
  return headers.find(h => normSyns.includes(normalizeHeader(h)));
}
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
    }catch(err){
      console.error(err);
      errEl.textContent = 'Could not read that file — make sure it\'s a valid Excel or CSV file.';
    }
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
  if(!col.name){
    document.getElementById('importError').textContent = 'Could not find a "Name" column in that file.';
    return;
  }
  const existingNames = new Set(state.guests.map(g=>g.name.trim().toLowerCase()));
  const toImport = [];
  const duplicates = [];
  let skippedBlank = 0;

  rows.forEach(row=>{
    const name = String(row[col.name]||'').trim();
    if(!name){ skippedBlank++; return; }
    if(existingNames.has(name.toLowerCase())){ duplicates.push(name); return; }

    const cohortRaw = String(col.cohort ? row[col.cohort] : '').toLowerCase();
    const rsvpRaw = String(col.rsvp ? row[col.rsvp] : '').toLowerCase();
    const guest = {
      id: uid(),
      name,
      phone: col.phone ? String(row[col.phone]||'').trim() : '',
      cohort: cohortRaw.includes('reception') ? 'RECEPTION' : 'FULL',
      rsvp: rsvpRaw.includes('confirm') ? 'confirmed' : rsvpRaw.includes('declin') ? 'declined' : 'pending',
      adults: col.adults ? (Number(row[col.adults]) || 1) : 1,
      children: col.children ? (Number(row[col.children]) || 0) : 0,
      notes: col.notes ? String(row[col.notes]||'').trim() : ''
    };
    toImport.push(guest);
    existingNames.add(name.toLowerCase()); // guard against duplicates within the file itself
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
  items.forEach(g=>{
    const el = document.createElement('div');
    el.className='item';
    el.innerHTML = `
      <div class="item-top">
        <div>
          <div class="item-title">${escapeHtml(g.name)}</div>
          <div class="item-meta">${g.cohort==='FULL'?'Full wedding':'Reception only'} · ${(Number(g.adults)||0)+(Number(g.children)||0)} people</div>
        </div>
        <span class="badge ${g.rsvp==='confirmed'?'confirmed':g.rsvp==='declined'?'declined':'pending'}">${g.rsvp[0].toUpperCase()+g.rsvp.slice(1)}</span>
      </div>`;
    el.addEventListener('click', ()=> openGuestForm(g));
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
  saveData(); renderAll(); toast('Settings saved');
});
document.getElementById('exportBtn').addEventListener('click', ()=>{
  const blob = new Blob([JSON.stringify(state, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `wedding-secretary-backup-${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(url);
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
      state = { ...structuredClone(DEFAULT_DATA), ...parsed };
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

/* ---------------- Helpers ---------------- */
function emptyState(title, sub){
  return `<div class="empty-state"><div class="serif">${title}</div><div>${sub}</div></div>`;
}
function escapeHtml(s){ return String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(s){ return escapeHtml(s); }

/* ---------------- Master render ---------------- */
function renderAll(){
  renderDashboard();
  renderTasks();
  renderVendors();
  renderFinance();
  renderGuests();
  document.getElementById('settingWeddingDate').value = state.settings.weddingDate;
  document.getElementById('settingReceptionDate').value = state.settings.receptionDate;
}
renderAll();

/* ---------------- Service worker registration ---------------- */
if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  });
}
