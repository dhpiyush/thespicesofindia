#!/usr/bin/env python3
"""Turn a Moneybird "documents export" download into the same moneybird-export/files/ +
manifest.json that scripts/moneybird-export.js produces, so the app's "Import from Moneybird
export" button can upload and link them. Alternative to the API script when you already have
the export from Moneybird's web UI. Uses only the Python standard library.

Usage:
  python3 scripts/moneybird-folder-to-manifest.py "/path/to/the_spices_of_india_documents_export"

The export contains purchase_documents_export.xlsx (one row per document) and
<year>/purchase/<n>/ folders holding each document's attachment(s). The folders aren't named
after anything in the sheet: they are a running number with gaps, in the same order as the
rows (which are sorted by document id), so the k-th folder belongs to the k-th row.
"""
import datetime
import json
import os
import re
import shutil
import sys
import zipfile
import xml.etree.ElementTree as ET

NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
TAG_T = '{%s}t' % NS['m']
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'moneybird-export', 'files')


def read_sheet(path):
    z = zipfile.ZipFile(path)
    shared = []
    if 'xl/sharedStrings.xml' in z.namelist():
        for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si', NS):
            shared.append(''.join(t.text or '' for t in si.iter(TAG_T)))
    rows = []
    for r in ET.fromstring(z.read('xl/worksheets/sheet1.xml')).iter('{%s}row' % NS['m']):
        row = {}
        for c in r.findall('m:c', NS):
            col = re.match(r'[A-Z]+', c.get('r')).group()
            v, inline = c.find('m:v', NS), c.find('m:is', NS)
            if inline is not None:
                row[col] = ''.join(t.text or '' for t in inline.iter(TAG_T))
            elif v is not None:
                row[col] = shared[int(v.text)] if c.get('t') == 's' else v.text
        rows.append(row)
    header = [rows[0][k] for k in sorted(rows[0], key=lambda k: (len(k), k))]
    cols = sorted(rows[0], key=lambda k: (len(k), k))
    return [{h: r.get(c) for h, c in zip(header, cols)} for r in rows[1:]]


def excel_date(v):
    if not v:
        return None
    try:
        return (datetime.date(1899, 12, 30) + datetime.timedelta(days=int(float(v)))).isoformat()
    except ValueError:
        return str(v)[:10]


def safe_name(s):
    return re.sub(r'\s+', ' ', re.sub(r'[/\\:*?"<>|]+', '_', s or '')).strip()[:80]


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    src = sys.argv[1]
    rows = read_sheet(os.path.join(src, 'purchase_documents_export.xlsx'))
    if [int(r['id']) for r in rows] != sorted(int(r['id']) for r in rows):
        sys.exit('Rows are not in document-id order; the folder mapping below would be wrong.')

    folders = []
    for year in sorted(d for d in os.listdir(src) if d.isdigit()):
        base = os.path.join(src, year, 'purchase')
        if os.path.isdir(base):
            folders += [os.path.join(base, d) for d in sorted((d for d in os.listdir(base) if d.isdigit()), key=int)]
    if len(folders) != len(rows):
        sys.exit('%d document folders but %d rows in the sheet; cannot pair them safely.' % (len(folders), len(rows)))

    os.makedirs(OUT_DIR, exist_ok=True)
    manifest = []
    for folder, r in zip(folders, rows):
        atts = sorted(f for f in os.listdir(folder) if not f.startswith('.'))
        date = excel_date(r.get('date'))
        amount = abs(float(r.get('total amount including VAT (EUR)') or r.get('Total price including vat') or 0))
        paid_on = excel_date(r.get('paid on'))
        label = safe_name(r.get('contact') or r.get('reference') or 'receipt')
        for i, att in enumerate(atts):
            suffix = '_%d' % (i + 1) if len(atts) > 1 else ''
            name = '%s_%s_%s%s%s' % (date, label, r['id'], suffix, os.path.splitext(att)[1].lower())
            shutil.copyfile(os.path.join(folder, att), os.path.join(OUT_DIR, name))
            manifest.append({
                'moneybirdId': r['id'] + suffix,
                'kind': 'purchase_documents',
                'date': date,
                'amount': amount,
                'contact': r.get('contact') or '',
                'reference': r.get('reference') or '',
                'file': name,
                'contentType': '',
                # The sheet has no bank link, only the paid-on date: try that date first, then the
                # app's amount matcher. Only the first attachment claims a transaction.
                'mutations': [{'date': paid_on, 'amount': -amount, 'message': r.get('reference') or '', 'contra': r.get('contact') or ''}]
                if paid_on and i == 0 else [],
            })

    with open(os.path.join(OUT_DIR, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=2)
    print('%d documents, %d files -> %s' % (len(rows), len(manifest), os.path.normpath(OUT_DIR)))
    print('%d paid (with paid-on date), %d open' % (sum(1 for r in rows if r.get('paid on')), sum(1 for r in rows if not r.get('paid on'))))


if __name__ == '__main__':
    main()
