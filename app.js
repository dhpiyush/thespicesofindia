// ─── CONFIG ─────────────────────────────────────────
const CLIENT_ID = '354274835745-f36h72g2th27fafmkj3i7d57kov2u8kc.apps.googleusercontent.com';
// drive.file = upload new files; drive.appdata not enough for shared folder
// We need drive scope to read/write the shared kitchen-data.json
const SCOPES = 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email';
const DATA_FILENAME = 'kitchen-data.json';
// ────────────────────────────────────────────────────

const CATEGORIES_IN  = ['Delivery revenue','Takeaway revenue','Catering revenue','Other revenue','Private deposit','Savings transfer','VAT payment'];
const CATEGORIES_OUT = ['Ingredients','Packaging','Kitchen rent','Energy','Delivery platform','Wages','Marketing','Administration','Other costs','Private withdrawal','Savings transfer','VAT payment'];
const PRIVATE_CATEGORIES = ['Private deposit','Private withdrawal'];
// Money moved between the business current account and the business savings account: not
// revenue or a cost, and not private either.
const SAVINGS_CATEGORY = 'Savings transfer';
// VAT paid to (or refunded by) the Belastingdienst settles the VAT owed on the balance sheet:
// not a cost, and not private either.
const VAT_PAYMENT_CATEGORY = 'VAT payment';
const OUTSIDE_PL_CATEGORIES = [...PRIVATE_CATEGORIES, SAVINGS_CATEGORY, VAT_PAYMENT_CATEGORY];
// Imports put transactions whose description mentions the savings account straight in SAVINGS_CATEGORY,
// and Belastingdienst payments for a VAT return ("Btw-aangifte") in VAT_PAYMENT_CATEGORY.
const SAVINGS_PATTERN = /spaarrekening/i;
const VAT_PAYMENT_PATTERN = /belastingdienst[\s\S]*\bbtw\b|\bbtw\b[\s\S]*belastingdienst/i;
const importCategory = (text, isIn) =>
  SAVINGS_PATTERN.test(text) ? SAVINGS_CATEGORY : VAT_PAYMENT_PATTERN.test(text) ? VAT_PAYMENT_CATEGORY : isIn ? CATEGORIES_IN[0] : CATEGORIES_OUT[0];

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

// Match each existing record at most once per statement. Equal payments on the
// same day can be separate transactions, especially workshop registrations.
function findINGDuplicate(existing, matched, date, amount, type, desc, details) {
  const normalize = value => (value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const incoming = [desc, details].map(normalize).filter(Boolean);
  return existing.find(t => {
    if (matched.has(t.id) || t.date !== date || Math.abs(t.amount - amount) >= 0.01 || t.type !== type) return false;
    const stored = [t.desc, t.bankDetails].map(normalize).filter(Boolean);
    return stored.some(a => incoming.some(b => a === b || a.includes(b) || b.includes(a)));
  });
}

let accessToken = null;
let transactions = [];
let receipts = [];
let pendingReceipts = [];
let pendingTasks = []; // receipt↔transaction conflicts needing manual resolution
let lastMatchJobRun = null; // ISO timestamp — gates the once-a-day auto-match job
let vatFrom = null; // YYYY-MM-DD the business left KOR and became VAT-liable; null = still in KOR
let categoryVat = {}; // category → default VAT rate (%); categories not listed use DEFAULT_VAT_RATE
let lockedQuarters = {}; // 'YYYY-Qn' → { lockedAt, vatNet } — closed quarters can't be edited
let assets = []; // asset register: { id, name, purchaseDate, cost, lifeYears, residual, disposedDate, txnId }
let savingsOpening = null; // { date, amount } — savings account balance on that date (Settings)
let hours = []; // hours log: { id, date, start, end, breakMin, hours, description, person }
let bankOpening = null; // { date, amount } — current account balance at the start of that date (Settings)
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
      pendingTasks = data.pendingTasks || [];
      lastMatchJobRun = data.lastMatchJobRun || null;
      vatFrom = data.vatFrom || null;
      categoryVat = data.categoryVat || {};
      lockedQuarters = data.lockedQuarters || {};
      assets = data.assets || [];
      savingsOpening = data.savingsOpening || null;
      hours = data.hours || [];
      bankOpening = data.bankOpening || null;
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
    const payload = JSON.stringify({ transactions, receipts, pendingTasks, lastMatchJobRun, vatFrom, categoryVat, lockedQuarters, assets, savingsOpening, hours, bankOpening, updatedAt: new Date().toISOString() });
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
  await runDailyReceiptMatch();
  await runDailyBackup();
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
  accessToken=null; transactions=[]; receipts=[]; pendingTasks=[]; lastMatchJobRun=null; vatFrom=null; categoryVat={}; lockedQuarters={}; assets=[]; savingsOpening=null; hours=[]; bankOpening=null; dataFileId=null; lastSyncTime=null;
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
  await runDailyReceiptMatch();
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
  if (id==='pending') renderPending();
  if (id==='pl') renderPL();
  if (id==='vat') renderVAT();
  if (id==='yearend') renderYearEnd();
  if (id==='hours') renderHours();
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
        const detailsKey = keys.find(k => /^(Notifications|Mededelingen)$/i.test(k.trim()));

        if (!amtKey || !dirKey) {
          alert('Could not detect ING CSV columns.\n\nFound columns: ' + keys.join(', ') + '\n\nPlease make sure you are uploading an ING transaction export (CSV).');
          input.value=''; return;
        }

        let added=0, skipped=0, lockedSkipped=0;
        const existing = transactions.slice(), matched = new Set();
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
          const bankDetails = (detailsKey ? row[detailsKey] || '' : '').trim();

          const id='txn_'+Date.now()+'_'+Math.random().toString(36).slice(2,10);
          // Duplicate check: same date + amount + direction, with a fuzzy desc match
          // (description text varies between export formats, e.g. "G. Bijsterbosch" vs "Betaling van G. Bijsterbosch NL13...")
          const duplicate = findINGDuplicate(existing, matched, dateStr, amt, isIn ? 'in' : 'out', descClean, bankDetails);
          if (duplicate) { matched.add(duplicate.id); skipped++; continue; }
          if (isLockedDate(dateStr)) { lockedSkipped++; continue; }
          transactions.push({
            id, date:dateStr, desc:descClean, bankDetails, amount:amt,
            type:isIn?'in':'out',
            category:importCategory(descClean+' '+bankDetails,isIn),
            receiptId:null
          });
          added++;
        }
        saveTxns(); renderTransactions(); renderDashboard();
        const msg = added+' transactions imported'+(skipped>0?` · ${skipped} duplicates skipped`:'')+(lockedSkipped?`\n\n${lockedSkipped} new transactions fall in a locked quarter and were NOT imported. Unlock the quarter on the VAT page first if they belong in the books.`:'');
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

      let added = 0, skipped = 0, lockedSkipped = 0, unmapped = new Set();

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
          category = importCategory(desc, isIn);
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
        if (isLockedDate(dateStr)) { lockedSkipped++; continue; }

        const id = 'txn_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
        transactions.push({ id, date: dateStr, desc, amount: absAmt, type: isIn ? 'in' : 'out', category, receiptId: null });
        added++;
      }

      saveTxns(); renderTransactions(); renderDashboard();

      let msg = `✓ ${added} transactions imported from Moneybird`;
      if (skipped) msg += `\n${skipped} duplicates skipped`;
      if (lockedSkipped) msg += `\n\n${lockedSkipped} new transactions fall in a locked quarter and were NOT imported. Unlock the quarter on the VAT page first if they belong in the books.`;
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
  const receiptF=$('filter-receipt')?.value||'';
  const receiptIds=new Set(receipts.map(r=>r.id));
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
    if(receiptF&&(receiptF==='linked')!==receiptIds.has(t.receiptId))return false;
    if(search&&!t.desc.toLowerCase().includes(search)&&!t.category.toLowerCase().includes(search))return false;
    return true;
  }).sort((a,b)=>b.date.localeCompare(a.date));
  const wrap=$('txn-table-wrap');
  const total=(type)=>filtered.filter(t=>t.type===type).reduce((s,t)=>s+t.amount,0);
  const filtering=search||typeF||monthF||catF||receiptF;
  $('txn-count').textContent=transactions.length
    ?`${filtering?`${filtered.length} of ${transactions.length}`:transactions.length} transaction${transactions.length===1?'':'s'} · +€ ${fmtEur(total('in'))} · −€ ${fmtEur(total('out'))}`
    :'';
  if(!filtered.length){wrap.innerHTML=`<div class="empty"><div class="empty-icon">${transactions.length?'🔍':'📂'}</div><h3>${transactions.length?'No results':'No transactions'}</h3><p>${transactions.length?'Adjust the filters':'Import your ING CSV to get started'}</p></div>`;return;}
  wrap.innerHTML=`<table><thead><tr><th>Date</th><th>Description</th><th>Category</th><th style="text-align:right">Amount</th><th>VAT</th><th>Type</th><th>Receipt</th></tr></thead><tbody>${filtered.map(t=>{
    const linked=receipts.find(r=>r.id===t.receiptId);
    return`<tr><td style="font-family:var(--font-mono);font-size:12px;white-space:nowrap">${t.date}</td><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.desc)}</td><td>${isLockedDate(t.date)?`<span class="badge badge-cat" title="Quarter is locked">🔒 ${esc(t.category)}</span>`:`<select class="cat-select" onchange="updateCat('${t.id}',this.value)">${(t.type==='in'?CATEGORIES_IN:CATEGORIES_OUT).map(c=>`<option${c===t.category?' selected':''}>${c}</option>`).join('')}</select>`}${assetOfTxn(t)?` <span class="badge badge-cat" title="Booked as an asset: depreciated instead of counted as a cost">🏷️ Asset</span>`:''}</td><td style="text-align:right"><span class="${t.type==='in'?'amount-in':'amount-out'}">${t.type==='in'?'+':'-'}${fmtEur(t.amount)}</span></td><td>${vatSelect(t)}</td><td><span class="badge ${t.type==='in'?'badge-in':'badge-out'}">${t.type==='in'?'Revenue':'Expense'}</span></td><td>${linked?`<a href="${linked.url}" target="_blank" class="badge badge-linked">🔗 ${esc(linked.name.slice(0,12))}…</a>`:`<button class="btn btn-secondary btn-sm" onclick="openLinkForTxn('${t.id}')">Link</button>`}</td></tr>`;
  }).join('')}</tbody></table>`;
}

function updateCat(id,cat){const t=transactions.find(t=>t.id===id);if(!t)return;if(isLockedDate(t.date)){alertLocked(t.date);renderTransactions();return;}t.category=cat;saveTxns();renderDashboard();}

// ─── VAT ─────────────────────────────────────────────
// Every amount is stored incl. VAT. Rate lookup: the transaction's own t.vatRate (set by hand),
// else its category's default from Settings (categoryVat), else DEFAULT_VAT_RATE. Private transfers never carry VAT. VAT only counts towards the P&L
// and the VAT return from vatFrom onwards — before that the business is in KOR (VAT-exempt),
// so VAT on expenses is a cost and nothing is charged on sales.
const DEFAULT_VAT_RATE = 9;
const VAT_RATES = [0, 9, 21];
const KOR_LIMIT = 20000;
const categoryVatRate = cat => categoryVat[cat] != null ? categoryVat[cat] : DEFAULT_VAT_RATE;
const vatRateOf = t => isOutsidePL(t) ? 0 : (t.vatRate != null ? t.vatRate : categoryVatRate(t.category));
const vatOf = t => { const r = vatRateOf(t); return t.amount * r / (100 + r); };
const isVatLiable = t => !!vatFrom && t.date >= vatFrom;
// Amount used in the P&L: excl. VAT once VAT-liable, otherwise the full amount paid/received.
const plAmount = t => isVatLiable(t) ? t.amount - vatOf(t) : t.amount;

