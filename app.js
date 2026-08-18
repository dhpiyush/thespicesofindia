// ─── CONFIG ─────────────────────────────────────────
const CLIENT_ID = '354274835745-f36h72g2th27fafmkj3i7d57kov2u8kc.apps.googleusercontent.com';
// drive.file = upload new files; drive.appdata not enough for shared folder
// We need drive scope to read/write the shared kitchen-data.json
const SCOPES = 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email';
const DATA_FILENAME = 'kitchen-data.json';
// ────────────────────────────────────────────────────

const CATEGORIES_IN  = ['Delivery revenue','Takeaway revenue','Catering revenue','Other revenue','Private deposit'];
const CATEGORIES_OUT = ['Ingredients','Packaging','Kitchen rent','Energy','Delivery platform','Wages','Marketing','Administration','Other costs','Private withdrawal'];
const PRIVATE_CATEGORIES = ['Private deposit','Private withdrawal'];

// Shared duplicate check for CSV/XLSX imports: same date + amount + direction, with a fuzzy
// (substring) desc match, since different export formats describe the same mutation differently.
function isDuplicateTxn(dateStr, amt, isIn, desc) {
  const d = (desc || '').trim().toLowerCase();
  return transactions.some(t => {
    if (t.date !== dateStr || Math.abs(t.amount - amt) >= 0.01 || t.type !== (isIn ? 'in' : 'out')) return false;
    const td = (t.desc || '').trim().toLowerCase();
    return !td || !d || td.includes(d) || d.includes(td);
  });
}

let accessToken = null;
let transactions = [];
let receipts = [];
let pendingReceipts = [];
let folderId = null, folderName = null;
let dataFileId = null; // ID of kitchen-data.json in Drive
let monthFolderCache = {};
let linkingReceiptId = null, selectedTxnId = null;
let linkingForTxn = false, _selectedReceiptForLink = null;
let plMonth = 'all';
let isSaving = false;

const $ = id => document.getElementById(id);

// ─── DRIVE DATA LAYER ────────────────────────────────

// Find kitchen-data.json — searches selected folder first, then anywhere in Drive
async function findDataFile() {
  // Search in selected folder first
  if (folderId) {
    const q = encodeURIComponent(`name='${DATA_FILENAME}' and '${folderId}' in parents and trashed=false`);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, {
      headers: { Authorization: 'Bearer ' + accessToken }
    }).then(r => r.json());
    if (res.files?.[0]?.id) return res.files[0].id;
  }
  // Fallback: search anywhere in Drive (catches files created before folder was set)
  const q2 = encodeURIComponent(`name='${DATA_FILENAME}' and trashed=false`);
  const res2 = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q2}&fields=files(id,name,parents)&orderBy=modifiedTime desc`, {
    headers: { Authorization: 'Bearer ' + accessToken }
  }).then(r => r.json());
  return res2.files?.[0]?.id || null;
}

// Load data from Drive — NEVER clears existing data if file not found
async function loadFromDrive() {
  showSyncStatus('loading');
  try {
    const foundId = await findDataFile();
    if (!foundId) {
      // No file found — keep whatever data is already in memory, don't wipe it
      showSyncStatus('ready', transactions.length
        ? `☁️ No Drive file yet — ${transactions.length} transactions in memory`
        : 'No data file yet — will be created on first save');
      return;
    }
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${foundId}?alt=media`, {
      headers: { Authorization: 'Bearer ' + accessToken }
    });
    if (!res.ok) {
      showSyncStatus('error', 'Could not read data file from Drive');
      return;
    }
    const data = await res.json();
    // Only update if Drive file actually has data
    if (data.transactions || data.receipts) {
      dataFileId = foundId;
      transactions = data.transactions || [];
      receipts = data.receipts || [];
      lastSyncTime = new Date(
        (await fetch(`https://www.googleapis.com/drive/v3/files/${foundId}?fields=modifiedTime`,
          {headers:{Authorization:'Bearer '+accessToken}}).then(r=>r.json())).modifiedTime
      ).getTime();
      showSyncStatus('ready', `Synced · ${transactions.length} transactions · ${receipts.length} receipts`);
    } else {
      showSyncStatus('ready', 'Drive file is empty — keeping current data');
    }
  } catch(e) {
    // On any error, keep existing data and show error — never wipe
    showSyncStatus('error', 'Sync failed — your data is safe, check connection');
    console.error(e);
  }
}

// Move kitchen-data.json to the correct folder if it's in the wrong place
async function moveDataFileToFolder() {
  if (!dataFileId || !folderId) return;
  try {
    // Get current parents of the file
    const info = await fetch(`https://www.googleapis.com/drive/v3/files/${dataFileId}?fields=parents`, {
      headers: { Authorization: 'Bearer ' + accessToken }
    }).then(r => r.json());
    const currentParents = (info.parents || []).join(',');
    // If already in the right folder, do nothing
    if (info.parents && info.parents.includes(folderId)) return;
    // Move: add new parent, remove old ones
    await fetch(`https://www.googleapis.com/drive/v3/files/${dataFileId}?addParents=${folderId}&removeParents=${currentParents}&fields=id`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    console.log('kitchen-data.json moved to folder:', folderId);
  } catch(e) {
    console.error('Could not move data file:', e);
  }
}

// Save data to Drive (create or update kitchen-data.json)
async function saveToDrive() {
  if (!accessToken) return;
  if (isSaving) return; // prevent concurrent saves
  isSaving = true;
  showSyncStatus('saving');
  try {
    const payload = JSON.stringify({ transactions, receipts, updatedAt: new Date().toISOString() });
    const blob = new Blob([payload], { type: 'application/json' });

    if (dataFileId) {
      // Update content
      await fetch(`https://www.googleapis.com/upload/drive/v3/files/${dataFileId}?uploadType=media`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
        body: blob
      });
      // Make sure file is in the right folder (moves it if it ended up in Drive root)
      if (folderId) await moveDataFileToFolder();
    } else {
      // Create new file directly in the selected folder
      const meta = { name: DATA_FILENAME, mimeType: 'application/json' };
      if (folderId) meta.parents = [folderId];
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
      form.append('file', blob);
      const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + accessToken },
        body: form
      }).then(r => r.json());
      dataFileId = res.id;
    }
    lastSyncTime = Date.now();
    showSyncStatus('saved');
    setTimeout(() => showSyncStatus('ready', `Saved · ${new Date().toLocaleTimeString()}`), 1500);
  } catch(e) {
    showSyncStatus('error', 'Save failed — check your connection');
    console.error(e);
  } finally {
    isSaving = false;
  }
}

function showSyncStatus(state, msg) {
  const icons = { loading:'⏳', saving:'💾', saved:'✓', ready:'☁️', error:'⚠️' };
  const colors = { loading:'var(--ink3)', saving:'var(--fire)', saved:'var(--green)', ready:'var(--ink3)', error:'var(--red)' };
  const text = icons[state] + ' ' + (msg || { loading:'Loading from Drive…', saving:'Saving…', saved:'Saved to Drive', ready:'Synced', error:'Sync error' }[state]);
  const el = $('sync-status');
  if (el) { el.textContent = text; el.style.color = colors[state]; }
  const mob = $('sync-status-mobile');
  if (mob) { mob.textContent = text; mob.style.color = colors[state]; }
  // Show mobile sync bar on mobile
  const bar = $('mobile-sync-bar');
  if (bar && window.innerWidth <= 768) bar.style.display = 'flex';
}

