// One-time export of Moneybird receipts + purchase invoices (with their attachments) to a local
// folder, plus a manifest.json describing each file and the bank mutation Moneybird linked it to.
// The app's "Import Moneybird receipts" button then uploads these files to Drive and links them
// to transactions. Runs locally because Moneybird's API can't be called from the browser (no CORS).
//
// Usage:
//   MONEYBIRD_TOKEN=xxx node scripts/moneybird-export.js [administration_id]
// Optional: MONEYBIRD_PERIOD=20240101..20261231 (defaults to everything)
//
// Read-only: only GET requests (plus the read-only POST that fetches mutations by id).

const https = require('https');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.MONEYBIRD_TOKEN;
const PERIOD = process.env.MONEYBIRD_PERIOD || '20000101..20991231';
const OUT_DIR = path.join(__dirname, '..', 'moneybird-export');
const DOC_KINDS = ['receipts', 'purchase_invoices'];

if (!TOKEN) {
  console.error('Set MONEYBIRD_TOKEN (Moneybird → Settings → Developers → API tokens; needs "documents" and "bank" scopes).');
  process.exit(1);
}

function request(method, url, body, withAuth = true) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (withAuth) headers.Authorization = 'Bearer ' + TOKEN;
    if (body) headers['Content-Type'] = 'application/json';
    const req = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Moneybird allows ~150 requests / 5 min; back off and retry on 429.
async function api(method, apiPath, body) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await request(method, 'https://moneybird.com/api/v2' + apiPath, body);
    if (res.status === 429) {
      const wait = (parseInt(res.headers['retry-after'], 10) || 60) * 1000;
      console.log(`  rate limited, waiting ${wait / 1000}s…`);
      await sleep(wait);
      continue;
    }
    if (res.status >= 400) throw new Error(`${method} ${apiPath} → ${res.status}: ${res.body.toString().slice(0, 300)}`);
    return res;
  }
  throw new Error(`${method} ${apiPath} → still rate limited after retries`);
}

const getJSON = async (p, body, method = 'GET') => JSON.parse((await api(method, p, body)).body.toString());

async function listAll(adminId, kind) {
  const all = [];
  for (let page = 1; ; page++) {
    const batch = await getJSON(`/${adminId}/documents/${kind}.json?filter=period:${PERIOD}&per_page=100&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

// Download endpoint answers with a 302 to a temporary storage URL; follow it without our token.
async function downloadAttachment(adminId, kind, docId, attId) {
  const res = await api('GET', `/${adminId}/documents/${kind}/${docId}/attachments/${attId}/download`);
  if (res.status >= 300 && res.status < 400 && res.headers.location) {
    const file = await request('GET', res.headers.location, null, false);
    if (file.status !== 200) throw new Error(`attachment download → ${file.status}`);
    return file.body;
  }
  return res.body;
}

const safeName = s => String(s || '').replace(/[\/\\:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);

async function main() {
  let adminId = process.argv[2];
  if (!adminId) {
    const admins = await getJSON('/administrations.json');
    if (admins.length !== 1) {
      console.log('Multiple administrations — pass one as an argument:');
      admins.forEach(a => console.log(`  ${a.id}  ${a.name}`));
      process.exit(1);
    }
    adminId = admins[0].id;
    console.log(`Administration: ${admins[0].name} (${adminId})`);
  }

  fs.mkdirSync(path.join(OUT_DIR, 'files'), { recursive: true });

  const docs = [];
  for (const kind of DOC_KINDS) {
    const list = await listAll(adminId, kind);
    console.log(`${kind}: ${list.length}`);
    list.forEach(d => docs.push({ kind, d }));
  }

  // Fetch the bank mutations Moneybird linked each document to, 100 ids per request.
  const mutationIds = [...new Set([].concat(...docs.map(({ d }) => (d.payments || []).map(p => p.financial_mutation_id).filter(Boolean))))];
  const mutations = {};
  for (let i = 0; i < mutationIds.length; i += 100) {
    const batch = await getJSON(`/${adminId}/financial_mutations/synchronization.json`, { ids: mutationIds.slice(i, i + 100) }, 'POST');
    batch.forEach(m => { mutations[m.id] = { date: m.date, amount: parseFloat(m.amount), message: m.message || '', contra: m.contra_account_name || '' }; });
  }
  console.log(`linked bank mutations: ${Object.keys(mutations).length}`);

  const manifest = [];
  let noAttachment = 0;
  for (const { kind, d } of docs) {
    const atts = d.attachments || [];
    if (!atts.length) { noAttachment++; continue; }
    const docMutations = (d.payments || []).map(p => mutations[p.financial_mutation_id]).filter(Boolean);
    for (const [i, a] of atts.entries()) {
      const ext = path.extname(a.filename || '') || '';
      const label = safeName((d.contact && d.contact.company_name) || d.reference || kind);
      const file = `${d.date}_${label}_${d.id}${atts.length > 1 ? '_' + (i + 1) : ''}${ext}`;
      const dest = path.join(OUT_DIR, 'files', file);
      if (!fs.existsSync(dest)) {
        fs.writeFileSync(dest, await downloadAttachment(adminId, kind, d.id, a.id));
        console.log(`  ✓ ${file}`);
      }
      manifest.push({
        moneybirdId: d.id + (atts.length > 1 ? '_' + (i + 1) : ''),
        kind,
        date: d.date,
        amount: Math.abs(parseFloat(d.total_price_incl_tax)),
        contact: (d.contact && d.contact.company_name) || '',
        reference: d.reference || '',
        file,
        contentType: a.content_type || '',
        // Only the first attachment carries the link, so one transaction doesn't get claimed twice.
        mutations: i === 0 ? docMutations : [],
      });
    }
  }

  fs.writeFileSync(path.join(OUT_DIR, 'files', 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nDone: ${manifest.length} files in ${path.join(OUT_DIR, 'files')}`);
  if (noAttachment) console.log(`${noAttachment} documents had no attachment and were skipped.`);
  console.log('Next: in the app, Receipts → "Import from Moneybird export" and select ALL files in that folder (including manifest.json).');
}

main().catch(e => { console.error(e.message); process.exit(1); });