function vatSelect(t){
  if(isOutsidePL(t)) return '<span style="font-size:11px;color:var(--ink3);font-family:var(--font-mono)">—</span>';
  const r=vatRateOf(t);
  if(isLockedDate(t.date)) return `<span style="font-size:11px;font-family:var(--font-mono)" title="Quarter is locked">${r}%</span>`;
  const opts=[...new Set([...VAT_RATES,r])].sort((a,b)=>a-b);
  // A hand-set rate that differs from the category default shows in bold; "Use category default" clears it.
  const overridden=t.vatRate!=null&&t.vatRate!==categoryVatRate(t.category);
  return `<select class="cat-select" style="width:auto${overridden?';font-weight:600':''}" title="${overridden?'Set by hand':'Category default'}" onchange="updateVat('${t.id}',this)">${opts.map(o=>`<option value="${o}"${o===r?' selected':''}>${o}%</option>`).join('')}<option value="custom">Other…</option>${t.vatRate!=null?`<option value="default">Use category default (${categoryVatRate(t.category)}%)</option>`:''}</select>`;
}

function updateVat(id,sel){
  const t=transactions.find(t=>t.id===id); if(!t) return;
  if(isLockedDate(t.date)){ alertLocked(t.date); renderTransactions(); return; }
  let rate=sel.value;
  if(rate==='default'){ delete t.vatRate; saveTxns(); renderTransactions(); renderDashboard(); return; }
  if(rate==='custom'){
    const input=prompt('VAT rate for this transaction (%):', vatRateOf(t));
    const val=input===null?NaN:parseAmountInput(input);
    if(isNaN(val)||val<0||val>100){ if(input!==null) alert('Please enter a percentage between 0 and 100.'); sel.outerHTML=vatSelect(t); return; }
    rate=val;
  }
  t.vatRate=Number(rate);
  saveTxns(); renderTransactions(); renderDashboard();
}

// ─── DASHBOARD ───────────────────────────────────────
const isPrivate = t => PRIVATE_CATEGORIES.includes(t.category);
const isSavings = t => t.category === SAVINGS_CATEGORY;
const isVatPayment = t => t.category === VAT_PAYMENT_CATEGORY;
// Private transfers and savings transfers: left out of revenue, costs, profit and VAT.
const isOutsidePL = t => OUTSIDE_PL_CATEGORIES.includes(t.category);

// Savings balance at the end of `date` (YYYY-MM-DD). The Settings balance is the balance at the
// start of its date; transfers from that day on are added: money moved to savings ('out' from the
// current account) adds, money moved back subtracts. null when no balance is set or `date` is
// before the start.
function savingsBalanceAt(date){
  if(!savingsOpening||date<savingsOpening.date) return null;
  return transactions.filter(t=>isSavings(t)&&t.date>=savingsOpening.date&&t.date<=date)
    .reduce((s,t)=>s+(t.type==='out'?t.amount:-t.amount),savingsOpening.amount);
}
// Balance at the start of `date`, before that day's transfers.
function savingsBalanceBefore(date){
  if(!savingsOpening||date<savingsOpening.date) return null;
  if(date===savingsOpening.date) return savingsOpening.amount;
  const prev=new Date(new Date(date+'T00:00:00Z').getTime()-864e5).toISOString().slice(0,10);
  return savingsBalanceAt(prev);
}

// Totals moved to and from savings for a list of transactions.
function savingsMoves(list){
  const sv=list.filter(isSavings);
  return { toSavings: sv.filter(t=>t.type==='out').reduce((s,t)=>s+t.amount,0),
           fromSavings: sv.filter(t=>t.type==='in').reduce((s,t)=>s+t.amount,0), count: sv.length };
}

function savingsSummaryHTML(list, endDate){
  const m=savingsMoves(list), bal=savingsBalanceAt(endDate);
  const row=(label,val,bold)=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:13px${bold?';font-weight:600':''}"><span style="color:var(--ink2)">${label}</span><span style="font-family:var(--font-mono)">${val}</span></div>`;
  return (m.count?row(`Moved to savings (${m.count} transfer${m.count===1?'':'s'})`,'€ '+fmtEur(m.toSavings))+row('Moved back from savings','€ '+fmtEur(m.fromSavings)):'<p style="font-size:13px;color:var(--ink3)">No savings transfers in this period</p>')
    +(bal!=null?row(`Savings balance on ${endDate}`,'€ '+fmtEur(bal),true)
      :`<p style="font-size:12px;color:var(--ink3);margin-top:6px">Set the savings account balance in Settings to see the running balance.</p>`);
}
function renderDashboard() {
  // Exclude private deposits/withdrawals from all P&L figures
  const income =transactions.filter(t=>t.type==='in' &&!isOutsidePL(t)).reduce((s,t)=>s+t.amount,0);
  const expense=transactions.filter(t=>t.type==='out'&&!isOutsidePL(t)).reduce((s,t)=>s+t.amount,0);
  const profit=income-expense;
  const linked=receipts.filter(r=>transactions.some(t=>t.receiptId===r.id)).length;
  $('stat-income').textContent=fmtEur(income,true);
  $('stat-income-sub').textContent=transactions.filter(t=>t.type==='in'&&!isOutsidePL(t)).length+' transactions';
  $('stat-expense').textContent=fmtEur(expense,true);
  $('stat-expense-sub').textContent=transactions.filter(t=>t.type==='out'&&!isOutsidePL(t)).length+' transactions';
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
  const maxVal=Math.max(...months.map(m=>{const i=transactions.filter(t=>t.type==='in'&&!isOutsidePL(t)&&t.date.startsWith(m)).reduce((s,t)=>s+t.amount,0);const e=transactions.filter(t=>t.type==='out'&&!isOutsidePL(t)&&t.date.startsWith(m)).reduce((s,t)=>s+t.amount,0);return Math.max(i,e);}),1);
  chart.innerHTML=months.map(m=>{
    const inc=transactions.filter(t=>t.type==='in'&&!isOutsidePL(t)&&t.date.startsWith(m)).reduce((s,t)=>s+t.amount,0);
    const exp=transactions.filter(t=>t.type==='out'&&!isOutsidePL(t)&&t.date.startsWith(m)).reduce((s,t)=>s+t.amount,0);
    const ih=Math.max(Math.round((inc/maxVal)*110),2);const eh=Math.max(Math.round((exp/maxVal)*110),2);
    return`<div class="bar-group"><div class="bar-wrap"><div class="bar income-bar" style="height:${ih}px" title="Revenue ${fmtEur(inc,true)}"></div><div class="bar expense-bar" style="height:${eh}px" title="Expenses ${fmtEur(exp,true)}"></div></div><div class="bar-label">${m.slice(5)}</div></div>`;
  }).join('');
  const recent=[...transactions].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,5);
  $('recent-txn-list').innerHTML=recent.length?`<table><thead><tr><th>Date</th><th>Description</th><th>Category</th><th style="text-align:right">Amount</th></tr></thead><tbody>${recent.map(t=>`<tr><td style="font-family:var(--font-mono);font-size:12px">${t.date}</td><td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.desc)}</td><td><span class="badge ${isOutsidePL(t)?'badge-private':'badge-cat'}">${esc(t.category)}</span></td><td style="text-align:right"><span class="${t.type==='in'?'amount-in':'amount-out'}">${t.type==='in'?'+':'-'}${fmtEur(t.amount)}</span></td></tr>`).join('')}</tbody></table>`:'<div class="empty" style="padding:1.5rem"><p>Import your bank statement to get started</p></div>';
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
  // Exclude private categories and asset purchases (those are depreciated instead) from P&L
  const filtered=all.filter(t=>!isOutsidePL(t)&&!assetOfTxn(t));
  const plMonths=plMonth==='all'?months.slice(1):[plMonth];
  const dep=plMonths.length?depreciationBetween(monthIndex(plMonths[0]+'-01'),monthIndex(plMonths[plMonths.length-1]+'-01')):0;
  const income=filtered.filter(t=>t.type==='in').reduce((s,t)=>s+plAmount(t),0);
  const expense=filtered.filter(t=>t.type==='out').reduce((s,t)=>s+plAmount(t),0)+dep;
  const liable=filtered.filter(isVatLiable).length;
  $('pl-subtitle').textContent=!liable?'By category — KOR-exempt, amounts incl. VAT':liable===filtered.length?'By category — amounts excl. VAT':`By category — excl. VAT from ${vatFrom}, incl. VAT before (KOR)`;
  $('pl-income').textContent=fmtEur(income,true);$('pl-expense').textContent=fmtEur(expense,true);$('pl-profit').textContent=fmtEur(income-expense,true);
  const byCat=(type,container)=>{
    const cats={};
    filtered.filter(t=>t.type===type).forEach(t=>{cats[t.category]=(cats[t.category]||0)+plAmount(t);});
    if(type==='out'&&dep>0) cats['Depreciation']=dep;
    const total=Object.values(cats).reduce((s,v)=>s+v,0)||1;
    const rows=Object.entries(cats).sort((a,b)=>b[1]-a[1]);
    $(container).innerHTML=rows.length?rows.map(([cat,val])=>`<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)"><div style="flex:1;font-size:13px">${esc(cat)}</div><div style="width:80px;height:6px;background:var(--paper2);border-radius:3px;overflow:hidden;flex-shrink:0"><div style="height:100%;width:${Math.round(val/total*100)}%;background:${type==='in'?'var(--green)':'var(--red)'};border-radius:3px"></div></div><div style="font-family:var(--font-mono);font-size:13px;min-width:80px;text-align:right;color:${type==='in'?'var(--green)':'var(--red)'}">${fmtEur(val,true)}</div></div>`).join(''):'<div class="empty" style="padding:1rem"><p>No data for this period</p></div>';
  };
  byCat('in','pl-income-cats');byCat('out','pl-expense-cats');
  // Show private transfers separately
  const lastDay=plMonth==='all'?(all.map(t=>t.date).sort().pop()||new Date().toISOString().slice(0,10)):plMonth+'-'+String(new Date(+plMonth.slice(0,4),+plMonth.slice(5,7),0).getDate()).padStart(2,'0');
  if($('pl-savings')) $('pl-savings').innerHTML=savingsSummaryHTML(all,lastDay);
  const privateRows=all.filter(t=>isPrivate(t));
  const privTotal=privateRows.reduce((s,t)=>s+(t.type==='in'?t.amount:-t.amount),0);
  const privEl=$('pl-private');
  if(privEl){
    const vatRows=all.filter(isVatPayment);
    const vatTotal=vatRows.reduce((s,t)=>s+(t.type==='in'?t.amount:-t.amount),0);
    privEl.innerHTML=(privateRows.length?`<div style="display:flex;justify-content:space-between;align-items:center"><span style="font-size:13px;color:var(--ink2)">Private transfers (${privateRows.length} transactions · not in P&L)</span><span style="font-family:var(--font-mono);font-size:13px;color:var(--ink3)">${privTotal>=0?'+':''}${fmtEur(Math.abs(privTotal),true)}</span></div>`:'<p style="font-size:13px;color:var(--ink3)">No private transfers</p>')
      +(vatRows.length?`<div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px"><span style="font-size:13px;color:var(--ink2)">VAT payments (${vatRows.length} transaction${vatRows.length===1?'':'s'} · not in P&L)</span><span style="font-family:var(--font-mono);font-size:13px;color:var(--ink3)">${vatTotal>=0?'+':'−'}${fmtEur(Math.abs(vatTotal),true)}</span></div>`:'');
  }
}

function setPLMonth(m,btn){plMonth=m;document.querySelectorAll('.month-tab').forEach(b=>b.classList.remove('active'));btn.classList.add('active');renderPL();}