// Compatibility: old calls to saveTxns / saveReceipts now go to Drive
function saveTxns() { saveToDrive(); }
function saveReceipts() { saveToDrive(); }

// ─── AUTH ────────────────────────────────────────────
let tokenClient = null;

// Called on page load — silently restores session if user was previously signed in
function tryAutoSignIn() {
  if (CLIENT_ID === 'YOUR_GOOGLE_CLIENT_ID') return;
  const wasSignedIn = localStorage.getItem('kb_signed_in');
  if (!wasSignedIn) return;
  // Without a hint, Google can't tell which signed-in browser session to
  // reuse and falls back to showing the account chooser. Passing the
  // email we saw at last sign-in lets it resolve silently instead.
  const cachedEmail = localStorage.getItem('kb_user_email');
  const waitForGIS = () => {
    if (!window.google?.accounts?.oauth2) { setTimeout(waitForGIS, 200); return; }
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID, scope: SCOPES,
      prompt: 'none', // never show UI — fail into our own login screen instead
      ...(cachedEmail ? { hint: cachedEmail } : {}),
      callback: async r => {
        if (r.error) {
          // Silent failed — show login screen
          $('auth-screen').style.display = 'flex';
          $('app').style.display = 'none';
          return;
        }
        accessToken = r.access_token;
        scheduleTokenRefresh();
        await onSignedIn();
      }
    });
    tokenClient.requestAccessToken();
  };
  waitForGIS();
}

// Called when user clicks Sign in button
function handleAuth() {
  const waitForGIS = () => {
    if (!window.google?.accounts?.oauth2) { setTimeout(waitForGIS, 200); return; }
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID, scope: SCOPES,
      callback: async r => {
        if (r.error) {
          $('auth-screen').style.display = 'flex';
          alert('Sign-in failed: ' + r.error);
          return;
        }
        accessToken = r.access_token;
        localStorage.setItem('kb_signed_in', '1');
        scheduleTokenRefresh();
        await onSignedIn();
      }
    });
    tokenClient.requestAccessToken({ prompt: 'select_account' });
  };
  waitForGIS();
}

// Shared post-login setup
async function onSignedIn() {
  await fetchUser();
  $('auth-screen').style.display = 'none';
  $('app').style.display = 'grid';
  if (CLIENT_ID === 'YOUR_GOOGLE_CLIENT_ID') $('setup-banner').style.display = 'block';
  loadSavedFolder();
  await loadFromDrive();
  await fixLegacyDates();
  await scanDriveForMissingReceipts();
  refreshAll();
  startAutoSync();
  showSyncStatus('ready', 'Auto-sync on · every 60s');
}

// Silently refresh the OAuth token before it expires (tokens last ~1 hour)
let tokenRefreshTimer = null;
function scheduleTokenRefresh() {
  if (tokenRefreshTimer) clearTimeout(tokenRefreshTimer);
  tokenRefreshTimer = setTimeout(() => {
    if (!tokenClient) return;
    const cachedEmail = localStorage.getItem('kb_user_email');
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID, scope: SCOPES, prompt: 'none',
      ...(cachedEmail ? { hint: cachedEmail } : {}),
      callback: r => {
        if (!r.error) {
          accessToken = r.access_token;
          scheduleTokenRefresh();
        }
      }
    });
    tokenClient.requestAccessToken();
  }, 55 * 60 * 1000);
}

async function fetchUser() {
  const u = await fetch('https://www.googleapis.com/oauth2/v2/userinfo',{headers:{Authorization:'Bearer '+accessToken}}).then(r=>r.json());
  const name = u.name||u.email||'User';
  $('user-name-side').textContent = name;
  $('user-av').textContent = name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
  localStorage.setItem('kb_user_name', name);
  if (u.email) localStorage.setItem('kb_user_email', u.email);
}

function handleSignOut() {
  if (window.google?.accounts?.oauth2 && accessToken) google.accounts.oauth2.revoke(accessToken,()=>{});
  if (tokenRefreshTimer) clearTimeout(tokenRefreshTimer);
  stopAutoSync();
  // Clear session flag so auto-sign-in doesn't trigger next time
  localStorage.removeItem('kb_signed_in');
  localStorage.removeItem('kb_user_name');
  localStorage.removeItem('kb_user_email');
  accessToken=null; transactions=[]; receipts=[]; dataFileId=null; lastSyncTime=null;
  $('auth-screen').style.display='flex';
  $('app').style.display='none';
}

async function syncNow() {
  // Save current data first (so nothing is lost), then reload from Drive
  if (transactions.length > 0 || receipts.length > 0) {
    await saveToDrive();
  }
  await loadFromDrive();
  await fixLegacyDates();
  await scanDriveForMissingReceipts();
  refreshAll();
}

// ─── NAVIGATION ──────────────────────────────────────
function showPage(id, btn) {
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active'));
  $('page-'+id)?.classList.add('active');
  if (btn) btn.classList.add('active');
  if (id==='dashboard') renderDashboard();
  if (id==='transactions') renderTransactions();
  if (id==='receipts') renderReceipts();
  if (id==='pl') renderPL();
  if (id==='quickupload') renderQuickUpload();
  if (id==='settings') renderSettings();
}

function setMobileNav(id) {
  document.querySelectorAll('.bnav-item').forEach(b=>b.classList.remove('active'));
  const el = $('bnav-'+id);
  if (el) el.classList.add('active');
}

