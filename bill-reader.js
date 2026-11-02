/* Keells bill reader: turns OCR words from a picture of a Keells Nexus e-bill into bill lines, and
 * puts a whole bill together from the pictures seen while it is scrolled on screen.
 * Runs in the browser (window.KeellsBill) and in Node (require) so it can be tested on saved frames.
 * Nothing here talks to a server.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KeellsBill = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DISCOUNT_RE = /\b(discount|disc|promo|promotion|offer|less|deal)\b/i;
  const MONEY = /^-?\d[\d,]*\.\d{2}$/;
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const HEAD = ['Receipt', 'DateText', 'BillDate', 'Counter', 'Store', 'Phone'];
  const CSV_FIELDS = ['BillKey', 'BillNo', 'BillDate', 'Store', 'Source', 'LineNo', 'Type', 'ItemCode', 'Item',
    'Qty', 'UnitPrice', 'Amount', 'BillTotal'];

  const toNumber = s => parseFloat(String(s).replace(/,/g, ''));
  const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
  const consistent = (q, p, a) => Math.abs(q * p - a) <= Math.max(0.05, Math.abs(a) * 0.01);
  const last = arr => arr[arr.length - 1];

  // --- OCR words -> printed rows ------------------------------------------------------------------
  // Tesseract's own lines break where the columns are far apart, so rows are rebuilt from word positions.
  function wordsFromTesseract(data) {
    const words = [];
    for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
      for (const w of l.words || []) {
        const text = (w.text || '').trim();
        if (text) words.push({ text, x: w.bbox.x0, y: w.bbox.y0, w: w.bbox.x1 - w.bbox.x0, h: w.bbox.y1 - w.bbox.y0, conf: w.confidence });
      }
    }
    return words;
  }

  function buildRows(words) {
    if (!words.length) return [];
    const hs = words.map(w => w.h).sort((a, b) => a - b);
    const hMed = hs[Math.floor(hs.length / 2)];
    const rows = [];
    for (const w of [...words].sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2))) {
      const yc = w.y + w.h / 2;
      const row = last(rows);
      if (row && Math.abs(yc - row.yc) <= hMed * 0.55) {
        row.words.push(w);
        row.yc = (row.yc * (row.words.length - 1) + yc) / row.words.length;
      } else rows.push({ yc, words: [w] });
    }
    for (const row of rows) {
      row.words.sort((a, b) => a.x - b.x);
      row.text = row.words.map((w, i) => (i ? (w.x - (row.words[i - 1].x + row.words[i - 1].w) > hMed * 1.2 ? '  ' : ' ') : '') + w.text).join('');
      row.x0 = row.words[0].x;
      row.x1 = Math.max(...row.words.map(w => w.x + w.w));
    }
    return rows;
  }

  // --- number and name repairs ----------------------------------------------------------------------
  // Common OCR slips inside numbers: O for 0, l/I for 1, a decimal point read as a comma or dash.
  function repairNumber(T) {
    let t = T.replace(/^[,;]+|[,;]+$/g, '');     // keep ':' - it marks the item code ("126325:")
    if (/^[\dOolI,.\-]+$/.test(t) && /\d/.test(t)) t = t.replace(/[Oo]/g, '0').replace(/[lI]/g, '1');
    const m = /^(-?\d{1,3}(?:,\d{3})*|-?\d+)[,\-](\d{2})$/.exec(t);
    if (m) t = `${m[1]}.${m[2]}`;
    // An item code ends in ':'; letters in it are misread digits ("T7777:" is 77777).
    if (/^[\dOoIlTSB|]{3,}:$/.test(t) && (t.match(/\d/g) || []).length >= 2) {
      t = t.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/T/g, '7').replace(/S/g, '5').replace(/B/g, '8');
    }
    return t;
  }

  // A row's words with number slips repaired, rejoining digit pieces OCR split apart when they almost touch.
  function rowTokens(row) {
    const out = [];
    let prev = null;
    for (const w of row.words) {
      const t = repairNumber(w.text);
      const gap = prev ? w.x - (prev.x + prev.w) : Infinity;
      const close = prev && gap < w.h * 0.6;
      if (close && /^\d+$/.test(last(out)) && /^\d+:?$/.test(t) && gap < w.h * 0.5) {
        out[out.length - 1] += t;                         // "1" + "14115:" is 114115:
      } else if (close && /^\d{1,3}$/.test(last(out)) && /^\d{3}\.\d{2}$/.test(t) &&
                 (/^,/.test(w.text) || /,$/.test(prev.text) || /^0/.test(t))) {
        out[out.length - 1] += ',' + t;                   // "1" + ",050.00" is 1,050.00
      } else if (t) out.push(t);
      prev = w;
    }
    return out;
  }

  // Possible values of an OCR'd number: as read, and with a thousands comma that was read as "1"
  // removed ("1,390.00" seen as "11390.00").
  function numberValues(t) {
    const vals = [toNumber(t)];
    const [int, frac] = t.replace(/,/g, '').split('.');
    const sign = int.startsWith('-') ? '-' : '';
    const digits = int.replace(/^-/, '');
    const i = digits.length - 4;
    if (i >= 1 && digits[i] === '1') vals.push(toNumber(`${sign}${digits.slice(0, i)}${digits.slice(i + 1)}.${frac}`));
    return vals;
  }

  // Weights and sizes in item names as OCR misreads them: "IKG" 1KG, "IOOG" 100G, "1206" 120G, "BOG" 80G.
  function repairUnit(t) {
    let m;
    const digits = s => s.replace(/[Il]/g, '1').replace(/[Oo]/g, '0');
    if ((m = /^([Il1][O0o\d]*)(G|KG|L|ML)$/.exec(t))) return digits(m[1]) + m[2];
    if ((m = /^([Il1][O0o]+)(S|PCS)$/.exec(t))) return digits(m[1]) + m[2];
    if ((m = /^[Ss5]([O0o]+)(G|KG|L|ML)$/.exec(t))) return '5' + digits(m[1]) + m[2];
    if ((m = /^(\d{1,3}0)6$/.exec(t))) return m[1] + 'G';
    if (/^B[O0]G$/.test(t)) return '80G';
    return t;
  }

  // A row starts an e-bill item: "<line no> <code>:" (OCR sometimes drops the line number, or reads 5 as "s").
  function isItemStart(tk) {
    return (tk.length >= 2 && /^(\d{1,3}|[sS])$/.test(tk[0]) && /^\d{3,}:?$/.test(tk[1])) ||
           (tk.length >= 1 && /^\d{3,}:/.test(tk[0]));
  }

  // One item from the tokens of its rows: "<line no> <code>: price qty amount" and the name below.
  // Within an item, price x qty = amount tells the three numbers apart. firstLen is how many of the
  // tokens are on the item's first row, where the numbers are.
  function parseItemBlock(tokens, firstLen = tokens.length) {
    let ln = null;
    if (tokens.length && /^(\d{1,3}|[sS])$/.test(tokens[0])) {
      ln = /\d/.test(tokens[0]) ? parseInt(tokens[0], 10) : 5;
      tokens = tokens.slice(1);
      firstLen--;
    }
    const merged = [];                                   // "1," + "673.36" is 1,673.36
    tokens.forEach((t, i) => {
      if (merged.length && /^\d{1,3},$/.test(last(merged).t) && /^\d{3}\.\d{2}$/.test(t)) last(merged).t += t;
      else merged.push({ t, first: i < firstLen });
    });
    let code = '';
    const name = [], nums = [], row1 = [];
    for (const { t, first } of merged) {
      let m;
      if (!code && (m = /^(\d{3,}):?(.*)$/.exec(t))) { code = m[1]; if (m[2]) name.push(m[2]); continue; }
      if (/^-?\d[\d,]*\.\d{1,3}$/.test(t)) {
        const n = { t, v: toNumber(t), vals: numberValues(t), dec: t.split('.').pop().length };
        nums.push(n);
        if (first) row1.push(n);
        continue;
      }
      if (first && code && /^\d{2,7}$/.test(t)) row1.push({ t, bare: true, at: name.length });
      name.push(repairUnit(t));
    }
    let p = 0, q = 1, a = 0, ok = false;
    if (nums.length >= 3) {
      const n3 = nums.slice(-3);
      [p, q, a] = [n3[0].v, n3[1].v, n3[2].v];            // reading order is price, qty, amount
      ok = consistent(q, p, a);
      // Try other orders and the alternative readings until price x qty = amount.
      const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
      for (const [i, j, k] of ok ? [] : perms) {
        const pp = n3[i], qq = n3[j], aa = n3[k];
        if (pp.dec !== 2 || aa.dec !== 2) continue;
        for (const pv of pp.vals) for (const qv of qq.vals) for (const av of aa.vals) {
          if (!ok && consistent(qv, pv, av)) { [p, q, a] = [pv, qv, av]; ok = true; }
        }
        if (ok) break;
      }
    } else if (nums.length === 2) {
      p = nums[0].v; a = nums[1].v;
      if (p !== 0) q = a / p;
    } else if (nums.length === 1) {
      a = nums[0].v; p = a;
    }
    // Numbers that lost their decimal point on the first row: "119000" for 1,190.00, "0879" for 0.879, "10" for 1.0.
    if (!ok && row1.length >= 3 && row1.some(n => n.bare)) {
      const [P, Q, A] = row1.slice(-3);
      const opts = (n, qty) => (!n.bare ? n.vals : qty ? [1000, 10, 100, 1].map(d => +n.t / d) : [+n.t / 100]);
      for (const pv of opts(P)) for (const qv of opts(Q, true)) for (const av of opts(A)) {
        if (!ok && pv > 0 && consistent(qv, pv, av)) { [p, q, a] = [pv, qv, av]; ok = true; }
      }
      if (ok) [P, Q, A].filter(n => n.bare).sort((x, y) => y.at - x.at).forEach(n => name.splice(n.at, 1));
    }
    // A size OCR split in two: "1" + "10G" is 110G, "1" + "OOG" is 100G.
    for (let i = name.length - 2; i >= 0; i--) {
      if (name[i] === '1' && /^[O0o\d]+(G|KG|L|ML|S)$/.test(name[i + 1])) { name[i] = repairUnit('1' + name[i + 1]); name.splice(i + 1, 1); }
    }
    if (name.length > 1 && /^\d{1,2}$/.test(name[0]) && ln === null) ln = parseInt(name.shift(), 10);   // a line number put in front of the name
    const item = name.join(' ').replace(/\s{2,}/g, ' ').replace(/^[\s\-:.]+|[\s\-:.]+$/g, '');
    return {
      Ln: ln, Type: a < 0 || DISCOUNT_RE.test(item) ? 'Discount' : 'Item', ItemCode: code, Item: item,
      Qty: round(q, 3), UnitPrice: round(p, 2), Amount: round(a, 2), Consistent: ok,
    };
  }

  // --- bill header ----------------------------------------------------------------------------------------
  function parseHeader(lines) {
    const all = lines.join('\n');
    let address = '';
    const sc = lines.findIndex(l => /Store Code/.test(l));
    if (sc > 0) address = lines[sc - 1].trim();
    const pick = (re, g = 1) => { const m = re.exec(all); return m ? m[g] : ''; };
    const storeCode = pick(/Store Code:\s*(\S+)/i);
    const phone = pick(/^([\d ]{7,})\s*\/\s*Store Code/im).trim();
    const counter = pick(/\bC:\s*(\S+)/i);
    // The points line ("redeemable as at 13-Sep-2026") has a date too, so the bill's date is looked for elsewhere.
    let dateText = '', billDate = '';
    const head = lines.filter(l => !/redeemable/i.test(l)).join('\n');
    const dm = /(\d{1,2})-([A-Za-z0][A-Za-z]{2})-(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(head);
    if (dm) {
      dateText = dm[0].replace(/-0([a-z]{2})-/i, '-O$1-');      // "0ct" is OCR for "Oct"
      const mon = MONTHS[dateText.split('-')[1].toLowerCase()];
      const day = parseInt(dm[1], 10);
      billDate = dateText;
      if (mon && day >= 1 && day <= 31) {
        const pad = n => String(n).padStart(2, '0');
        billDate = `${dm[3]}-${pad(mon)}-${pad(day)}`;
        if (dm[4] !== undefined && +dm[4] < 24 && +dm[5] < 60) billDate += ` ${pad(+dm[4])}:${dm[5]}`;
      }
    }
    const pts = all.replace(/(\d),(\d{2})(?!\d)/g, '$1.$2');     // OCR reads "5.69" as "5,69"
    let m = /Points earned for this bill:\s*(-?[\d,]*\.?\d+)/i.exec(pts);
    const earned = m ? toNumber(m[1]) : null;
    m = /Total points redeemable as at\s+(\S+)\s+(-?[\d,]*\.?\d+)/i.exec(pts);
    let store = `Keells ${storeCode}`.trim();
    if (address) store += ` (${address})`;
    return {
      Store: store, Phone: phone, DateText: dateText, BillDate: billDate, Counter: counter,
      PointsEarned: earned, PointsBalance: m ? toNumber(m[2]) : null, PointsAsAt: m ? m[1] : '',
    };
  }

  // --- one frame -------------------------------------------------------------------------------------------
  // Reads one picture of a Nexus e-bill on screen, scrolled to any part of the bill. An item running
  // off the bottom of the picture is marked Closed = false (its name may be cut), and FinalLn is set
  // when the last item and the totals are both in view.
  function parseFrame(rows) {
    const lines = rows.map(r => r.text);
    const all = lines.join('\n');
    const tokens = rows.map(rowTokens);

    let first = 0;
    for (let i = 0; i < rows.length; i++) if (/\bitem\b.*\b(price|qty)\b/i.test(lines[i])) { first = i + 1; break; }
    // Only the bill's own totals end the item list, so a "Total" in the app's title bar can't cut it short.
    const starts = [];
    let end = -1;
    for (let i = first; i < rows.length; i++) {
      if (/^\W*((gross|net)\s+(a\w*|total)|sub\s*-?\s*total)\b|thank you|points earned|redeemable/i.test(lines[i])) { end = i; break; }
      if (isItemStart(tokens[i])) starts.push(i);
    }
    const items = [];
    const stopAll = end >= 0 ? end : rows.length;
    starts.forEach((s, k) => {
      const isLast = k + 1 >= starts.length;
      const stop = isLast ? stopAll : starts[k + 1];
      const tk = [].concat(...tokens.slice(s, stop));
      if (!tk.some(t => MONEY.test(t) || /^\d{4,}$/.test(t))) return;    // not an item: no amount in it
      const it = parseItemBlock(tk, tokens[s].length);
      it.Closed = !isLast || end >= 0;
      items.push(it);
    });
    // OCR can miss a thin one-digit line number; work it out from the items next to it.
    for (let pass = 0; pass < 2; pass++) {
      items.forEach((it, k) => {
        if (it.Ln !== null) return;
        if (k + 1 < items.length && items[k + 1].Ln !== null) it.Ln = items[k + 1].Ln - 1;
        else if (k > 0 && items[k - 1].Ln !== null) it.Ln = items[k - 1].Ln + 1;
        else if (k === 0 && first > 0) it.Ln = 1;
        if (it.Ln !== null && it.Ln < 1) it.Ln = null;
      });
    }
    // A line number misread ("11" as "1") when the items either side agree on what it must be.
    items.forEach((it, k) => {
      const prev = items[k - 1], next = items[k + 1];
      if (prev && next && prev.Ln !== null && next.Ln === prev.Ln + 2 && it.Ln !== prev.Ln + 1) it.Ln = prev.Ln + 1;
    });
    const finalLn = end >= 0 && items.length ? last(items).Ln : null;

    // Totals: "Gross Amount 1,673.36", "Net Amount ...", payment rows, up to the points lines.
    const totals = [];
    if (end >= 0) {
      for (let i = end; i < rows.length; i++) {
        if (/points|redeemable|thank you/i.test(lines[i])) break;
        const tk = tokens[i];
        if (tk.length >= 2 && MONEY.test(last(tk))) {
          const label = tk.slice(0, -1).join(' ').trim();
          if (/[A-Za-z]/.test(label)) totals.push({ Label: label, Amount: toNumber(last(tk)) });
        }
      }
    }

    const h = parseHeader(lines);
    // The receipt number is the bill's key, so only a clean reading counts; another frame will have it right.
    let receipt = '';
    for (const m of all.matchAll(/\bR\s*[:.;]\s*(\S{4,})/g)) {
      const c = m[1].replace(/[Oo]/g, '0').replace(/[Il]/g, '1');
      if (/^\d{5,}$/.test(c)) { receipt = c; break; }
    }
    const isBill = items.length > 0 || totals.length > 0 || first > 0 ||
      /Store Code|Points earned for this bill|redeemable as at|\bR\s*[:.;]\s*\d{5,}/i.test(all);
    // Where the bill is in the picture (for cropping a whole-screen capture to it).
    const billRows = rows.filter((r, i) => (first > 0 && i >= first - 1) || isItemStart(tokens[i]) || /Store Code|\bR\s*:|Gross|Net Amount/i.test(r.text));
    const area = billRows.length ? [Math.min(...billRows.map(r => r.x0)), Math.max(...billRows.map(r => r.x1))] : null;
    return {
      IsBill: isBill, Receipt: receipt, DateText: h.DateText, BillDate: h.BillDate, Counter: h.Counter,
      Store: /Store Code/.test(all) ? h.Store : '', Phone: h.Phone,
      Items: items, Totals: totals, FinalLn: finalLn,
      PointsEarned: h.PointsEarned, PointsBalance: h.PointsBalance, PointsAsAt: h.PointsAsAt,
      Lines: lines, Area: area,
    };
  }

  // --- putting a bill together from frames -------------------------------------------------------------
  class Tally {                          // a Counter that remembers the order values were first seen
    constructor() { this.m = new Map(); }
    add(k, n = 1) { this.m.set(k, (this.m.get(k) || 0) + n); }
    get size() { return this.m.size; }
    keys() { return [...this.m.keys()]; }
    top() { let best, bn = -1; for (const [k, n] of this.m) if (n > bn) { best = k; bn = n; } return best; }
  }

  const cmpTuple = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1; } return 0; };

  // One e-bill being read off the screen. Items are kept by line number; each line keeps every different
  // reading with how often it was seen. A reading where price x qty = amount wins, then the one seen most,
  // so a one-off OCR slip is outvoted by the frames before and after it.
  class ScreenBill {
    constructor(now) {
      this.head = Object.fromEntries(HEAD.map(k => [k, new Tally()]));
      this.lines = new Map();           // line no, or "?code|amount" until the number is read -> Map(key -> reading)
      this.totals = new Map();          // "gross" / "net" / label -> {Label, Amounts: Tally}
      this.points = {};
      this.finalLn = new Tally();
      this.seen = this.updated = now;
      this.frames = 0;
      this.done = false;
    }

    value(k) {
      const t = this.head[k];
      if (!t.size) return '';
      const timed = k === 'DateText' || k === 'BillDate';   // OCR sometimes drops the time; prefer a reading with it
      let best, bs = null;
      for (const [v, n] of t.m) {
        const s = [timed && v.includes(':') ? 1 : 0, n];
        if (bs === null || cmpTuple(s, bs) > 0) { best = v; bs = s; }
      }
      return best;
    }

    sameBill(f) {
      const r = f.Receipt, mine = this.value('Receipt');
      if (!r || !mine || r === mine) return true;
      const d = f.DateText || '';
      if (d.includes(':') && d === this.value('DateText')) return true;     // a misread receipt number on the same date and time
      return (f.Items || []).some(it => {                                     // or the same items on the same lines
        const slot = this.lines.get(it.Ln);
        return slot && [...slot.values()].some(r2 => r2.item.ItemCode === (it.ItemCode || ''));
      });
    }

    merge(f, now) {
      this.frames++;
      this.seen = this.updated = now;
      for (const k of HEAD) if (f[k]) this.head[k].add(f[k]);
      for (const it of f.Items || []) this._addItem(it);
      for (const t of f.Totals || []) {
        const label = String(t.Label || '').trim();
        const key = /^gross/i.test(label) ? 'gross' : /^net/i.test(label) ? 'net' : label.toLowerCase().replace(/[^a-z]/g, '');
        if (!key) continue;
        if (!this.totals.has(key)) this.totals.set(key, { Label: label, Amounts: new Tally() });
        this.totals.get(key).Amounts.add(round(+t.Amount || 0, 2));
      }
      for (const k of ['PointsEarned', 'PointsBalance', 'PointsAsAt']) {
        if (f[k] !== null && f[k] !== undefined && f[k] !== '') (this.points[k] = this.points[k] || new Tally()).add(f[k]);
      }
      if (f.FinalLn) this.finalLn.add(+f.FinalLn);
    }

    _addItem(it) {
      const code = String(it.ItemCode || '');
      const amount = round(+it.Amount || 0, 2);
      const key = `${code}|${amount}`;
      const reading = {
        item: { Type: it.Type, ItemCode: code, Item: it.Item, Qty: it.Qty, UnitPrice: it.UnitPrice, Amount: amount },
        q: [it.Consistent ? 1 : 0, it.Closed ? 1 : 0, (it.Item || '').length], n: 1, names: new Tally(),
      };
      if (it.Closed && it.Item) reading.names.add(it.Item);
      const loose = `?${key}`;
      let slot;
      if (it.Ln === null || it.Ln === undefined) {
        slot = [...this.lines.values()].find(s => s.has(key));
        if (!slot) { if (!this.lines.has(loose)) this.lines.set(loose, new Map()); slot = this.lines.get(loose); }
      } else {
        const ln = +it.Ln;
        if (!this.lines.has(ln)) this.lines.set(ln, new Map());
        slot = this.lines.get(ln);
        const before = this.lines.get(loose);              // the same line, read before without its number
        if (before) {
          this.lines.delete(loose);
          for (const [k2, r2] of before) { if (slot.has(k2)) slot.get(k2).n += r2.n; else slot.set(k2, r2); }
        }
      }
      const cur = slot.get(key);
      if (!cur) slot.set(key, reading);
      else {
        cur.n++;
        for (const [nm, n] of reading.names.m) cur.names.add(nm, n);
        if (cmpTuple(reading.q, cur.q) > 0) { cur.item = reading.item; cur.q = reading.q; }
      }
    }

    // The name read most often in full (not cut off at the screen's edge); the longer one on a tie.
    static bestName(r) {
      let best = r.item.Item, bs = null;
      for (const [nm, n] of r.names.m) if (bs === null || cmpTuple([n, nm.length], bs) > 0) { best = nm; bs = [n, nm.length]; }
      return best;
    }

    bestLines() {
      const ks = [...this.lines.keys()];
      const keys = ks.filter(k => typeof k === 'number').sort((a, b) => a - b).concat(ks.filter(k => typeof k !== 'number'));
      const out = [];
      for (const k of keys) {
        const rs = [...this.lines.get(k).values()];
        if (!rs.length) continue;
        let best = rs[0];
        for (const r of rs.slice(1)) if (cmpTuple([r.q[0], r.n, r.q[1], r.q[2]], [best.q[0], best.n, best.q[1], best.q[2]]) > 0) best = r;
        out.push([k, best]);
      }
      return out;
    }

    progress() {
      const lines = this.bestLines();
      const lns = lines.map(([k]) => k).filter(k => typeof k === 'number');
      const final = this.finalLn.size ? this.finalLn.top() : null;
      const top = Math.max(0, ...lns, ...(final ? [final] : []));
      const missing = [];
      for (let n = 1; n <= top; n++) if (!lns.includes(n)) missing.push(n);
      const itemsSum = round(lines.reduce((s, [, r]) => s + (+r.item.Amount || 0), 0), 2);
      let disc = 0;
      for (const [k, t] of this.totals) if (k !== 'gross' && k !== 'net' && DISCOUNT_RE.test(t.Label)) disc += Math.abs(t.Amounts.top());
      disc = round(disc, 2);
      const fits = x => x !== null && x !== undefined && (Math.abs(itemsSum - x) <= 0.05 || Math.abs(itemsSum - disc - x) <= 0.05);
      const pick = key => {                // the reading of a total that the lines add up to, else the commonest
        const t = this.totals.get(key);
        if (!t) return null;
        const f = t.Amounts.keys().find(fits);
        return f !== undefined ? f : t.Amounts.top();
      };
      const gross = pick('gross'), net = pick('net');
      const target = net !== null ? net : gross;
      const known = !!(this.value('Receipt') || this.value('DateText').includes(':'));
      const addsUp = lines.length > 0 && !missing.length && (fits(net) || fits(gross));
      return {
        receipt: this.value('Receipt'), dateText: this.value('DateText'), lines: lines.length, top, missing,
        itemsSum, discount: disc, gross, net, target, addsUp, known, complete: known && addsUp,
        structural: known && target !== null && final !== null && top === final && !missing.length,
        namesDone: lines.every(([, r]) => r.q[1]), frames: this.frames,
      };
    }

    // The finished bill, and its CSV lines (bill-level discounts become lines so they sum to the total).
    record() {
      const p = this.progress();
      const items = this.bestLines().map(([k, r]) => ({ ...r.item, Item: ScreenBill.bestName(r), LineNo: typeof k === 'number' ? k : null }));
      const totals = [], discLines = [];
      for (const [k, t] of this.totals) {
        const amt = k === 'gross' || k === 'net' ? p[k] : t.Amounts.top();
        totals.push({ Label: t.Label, Amount: amt });
        if (k !== 'gross' && k !== 'net' && DISCOUNT_RE.test(t.Label)) {
          discLines.push({ Type: 'Discount', ItemCode: '', Item: t.Label, Qty: 1, UnitPrice: -Math.abs(amt), Amount: -Math.abs(amt) });
        }
      }
      const total = p.target, gross = p.gross;
      const linesSum = round(p.itemsSum - p.discount, 2);
      let check, msg;
      if (total === null) { check = 'unknown'; msg = `Items add up to Rs ${money(linesSum)} (no bill total found to check against).`; }
      else if (Math.abs(total - linesSum) <= 0.05) { check = 'ok'; msg = `Items add up to the bill total, Rs ${money(total)}.`; }
      else if (gross !== null && Math.abs(gross - p.itemsSum) <= 0.05) {
        check = 'ok'; msg = `Items add up to the gross amount, Rs ${money(gross)}; the net amount is Rs ${money(total)}.`;
      } else {
        check = 'mismatch';
        msg = `Items add up to Rs ${money(linesSum)} but the bill total is Rs ${money(total)}. Some lines may be misread; open the bill again and scroll slowly.`;
      }
      const receipt = this.value('Receipt'), billDate = this.value('BillDate');
      const pts = Object.fromEntries(Object.entries(this.points).map(([k, t]) => [k, t.top()]));
      return {
        BillKey: receipt ? `bill:${receipt}` : `screen:${billDate}|${(total || 0).toFixed(2)}`,
        BillNo: receipt, BillDate: billDate, DateText: this.value('DateText'), Store: this.value('Store') || 'Keells',
        Counter: this.value('Counter'), Total: total, Gross: gross, Items: items, Totals: totals, CsvLines: items.concat(discLines),
        PointsEarned: pts.PointsEarned ?? null, PointsBalance: pts.PointsBalance ?? null, PointsAsAt: pts.PointsAsAt || '',
        Check: check, CheckMessage: msg, Source: 'screen',
      };
    }
  }

  // --- the reading session: frames in, finished bills out ----------------------------------------------------
  // The app calls frame() with each read frame, still() while the screen hasn't changed, and tick() regularly.
  class BillSession {
    constructor({ now = () => Date.now() / 1000, onProgress = () => {}, onBill = () => {}, onNote = () => {} } = {}) {
      Object.assign(this, { now, onProgress, onBill, onNote });
      this.cur = null;
      this.lastWasBill = false;
    }

    frame(f) {
      this.lastWasBill = !!f.IsBill;
      if (!this.lastWasBill) return;
      if (this.cur && !this.cur.sameBill(f)) this.closeBill();
      if (!this.cur) {
        this.cur = new ScreenBill(this.now());
        this.onNote('A Keells bill is on screen. Reading it...', 'info');
      }
      if (this.cur.done) { this.cur.seen = this.now(); return; }
      this.cur.merge(f, this.now());
      const p = this.cur.progress();
      this.onProgress(p, 'reading');
      if (p.complete && p.namesDone) this.finish(this.cur);
    }

    still() { if (this.cur && this.lastWasBill) this.cur.seen = this.now(); }

    tick() {
      const cur = this.cur;
      if (!cur) return;
      const now = this.now();
      if (!cur.done && now - cur.updated > 4 && cur.progress().complete) this.finish(cur);   // a name cut off at the edge stays short
      if (now - cur.seen > 5) this.closeBill();
    }

    // The bill left the screen (or the recording ended): save it if it was read in full, else say what's missing.
    closeBill() {
      const cur = this.cur;
      this.cur = null;
      if (!cur) return;
      if (!cur.done) {
        const p = cur.progress();
        if (p.complete || p.structural) { this.finish(cur); this.onProgress(null); return; }
        const what = p.receipt ? `receipt ${p.receipt}` : 'the bill';
        const missing = p.missing.length ? `; line(s) ${p.missing.slice(0, 8).join(', ')} not read`
          : p.target === null ? "; the totals at the end weren't seen"
          : p.addsUp ? "; the receipt number at the top wasn't read" : '';
        this.onNote(`Only part of ${what} was read (${p.lines} line(s), Rs ${money(p.itemsSum)}` +
          `${p.target !== null ? ' of ' + money(p.target) : ''}${missing}). Open it again and scroll slowly from top to bottom.`, 'warn');
        this.onProgress(p, 'incomplete');
        return;
      }
      this.onProgress(null);
    }

    finish(cur) {
      cur.done = true;
      this.onBill(cur.record());
      this.onProgress(cur.progress(), 'done');
    }
  }

  // --- helpers for the app ------------------------------------------------------------------------------
  function money(v) {
    if (v === null || v === undefined || isNaN(v)) return '-';
    return Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // The bill's lines as rows of keells_ebill_items.csv (the same columns the PC scripts use).
  function csvRows(rec) {
    const num = v => (v === null || v === undefined ? '' : String(+(+v).toFixed(3)));
    return rec.CsvLines.map((it, i) => [rec.BillKey, rec.BillNo, rec.BillDate, rec.Store, 'screen', i + 1, it.Type,
      it.ItemCode, it.Item, num(it.Qty), num(it.UnitPrice), num(it.Amount), num(rec.Total)]);
  }

  function toCsv(rows) {
    const q = v => `"${String(v === null || v === undefined ? '' : v).replace(/"/g, '""')}"`;
    return '﻿' + [CSV_FIELDS, ...rows].map(r => r.map(q).join(',')).join('\r\n') + '\r\n';
  }

  // OCR words -> frame, in one call.
  function readFrame(words) { return parseFrame(buildRows(words)); }

  return {
    wordsFromTesseract, buildRows, rowTokens, repairNumber, repairUnit, numberValues, isItemStart,
    parseItemBlock, parseHeader, parseFrame, readFrame, ScreenBill, BillSession, money, csvRows, toCsv, CSV_FIELDS,
  };
});