function exportCSV(){
  const filtered=plMonth==='all'?transactions:transactions.filter(t=>t.date.startsWith(plMonth));
  const rows=[['Date','Description','Category','Type','Amount','VAT rate %','VAT','Amount excl. VAT']];
  filtered.sort((a,b)=>a.date.localeCompare(b.date)).forEach(t=>{const sign=t.type==='out'?'-':'';rows.push([t.date,t.desc,t.category,t.type==='in'?'Revenue':'Expense',sign+t.amount.toFixed(2),vatRateOf(t),sign+vatOf(t).toFixed(2),sign+(t.amount-vatOf(t)).toFixed(2)]);});
  const csv=rows.map(r=>r.map(c=>'"'+String(c).replace(/"/g,'""')+'"').join(',')).join('\n');
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=`kitchen-books${plMonth!=='all'?'_'+plMonth:''}.csv`;a.click();
  URL.revokeObjectURL(url);
}

// ─── VAT RETURN ──────────────────────────────────────
let vatQuarter = null; // 'YYYY-Qn'
const quarterOf = d => d.slice(0,4)+'-Q'+(Math.floor((parseInt(d.slice(5,7),10)-1)/3)+1);

function renderVAT(){
  const quarters=[...new Set(transactions.filter(t=>/^\d{4}-\d{2}/.test(t.date||'')).map(t=>quarterOf(t.date)))].sort();
  if(!vatQuarter||!quarters.includes(vatQuarter)) vatQuarter=quarters[quarters.length-1]||null;
  $('vat-quarters').innerHTML=quarters.map(q=>`<button class="month-tab${q===vatQuarter?' active':''}" onclick="vatQuarter='${q}';renderVAT()">${lockedQuarters[q]?'🔒 ':''}${q.replace('-',' ')}</button>`).join('');

  // KOR limit tracker: business revenue this calendar year vs the €20,000 limit.
  const year=new Date().getFullYear().toString();
  const revenue=transactions.filter(t=>t.type==='in'&&!isOutsidePL(t)&&t.date.startsWith(year)).reduce((s,t)=>s+t.amount,0);
  const pct=Math.min(revenue/KOR_LIMIT*100,100);
  const korColor=pct>=100?'var(--red)':pct>=80?'#D97706':'var(--green)';
  $('vat-kor').innerHTML=vatFrom
    ?`<p style="font-size:13px;color:var(--ink2)">VAT-registered from <strong>${vatFrom}</strong> (no longer in KOR). Change this in Settings.</p>`
    :`<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:8px"><span>Revenue ${year}</span><span style="font-family:var(--font-mono)">${fmtEur(revenue,true)} / ${fmtEur(KOR_LIMIT,true)}</span></div>
      <div style="height:8px;background:var(--paper2);border-radius:4px;overflow:hidden"><div style="height:100%;width:${pct}%;background:${korColor}"></div></div>
      <p style="font-size:12px;color:${pct>=80?korColor:'var(--ink3)'};margin-top:8px">${pct>=100?'Over the KOR limit — VAT applies from the sale that crossed it. Contact your accountant and set the date in Settings.':pct>=80?`${Math.round(pct)}% of the KOR limit used — ${fmtEur(KOR_LIMIT-revenue,true)} left this year.`:`${fmtEur(KOR_LIMIT-revenue,true)} left before the KOR limit.`}</p>`;

  const open=unlockedEndedQuarters();
  $('vat-lock-reminder').innerHTML=open.length?`<div style="font-size:13px;background:#FFFBEB;color:#92400E;border-radius:var(--radius);padding:10px 12px;margin-bottom:16px;line-height:1.6">
      ⏰ ${open.length===1?'This quarter has':'These quarters have'} ended but ${open.length===1?"isn't":"aren't"} locked yet: ${open.map(q=>`<a href="#" style="color:inherit;font-weight:600" onclick="vatQuarter='${q}';renderVAT();return false">${q.replace('-',' ')}</a>`).join(', ')}.
      Lock ${open.length===1?'it':'each one'} once ${vatFrom?'its VAT return is filed':'its books are checked'}.</div>`:'';
  renderLockReminder();

  const wrap=$('vat-return');
  if(!vatQuarter){wrap.innerHTML='<div class="empty"><p>No transactions yet</p></div>';return;}
  const inQ=transactions.filter(t=>t.date&&quarterOf(t.date)===vatQuarter&&!isOutsidePL(t));
  const liable=inQ.filter(isVatLiable);
  // Before vatFrom the figures are a preview: what the return would be without KOR.
  const rows=liable.length?liable:inQ;
  const preview=!liable.length;
  const sales=rows.filter(t=>t.type==='in'), purchases=rows.filter(t=>t.type==='out');
  const sum=(list,f)=>list.reduce((s,t)=>s+f(t),0);
  const byRate=(list,test)=>list.filter(t=>test(vatRateOf(t)));
  const line=(box,label,list)=>`<tr><td style="font-family:var(--font-mono);font-size:12px;color:var(--ink3)">${box}</td><td style="font-size:13px">${label}</td><td style="text-align:right;font-family:var(--font-mono);font-size:13px">${fmtEur(sum(list,t=>t.amount-vatOf(t)))}</td><td style="text-align:right;font-family:var(--font-mono);font-size:13px">${fmtEur(sum(list,vatOf))}</td></tr>`;
  const due=sum(sales,vatOf), input=sum(purchases,vatOf), net=due-input;
  const lock=lockedQuarters[vatQuarter];
  const ended=quarterEnd(vatQuarter)<new Date().toISOString().slice(0,10);
  const lockBar=lock
    ?`<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:12px;background:var(--green-light);color:var(--green);border-radius:var(--radius);padding:10px 12px;margin-bottom:12px"><span>🔒 Locked on ${lock.lockedAt.slice(0,10)} — transactions in this quarter can't be changed.</span><button class="btn btn-secondary btn-sm" onclick="unlockQuarter('${vatQuarter}')">Unlock</button></div>`
    :ended?`<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--ink3);margin-bottom:12px"><span>${preview?'Lock this quarter once its books are checked.':'Lock this quarter once its VAT return is filed.'} A backup is made first.</span><button class="btn btn-primary btn-sm" onclick="lockQuarter('${vatQuarter}',${net.toFixed(2)})">🔒 Lock quarter</button></div>`
    :`<div style="font-size:12px;color:var(--ink3);margin-bottom:12px">This quarter runs until ${quarterEnd(vatQuarter)}; it can be locked after that.</div>`;
  wrap.innerHTML=`${lockBar}
    ${preview?`<div style="font-size:12px;background:#FFFBEB;color:#92400E;border-radius:var(--radius);padding:10px 12px;margin-bottom:12px">Preview only — in KOR for this quarter, so no VAT return is due and VAT on expenses can't be reclaimed. Shows what the return would be without KOR.</div>`:''}
    ${!preview&&liable.length<inQ.length?`<div style="font-size:12px;color:var(--ink3);margin-bottom:12px">Only transactions from ${vatFrom} are included (${inQ.length-liable.length} earlier ones were under KOR).</div>`:''}
    <table style="width:100%"><thead><tr><th style="width:44px">Box</th><th></th><th style="text-align:right">Excl. VAT</th><th style="text-align:right">VAT</th></tr></thead><tbody>
      ${line('1a','Sales at 21%',byRate(sales,r=>r===21))}
      ${line('1b','Sales at 9%',byRate(sales,r=>r===9))}
      ${line('1c','Sales at other rates',byRate(sales,r=>r!==21&&r!==9&&r!==0))}
      ${line('1e','Sales at 0% / not taxed',byRate(sales,r=>r===0))}
      <tr><td style="font-family:var(--font-mono);font-size:12px;color:var(--ink3)">5b</td><td style="font-size:13px">VAT on expenses (input VAT)</td><td></td><td style="text-align:right;font-family:var(--font-mono);font-size:13px;white-space:nowrap">− ${fmtEur(input)}</td></tr>
      <tr><td></td><td style="font-size:13px;font-weight:600">${net>=0?'VAT to pay':'VAT to get back'}</td><td></td><td style="text-align:right;font-family:var(--font-mono);font-size:14px;font-weight:600;color:${net>=0?'var(--red)':'var(--green)'}">${fmtEur(Math.abs(net))}</td></tr>
    </tbody></table>
    <p style="font-size:11px;color:var(--ink3);margin-top:10px">Calculated from each transaction's VAT rate (default ${DEFAULT_VAT_RATE}%). The Belastingdienst return uses whole euros, rounded down.</p>`;
}

// Labels around the app that say whether the business is in KOR (sidebar, dashboard, settings).
function renderVatStatusLabels(){
  const set=(sel,text)=>document.querySelectorAll(sel).forEach(el=>el.textContent=text);
  set('.vat-status-short',vatFrom?'VAT-registered':'KOR');
  set('.vat-status-tag',vatFrom?'Incl. VAT':'KOR · no VAT');
  set('.vat-status-long',vatFrom?`VAT-registered from ${vatFrom}`:'KOR-exempt · no BTW');
}

function renderSavingsSettings(){
  if(!$('settings-savings-amount')) return;
  $('settings-savings-date').value=savingsOpening?savingsOpening.date:(transactions.map(t=>t.date).sort()[0]||new Date().toISOString().slice(0,4)+'-01-01').slice(0,4)+'-01-01';
  $('settings-savings-amount').value=savingsOpening?savingsOpening.amount:'';
  const bal=savingsBalanceAt(new Date().toISOString().slice(0,10));
  $('settings-savings-now').textContent=bal!=null?`Current balance according to the portal: € ${fmtEur(bal)}`:'';
}

function renderBankSettings(){
  if(!$('settings-bank-amount')) return;
  $('settings-bank-date').value=bankOpening?bankOpening.date:(transactions.map(t=>t.date).sort()[0]||new Date().toISOString().slice(0,4)+'-01-01').slice(0,4)+'-01-01';
  $('settings-bank-amount').value=bankOpening?bankOpening.amount:'';
  const bal=bankBalanceAt(new Date().toISOString().slice(0,10));
  $('settings-bank-now').textContent=bal!=null?`Current balance according to the portal: € ${bal<0?'−':''}${fmtEur(bal)}`:'';
}

function saveBankOpening(){
  const date=$('settings-bank-date').value, raw=$('settings-bank-amount').value.trim();
  if(raw===''){ bankOpening=null; }
  else{
    const amount=parseAmountInput(raw.replace(/^−/,'-'));
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||isNaN(amount)){ alert('Please enter a date and a balance.'); return; }
    bankOpening={date,amount};
  }
  saveToDrive(); renderBankSettings();
}

function saveSavingsOpening(){
  const date=$('settings-savings-date').value, raw=$('settings-savings-amount').value.trim();
  if(raw===''){ savingsOpening=null; }
  else{
    const amount=parseAmountInput(raw);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||isNaN(amount)||amount<0){ alert('Please enter a date and a balance of 0 or more.'); return; }
    savingsOpening={date,amount};
  }
  saveToDrive(); renderSavingsSettings(); renderPL();
}

function renderVatSettings(){
  renderVatStatusLabels();
  renderCategoryVat();
  const box=$('settings-kor'), date=$('settings-vat-from');
  if(!box) return;
  box.checked=!vatFrom;
  date.value=vatFrom||'';
  $('settings-vat-from-row').style.display=vatFrom?'block':'none';
}

function setKor(inKor){
  // Leaving KOR starts VAT today; returning to KOR removes vatFrom. Either way, a locked quarter
  // on or after the affected date would change, so refuse until it's unlocked.
  const locked=lastLockedDay();
  const affected=inKor?vatFrom:new Date().toISOString().slice(0,10);
  if(locked&&affected&&affected<=locked){
    alert(`Quarters up to ${locked} are locked, and this change would alter their figures. Unlock them on the VAT page first.`);
    renderVatSettings(); return;
  }
  if(inKor){
    if(vatFrom&&!confirm('Mark the business as in KOR again? VAT will no longer be counted in the P&L and VAT return.')){renderVatSettings();return;}
    vatFrom=null;
  } else {
    vatFrom=new Date().toISOString().slice(0,10);
  }
  renderVatSettings(); saveToDrive(); renderPL();
}

// Settings → default VAT rate per category. Applies to every transaction in the category that
// has no hand-set rate; hand-set ones can optionally be reset to the new default.
function renderCategoryVat(){
  const wrap=$('settings-category-vat'); if(!wrap) return;
  const cats=[...new Set([...CATEGORIES_IN,...CATEGORIES_OUT])].filter(c=>!OUTSIDE_PL_CATEGORIES.includes(c));
  // Also list categories that only exist in imported data (e.g. unmapped Moneybird ones).
  transactions.forEach(t=>{if(!cats.includes(t.category)&&!OUTSIDE_PL_CATEGORIES.includes(t.category))cats.push(t.category);});
  wrap.innerHTML=cats.map(c=>{
    const r=categoryVatRate(c);
    const opts=[...new Set([...VAT_RATES,r])].sort((a,b)=>a-b);
    const n=transactions.filter(t=>t.category===c).length;
    return `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border)">
      <div style="flex:1;font-size:13px">${esc(c)} <span style="font-size:11px;color:var(--ink3);font-family:var(--font-mono)">${n}</span></div>
      <select class="cat-select" style="width:auto" data-cat="${esc(c)}" onchange="setCategoryVat(this)">${opts.map(o=>`<option value="${o}"${o===r?' selected':''}>${o}%</option>`).join('')}<option value="custom">Other…</option></select>
    </div>`;
  }).join('');
}

function setCategoryVat(sel){
  const cat=sel.dataset.cat;
  let rate=sel.value;
  if(rate==='custom'){
    const input=prompt(`Default VAT rate for "${cat}" (%):`, categoryVatRate(cat));
    const val=input===null?NaN:parseAmountInput(input);
    if(isNaN(val)||val<0||val>100){ if(input!==null) alert('Please enter a percentage between 0 and 100.'); renderCategoryVat(); return; }
    rate=val;
  }
  rate=Number(rate);
  if(rate===DEFAULT_VAT_RATE) delete categoryVat[cat]; else categoryVat[cat]=rate;
  const handSet=transactions.filter(t=>t.category===cat&&t.vatRate!=null&&t.vatRate!==rate&&!isLockedDate(t.date));
  if(handSet.length&&confirm(`${handSet.length} "${cat}" transaction${handSet.length>1?'s have':' has'} a VAT rate set by hand. Change ${handSet.length>1?'them':'it'} to ${rate}% too?`)){
    handSet.forEach(t=>delete t.vatRate);
  }
  saveToDrive(); renderCategoryVat(); renderTransactions(); renderPL();
}

function setVatFrom(val){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(val)) return;
  const locked=lastLockedDay();
  if(locked&&(val<=locked||(vatFrom&&vatFrom<=locked))){
    alert(`Quarters up to ${locked} are locked. The VAT-registered date must be after that, or unlock those quarters on the VAT page first.`);
    renderVatSettings(); return;
  }
  vatFrom=val; renderVatStatusLabels(); saveToDrive(); renderPL();
}