// ─── ING CSV ─────────────────────────────────────────
function importING(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    Papa.parse(e.target.result, {
      delimiter:'', header:true, skipEmptyLines:true, quoteChar:'"', // '' = auto-detect ',' vs ';' (ING exports vary)
      complete: r => {
        if (!r.data.length) { alert('No transactions found. Check this is an ING CSV export.'); return; }
        const rows=r.data, sample=rows[0];
        const keys = Object.keys(sample);

        // Detect column names — supports both English and Dutch ING exports
        const dateKey = keys.find(k => k.trim().match(/^Date$|^Datum$/i)) || keys[0];
        const descKey = keys.find(k => k.trim().match(/^Name\s*\/\s*Description$|^Naam\s*[/\/]\s*Omschrijving$|^Naam$/i));
        const amtKey  = keys.find(k => k.trim().match(/^Amount\s*\(EUR\)$|^Bedrag\s*\(EUR\)$/i));
        const dirKey  = keys.find(k => k.trim().match(/^Debit\/credit$|^Af\s*Bij$|^Bij\/Af$/i));

        if (!amtKey || !dirKey) {
          alert('Could not detect ING CSV columns.\n\nFound columns: ' + keys.join(', ') + '\n\nPlease make sure you are uploading an ING transaction export (CSV).');
          input.value=''; return;
        }

        let added=0, skipped=0;
        for (const row of rows) {
          // Amount: strip thousands separator (.) and replace decimal comma
          const rawAmt=(row[amtKey]||'').trim().replace(/\./g,'').replace(',','.');
          const amt=parseFloat(rawAmt); if(isNaN(amt)||amt===0) continue;

          const dir=(row[dirKey]||'').trim().toLowerCase();
          const isIn = dir==='credit'||dir==='bij';

          // Date: handle YYYYMMDD and DD-MM-YYYY and YYYY-MM-DD
          const rawDate=(row[dateKey]||'').trim();
          let dateStr=rawDate;
          if(/^\d{8}$/.test(rawDate)) {
            dateStr=rawDate.slice(0,4)+'-'+rawDate.slice(4,6)+'-'+rawDate.slice(6,8);
          } else if(/^\d{2}-\d{2}-\d{4}$/.test(rawDate)) {
            const[d,m,y]=rawDate.split('-'); dateStr=y+'-'+m+'-'+d;
          }

          const desc=(descKey ? row[descKey] : '') || row['Name / Description'] || row['Naam / Omschrijving'] || row['Naam'] || '';
          const descClean = desc.trim();

          const id='txn_'+Date.now()+'_'+Math.random().toString(36).slice(2,6);
          // Duplicate check: same date + amount + direction, with a fuzzy desc match
          // (description text varies between export formats, e.g. "G. Bijsterbosch" vs "Betaling van G. Bijsterbosch NL13...")
          if(isDuplicateTxn(dateStr, amt, isIn, descClean)){skipped++;continue;}
          transactions.push({
            id, date:dateStr, desc:descClean, amount:amt,
            type:isIn?'in':'out',
            category:isIn?CATEGORIES_IN[0]:CATEGORIES_OUT[0],
            receiptId:null
          });
          added++;
        }
        saveTxns(); renderTransactions(); renderDashboard();
        const msg = added+' transactions imported'+(skipped>0?` · ${skipped} duplicates skipped`:'');
        alert(msg);
        input.value='';
      },
      error:(err)=>alert('Error reading CSV: '+err.message)
    });
  };
  // Try UTF-8 first (English ING export), fall back handled by PapaParse
  reader.readAsText(file, 'UTF-8');
}

// ─── MONEYBIRD XLSX IMPORT ──────────────────────────
// Maps Moneybird's "Linked to" category names → our app categories
const MONEYBIRD_CAT_MAP = {
  'Category Revenue':                      'Delivery revenue',
  'Category Grocery':                      'Ingredients',
  'Category Private withdrawals':          'Private withdrawal',
  'Category Private Deposits':             'Private deposit',
  'Category Sales costs':                  'Delivery platform',
  'Category Business liability insurance': 'Administration',
  'Category Cost of acquisition or production': 'Ingredients',
  'Category Bank charges':                 'Administration',
};

function importMoneybird(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { raw: false, dateNF: 'yyyy-mm-dd' });

      if (!rows.length) { alert('No transactions found in this file.'); return; }

      let added = 0, skipped = 0, unmapped = new Set();

      for (const row of rows) {
        // Parse amount — Moneybird uses negative for debits, positive for credits
        const amt = parseFloat(String(row['Amount'] || '0').replace(',', '.'));
        if (isNaN(amt) || amt === 0) continue;
        const isIn = amt > 0;
        const absAmt = Math.abs(amt);

        // Parse date robustly — Excel can give serial numbers, M/D/YY, or YYYY-MM-DD
        let dateStr = '';
        const rawDate = row['Date'] || row['Value date'] || '';
        if (typeof rawDate === 'number') {
          // Excel serial date (days since 1900-01-01)
          const d = new Date(Math.round((rawDate - 25569) * 86400 * 1000));
          dateStr = d.toISOString().slice(0, 10);
        } else {
          const s = String(rawDate).trim();
          if (s.match(/^\d{4}-\d{2}-\d{2}/)) {
            // Already YYYY-MM-DD
            dateStr = s.slice(0, 10);
          } else if (s.match(/^\d{1,2}\/\d{1,2}\/\d{2,4}$/)) {
            // M/D/YY or M/D/YYYY (Excel US format)
            const parts = s.split('/');
            const m = parts[0].padStart(2,'0');
            const d = parts[1].padStart(2,'0');
            let y = parts[2];
            if (y.length === 2) y = (parseInt(y) < 50 ? '20' : '19') + y;
            dateStr = y + '-' + m + '-' + d;
          } else if (s.match(/^\d{2}-\d{2}-\d{4}$/)) {
            // DD-MM-YYYY (Dutch format)
            const [dd,mm,yyyy] = s.split('-');
            dateStr = yyyy + '-' + mm + '-' + dd;
          } else {
            dateStr = s.slice(0, 10);
          }
        }

        const desc = (row['Description'] || '').trim();
        const linkedTo = (row['Linked to'] || '').trim();

        // Map Moneybird category to our category
        let category;
        if (MONEYBIRD_CAT_MAP[linkedTo]) {
          category = MONEYBIRD_CAT_MAP[linkedTo];
        } else if (linkedTo.startsWith('Category ')) {
          // Unknown category — keep raw name, flag it
          category = linkedTo.replace('Category ', '');
          unmapped.add(linkedTo);
        } else {
          // No category (linked to a receipt filename/screenshot) — use default
          category = isIn ? CATEGORIES_IN[0] : CATEGORIES_OUT[0];
        }

        // Override with private categories based on mapping
        if (linkedTo === 'Category Private withdrawals' || linkedTo === 'Category Private Deposits') {
          category = isIn ? 'Private deposit' : 'Private withdrawal';
        }

        // Duplicate check: same date + amount + direction, with a fuzzy desc match
        // (description text varies between export formats, e.g. "G. Bijsterbosch" vs "Betaling van G. Bijsterbosch NL13...")
        if (isDuplicateTxn(dateStr, absAmt, isIn, desc)) {
          skipped++; continue;
        }

        const id = 'txn_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        transactions.push({ id, date: dateStr, desc, amount: absAmt, type: isIn ? 'in' : 'out', category, receiptId: null });
        added++;
      }

      saveTxns(); renderTransactions(); renderDashboard();

      let msg = `✓ ${added} transactions imported from Moneybird`;
      if (skipped) msg += `\n${skipped} duplicates skipped`;
      if (unmapped.size) msg += `\n\nUnknown categories (set to default):\n${[...unmapped].join('\n')}`;
      alert(msg);
      input.value = '';
    } catch(err) {
      alert('Error reading XLSX: ' + err.message);
      console.error(err);
    }
  };
  reader.readAsArrayBuffer(file);
}