// ─── QUARTER LOCKING ─────────────────────────────────
// A locked quarter's transactions can't be recategorised, re-rated or added to by imports, so the
// figures behind a filed VAT return (or closed books) stay fixed. Locking also writes each
// transaction's current VAT rate onto it, so later changes to category defaults don't shift it.
const quarterEnd = q => { const y=q.slice(0,4), n=+q.slice(-1); return y+'-'+String(n*3).padStart(2,'0')+'-'+(n===1||n===4?'31':'30'); };
const isLockedDate = d => !!d && !!lockedQuarters[quarterOf(d)];
const alertLocked = d => alert(`${quarterOf(d).replace('-',' ')} is locked. Unlock it on the VAT page to make changes.`);
// Ended quarters with transactions that haven't been locked yet, oldest first.
function unlockedEndedQuarters(){
  const today=new Date().toISOString().slice(0,10);
  return [...new Set(transactions.filter(t=>/^\d{4}-\d{2}/.test(t.date||'')).map(t=>quarterOf(t.date)))]
    .filter(q=>quarterEnd(q)<today&&!lockedQuarters[q]).sort();
}

// Reminder badge on the VAT nav item.
function renderLockReminder(){
  const badge=$('nav-vat-badge'); if(!badge) return;
  const n=unlockedEndedQuarters().length;
  badge.style.display=n?'inline-block':'none'; badge.textContent=n;
  const dot=$('bnav-vat-dot'); if(dot) dot.style.display=n?'block':'none';
}

// Last day of the latest locked quarter, or '' if none.
const lastLockedDay = () => { const q=Object.keys(lockedQuarters).sort().pop(); return q?quarterEnd(q):''; };

async function lockQuarter(q,vatNet){
  if(!confirm(`Lock ${q.replace('-',' ')}?\n\nIts transactions can no longer be changed, and imports will skip new transactions dated in it. You can unlock it later if a correction is needed.`)) return;
  if(!await backupNow('before-lock-'+q) && !confirm('The backup failed. Lock anyway?')) return;
  transactions.forEach(t=>{ if(t.date&&quarterOf(t.date)===q&&!isOutsidePL(t)&&t.vatRate==null) t.vatRate=vatRateOf(t); });
  lockedQuarters[q]={lockedAt:new Date().toISOString(),vatNet};
  await saveToDrive();
  renderVAT(); renderTransactions();
}

async function unlockQuarter(q){
  if(!confirm(`Unlock ${q.replace('-',' ')}?\n\nOnly do this to correct a mistake. If its VAT return was already filed, a change may need a correction (suppletie) with the Belastingdienst.`)) return;
  delete lockedQuarters[q];
  await saveToDrive();
  renderVAT(); renderTransactions();
}

// ─── BACKUPS ─────────────────────────────────────────
// Copies of kitchen-data.json in a "backups" folder next to it, made with Drive's server-side
// copy. One automatic backup per day on sign-in; automatic ones older than BACKUP_KEEP_DAYS go to
// the Drive trash, except the first of each month. Labelled ones (manual, before-lock, …) are kept.
const BACKUP_FOLDER='backups', BACKUP_KEEP_DAYS=30, BACKUP_PREFIX='kitchen-data_';
let backupFolderId=null;

async function driveJSON(url,opts={}){
  const headers={Authorization:'Bearer '+accessToken};
  if(opts.body) headers['Content-Type']='application/json';
  const res=await fetch(url,{...opts,headers});
  if(!res.ok) throw new Error('Drive '+res.status);
  return res.json();
}

async function getBackupFolder(){
  if(backupFolderId) return backupFolderId;
  const parent=folderId?` and '${folderId}' in parents`:'';
  const q=encodeURIComponent(`name='${BACKUP_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parent}`);
  const res=await driveJSON(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`);
  if(res.files?.length) return backupFolderId=res.files[0].id;
  const meta={name:BACKUP_FOLDER,mimeType:'application/vnd.google-apps.folder'}; if(folderId) meta.parents=[folderId];
  return backupFolderId=(await driveJSON('https://www.googleapis.com/drive/v3/files',{method:'POST',body:JSON.stringify(meta)})).id;
}

async function listBackups(){
  const q=encodeURIComponent(`'${await getBackupFolder()}' in parents and trashed=false`);
  return (await driveJSON(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&orderBy=name desc&pageSize=1000`)).files||[];
}

// Copies kitchen-data.json into the backups folder. With a label (manual, before-lock, …) the
// current data is saved first so the backup matches what's on screen. Returns true on success.
async function backupNow(label){
  if(!accessToken) return false;
  try{
    if(label) await saveToDrive();
    if(!dataFileId) return false;
    const stamp=new Date().toISOString().slice(0,19).replace(/:/g,'-');
    const name=`${BACKUP_PREFIX}${stamp}${label?'_'+label:''}.json`;
    await driveJSON(`https://www.googleapis.com/drive/v3/files/${dataFileId}/copy?fields=id`,{method:'POST',body:JSON.stringify({name,parents:[await getBackupFolder()]})});
    return true;
  }catch(e){ console.error('Backup failed',e); return false; }
}

async function runDailyBackup(){
  if(!accessToken||!dataFileId) return;
  try{
    const today=new Date().toISOString().slice(0,10);
    const files=await listBackups();
    if(!files.some(f=>f.name.startsWith(BACKUP_PREFIX+today))) await backupNow();
    const isAuto=f=>/^kitchen-data_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/.test(f.name);
    const keep=new Set(), seenMonth=new Set();
    files.filter(isAuto).sort((a,b)=>a.name.localeCompare(b.name)).forEach(f=>{
      const month=f.name.slice(BACKUP_PREFIX.length,BACKUP_PREFIX.length+7);
      if(!seenMonth.has(month)){ seenMonth.add(month); keep.add(f.id); }
    });
    const cutoff=new Date(Date.now()-BACKUP_KEEP_DAYS*864e5).toISOString().slice(0,10);
    for(const f of files.filter(isAuto)){
      if(f.name.slice(BACKUP_PREFIX.length,BACKUP_PREFIX.length+10)<cutoff&&!keep.has(f.id))
        await driveJSON(`https://www.googleapis.com/drive/v3/files/${f.id}?fields=id`,{method:'PATCH',body:JSON.stringify({trashed:true})});
    }
  }catch(e){ console.error('Daily backup failed',e); }
}

// "kitchen-data_2026-10-05T08-16-05_before-lock-2026-Q2.json" → local date/time + "before lock 2026 Q2".
function backupLabel(name){
  const m=name.match(/^kitchen-data_(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:_(.+))?\.json$/);
  if(!m) return `<div style="font-size:12px;font-family:var(--font-mono)">${esc(name)}</div>`;
  const when=new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`).toLocaleString('en-GB',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
  const label=m[5]?m[5].replace(/^before-lock-(\d{4})-(Q\d)$/,'before locking $1 $2').replace(/-/g,' '):'daily';
  return `<div style="font-size:13px">${when}</div><div style="font-size:11px;color:var(--ink3);font-family:var(--font-mono)">${esc(label)}</div>`;
}

async function renderBackups(){
  const wrap=$('settings-backups'); if(!wrap) return;
  if(!accessToken){ wrap.innerHTML='<p style="font-size:13px;color:var(--ink3)">Sign in to see backups.</p>'; return; }
  wrap.innerHTML='<p style="font-size:13px;color:var(--ink3)">Loading backups…</p>';
  try{
    const files=(await listBackups()).slice(0,15);
    wrap.innerHTML=files.length?files.map(f=>`<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border);flex-wrap:wrap">
      <div style="flex:1;min-width:0">${backupLabel(f.name)}</div>
      <button class="btn btn-secondary btn-sm" onclick="downloadBackup('${f.id}','${esc(f.name)}')">Download</button>
      <button class="btn btn-secondary btn-sm" onclick="restoreBackup('${f.id}','${esc(f.name)}')">Restore</button>
    </div>`).join(''):'<p style="font-size:13px;color:var(--ink3)">No backups yet.</p>';
  }catch(e){ wrap.innerHTML='<p style="font-size:13px;color:var(--red)">Could not load backups.</p>'; }
}

async function backupNowFromSettings(btn){
  btn.disabled=true;
  const ok=await backupNow('manual');
  btn.disabled=false;
  alert(ok?'Backup saved to the "backups" folder in Drive.':'Backup failed — check your connection.');
  renderBackups();
}

async function fetchBackup(id){
  const res=await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`,{headers:{Authorization:'Bearer '+accessToken}});
  if(!res.ok) throw new Error('Drive '+res.status);
  return res.json();
}

async function downloadBackup(id,name){
  try{
    const blob=new Blob([JSON.stringify(await fetchBackup(id),null,2)],{type:'application/json'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; a.click(); URL.revokeObjectURL(a.href);
  }catch(e){ alert('Could not download this backup.'); }
}

async function restoreBackup(id,name){
  let data;
  try{ data=await fetchBackup(id); }catch(e){ alert('Could not read this backup.'); return; }
  if(!Array.isArray(data.transactions)){ alert('This file is not a valid backup.'); return; }
  if(!confirm(`Restore "${name}"?\n\nIt has ${data.transactions.length} transactions and ${(data.receipts||[]).length} receipts (you now have ${transactions.length} and ${receipts.length}).\n\nYour current data is backed up first, so this can be undone.`)) return;
  if(!await backupNow('before-restore')){ alert('Could not back up the current data, so nothing was restored.'); return; }
  transactions=data.transactions; receipts=data.receipts||[]; pendingTasks=data.pendingTasks||[];
  lastMatchJobRun=data.lastMatchJobRun||null; vatFrom=data.vatFrom||null; categoryVat=data.categoryVat||{}; lockedQuarters=data.lockedQuarters||{}; assets=data.assets||[]; savingsOpening=data.savingsOpening||null; hours=data.hours||[]; bankOpening=data.bankOpening||null;
  await saveToDrive();
  refreshAll(); renderBackups();
  alert('Backup restored.');
}

// ─── ASSETS & DEPRECIATION ───────────────────────────
// Equipment and other purchases that last longer than a year are booked as assets: the purchase
// transaction (if linked via t.assetId) leaves the P&L, and the cost is spread as straight-line
// depreciation per month from the purchase month over lifeYears, down to the residual value.
// Cost is what the books carry: incl. VAT while in KOR, excl. VAT once VAT-registered.
const ASSET_MIN_COST = 450;
const monthIndex = d => parseInt(d.slice(0,4),10)*12 + parseInt(d.slice(5,7),10) - 1;
const assetOfTxn = t => t.assetId ? assets.find(a=>a.id===t.assetId) : null;

function assetDepreciation(a, from, to){
  const start=monthIndex(a.purchaseDate), months=Math.round(a.lifeYears*12);
  let end=start+months-1;
  if(a.disposedDate) end=Math.min(end,monthIndex(a.disposedDate));
  const n=Math.max(0,Math.min(to,end)-Math.max(from,start)+1);
  return n*(a.cost-(a.residual||0))/months;
}
const depreciationBetween = (from,to) => assets.reduce((s,a)=>s+assetDepreciation(a,from,to),0);
// Book value at the end of month `at` (0 once disposed).
function bookValue(a, at){
  if(at<monthIndex(a.purchaseDate)) return null;
  if(a.disposedDate&&monthIndex(a.disposedDate)<=at) return 0;
  return a.cost-assetDepreciation(a,monthIndex(a.purchaseDate),at);
}

// Default cost for an asset bought via this transaction.
const assetCostFromTxn = t => +(isVatLiable(t) ? t.amount - vatOf(t) : t.amount).toFixed(2);

let editingAssetId = null;

function openAssetForm(id){
  editingAssetId=id||null;
  const a=id?assets.find(a=>a.id===id):null;
  const linkable=transactions.filter(t=>t.type==='out'&&!isOutsidePL(t)&&(!t.assetId||(a&&t.id===a.txnId))&&t.amount>=50)
    .sort((x,y)=>y.amount-x.amount).slice(0,300);
  $('asset-txn').innerHTML='<option value="">— Not linked (paid privately or before using the app) —</option>'+linkable.map(t=>`<option value="${t.id}"${a&&a.txnId===t.id?' selected':''}>${t.date} · € ${fmtEur(t.amount)} · ${esc(t.desc.slice(0,40))}</option>`).join('');
  $('asset-name').value=a?a.name:'';
  $('asset-date').value=a?a.purchaseDate:'';
  $('asset-cost').value=a?a.cost:'';
  $('asset-life').value=a?a.lifeYears:5;
  $('asset-residual').value=a?(a.residual||0):0;
  $('asset-disposed').value=a?(a.disposedDate||''):'';
  $('asset-form-title').textContent=a?'Edit asset':'Add asset';
  $('asset-delete').style.display=a?'inline-flex':'none';
  $('asset-form').style.display='block';
  $('asset-form').scrollIntoView({behavior:'smooth',block:'center'});
}

function closeAssetForm(){ $('asset-form').style.display='none'; editingAssetId=null; }

// Picking a transaction prefills date, cost and a name.
function assetTxnChanged(id){
  const t=transactions.find(t=>t.id===id); if(!t) return;
  $('asset-date').value=t.date;
  $('asset-cost').value=assetCostFromTxn(t);
  if(!$('asset-name').value) $('asset-name').value=t.desc.slice(0,40);
}

function saveAsset(){
  const name=$('asset-name').value.trim(), date=$('asset-date').value, cost=parseAmountInput($('asset-cost').value);
  const life=parseAmountInput($('asset-life').value), residual=parseAmountInput($('asset-residual').value||'0');
  const disposed=$('asset-disposed').value||null, txnId=$('asset-txn').value||null;
  if(!name||!/^\d{4}-\d{2}-\d{2}$/.test(date)){ alert('Please enter a name and purchase date.'); return; }
  if(isNaN(cost)||cost<=0){ alert('Please enter the cost.'); return; }
  if(isNaN(life)||life<1||life>50){ alert('Useful life must be between 1 and 50 years.'); return; }
  if(isNaN(residual)||residual<0||residual>=cost){ alert('Residual value must be 0 or more, and less than the cost.'); return; }
  if(disposed&&disposed<date){ alert('The disposal date can\'t be before the purchase date.'); return; }
  const old=editingAssetId?assets.find(a=>a.id===editingAssetId):null;
  // (Un)linking a transaction changes how it counts in the P&L, so it isn't allowed in a locked quarter.
  for(const id of [old&&old.txnId!==txnId?old.txnId:null, txnId&&(!old||old.txnId!==txnId)?txnId:null]){
    const t=id&&transactions.find(t=>t.id===id);
    if(t&&isLockedDate(t.date)){ alertLocked(t.date); return; }
  }
  if(life<5&&!confirm('Dutch tax rules usually allow at most 20% depreciation per year, which is a useful life of 5 years or more. Save with '+life+' years anyway?')) return;
  if(cost<ASSET_MIN_COST&&!confirm(`Purchases under € ${ASSET_MIN_COST} can usually be counted as a cost straight away instead. Save as an asset anyway?`)) return;
  const a=old||{id:'as_'+Math.random().toString(36).slice(2)};
  if(old&&old.txnId&&old.txnId!==txnId){ const t=transactions.find(t=>t.id===old.txnId); if(t) delete t.assetId; }
  Object.assign(a,{name,purchaseDate:date,cost,lifeYears:life,residual,disposedDate:disposed,txnId});
  if(txnId){ const t=transactions.find(t=>t.id===txnId); if(t) t.assetId=a.id; }
  if(!old) assets.push(a);
  closeAssetForm(); saveToDrive(); renderYearEnd(); renderPL(); renderTransactions();
}

function deleteAsset(){
  const a=assets.find(a=>a.id===editingAssetId); if(!a) return;
  const t=a.txnId&&transactions.find(t=>t.id===a.txnId);
  if(t&&isLockedDate(t.date)){ alertLocked(t.date); return; }
  if(!confirm(`Delete "${a.name}" from the asset list?${t?' Its purchase will count as a normal cost again.':''}`)) return;
  if(t) delete t.assetId;
  assets=assets.filter(x=>x.id!==a.id);
  closeAssetForm(); saveToDrive(); renderYearEnd(); renderPL(); renderTransactions();
}

function markTxnAsAsset(txnId){
  openAssetForm(null);
  $('asset-txn').value=txnId; assetTxnChanged(txnId);
}

// ─── BALANCE SHEET ───────────────────────────────────
// Built from what the portal knows: equipment at book value, the current account (opening balance
// from Settings plus every transaction since), the savings account, and — once VAT-registered —
// net VAT since registration. Equity is the difference; it's checked against the start equity plus
// profit and private movements. That check catches inconsistent bookings (e.g. an asset cost that
// includes VAT that is also reclaimed), not missing transactions — those change the bank balance and
// profit alike, so the current account has to be compared with the bank statement.
const dayBefore = d => new Date(new Date(d+'T00:00:00Z').getTime()-864e5).toISOString().slice(0,10);

// Current account balance at the end of `date`; null before the Settings opening date.
function bankBalanceAt(date){
  if(!bankOpening||date<bankOpening.date) return null;
  return transactions.filter(t=>t.date>=bankOpening.date&&t.date<=date)
    .reduce((s,t)=>s+(t.type==='in'?t.amount:-t.amount),bankOpening.amount);
}

// VAT still owed at the end of `date`: net VAT (sales VAT minus input VAT) on transactions up to
// and including `date`, less VAT paid to the Belastingdienst (plus refunds received).
const vatOwedAt = date => transactions.filter(t=>t.date<=date).reduce((s,t)=>{
  if(isVatPayment(t)) return s+(t.type==='in'?t.amount:-t.amount);
  if(isOutsidePL(t)||!isVatLiable(t)) return s;
  return s+(t.type==='in'?vatOf(t):-vatOf(t));
},0);

// Current account balance at the start of `date`, before that day's transactions.
function bankBalanceBefore(date){
  if(!bankOpening||date<bankOpening.date) return null;
  return date===bankOpening.date?bankOpening.amount:bankBalanceAt(dayBefore(date));
}

// Position at the end of `date`, or at its start with {start:true}. null if a balance is unknown.
function balanceAt(date,{start=false}={}){
  const upTo=start?dayBefore(date):date;
  const bank=start?bankBalanceBefore(date):bankBalanceAt(date);
  const anySavings=transactions.some(t=>isSavings(t)&&t.date<=upTo);
  const savings=savingsOpening?(start?savingsBalanceBefore(date):savingsBalanceAt(date)):(anySavings?null:0);
  date=upTo;
  if(bank==null||savings==null) return null;
  const fixed=assets.reduce((s,a)=>s+(bookValue(a,monthIndex(date))||0),0);
  const vat=vatOwedAt(date);
  const totalAssets=fixed+bank+savings+(vat<0?-vat:0);
  const liabilities=vat>0?vat:0;
  return {fixed,bank,savings,vat,totalAssets,liabilities,equity:totalAssets-liabilities};
}

// Profit from `from` to `to` (inclusive dates), matching the P&L rules.
function profitBetween(from,to){
  const inRange=transactions.filter(t=>t.date>=from&&t.date<=to&&!isOutsidePL(t)&&!assetOfTxn(t));
  const rev=inRange.filter(t=>t.type==='in').reduce((s,t)=>s+plAmount(t),0);
  const cost=inRange.filter(t=>t.type==='out').reduce((s,t)=>s+plAmount(t),0);
  return rev-cost-depreciationBetween(monthIndex(from),monthIndex(to));
}

function balanceSheetHTML(y){
  const today=new Date().toISOString().slice(0,10);
  const start=y+'-01-01', end=(y+'-12-31')<today?y+'-12-31':today;
  if(!bankOpening) return '<p style="font-size:13px;color:var(--ink3)">Enter your current account balance in Settings → Bank balances to see the balance sheet.</p>';
  if(end<bankOpening.date) return `<p style="font-size:13px;color:var(--ink3)">The current account balance in Settings starts on ${bankOpening.date}, after this year.</p>`;
  const from=start<bankOpening.date?bankOpening.date:start;
  const a=balanceAt(from,{start:true}), b=balanceAt(end);
  if(!b) return '<p style="font-size:13px;color:var(--ink3)">There are savings transfers but no savings balance yet. Enter it in Settings → Bank balances.</p>';
  const money=v=>v==null?'—':(v<0?'−':'')+'€ '+fmtEur(v);
  const r=(label,va,vb,o={})=>`<tr${o.bold?' style="font-weight:600"':''}><td style="font-size:13px;padding:6px 0">${label}</td><td style="text-align:right;font-family:var(--font-mono);font-size:12px">${money(va)}</td><td style="text-align:right;font-family:var(--font-mono);font-size:12px">${money(vb)}</td></tr>`;
  const g=k=>a?a[k]:null;
  const head=(t)=>`<tr><td colspan="3" style="font-size:10px;font-family:var(--font-mono);color:var(--ink3);text-transform:uppercase;letter-spacing:0.08em;padding-top:10px">${t}</td></tr>`;
  // Equity movement over the period
  const inP=transactions.filter(t=>t.date>=from&&t.date<=end);
  const lastTxnDate=transactions.map(t=>t.date).filter(x=>x<=end).sort().pop()||end;
  const withdrawals=inP.filter(t=>isPrivate(t)&&t.type==='out').reduce((s,t)=>s+t.amount,0);
  const deposits=inP.filter(t=>isPrivate(t)&&t.type==='in').reduce((s,t)=>s+t.amount,0);
  const broughtIn=assets.filter(x=>!x.txnId&&x.purchaseDate>=from&&x.purchaseDate<=end).reduce((s,x)=>s+x.cost,0);
  const profit=profitBetween(from,end);
  const expected=a?a.equity+profit+deposits-withdrawals+broughtIn:null;
  const diff=expected!=null?b.equity-expected:null;
  const line=(label,v,o={})=>`<div style="display:flex;justify-content:space-between;padding:5px 0;font-size:13px${o.bold?';font-weight:600':''}${o.color?';color:'+o.color:''}"><span>${label}</span><span style="font-family:var(--font-mono)">${money(v)}</span></div>`;
  return `<div style="overflow-x:auto"><table style="width:100%"><thead><tr><th></th><th style="text-align:right">Start ${from}</th><th style="text-align:right">${end}</th></tr></thead><tbody>
      ${head('Assets')}
      ${r('Equipment (book value)',g('fixed'),b.fixed)}
      ${r('Current account',g('bank'),b.bank)}
      ${r('Savings account',g('savings'),b.savings)}
      ${b.vat<0||(a&&a.vat<0)?r('VAT to get back',a&&a.vat<0?-a.vat:0,b.vat<0?-b.vat:0):''}
      ${r('Total assets',g('totalAssets'),b.totalAssets,{bold:true})}
      ${head('Liabilities')}
      ${r('VAT to pay',a&&a.vat>0?a.vat:0,b.vat>0?b.vat:0)}
      ${head('Equity')}
      ${r('Equity (assets − liabilities)',g('equity'),b.equity,{bold:true})}
    </tbody></table></div>
    ${a?`<div style="margin-top:12px;border-top:1px solid var(--border);padding-top:8px">
      <div style="font-size:10px;font-family:var(--font-mono);color:var(--ink3);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px">Equity check</div>
      ${line('Equity at '+from,a.equity)}
      ${line('+ Profit',profit)}
      ${line('+ Private deposits',deposits)}
      ${line('− Private withdrawals',-withdrawals)}
      ${broughtIn?line('+ Equipment paid privately',broughtIn):''}
      ${line('= Expected equity at '+end,expected,{bold:true})}
      ${Math.abs(diff)<0.01?`<p style="font-size:12px;color:var(--green);margin-top:4px">✓ Matches the balance sheet</p>`
        :`<p style="font-size:12px;color:#92400E;background:#FFFBEB;border-radius:var(--radius);padding:8px 10px;margin-top:6px">Difference of ${money(diff)}. Usually an asset whose cost doesn't match how it was paid — e.g. a cost incl. VAT for something bought after VAT registration (use the price excl. VAT).</p>`}
    </div>`:''}
    <p style="font-size:12px;color:var(--ink2);margin-top:10px;line-height:1.6">Check the current account (${money(bankBalanceAt(lastTxnDate))} on ${lastTxnDate}, the last imported transaction) against your ING statement for that day. A different amount means transactions are missing or imported twice.</p>
    ${vatFrom?'<p style="font-size:11px;color:var(--ink3);margin-top:8px">VAT is the net VAT since registration, less VAT payments (category "VAT payment").</p>':''}`;
}

// ─── YEAR-END SUMMARY ────────────────────────────────
let yearEndYear = null;

function renderYearEnd(){
  const years=[...new Set([...transactions.map(t=>(t.date||'').slice(0,4)),...assets.map(a=>a.purchaseDate.slice(0,4))].filter(y=>/^\d{4}$/.test(y)))].sort();
  if(!yearEndYear||!years.includes(yearEndYear)) yearEndYear=years[years.length-1]||String(new Date().getFullYear());
  $('ye-years').innerHTML=years.map(y=>`<button class="month-tab${y===yearEndYear?' active':''}" onclick="yearEndYear='${y}';renderYearEnd()">${y}</button>`).join('');
  const y=yearEndYear, from=monthIndex(y+'-01-01'), to=monthIndex(y+'-12-01');
  const inYear=transactions.filter(t=>(t.date||'').startsWith(y));
  const biz=inYear.filter(t=>!isOutsidePL(t)&&!assetOfTxn(t));
  const sum=(list,f)=>list.reduce((s,t)=>s+f(t),0);
  const revenue=sum(biz.filter(t=>t.type==='in'),plAmount);
  const costsByCat={}; biz.filter(t=>t.type==='out').forEach(t=>costsByCat[t.category]=(costsByCat[t.category]||0)+plAmount(t));
  const dep=depreciationBetween(from,to);
  const costs=Object.values(costsByCat).reduce((s,v)=>s+v,0)+dep;
  const result=revenue-costs;
  const withdrawals=sum(inYear.filter(t=>isPrivate(t)&&t.type==='out'),t=>t.amount);
  const deposits=sum(inYear.filter(t=>isPrivate(t)&&t.type==='in'),t=>t.amount);
  const bought=assets.filter(a=>a.purchaseDate.startsWith(y));
  const noReceipt=inYear.filter(t=>t.type==='out'&&!isOutsidePL(t)&&!t.receiptId);
  const quarters=[1,2,3,4].map(n=>y+'-Q'+n);
  const row=(label,val,opts={})=>`<div style="display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px${opts.bold?';font-weight:600':''}"><span>${label}</span><span style="font-family:var(--font-mono);white-space:nowrap${opts.color?';color:'+opts.color:''}">${opts.raw||'€ '+fmtEur(val)}</span></div>`;

  $('ye-summary').innerHTML=`
    <div class="card"><div class="card-label">Profit & loss ${y}${vatFrom?'':' · incl. VAT (KOR)'}</div>
      ${row('Revenue',revenue,{color:'var(--green)'})}
      ${Object.entries(costsByCat).sort((a,b)=>b[1]-a[1]).map(([c,v])=>row(esc(c),v)).join('')}
      ${row('Depreciation',dep)}
      ${row('Total costs',costs,{bold:true,color:'var(--red)'})}
      ${row(result>=0?'Profit':'Loss',Math.abs(result),{bold:true,color:result>=0?'var(--green)':'var(--red)'})}
    </div>
    <div class="card"><div class="card-label">Private (not in P&L)</div>
      ${row('Private withdrawals',withdrawals)}
      ${row('Private deposits',deposits)}
      ${row('Net withdrawn',withdrawals-deposits,{bold:true})}
    </div>
    <div class="card"><div class="card-label">Savings account (not in P&L)</div>
      ${row('Balance on 1 Jan',0,{raw:savingsBalanceBefore(y+'-01-01')!=null?'€ '+fmtEur(savingsBalanceBefore(y+'-01-01')):'—'})}
      ${row('Moved to savings',savingsMoves(inYear).toSavings)}
      ${row('Moved back from savings',savingsMoves(inYear).fromSavings)}
      ${row('Balance on 31 Dec',0,{bold:true,raw:savingsBalanceAt(y+'-12-31')!=null?'€ '+fmtEur(savingsBalanceAt(y+'-12-31')):'— (set the balance in Settings)'})}
    </div>
    <div class="card"><div class="card-label">Balance sheet</div>${balanceSheetHTML(y)}</div>
    <div class="card"><div class="card-label">Checks for your accountant</div>
      ${row('Expenses without a receipt',0,{raw:`${noReceipt.length} · € ${fmtEur(sum(noReceipt,t=>t.amount))}`,color:noReceipt.length?'#D97706':'var(--green)'})}
      ${row('Quarters locked',0,{raw:quarters.map(q=>`${q.slice(5)} ${lockedQuarters[q]?'🔒':'—'}`).join('  ')})}
      ${row('VAT status',0,{raw:vatFrom?`VAT-registered from ${vatFrom}`:'KOR'})}
      ${row('Investments this year',sum(bought,a=>a.cost),{raw:`${bought.length} · € ${fmtEur(sum(bought,a=>a.cost))}`})}
    </div>`;

  // Asset register with this year's figures
  const assetRows=assets.filter(a=>a.purchaseDate.slice(0,4)<=y).sort((a,b)=>a.purchaseDate.localeCompare(b.purchaseDate));
  const startVal=a=>{const v=bookValue(a,from-1);return v==null?'—':fmtEur(v);};
  $('ye-assets').innerHTML=assetRows.length?`<div style="overflow-x:auto"><table style="width:100%"><thead><tr><th>Asset</th><th class="hide-sm">Bought</th><th style="text-align:right">Cost</th><th class="hide-sm" style="text-align:right">Value 1 Jan</th><th style="text-align:right">Depr.<span class="hide-sm"> ${y}</span></th><th style="text-align:right"><span class="hide-sm">Value </span>31 Dec</th><th class="no-print hide-sm"></th></tr></thead><tbody>
    ${assetRows.map(a=>`<tr><td style="font-size:13px"><a href="#" style="color:inherit" onclick="openAssetForm('${a.id}');return false">${esc(a.name)}</a>${a.disposedDate?`<div style="font-size:11px;color:var(--ink3)">disposed ${a.disposedDate}</div>`:''}<div style="font-size:11px;color:var(--ink3)"><span class="show-sm">${a.purchaseDate} · </span>${a.lifeYears} yrs${a.residual?' · residual € '+fmtEur(a.residual):''}${a.txnId?'':' · not linked'}</div></td>
      <td class="hide-sm" style="font-family:var(--font-mono);font-size:12px;white-space:nowrap">${a.purchaseDate}</td>
      <td style="text-align:right;font-family:var(--font-mono);font-size:12px">${fmtEur(a.cost)}</td>
      <td class="hide-sm" style="text-align:right;font-family:var(--font-mono);font-size:12px">${startVal(a)}</td>
      <td style="text-align:right;font-family:var(--font-mono);font-size:12px">${fmtEur(assetDepreciation(a,from,to))}</td>
      <td style="text-align:right;font-family:var(--font-mono);font-size:12px">${fmtEur(bookValue(a,to)||0)}</td>
      <td class="no-print hide-sm"><button class="btn btn-secondary btn-sm" onclick="openAssetForm('${a.id}')">Edit</button></td></tr>`).join('')}
    </tbody></table></div>`:'<p style="font-size:13px;color:var(--ink3);padding:8px 0">No assets yet.</p>';

  // Suggest large expenses that may be assets
  const candidates=inYear.filter(t=>t.type==='out'&&!isOutsidePL(t)&&!t.assetId&&t.amount>=ASSET_MIN_COST).sort((a,b)=>b.amount-a.amount);
  $('ye-candidates').innerHTML=candidates.length?`<div style="font-size:12px;background:#FFFBEB;color:#92400E;border-radius:var(--radius);padding:10px 12px;margin-top:12px">
      <div style="margin-bottom:6px">Expenses of € ${ASSET_MIN_COST} or more in ${y}. If one bought equipment or something else that lasts more than a year, mark it as an asset:</div>
      ${candidates.map(t=>`<div style="display:flex;align-items:center;gap:8px;padding:4px 0;flex-wrap:wrap"><span style="font-family:var(--font-mono)">${t.date}</span><span style="font-family:var(--font-mono)">€ ${fmtEur(t.amount)}</span><span style="flex:1;min-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.desc)} · ${esc(t.category)}</span><button class="btn btn-secondary btn-sm no-print" onclick="markTxnAsAsset('${t.id}')">Mark as asset</button></div>`).join('')}
    </div>`:'';
}

function exportYearEndCSV(){
  const y=yearEndYear, from=monthIndex(y+'-01-01'), to=monthIndex(y+'-12-01');
  const rows=[['Section','Item','Date','Amount']];
  [...$('ye-summary').querySelectorAll('.card')].forEach(card=>{
    const section=card.querySelector('.card-label').textContent;
    card.querySelectorAll('.card-label ~ div').forEach(r=>{const [a,b]=r.children;rows.push([section,a.textContent,'',b.textContent.replace(/€\s?/g,'').replace(/(\d),(?=\d{3}\b)/g,'$1')]);});
  });
  assets.filter(a=>a.purchaseDate.slice(0,4)<=y).forEach(a=>rows.push(['Assets',`${a.name} (cost ${a.cost.toFixed(2)}, ${a.lifeYears} yrs, depreciation ${assetDepreciation(a,from,to).toFixed(2)})`,a.purchaseDate,(bookValue(a,to)||0).toFixed(2)]));
  const csv=rows.map(r=>r.map(c=>'"'+String(c).replace(/"/g,'""')+'"').join(',')).join('\n');
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})); a.download=`year-end-${y}.csv`; a.click(); URL.revokeObjectURL(a.href);
}

// ─── HOURS LOG ───────────────────────────────────────
// Working hours per person, as proof for the hours criterion (urencriterium): at least
// HOURS_TARGET hours a year on the business for the self-employed deduction. Each entry is either
// start/end time minus a break, or a number of hours entered directly.
const HOURS_TARGET = 1225;
let hoursYear = null, editingHoursId = null;

const currentPerson = () => localStorage.getItem('kb_user_name') || '';
const hoursPeople = () => [...new Set([...hours.map(h=>h.person).filter(Boolean), currentPerson()].filter(Boolean))];
const fmtHours = h => (Math.round(h*100)/100).toLocaleString('en-GB',{maximumFractionDigits:2});

// Hours between HH:MM times minus a break; an end before the start means past midnight.
function hoursFromTimes(start,end,breakMin){
  const toMin=t=>{const [h,m]=t.split(':').map(Number);return h*60+m;};
  let mins=toMin(end)-toMin(start); if(mins<=0) mins+=24*60;
  return Math.max(0,(mins-(breakMin||0))/60);
}

// Hours logged per person in a year.
function hoursByPerson(year){
  const by={}; hours.filter(h=>h.date.startsWith(year)).forEach(h=>{const p=h.person||'—';by[p]=(by[p]||0)+h.hours;}); return by;
}

// Progress bar + what's needed per week for the rest of the year.
function hoursProgressHTML(year, person, total){
  const pct=Math.min(total/HOURS_TARGET*100,100);
  const today=new Date(), end=new Date(+year,11,31);
  const weeksLeft=+year===today.getFullYear()?Math.max((end-today)/(7*864e5),0):0;
  const left=Math.max(HOURS_TARGET-total,0);
  const note=total>=HOURS_TARGET?'✓ Hours criterion met'
    :weeksLeft>0&&left/weeksLeft>60?`${fmtHours(left)} hours to go — more than 60 a week until 31 Dec. Add the hours you've already worked this year but not logged yet (your order history and calendar help).`
    :weeksLeft>0?`${fmtHours(left)} hours to go · about ${fmtHours(left/weeksLeft)} a week until 31 Dec`
    :`${fmtHours(left)} hours short`;
  return `<div style="margin-bottom:12px"><div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px"><span>${esc(person)}</span><span style="font-family:var(--font-mono)">${fmtHours(total)} / ${HOURS_TARGET.toLocaleString('en-GB')} h</span></div>
    <div style="height:8px;background:var(--paper2);border-radius:4px;overflow:hidden"><div style="height:100%;width:${pct}%;background:${total>=HOURS_TARGET?'var(--green)':'var(--fire)'}"></div></div>
    <div style="font-size:12px;color:${total>=HOURS_TARGET?'var(--green)':'var(--ink3)'};margin-top:6px">${note}</div></div>`;
}

function renderHoursDashboard(){
  const el=$('dash-hours'); if(!el) return;
  const y=String(new Date().getFullYear()), by=hoursByPerson(y);
  const people=Object.keys(by).length?Object.keys(by):[currentPerson()||'You'];
  el.innerHTML=people.map(p=>hoursProgressHTML(y,p,by[p]||0)).join('');
}

function renderHours(){
  const years=[...new Set([...hours.map(h=>h.date.slice(0,4)),String(new Date().getFullYear())])].sort();
  if(!hoursYear||!years.includes(hoursYear)) hoursYear=years[years.length-1];
  $('hours-years').innerHTML=years.map(y=>`<button class="month-tab${y===hoursYear?' active':''}" onclick="hoursYear='${y}';renderHours()">${y}</button>`).join('');
  const by=hoursByPerson(hoursYear);
  const people=Object.keys(by).length?Object.keys(by):[currentPerson()||'You'];
  $('hours-progress').innerHTML=people.map(p=>hoursProgressHTML(hoursYear,p,by[p]||0)).join('');
  $('hours-people').innerHTML=hoursPeople().map(p=>`<option value="${esc(p)}">`).join('');
  if(!editingHoursId&&!$('hours-date').value) resetHoursForm();

  const list=hours.filter(h=>h.date.startsWith(hoursYear)).sort((a,b)=>b.date.localeCompare(a.date)||(b.start||'').localeCompare(a.start||''));
  const byMonth={}; list.forEach(h=>(byMonth[h.date.slice(0,7)]=byMonth[h.date.slice(0,7)]||[]).push(h));
  $('hours-list').innerHTML=list.length?Object.keys(byMonth).sort().reverse().map(m=>`
    <div style="display:flex;justify-content:space-between;padding:10px 0 4px;font-size:10px;font-family:var(--font-mono);color:var(--ink3);text-transform:uppercase;letter-spacing:0.08em;border-top:1px solid var(--border);margin-top:6px"><span>${fmtMonth(m)}</span><span>${fmtHours(byMonth[m].reduce((s,h)=>s+h.hours,0))} h</span></div>
    ${byMonth[m].map(h=>`<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);font-size:13px;flex-wrap:wrap">
      <span style="font-family:var(--font-mono);font-size:12px;white-space:nowrap">${h.date}</span>
      <span style="font-family:var(--font-mono);font-size:12px;color:var(--ink3);white-space:nowrap">${h.start&&h.end?`${h.start}–${h.end}${h.breakMin?` −${h.breakMin}m`:''}`:''}</span>
      <span style="flex:1;min-width:120px">${esc(h.description||'')}${h.person?` <span style="font-size:11px;color:var(--ink3)">· ${esc(h.person)}</span>`:''}</span>
      <span style="font-family:var(--font-mono);font-weight:600">${fmtHours(h.hours)} h</span>
      <button class="btn btn-secondary btn-sm" onclick="editHours('${h.id}')">Edit</button>
    </div>`).join('')}`).join(''):'<p style="font-size:13px;color:var(--ink3);padding:8px 0">No hours logged for this year yet.</p>';
}

function resetHoursForm(){
  editingHoursId=null;
  $('hours-date').value=new Date().toISOString().slice(0,10);
  $('hours-start').value=''; $('hours-end').value=''; $('hours-break').value='';
  $('hours-direct').value=''; $('hours-desc').value=''; $('hours-person').value=currentPerson();
  $('hours-form-title').textContent='Log hours'; $('hours-delete').style.display='none';
  updateHoursPreview();
}

function updateHoursPreview(){
  const s=$('hours-start').value, e=$('hours-end').value, b=parseInt($('hours-break').value||'0',10)||0;
  $('hours-preview').textContent=s&&e?`= ${fmtHours(hoursFromTimes(s,e,b))} hours`:'';
}

function editHours(id){
  const h=hours.find(h=>h.id===id); if(!h) return;
  editingHoursId=id;
  $('hours-date').value=h.date; $('hours-start').value=h.start||''; $('hours-end').value=h.end||'';
  $('hours-break').value=h.breakMin||''; $('hours-direct').value=h.start?'':h.hours;
  $('hours-desc').value=h.description||''; $('hours-person').value=h.person||'';
  $('hours-form-title').textContent='Edit hours'; $('hours-delete').style.display='inline-flex';
  updateHoursPreview();
  $('hours-form').scrollIntoView({behavior:'smooth',block:'center'});
}

function saveHours(){
  const date=$('hours-date').value, start=$('hours-start').value, end=$('hours-end').value;
  const breakMin=parseInt($('hours-break').value||'0',10)||0, direct=$('hours-direct').value.trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)){ alert('Please pick a date.'); return; }
  let h;
  if(start&&end){ h=hoursFromTimes(start,end,breakMin); }
  else if(direct){ h=parseAmountInput(direct); }
  else { alert('Enter a start and end time, or the number of hours.'); return; }
  if(isNaN(h)||h<=0||h>24){ alert('Hours must be more than 0 and at most 24.'); return; }
  const entry={date,start:start&&end?start:'',end:start&&end?end:'',breakMin:start&&end?breakMin:0,hours:Math.round(h*100)/100,
    description:$('hours-desc').value.trim(),person:$('hours-person').value.trim()};
  const sameDay=hours.filter(x=>x.date===date&&x.id!==editingHoursId&&(x.person||'')===entry.person).reduce((s,x)=>s+x.hours,0);
  if(sameDay+entry.hours>24){ alert(`That would make ${fmtHours(sameDay+entry.hours)} hours on ${date} for ${entry.person||'this person'}.`); return; }
  if(editingHoursId) Object.assign(hours.find(x=>x.id===editingHoursId),entry);
  else hours.push({id:'hr_'+Math.random().toString(36).slice(2),...entry});
  hoursYear=date.slice(0,4);
  saveToDrive(); resetHoursForm(); renderHours(); renderHoursDashboard();
}