// ─── TRANSACTIONS ────────────────────────────────────
function renderTransactions() {
  const search=($('search-txn')?.value||'').toLowerCase();
  const typeF=$('filter-type')?.value||'';
  const monthF=$('filter-month')?.value||'';
  const catF=$('filter-cat')?.value||'';
  const months=[...new Set(transactions
    .map(t=>t.date ? t.date.slice(0,7) : null)
    .filter(m=>m && /^\d{4}-\d{2}$/.test(m))
  )].sort().reverse();
  const mSel=$('filter-month');
  if(mSel){const cur=mSel.value;mSel.innerHTML='<option value="">All months</option>'+months.map(m=>`<option value="${m}"${m===cur?' selected':''}>${fmtMonth(m)}</option>`).join('');}
  const catSel=$('filter-cat');
  if(catSel){const curCat=catSel.value;const cats=[...new Set(transactions.map(t=>t.category))].sort();catSel.innerHTML='<option value="">All categories</option>'+cats.map(c=>`<option value="${c}"${c===curCat?' selected':''}>${c}</option>`).join('');}
  let filtered=transactions.filter(t=>{
    if(typeF&&t.type!==typeF)return false;
    if(monthF&&!t.date.startsWith(monthF))return false;
    if(catF&&t.category!==catF)return false;
    if(search&&!t.desc.toLowerCase().includes(search)&&!t.category.toLowerCase().includes(search))return false;
    return true;
  }).sort((a,b)=>b.date.localeCompare(a.date));
  const wrap=$('txn-table-wrap');
  if(!filtered.length){wrap.innerHTML=`<div class="empty"><div class="empty-icon">${transactions.length?'🔍':'📂'}</div><h3>${transactions.length?'No results':'No transactions'}</h3><p>${transactions.length?'Adjust the filters':'Import your ING CSV to get started'}</p></div>`;return;}
  wrap.innerHTML=`<table><thead><tr><th>Date</th><th>Description</th><th>Category</th><th style="text-align:right">Amount</th><th>Type</th><th>Receipt</th></tr></thead><tbody>${filtered.map(t=>{
    const linked=receipts.find(r=>r.id===t.receiptId);
    return`<tr><td style="font-family:var(--font-mono);font-size:12px;white-space:nowrap">${t.date}</td><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.desc)}</td><td><select class="cat-select" onchange="updateCat('${t.id}',this.value)">${(t.type==='in'?CATEGORIES_IN:CATEGORIES_OUT).map(c=>`<option${c===t.category?' selected':''}>${c}</option>`).join('')}</select></td><td style="text-align:right"><span class="${t.type==='in'?'amount-in':'amount-out'}">${t.type==='in'?'+':'-'}${fmtEur(t.amount)}</span></td><td><span class="badge ${t.type==='in'?'badge-in':'badge-out'}">${t.type==='in'?'Revenue':'Expense'}</span></td><td>${linked?`<a href="${linked.url}" target="_blank" class="badge badge-linked">🔗 ${esc(linked.name.slice(0,12))}…</a>`:`<button class="btn btn-secondary btn-sm" onclick="openLinkForTxn('${t.id}')">Link</button>`}</td></tr>`;
  }).join('')}</tbody></table>`;
}

function updateCat(id,cat){const t=transactions.find(t=>t.id===id);if(t){t.category=cat;saveTxns();renderDashboard();}}

// ─── DASHBOARD ───────────────────────────────────────
const isPrivate = t => PRIVATE_CATEGORIES.includes(t.category);
function renderDashboard() {
  // Exclude private deposits/withdrawals from all P&L figures
  const income =transactions.filter(t=>t.type==='in' &&!isPrivate(t)).reduce((s,t)=>s+t.amount,0);
  const expense=transactions.filter(t=>t.type==='out'&&!isPrivate(t)).reduce((s,t)=>s+t.amount,0);
  const profit=income-expense;
  const linked=receipts.filter(r=>transactions.some(t=>t.receiptId===r.id)).length;
  $('stat-income').textContent=fmtEur(income,true);
  $('stat-income-sub').textContent=transactions.filter(t=>t.type==='in'&&!isPrivate(t)).length+' transactions';
  $('stat-expense').textContent=fmtEur(expense,true);
  $('stat-expense-sub').textContent=transactions.filter(t=>t.type==='out'&&!isPrivate(t)).length+' transactions';
  $('stat-profit').textContent=fmtEur(profit,true);
  $('stat-receipts').textContent=receipts.length;
  $('stat-receipts-linked').textContent=linked+' linked';
  // Mobile stats
  if($('m-stat-income')){$('m-stat-income').textContent=fmtEur(income,true);$('m-stat-expense').textContent=fmtEur(expense,true);$('m-stat-profit').textContent=fmtEur(profit,true);$('m-stat-receipts').textContent=receipts.length;}
  const months=[...new Set(transactions
    .map(t=>t.date ? t.date.slice(0,7) : null)
    .filter(m=>m && /^\d{4}-\d{2}$/.test(m))
  )].sort();
  const chart=$('bar-chart');
  if(!months.length){chart.innerHTML='<div class="empty" style="padding:1rem;flex:1"><p>No data yet</p></div>';return;}
  const maxVal=Math.max(...months.map(m=>{const i=transactions.filter(t=>t.type==='in'&&!isPrivate(t)&&t.date.startsWith(m)).reduce((s,t)=>s+t.amount,0);const e=transactions.filter(t=>t.type==='out'&&!isPrivate(t)&&t.date.startsWith(m)).reduce((s,t)=>s+t.amount,0);return Math.max(i,e);}),1);
  chart.innerHTML=months.map(m=>{
    const inc=transactions.filter(t=>t.type==='in'&&!isPrivate(t)&&t.date.startsWith(m)).reduce((s,t)=>s+t.amount,0);
    const exp=transactions.filter(t=>t.type==='out'&&!isPrivate(t)&&t.date.startsWith(m)).reduce((s,t)=>s+t.amount,0);
    const ih=Math.max(Math.round((inc/maxVal)*110),2);const eh=Math.max(Math.round((exp/maxVal)*110),2);
    return`<div class="bar-group"><div class="bar-wrap"><div class="bar income-bar" style="height:${ih}px" title="Revenue ${fmtEur(inc,true)}"></div><div class="bar expense-bar" style="height:${eh}px" title="Expenses ${fmtEur(exp,true)}"></div></div><div class="bar-label">${m.slice(5)}</div></div>`;
  }).join('');
  const recent=[...transactions].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,5);
  $('recent-txn-list').innerHTML=recent.length?`<table><thead><tr><th>Date</th><th>Description</th><th>Category</th><th style="text-align:right">Amount</th></tr></thead><tbody>${recent.map(t=>`<tr><td style="font-family:var(--font-mono);font-size:12px">${t.date}</td><td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.desc)}</td><td><span class="badge ${isPrivate(t)?'badge-private':'badge-cat'}">${esc(t.category)}</span></td><td style="text-align:right"><span class="${t.type==='in'?'amount-in':'amount-out'}">${t.type==='in'?'+':'-'}${fmtEur(t.amount)}</span></td></tr>`).join('')}</tbody></table>`:'<div class="empty" style="padding:1.5rem"><p>Import your bank statement to get started</p></div>';
}