function deleteHours(){
  if(!editingHoursId||!confirm('Delete this hours entry?')) return;
  hours=hours.filter(h=>h.id!==editingHoursId);
  saveToDrive(); resetHoursForm(); renderHours(); renderHoursDashboard();
}

function exportHoursCSV(){
  const rows=[['Date','Start','End','Break (min)','Hours','Description','Person']];
  hours.filter(h=>h.date.startsWith(hoursYear)).sort((a,b)=>a.date.localeCompare(b.date)).forEach(h=>rows.push([h.date,h.start||'',h.end||'',h.breakMin||0,h.hours,h.description||'',h.person||'']));
  const csv=rows.map(r=>r.map(c=>'"'+String(c).replace(/"/g,'""')+'"').join(',')).join('\n');
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})); a.download=`hours-${hoursYear}.csv`; a.click(); URL.revokeObjectURL(a.href);
}

// Import a CSV with the same columns as the export (Date and Hours required). Rows identical to
// an existing entry (date, start, hours, person) are skipped, so importing twice is harmless.
function importHoursCSV(input){
  const file=input.files[0]; if(!file) return;
  Papa.parse(file,{header:true,skipEmptyLines:true,complete:res=>{
    let added=0, skipped=0, bad=0;
    for(const r of res.data){
      const date=(r['Date']||'').trim(), h=parseAmountInput(r['Hours']);
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||isNaN(h)||h<=0||h>24){ bad++; continue; }
      const entry={date,start:(r['Start']||'').trim(),end:(r['End']||'').trim(),breakMin:parseInt(r['Break (min)']||'0',10)||0,
        hours:Math.round(h*100)/100,description:(r['Description']||'').trim(),person:(r['Person']||'').trim()||currentPerson()};
      if(hours.some(x=>x.date===entry.date&&(x.start||'')===entry.start&&x.hours===entry.hours&&(x.person||'')===entry.person)){ skipped++; continue; }
      hours.push({id:'hr_'+Math.random().toString(36).slice(2),...entry}); added++;
    }
    saveToDrive(); renderHours(); renderHoursDashboard();
    alert(`${added} hours entries imported`+(skipped?` · ${skipped} already there`:'')+(bad?` · ${bad} rows skipped (need a date and hours)`:''));
    input.value='';
  }});
}

// ─── RECEIPTS ────────────────────────────────────────
function renderReceipts() {
  // ── Pending upload queue ──
  const list=$('receipt-list');
  list.innerHTML=pendingReceipts.map(r=>{
    const tag={pending:'Ready',uploading:'Uploading…',done:'Done',error:'Error'}[r.status];
    const tc={pending:'tag-ready',uploading:'tag-uploading',done:'tag-done',error:'tag-error'}[r.status];
    const amountInput=r.status==='pending'?`<input type="text" inputmode="decimal" class="filter-input" style="width:110px" placeholder="Amount € *" value="${r.amount||''}" oninput="updatePendingAmount('${r.id}',this.value)"/>`:'';
    return`<div class="receipt-item"><div class="receipt-icon">${r.file.name.match(/\.pdf$/i)?'📄':'🖼️'}</div><div class="receipt-info"><div class="receipt-name">${esc(r.file.name)}</div><div class="receipt-meta">${fmtSize(r.file.size)}</div>${r.status==='uploading'?`<div class="progress-bar"><div class="progress-fill" style="width:${r.progress}%"></div></div>`:''}</div>${amountInput}<span class="receipt-tag ${tc}">${tag}</span>${r.status!=='uploading'?`<button class="btn-x" onclick="removePending('${r.id}')">×</button>`:''}</div>`;
  }).join('');
  updateUploadButtonsState();

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
            <td style="padding:9px 12px;border-bottom:1px solid var(--border);font-size:12px;font-family:var(--font-mono);white-space:nowrap;color:var(--ink2)">${r.amount!=null?'€ '+fmtEur(r.amount):'—'}<button class="amount-edit-btn" title="Edit amount" onclick="editReceiptAmount('${r.id}')">✎</button></td>
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
            <div class="receipt-card-meta">${r.date||''}${r.amount!=null?' · € '+fmtEur(r.amount):''}${isLinked?' · 🔗 '+esc(lt.desc.slice(0,20)):' · not linked'}</div>
            <div class="receipt-card-actions">
              <a href="${r.url}" target="_blank" class="btn btn-secondary btn-sm">View ↗</a>
              <button class="btn btn-secondary btn-sm" onclick="editReceiptAmount('${r.id}')">Edit €</button>
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
    qList.innerHTML=pending.map(r=>`<div class="qu-item"><div class="qu-item-thumb">${r.file.type.startsWith('image/')?`<img src="${URL.createObjectURL(r.file)}"/>`:r.file.name.match(/\.pdf$/i)?'📄':'📁'}</div><div class="qu-item-info"><div class="qu-item-name">${esc(r.file.name)}</div><div class="qu-item-meta">${fmtSize(r.file.size)}${r.status==='uploading'?` · ${r.progress}%`:''}</div>${r.status==='uploading'?`<div class="progress-bar"><div class="progress-fill" style="width:${r.progress}%"></div></div>`:''}${r.status==='pending'?`<input type="text" inputmode="decimal" class="filter-input" style="width:100%;margin-top:6px" placeholder="Amount € — required" value="${r.amount||''}" oninput="updatePendingAmount('${r.id}',this.value)"/>`:''}</div>${r.status!=='uploading'?`<button class="btn-x" onclick="removePending('${r.id}')">×</button>`:''}</div>`).join('');
  } else { queue.style.display='none'; }
  updateUploadButtonsState();
  // Recent
  const recent=$('qu-recent-list');
  if(recent){
    if(!receipts.length){recent.innerHTML='<div style="text-align:center;padding:1.5rem;color:var(--ink3);font-size:13px">No receipts yet</div>';}
    else{recent.innerHTML=receipts.slice().reverse().slice(0,5).map(r=>{const lt=transactions.find(t=>t.receiptId===r.id);return`<div class="receipt-card"><div class="receipt-card-icon">${r.name.match(/\.pdf$/i)?'📄':'🖼️'}</div><div class="receipt-card-info flex-1" style="min-width:0"><div class="receipt-card-name">${esc(r.name)}</div><div class="receipt-card-meta">${r.date}${r.amount!=null?' · € '+fmtEur(r.amount):''}${lt?' · linked':' · not linked'}</div><div class="receipt-card-actions"><a href="${r.url}" target="_blank" class="btn btn-secondary btn-sm">View ↗</a><button class="btn btn-secondary btn-sm" onclick="editReceiptAmount('${r.id}')">Edit €</button><button class="btn btn-secondary btn-sm" onclick="openLinkForReceipt('${r.id}')">${lt?'Relink':'Link'}</button></div></div></div>`;}).join('');}
  }
}