// ─── P&L ─────────────────────────────────────────────
function renderPL() {
  // Group by YYYY-MM, filter out any bad dates, sort chronologically
  const months=['all',...[...new Set(transactions
    .map(t=>t.date ? t.date.slice(0,7) : null)
    .filter(m=>m && /^\d{4}-\d{2}$/.test(m))
  )].sort()];
  $('pl-months').innerHTML=months.map(m=>`<button class="month-tab${m===plMonth?' active':''}" onclick="setPLMonth('${m}',this)">${m==='all'?'Full year':fmtMonth(m)}</button>`).join('');
  const all=plMonth==='all'?transactions:transactions.filter(t=>t.date && t.date.startsWith(plMonth));
  // Exclude private categories from P&L
  const filtered=all.filter(t=>!isPrivate(t));
  const income=filtered.filter(t=>t.type==='in').reduce((s,t)=>s+t.amount,0);
  const expense=filtered.filter(t=>t.type==='out').reduce((s,t)=>s+t.amount,0);
  $('pl-income').textContent=fmtEur(income,true);$('pl-expense').textContent=fmtEur(expense,true);$('pl-profit').textContent=fmtEur(income-expense,true);
  const byCat=(type,container)=>{
    const cats={};
    filtered.filter(t=>t.type===type).forEach(t=>{cats[t.category]=(cats[t.category]||0)+t.amount;});
    const total=Object.values(cats).reduce((s,v)=>s+v,0)||1;
    const rows=Object.entries(cats).sort((a,b)=>b[1]-a[1]);
    $(container).innerHTML=rows.length?rows.map(([cat,val])=>`<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)"><div style="flex:1;font-size:13px">${esc(cat)}</div><div style="width:80px;height:6px;background:var(--paper2);border-radius:3px;overflow:hidden;flex-shrink:0"><div style="height:100%;width:${Math.round(val/total*100)}%;background:${type==='in'?'var(--green)':'var(--red)'};border-radius:3px"></div></div><div style="font-family:var(--font-mono);font-size:13px;min-width:80px;text-align:right;color:${type==='in'?'var(--green)':'var(--red)'}">${fmtEur(val,true)}</div></div>`).join(''):'<div class="empty" style="padding:1rem"><p>No data for this period</p></div>';
  };
  byCat('in','pl-income-cats');byCat('out','pl-expense-cats');
  // Show private transfers separately
  const privateRows=all.filter(t=>isPrivate(t));
  const privTotal=privateRows.reduce((s,t)=>s+(t.type==='in'?t.amount:-t.amount),0);
  const privEl=$('pl-private');
  if(privEl){
    privEl.innerHTML=privateRows.length?`<div style="display:flex;justify-content:space-between;align-items:center"><span style="font-size:13px;color:var(--ink2)">Private transfers (${privateRows.length} transactions · not in P&L)</span><span style="font-family:var(--font-mono);font-size:13px;color:var(--ink3)">${privTotal>=0?'+':''}${fmtEur(Math.abs(privTotal),true)}</span></div>`:'<p style="font-size:13px;color:var(--ink3)">No private transfers</p>';
  }
}

function setPLMonth(m,btn){plMonth=m;document.querySelectorAll('.month-tab').forEach(b=>b.classList.remove('active'));btn.classList.add('active');renderPL();}

function exportCSV(){
  const filtered=plMonth==='all'?transactions:transactions.filter(t=>t.date.startsWith(plMonth));
  const rows=[['Date','Description','Category','Type','Amount']];
  filtered.sort((a,b)=>a.date.localeCompare(b.date)).forEach(t=>{rows.push([t.date,t.desc,t.category,t.type==='in'?'Revenue':'Expense',(t.type==='out'?'-':'')+t.amount.toFixed(2)]);});
  const csv=rows.map(r=>r.map(c=>'"'+String(c).replace(/"/g,'""')+'"').join(',')).join('\n');
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=`kitchen-books${plMonth!=='all'?'_'+plMonth:''}.csv`;a.click();
  URL.revokeObjectURL(url);
}

// ─── RECEIPTS ────────────────────────────────────────
function renderReceipts() {
  // ── Pending upload queue ──
  const list=$('receipt-list');
  list.innerHTML=pendingReceipts.map(r=>{
    const tag={pending:'Ready',uploading:'Uploading…',done:'Done',error:'Error'}[r.status];
    const tc={pending:'tag-ready',uploading:'tag-uploading',done:'tag-done',error:'tag-error'}[r.status];
    return`<div class="receipt-item"><div class="receipt-icon">${r.file.name.match(/\.pdf$/i)?'📄':'🖼️'}</div><div class="receipt-info"><div class="receipt-name">${esc(r.file.name)}</div><div class="receipt-meta">${fmtSize(r.file.size)}</div>${r.status==='uploading'?`<div class="progress-bar"><div class="progress-fill" style="width:${r.progress}%"></div></div>`:''}</div><span class="receipt-tag ${tc}">${tag}</span>${r.status!=='uploading'?`<button class="btn-x" onclick="removePending('${r.id}')">×</button>`:''}</div>`;
  }).join('');
  $('upload-receipts-btn').disabled=!pendingReceipts.filter(r=>r.status==='pending').length;

  if(!receipts.length){
    const empty='<div class="empty"><div class="empty-icon">🗂️</div><h3>No receipts yet</h3><p>Upload receipts above</p></div>';
    $('uploaded-receipts-desktop').innerHTML=empty;
    $('uploaded-receipts-mobile').innerHTML=empty;
    renderQuickUpload(); return;
  }

  // ── Group receipts by month ──
  const sorted=[...receipts].sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  const byMonth={};
  for(const r of sorted){
    const m=(r.date||'').slice(0,7)||'Unknown';
    if(!byMonth[m]) byMonth[m]=[];
    byMonth[m].push(r);
  }
  const months=Object.keys(byMonth).sort().reverse();

  // Summary counts
  const unlinked=receipts.filter(r=>!transactions.some(t=>t.receiptId===r.id)).length;

  // ── Desktop: month-grouped table ──
  const dsk=$('uploaded-receipts-desktop');
  dsk.innerHTML=`
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px 0;flex-wrap:wrap;gap:8px">
      <div style="font-size:13px;color:var(--ink2)">${receipts.length} receipts total</div>
      ${unlinked>0?`<span style="font-size:12px;font-family:var(--font-mono);background:var(--amber-light,#FFFBEB);color:var(--amber,#D97706);padding:3px 10px;border-radius:20px">⚠ ${unlinked} not linked</span>`:'<span style="font-size:12px;font-family:var(--font-mono);background:var(--green-light);color:var(--green);padding:3px 10px;border-radius:20px">✓ All linked</span>'}
    </div>
    ${months.map(m=>`
      <div style="padding:10px 16px 4px;font-size:10px;font-family:var(--font-mono);color:var(--ink3);text-transform:uppercase;letter-spacing:0.08em;border-top:1px solid var(--border);margin-top:8px">
        ${m!=='Unknown'?fmtMonth(m):' Unknown date'} · ${byMonth[m].length} receipt${byMonth[m].length>1?'s':''}
      </div>
      <table style="width:100%;border-collapse:collapse">
        <tbody>
        ${byMonth[m].map(r=>{
          const lt=transactions.find(t=>t.receiptId===r.id);
          const isLinked=!!lt;
          return`<tr>
            <td style="padding:9px 12px;border-bottom:1px solid var(--border);width:32px;font-size:18px">${r.name.match(/\.pdf$/i)?'📄':'🖼️'}</td>
            <td style="padding:9px 12px;border-bottom:1px solid var(--border);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
              <a href="${r.url}" target="_blank" style="color:var(--fire);font-size:13px;font-weight:500">${esc(r.name)}</a>
            </td>
            <td style="padding:9px 12px;border-bottom:1px solid var(--border);font-size:12px;font-family:var(--font-mono);white-space:nowrap;color:var(--ink2)">${r.date||'—'}</td>
            <td style="padding:9px 12px;border-bottom:1px solid var(--border)">
              ${isLinked
                ?`<span class="badge badge-linked" title="${esc(lt.desc)}">🔗 ${esc(lt.desc.slice(0,22))}…</span>`
                :`<span style="font-size:12px;color:var(--ink3);font-family:var(--font-mono)">Not linked</span>`}
            </td>
            <td style="padding:9px 12px;border-bottom:1px solid var(--border);white-space:nowrap">
              <button class="btn btn-secondary btn-sm" onclick="openLinkForReceipt('${r.id}')">${isLinked?'Relink':'Link →'}</button>
            </td>
          </tr>`;
        }).join('')}
        </tbody>
      </table>
    `).join('')}`;

  // ── Mobile: month-grouped cards ──
  const mob=$('uploaded-receipts-mobile');
  mob.innerHTML=`
    <div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0 12px;flex-wrap:wrap;gap:8px">
      <div style="font-size:13px;color:var(--ink2)">${receipts.length} receipts total</div>
      ${unlinked>0?`<span style="font-size:11px;font-family:var(--font-mono);background:#FFFBEB;color:#D97706;padding:3px 10px;border-radius:20px">⚠ ${unlinked} not linked</span>`:''}
    </div>
    ${months.map(m=>`
      <div style="font-size:10px;font-family:var(--font-mono);color:var(--ink3);text-transform:uppercase;letter-spacing:0.08em;padding:8px 0 6px;border-top:1px solid var(--border);margin-top:4px">
        ${m!=='Unknown'?fmtMonth(m):'Unknown date'} · ${byMonth[m].length} receipt${byMonth[m].length>1?'s':''}
      </div>
      ${byMonth[m].map(r=>{
        const lt=transactions.find(t=>t.receiptId===r.id);
        const isLinked=!!lt;
        return`<div class="receipt-card" style="${isLinked?'border-color:rgba(42,122,75,0.25);background:var(--green-light)':''}">
          <div class="receipt-card-icon">${r.name.match(/\.pdf$/i)?'📄':'🖼️'}</div>
          <div class="receipt-card-info flex-1" style="min-width:0">
            <div class="receipt-card-name">${esc(r.name)}</div>
            <div class="receipt-card-meta">${r.date||''}${isLinked?' · 🔗 '+esc(lt.desc.slice(0,20)):' · not linked'}</div>
            <div class="receipt-card-actions">
              <a href="${r.url}" target="_blank" class="btn btn-secondary btn-sm">View ↗</a>
              <button class="btn btn-secondary btn-sm" onclick="openLinkForReceipt('${r.id}')">${isLinked?'Relink':'Link →'}</button>
            </div>
          </div>
        </div>`;
      }).join('')}
    `).join('')}`;

  renderQuickUpload();
}

// ─── QUICK UPLOAD (mobile) ───────────────────────────
function renderQuickUpload() {
  // Sync folder name
  if($('qu-folder-name')&&folderName){$('qu-folder-name').value=folderName;$('qu-folder-hint').textContent='Selected: '+folderName;}
  // Queue
  const queue=$('qu-queue');
  const qList=$('qu-queue-list');
  const pending=pendingReceipts.filter(r=>r.status==='pending'||r.status==='uploading');
  if(pending.length){
    queue.style.display='block';
    qList.innerHTML=pending.map(r=>`<div class="qu-item"><div class="qu-item-thumb">${r.file.type.startsWith('image/')?`<img src="${URL.createObjectURL(r.file)}"/>`:r.file.name.match(/\.pdf$/i)?'📄':'📁'}</div><div class="qu-item-info"><div class="qu-item-name">${esc(r.file.name)}</div><div class="qu-item-meta">${fmtSize(r.file.size)}${r.status==='uploading'?` · ${r.progress}%`:''}</div>${r.status==='uploading'?`<div class="progress-bar"><div class="progress-fill" style="width:${r.progress}%"></div></div>`:''}</div>${r.status!=='uploading'?`<button class="btn-x" onclick="removePending('${r.id}')">×</button>`:''}</div>`).join('');
  } else { queue.style.display='none'; }
  const btn=$('qu-upload-btn');
  if(btn) btn.disabled=!pendingReceipts.filter(r=>r.status==='pending').length;
  // Recent
  const recent=$('qu-recent-list');
  if(recent){
    if(!receipts.length){recent.innerHTML='<div style="text-align:center;padding:1.5rem;color:var(--ink3);font-size:13px">No receipts yet</div>';}
    else{recent.innerHTML=receipts.slice().reverse().slice(0,5).map(r=>{const lt=transactions.find(t=>t.receiptId===r.id);return`<div class="receipt-card"><div class="receipt-card-icon">${r.name.match(/\.pdf$/i)?'📄':'🖼️'}</div><div class="receipt-card-info flex-1" style="min-width:0"><div class="receipt-card-name">${esc(r.name)}</div><div class="receipt-card-meta">${r.date}${lt?' · linked':' · not linked'}</div><div class="receipt-card-actions"><a href="${r.url}" target="_blank" class="btn btn-secondary btn-sm">View ↗</a><button class="btn btn-secondary btn-sm" onclick="openLinkForReceipt('${r.id}')">${lt?'Relink':'Link'}</button></div></div></div>`;}).join('');}
  }
}

function addReceiptsQU(files){addReceipts(files);renderQuickUpload();}

function addReceipts(files){
  for(const f of files){
    if(f.size>20*1024*1024){alert(f.name+' exceeds 20 MB limit');continue;}
    pendingReceipts.push({id:'pr_'+Math.random().toString(36).slice(2),file:f,status:'pending',progress:0});
  }
  renderReceipts();
}

function removePending(id){pendingReceipts=pendingReceipts.filter(r=>r.id!==id);renderReceipts();}
function clearDoneReceipts(){pendingReceipts=pendingReceipts.filter(r=>r.status!=='done');renderReceipts();}

async function uploadAllReceipts(fromQuick=false){
  if(!accessToken){alert('Please sign in first.');return;}
  const pending=pendingReceipts.filter(r=>r.status==='pending');
  for(const r of pending) await uploadReceipt(r);
  saveReceipts();renderReceipts();
}

async function uploadReceipt(entry){
  entry.status='uploading';entry.progress=0;renderReceipts();renderQuickUpload();
  let targetId=folderId;
  if(folderId){try{targetId=await getOrCreateMonthFolder(folderId);}catch(e){}}
  const ds=new Date().toISOString().slice(0,10);
  const newName=ds+'_'+entry.file.name;
  const meta={name:newName,mimeType:entry.file.type||'application/octet-stream'};
  if(targetId)meta.parents=[targetId];
  const form=new FormData();
  form.append('metadata',new Blob([JSON.stringify(meta)],{type:'application/json'}));
  form.append('file',entry.file);
  await new Promise(resolve=>{
    const xhr=new XMLHttpRequest();
    xhr.open('POST','https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink');
    xhr.setRequestHeader('Authorization','Bearer '+accessToken);
    xhr.upload.onprogress=e=>{if(e.lengthComputable){entry.progress=Math.round(e.loaded/e.total*100);renderReceipts();renderQuickUpload();}};
    xhr.onload=()=>{
      if(xhr.status===200){const resp=JSON.parse(xhr.responseText);entry.status='done';receipts.push({id:entry.id,name:newName,url:resp.webViewLink,date:ds,driveId:resp.id});saveReceipts();}
      else{entry.status='error';}
      resolve();
    };
    xhr.onerror=()=>{entry.status='error';resolve();};
    xhr.send(form);
  });
}

// saveReceipts: defined above — saves to Drive via saveToDrive()

// ─── LINKING ─────────────────────────────────────────
function openLinkForReceipt(receiptId){
  linkingReceiptId=receiptId;linkingForTxn=false;selectedTxnId=null;
  const r=receipts.find(r=>r.id===receiptId);
  $('link-modal-desc').textContent=`Choose a transaction for "${r?.name||'receipt'}"`;
  $('link-modal-list').innerHTML=transactions.slice().sort((a,b)=>b.date.localeCompare(a.date)).map(t=>`<div class="modal-item" onclick="selectTxn('${t.id}',this)"><span style="font-family:var(--font-mono);font-size:11px;white-space:nowrap">${t.date}</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;padding:0 8px">${esc(t.desc)}</span><span class="${t.type==='in'?'amount-in':'amount-out'}" style="font-family:var(--font-mono);font-size:12px">${t.type==='in'?'+':'-'}${fmtEur(t.amount)}</span></div>`).join('')||'<p style="padding:1rem;color:var(--ink3);font-size:13px">No transactions yet. Import your CSV first.</p>';
  $('link-modal').style.display='flex';
}

function openLinkForTxn(txnId){
  linkingReceiptId=null;linkingForTxn=true;selectedTxnId=txnId;_selectedReceiptForLink=null;
  const t=transactions.find(t=>t.id===txnId);
  $('link-modal-desc').textContent=`Choose a receipt for "${t?.desc?.slice(0,30)||'transaction'}"`;
  $('link-modal-list').innerHTML=receipts.map(r=>`<div class="modal-item" onclick="selectReceipt('${r.id}',this)"><span style="font-size:16px">📄</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;padding:0 8px">${esc(r.name)}</span><span style="font-family:var(--font-mono);font-size:11px">${r.date}</span><a href="${r.url}" target="_blank" style="font-size:11px;color:var(--fire);flex-shrink:0" onclick="event.stopPropagation()">View ↗</a></div>`).join('')||'<p style="padding:1rem;color:var(--ink3);font-size:13px">No receipts yet. Upload receipts first.</p>';
  $('link-modal').style.display='flex';
}

function selectTxn(id,el){document.querySelectorAll('.modal-item').forEach(e=>e.classList.remove('selected'));el.classList.add('selected');selectedTxnId=id;}
function selectReceipt(id,el){document.querySelectorAll('.modal-item').forEach(e=>e.classList.remove('selected'));el.classList.add('selected');_selectedReceiptForLink=id;}

function confirmLink(){
  if(linkingForTxn){
    if(!_selectedReceiptForLink){alert('Please select a receipt.');return;}
    const t=transactions.find(t=>t.id===selectedTxnId);if(t){t.receiptId=_selectedReceiptForLink;saveTxns();}
  } else {
    if(!selectedTxnId){alert('Please select a transaction.');return;}
    const t=transactions.find(t=>t.id===selectedTxnId);if(t){t.receiptId=linkingReceiptId;saveTxns();}
  }
  $('link-modal').style.display='none';
  renderTransactions();renderReceipts();renderDashboard();
}

function closeModal(e){if(e.target.id==='link-modal')$('link-modal').style.display='none';}

// ─── GOOGLE DRIVE ────────────────────────────────────
function pickFolder(){ pickFolderFromSettings(); }
function pickFolderFromSettings(){
  if(!accessToken){alert('Please sign in first.');return;}
  const tryPicker=()=>{if(!window.gapi?.picker){gapi.load('picker',openPicker);return;}openPicker();};
  if(!window.gapi){setTimeout(tryPicker,400);}else{tryPicker();}
}
function openPicker(){
  const view=new google.picker.DocsView(google.picker.ViewId.FOLDERS).setSelectFolderEnabled(true).setMimeTypes('application/vnd.google-apps.folder');
  new google.picker.PickerBuilder().addView(view).setOAuthToken(accessToken).setCallback(async d=>{
    if(d.action===google.picker.Action.PICKED){
      folderId=d.docs[0].id; folderName=d.docs[0].name;
      // Persist so it survives page reload
      localStorage.setItem('kb_folderId', folderId);
      localStorage.setItem('kb_folderName', folderName);
      monthFolderCache={}; dataFileId=null;
      applyFolderToUI();
      renderSettings();
      // Load from new folder, then move data file there if it was at root
      await loadFromDrive();
      await moveDataFileToFolder();
      await saveToDrive(); // re-save to ensure file is in correct folder
      refreshAll();
    }
  }).build().setVisible(true);
}
function applyFolderToUI(){
  if($('folder-name-r')) $('folder-name-r').value = folderName||'';
  if($('folder-hint-r')) $('folder-hint-r').textContent = folderName?'Selected: '+folderName:'Files go to Drive root.';
  if($('qu-folder-name')) $('qu-folder-name').value = folderName||'';
  if($('qu-folder-hint')) $('qu-folder-hint').textContent = folderName?'Selected: '+folderName:'Files go to Drive root if none selected.';
}
function clearFolder(){
  if(!confirm('Clear the selected folder? Your Drive data is not deleted.')) return;
  folderId=null; folderName=null;
  localStorage.removeItem('kb_folderId'); localStorage.removeItem('kb_folderName');
  dataFileId=null; monthFolderCache={};
  applyFolderToUI(); renderSettings();
}
function loadSavedFolder(){
  const savedId=localStorage.getItem('kb_folderId');
  const savedName=localStorage.getItem('kb_folderName');
  if(savedId&&savedName){ folderId=savedId; folderName=savedName; applyFolderToUI(); }
}
function renderSettings(){
  const nameEl=$('settings-folder-name');
  const idEl=$('settings-folder-id');
  const badge=$('settings-folder-badge');
  const clearBtn=$('settings-clear-btn');
  if(!nameEl) return;
  if(folderName&&folderId){
    nameEl.textContent=folderName;
    idEl.textContent='ID: '+folderId;
    if(badge) badge.style.display='inline-block';
    if(clearBtn) clearBtn.style.display='inline-flex';
    if($('settings-folder-hint')) $('settings-folder-hint').textContent='✓ kitchen-data.json and receipts will be saved here';
    const tree=$('folder-tree-preview');
    if(tree){
      const mo=new Date().toISOString().slice(0,7);
      const prevN=String(parseInt(mo.slice(5))-1).padStart(2,'0');
      const prevMo=mo.slice(0,5)+prevN;
      tree.innerHTML='📁 <strong>'+esc(folderName)+'</strong><br/>&nbsp;&nbsp;&nbsp;├── 📄 kitchen-data.json &nbsp;<span style="color:var(--ink3);font-family:var(--font-body)">(shared transaction data)</span><br/>&nbsp;&nbsp;&nbsp;├── 📁 '+prevMo+'/<br/>&nbsp;&nbsp;&nbsp;│&nbsp;&nbsp;&nbsp;&nbsp;└── 🧾 '+prevMo+'-15_receipt.pdf<br/>&nbsp;&nbsp;&nbsp;└── 📁 '+mo+'/<br/>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└── 🧾 '+mo+'-03_invoice.pdf';
    }
  } else {
    nameEl.textContent='No folder selected';
    idEl.textContent='Choose a folder to get started';
    if(badge) badge.style.display='none';
    if(clearBtn) clearBtn.style.display='none';
    if($('settings-folder-hint')) $('settings-folder-hint').textContent='Without a folder, receipts go to Drive root and data may not sync between users.';
  }
}

async function getOrCreateMonthFolder(parentId){
  const m=new Date().toISOString().slice(0,7);
  if(monthFolderCache[m])return monthFolderCache[m];
  const q=encodeURIComponent(`name='${m}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parentId?` and '${parentId}' in parents`:''}`);
  const res=await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`,{headers:{Authorization:'Bearer '+accessToken}}).then(r=>r.json());
  if(res.files?.length){monthFolderCache[m]=res.files[0].id;return res.files[0].id;}
  const meta={name:m,mimeType:'application/vnd.google-apps.folder'};if(parentId)meta.parents=[parentId];
  const cr=await fetch('https://www.googleapis.com/drive/v3/files',{method:'POST',headers:{Authorization:'Bearer '+accessToken,'Content-Type':'application/json'},body:JSON.stringify(meta)}).then(r=>r.json());
  monthFolderCache[m]=cr.id;return cr.id;
}

// ─── DRAG & DROP ─────────────────────────────────────
function onDragOver(e,id){e.preventDefault();$(id)?.classList.add('drag-over')}
function onDragLeave(id){$(id)?.classList.remove('drag-over')}
function onDropReceipt(e){e.preventDefault();onDragLeave('drop-zone-r');addReceipts(e.dataTransfer.files)}

// ─── UTILS ───────────────────────────────────────────
function fmtEur(n,prefix=false){return(prefix?'€ ':'')+Math.abs(n).toLocaleString('en-EU',{minimumFractionDigits:2,maximumFractionDigits:2})}
function fmtMonth(m){
  if (!m) return '?';
  // Handle YYYY-MM (standard)
  if (/^\d{4}-\d{2}$/.test(m)) {
    const [y,mo]=m.split('-');
    return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(mo)-1]+' '+y;
  }
  return m; // fallback: show raw
}
function fmtSize(b){return b<1048576?Math.round(b/1024)+' KB':(b/1048576).toFixed(1)+' MB'}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function refreshAll(){renderDashboard();renderTransactions();renderReceipts();renderPL();}

// ─── AUTO SYNC ───────────────────────────────────────
let autoSyncInterval = null;

function startAutoSync() {
  // Poll every 60 seconds — pull latest from Drive silently
  if (autoSyncInterval) clearInterval(autoSyncInterval);
  autoSyncInterval = setInterval(async () => {
    if (!accessToken) return;
    try {
      const foundId = await findDataFile();
      if (!foundId) return;
      // Only reload if Drive file is newer than what we have
      const meta = await fetch(
        `https://www.googleapis.com/drive/v3/files/${foundId}?fields=modifiedTime`,
        { headers: { Authorization: 'Bearer ' + accessToken } }
      ).then(r => r.json());
      const driveTime = new Date(meta.modifiedTime).getTime();
      if (!lastSyncTime || driveTime > lastSyncTime) {
        const res = await fetch(
          `https://www.googleapis.com/drive/v3/files/${foundId}?alt=media`,
          { headers: { Authorization: 'Bearer ' + accessToken } }
        );
        if (!res.ok) return;
        const data = await res.json();
        if (data.transactions || data.receipts) {
          dataFileId = foundId;
          transactions = data.transactions || [];
          receipts = data.receipts || [];
          lastSyncTime = driveTime;
          refreshAll();
          showSyncStatus('saved', `Auto-synced · ${new Date().toLocaleTimeString()}`);
          setTimeout(() => showSyncStatus('ready', 'Auto-sync on'), 2000);
        }
      }
    } catch(e) { /* silent fail on auto-sync */ }
  }, 60000); // every 60 seconds
}