function addReceiptsQU(files){addReceipts(files);renderQuickUpload();}

function addReceipts(files){
  for(const f of files){
    if(f.size>20*1024*1024){alert(f.name+' exceeds 20 MB limit');continue;}
    pendingReceipts.push({id:'pr_'+Math.random().toString(36).slice(2),file:f,status:'pending',progress:0,amount:''});
  }
  renderReceipts();
}

// Update the amount on a pending receipt without re-rendering the list —
// re-rendering on every keystroke would rebuild the <input> and steal focus.
function updatePendingAmount(id,val){
  const r=pendingReceipts.find(r=>r.id===id);
  if(r){r.amount=val;updateUploadButtonsState();}
}

// Accepts either '.' or ',' as the decimal separator — iOS shows a comma-only numeric
// keypad for many EU keyboard locales, and a plain parseFloat('12,50') silently truncates
// to 12 instead of failing, so this must run before any amount is validated or stored.
function parseAmountInput(val){
  return parseFloat(String(val==null?'':val).trim().replace(',','.'));
}

function pendingHasValidAmount(r){return r.amount!==''&&r.amount!=null&&!isNaN(parseAmountInput(r.amount))&&parseAmountInput(r.amount)>0;}

function updateUploadButtonsState(){
  const pending=pendingReceipts.filter(r=>r.status==='pending');
  const ready=pending.length>0&&pending.every(pendingHasValidAmount);
  const btn=$('upload-receipts-btn'); if(btn) btn.disabled=!ready;
  const qbtn=$('qu-upload-btn'); if(qbtn) qbtn.disabled=!ready;
}

function removePending(id){pendingReceipts=pendingReceipts.filter(r=>r.id!==id);renderReceipts();}
function clearDoneReceipts(){pendingReceipts=pendingReceipts.filter(r=>r.status!=='done');renderReceipts();}

async function uploadAllReceipts(fromQuick=false){
  if(!accessToken){alert('Please sign in first.');return;}
  const pending=pendingReceipts.filter(r=>r.status==='pending');
  if(!pending.length)return;
  if(pending.some(r=>!pendingHasValidAmount(r))){alert('Please enter a valid amount for every receipt before uploading — it\'s required to match receipts to transactions.');return;}
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
      if(xhr.status===200){const resp=JSON.parse(xhr.responseText);entry.status='done';receipts.push({id:entry.id,name:newName,url:resp.webViewLink,date:ds,driveId:resp.id,amount:parseAmountInput(entry.amount)});saveReceipts();}
      else{entry.status='error';}
      resolve();
    };
    xhr.onerror=()=>{entry.status='error';resolve();};
    xhr.send(form);
  });
}

// Edit the amount on an already-uploaded receipt (e.g. to fix a typo made at upload time).
// Drops any open pending task for it, since that task's candidates were computed off the old
// amount, then re-runs matching immediately so the corrected amount gets a fresh chance to link.
function editReceiptAmount(receiptId){
  const r=receipts.find(r=>r.id===receiptId); if(!r) return;
  const input=prompt('Amount for "'+r.name+'" (€):', r.amount!=null?r.amount:'');
  if(input===null) return; // cancelled
  const val=parseAmountInput(input);
  if(isNaN(val)||val<=0){alert('Please enter a valid amount greater than 0.');return;}
  r.amount=val;
  pendingTasks=pendingTasks.filter(p=>!(p.receiptId===receiptId&&p.status==='open'));
  matchReceiptsToTransactions();
  saveReceipts();
  renderReceipts();renderTransactions();renderDashboard();renderPending();
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

// ─── RECEIPT ↔ TRANSACTION AUTO-MATCH (runs at most once/day) ──
// Matches receipts (by their entered amount) to unlinked transactions of the same amount.
// One candidate → link automatically. Multiple candidates → raise a pending task for manual
// resolution. lastMatchJobRun is persisted to Drive so the "once a day" gate holds across
// devices/sessions, not just this browser.
async function runDailyReceiptMatch(force){
  const today=new Date().toDateString();
  if(!force && lastMatchJobRun && new Date(lastMatchJobRun).toDateString()===today) return;
  matchReceiptsToTransactions();
  lastMatchJobRun=new Date().toISOString();
  await saveToDrive();
  renderReceipts();renderTransactions();renderDashboard();renderPending();
}

function matchReceiptsToTransactions(){
  let changed=false;
  for(const r of receipts){
    if(r.amount==null) continue; // legacy/recovered receipts with no amount — can't match
    if(transactions.some(t=>t.receiptId===r.id)) continue; // already linked
    if(pendingTasks.some(p=>p.receiptId===r.id)) continue; // already flagged (open, resolved or dismissed)
    const candidates=transactions.filter(t=>!t.receiptId && Math.abs(t.amount-r.amount)<0.01);
    if(candidates.length===1){
      candidates[0].receiptId=r.id;
      changed=true;
    } else if(candidates.length>1){
      pendingTasks.push({
        id:'pt_'+Math.random().toString(36).slice(2),
        receiptId:r.id, amount:r.amount,
        candidateTxnIds:candidates.map(t=>t.id),
        createdAt:new Date().toISOString(), status:'open'
      });
      changed=true;
    }
    // zero candidates: leave for a future run once a matching transaction is imported
  }
  return changed;
}

// ─── PENDING TASKS ───────────────────────────────────
function renderPending(){
  const open=pendingTasks.filter(p=>p.status==='open');
  const badge=$('nav-pending-badge');
  if(badge){ badge.style.display=open.length?'inline-block':'none'; badge.textContent=open.length; }
  const dot=$('bnav-pending-dot');
  if(dot) dot.style.display=open.length?'block':'none';

  const wrap=$('pending-list-wrap');
  if(!wrap) return;
  if(!open.length){
    wrap.innerHTML='<div class="empty"><div class="empty-icon">✅</div><h3>Nothing pending</h3><p>Receipts that match more than one transaction will show up here for you to resolve.</p></div>';
    return;
  }
  wrap.innerHTML=open.map(p=>{
    const r=receipts.find(rc=>rc.id===p.receiptId);
    // Re-filter live: a candidate may have been linked elsewhere since this task was created
    const cands=transactions.filter(t=>p.candidateTxnIds.includes(t.id)&&!t.receiptId);
    const header=`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px">
        <div>${r?`<a href="${r.url}" target="_blank" style="font-weight:500;color:var(--fire)">${esc(r.name)}</a>`:'<strong>Receipt</strong>'}
          <span style="font-family:var(--font-mono);color:var(--ink3);font-size:12px;margin-left:6px">€ ${fmtEur(p.amount)}</span>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="dismissPendingTask('${p.id}')">Dismiss</button>
      </div>`;
    if(!cands.length){
      return `<div class="card" style="margin-bottom:12px">${header}<p style="font-size:12px;color:var(--ink3)">All matching transactions were already linked elsewhere — dismiss or link this receipt manually from the Receipts tab.</p></div>`;
    }
    return `<div class="card" style="margin-bottom:12px">${header}
      <div style="font-size:12px;color:var(--ink3);margin-bottom:8px">${cands.length} transactions match this amount — pick the right one:</div>
      <div class="modal-list">
        ${cands.map(t=>`<div class="modal-item" onclick="resolvePendingTask('${p.id}','${t.id}')">
          <span style="font-family:var(--font-mono);font-size:11px;white-space:nowrap">${t.date}</span>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;padding:0 8px">${esc(t.desc)}</span>
          <span class="${t.type==='in'?'amount-in':'amount-out'}" style="font-family:var(--font-mono);font-size:12px">${t.type==='in'?'+':'-'}${fmtEur(t.amount)}</span>
        </div>`).join('')}
      </div>
    </div>`;
  }).join('');
}

function resolvePendingTask(taskId,txnId){
  const p=pendingTasks.find(p=>p.id===taskId); if(!p) return;
  const t=transactions.find(t=>t.id===txnId);
  if(!t||t.receiptId){ alert('That transaction is no longer available — it may have just been linked elsewhere.'); renderPending(); return; }
  t.receiptId=p.receiptId;
  p.status='resolved'; p.resolvedTxnId=txnId; p.resolvedAt=new Date().toISOString();
  saveTxns();
  renderPending();renderReceipts();renderTransactions();renderDashboard();
}

function dismissPendingTask(taskId){
  const p=pendingTasks.find(p=>p.id===taskId); if(!p) return;
  if(!confirm('Dismiss this task and leave the receipt unlinked?')) return;
  p.status='dismissed'; p.dismissedAt=new Date().toISOString();
  saveToDrive();
  renderPending();
}

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
  renderVatSettings();
  renderSavingsSettings();
  renderBankSettings();
  renderBackups();
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

async function getOrCreateMonthFolder(parentId,month){
  const m=month||new Date().toISOString().slice(0,7);
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
function refreshAll(){renderHoursDashboard();renderDashboard();renderTransactions();renderReceipts();renderPL();renderPending();renderVatSettings();renderLockReminder();}

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
          pendingTasks = data.pendingTasks || [];
          lastMatchJobRun = data.lastMatchJobRun || lastMatchJobRun;
          vatFrom = data.vatFrom || null;
          categoryVat = data.categoryVat || {};
          lockedQuarters = data.lockedQuarters || {};
          assets = data.assets || [];
          savingsOpening = data.savingsOpening || null;
          hours = data.hours || [];
          bankOpening = data.bankOpening || null;
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