function stopAutoSync() {
  if (autoSyncInterval) { clearInterval(autoSyncInterval); autoSyncInterval = null; }
}

// Track last sync time to detect changes
let lastSyncTime = null;

// ─── BOOT ────────────────────────────────────────────
// On page load: show cached user name immediately, then silently restore session
window.addEventListener('load', () => {
  const cachedName = localStorage.getItem('kb_user_name');
  if (cachedName && localStorage.getItem('kb_signed_in')) {
    // Show app shell instantly from cache while silent token request runs in background
    $('user-name-side').textContent = cachedName;
    $('user-av').textContent = cachedName.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
    $('auth-screen').style.display = 'none';
    $('app').style.display = 'grid';
    showSyncStatus('loading');
  }
  tryAutoSignIn();
});

// Scan Drive folder for receipt files not yet in receipts metadata
// This recovers files uploaded from mobile/another device
async function scanDriveForMissingReceipts() {
  if (!accessToken || !folderId) return;
  try {
    // Get all month subfolders inside the selected folder
    const q1 = encodeURIComponent(`'${folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const foldersRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q1}&fields=files(id,name)`, {
      headers: { Authorization: 'Bearer ' + accessToken }
    }).then(r => r.json());

    const subFolders = foldersRes.files || [];
    // Also check root folder directly
    const allFolderIds = [folderId, ...subFolders.map(f => f.id)];
    const knownDriveIds = new Set(receipts.map(r => r.driveId).filter(Boolean));
    let added = 0;

    for (const fid of allFolderIds) {
      const q2 = encodeURIComponent(`'${fid}' in parents and mimeType!='application/vnd.google-apps.folder' and name!='kitchen-data.json' and trashed=false`);
      const filesRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q2}&fields=files(id,name,webViewLink,createdTime)&orderBy=createdTime`, {
        headers: { Authorization: 'Bearer ' + accessToken }
      }).then(r => r.json());

      for (const file of (filesRes.files || [])) {
        if (knownDriveIds.has(file.id)) continue; // already in metadata
        // It's a receipt file we don't know about — add it
        const date = file.createdTime ? file.createdTime.slice(0, 10) : new Date().toISOString().slice(0, 10);
        receipts.push({
          id: 'recovered_' + file.id,
          name: file.name,
          url: file.webViewLink,
          date: date,
          driveId: file.id
        });
        knownDriveIds.add(file.id);
        added++;
      }
    }

    if (added > 0) {
      console.log(`Recovered ${added} receipts from Drive`);
      await saveToDrive();
    }
  } catch(e) {
    console.error('Drive scan failed:', e);
  }
}

// Migration: fix dates stored in bad format (M/D/YY → YYYY-MM-DD)
// Runs after Drive data loads and saves back if anything changed
async function fixLegacyDates() {
  let fixed = 0;
  transactions = transactions.map(t => {
    const d = t.date || '';
    // Fix M/D/YY or M/D/YYYY format
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(d)) {
      const parts = d.split('/');
      const mo = parts[0].padStart(2,'0');
      const day = parts[1].padStart(2,'0');
      let y = parts[2];
      if (y.length === 2) y = (parseInt(y) < 50 ? '20' : '19') + y;
      fixed++;
      return {...t, date: y + '-' + mo + '-' + day};
    }
    return t;
  });
  if (fixed > 0) {
    console.log('Fixed ' + fixed + ' legacy date formats — saving to Drive');
    await saveToDrive(); // persist fix back to Drive so it never happens again
  }
}
