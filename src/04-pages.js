
/* ================= vibration page ================= */
const VIB = { id: null, follow: true, spec: 'avg', key: '', optKey: '' };
function vibCurrentId() {
  const pl = prevList();
  if (VIB.follow || !VIB.id) return pl.length ? pl[pl.length - 1].id : (lastCap()?.id ?? null);
  return VIB.id;
}
function setVibId(id, follow) {
  VIB.id = id; VIB.follow = !!follow;
  $('#vib-follow').checked = VIB.follow;
  try { history.replaceState(null, '', VIB.follow ? '#vibration' : '#vibration/' + encodeURIComponent(id)); } catch (e) { }
  renderVibration(true);
}
function renderVibPicker(id) {
  const pl = prevList();
  const key = pl.length + '|' + (pl[pl.length - 1]?.id || '') + '|' + id;
  if (key === VIB.optKey) return;
  VIB.optKey = key;
  const sel = $('#vib-select');
  const items = pl.slice(-300).reverse();
  let html = items.map(p => `<option value="${esc(p.id)}">${esc(fmtDT(p.ts))}${p.state && p.state !== 'NORMAL' ? ', ' + STATE_WORD[p.state].toLowerCase() : ''}${p.live ? ', live' : ''}</option>`).join('');
  if (id && !S.prevs.has(id)) { const c = S.capById.get(id); html = `<option value="${esc(id)}">${esc(c ? fmtDT(c.ts) : id)} (no waveform)</option>` + html; }
  sel.innerHTML = html || '<option value="">No captures yet</option>';
  if (id) sel.value = id;
  const idx = pl.findIndex(p => p.id === id);
  $('#vib-prev').disabled = !(idx > 0 || (idx < 0 && pl.length));
  $('#vib-next').disabled = !(idx >= 0 && idx < pl.length - 1);
}
function vibSummaryHTML(id) {
  const c = S.capById.get(id), p = S.prevs.get(id), src = c || p;
  if (!src) return '<p class="hint" style="margin-top:12px">No captures yet. They appear here as they arrive; you can also open a history file on the <a href="#connect">Connect page</a>.</p>';
  const state = src.state || 'NORMAL';
  const evs = p ? (p.events || []).length : null;
  let spikes = null, bad = null;
  if (p && Array.isArray(p.nodes)) {
    spikes = 0; bad = 0;
    for (const nd of p.nodes) { spikes += (nd.spikes || []).length; bad += (nd.glitches || []).length + (nd.ok === false ? 1 : 0); }
  }
  const why = humanWhy(src.why);
  return `<div class="summary"><span class="badge ${STATE_CLS[state] || ''}">${STATE_WORD[state] || esc(state)}</span>
    <span class="kv">Time<b>${esc(fmtDT(src.ts))}</b></span>
    <span class="kv">Score<b>${fmt(src.ratio, 2)}</b></span>
    <span class="kv">Vehicle crossings<b>${evs ?? '–'}</b></span>
    <span class="kv">Spikes<b>${spikes ?? '–'}</b></span>
    <span class="kv">Bad reads<b>${bad ?? '–'}</b></span>
    ${src.q === false ? '<span class="badge warn">quality problem' + (Array.isArray(src.flags) && src.flags.length ? ': ' + esc(src.flags.join(', ').replace(/_/g, ' ')) : '') + '</span>' : ''}
    ${p?.live ? '<span class="badge info">live window</span>' : ''}${src.mode === 'collect' ? '<span class="badge info">learning</span>' : ''}</div>
    <p class="why-line">${why ? '<b>Reason.</b> ' + esc(why) : (state === 'NORMAL' ? 'Nothing unusual in this capture.' : '')} <span class="c-mute">Capture ${esc(id)}</span></p>`;
}
function avgSpec(dec, node) {
  if (node) { const nd = dec.nodes[node]; return nd && nd.spec ? nd.spec : null; }
  const arr = NODES.map(n => dec.nodes[n]).filter(x => x && x.ok && x.spec);
  if (!arr.length) return null;
  const L = Math.min(...arr.map(a => a.spec.length)), out = new Float32Array(L);
  for (let k = 0; k < L; k++) { let s = 0; for (const a of arr) s += Math.pow(10, a.spec[k] / 10); out[k] = 10 * Math.log10(s / arr.length); }
  return out;
}
const TYP = { key: '', res: null };
async function typicalSpectrum(excludeId, mode) {
  const pl = prevList(), pick = [];
  for (let i = pl.length - 1; i >= 0 && pick.length < 15; i--) { const p = pl[i]; if (p.id !== excludeId && p.state === 'NORMAL' && p.q !== false && p.mode !== 'collect') pick.push(p); }
  if (pick.length < 5) return { n: pick.length, val: null };
  const key = mode + ':' + pick.map(p => p.id).join(',');
  if (TYP.key === key) return TYP.res;
  const specs = [];
  for (const p of pick) { const d = await decodePreview(p); const a = d && avgSpec(d, mode === 'avg' ? null : mode); if (a) specs.push(a); }
  if (specs.length < 5) return { n: specs.length, val: null };
  const L = Math.min(...specs.map(s => s.length)), val = new Float32Array(L), col = new Array(specs.length);
  for (let k = 0; k < L; k++) { for (let j = 0; j < specs.length; j++) col[j] = specs[j][k]; val[k] = median(col); }
  TYP.key = key; TYP.res = { n: specs.length, val };
  return TYP.res;
}
async function renderVibration(force) {
  const id = vibCurrentId();
  VIB.id = id;
  $('#vib-follow').checked = VIB.follow;
  renderVibPicker(id);
  $('#vib-summary').innerHTML = vibSummaryHTML(id);
  renderLiveState();
  const wavesEl = $('#vib-waves'), specEl = $('#vib-spec');
  const p = id ? S.prevs.get(id) : null;
  const sig = [id, VIB.spec, wavesEl.clientWidth, prevList().length > 5 ? Math.min(prevList().length, 20) : prevList().length].join('|');
  if (!force && sig === VIB.key) return;
  VIB.key = sig;
  if (!p) {
    const msg = id ? 'No waveform preview was kept for this capture. Ask the base station for its raw file further down this page.' : 'No vibration previews yet. One arrives with each capture once connected, or open remote.sqlite on the <a href="#connect">Connect page</a>.';
    wavesEl.innerHTML = `<div class="empty-chart">${msg}</div>`;
    specEl.innerHTML = `<div class="empty-chart">The spectrum comes from the waveform preview, so there is none for this capture.</div>`;
    return;
  }
  const dec = await decodePreview(p);
  if (VIB.id !== id || !dec) return;
  waveStack(wavesEl, {
    label: 'Vertical vibration at each node', fs: dec.fs, dur: dec.dur, unit: 'mg', events: dec.events,
    chans: NODES.map(n => { const nd = dec.nodes[n]; return { name: n, label: n, sub: NODE_PLACE[n], data: nd?.wave, color: NODE_COLOR[n], spikes: nd?.spikes, glitches: nd?.glitches, empty: !nd ? 'no data from this node in this capture' : nd.err ? 'could not unpack: ' + nd.err : nd.n === 0 ? 'no data from this node in this capture' : 'bad data, no waveform' }; }),
  });
  await renderSpectrum(p, dec);
}
async function renderSpectrum(p, dec) {
  const el = $('#vib-spec'), mode = VIB.spec;
  const spec = avgSpec(dec, mode === 'avg' ? null : mode);
  const df = dec.df, c = S.capById.get(p.id) || p, bl = baseline();
  if (!spec) { el.innerHTML = `<div class="empty-chart">${mode === 'avg' ? 'No node had good data in this capture.' : `Node ${mode.slice(1)} had no spectrum in this capture.`}</div>`; return; }
  const typ = await typicalSpectrum(p.id, mode);
  if (VIB.id !== p.id || VIB.spec !== mode) return;
  const fmax = Math.min(dec.fs / 2, 25);
  const toPts = s => { const out = []; for (let k = 0; k < s.length && k * df <= fmax + 1e-9; k++) out.push([k * df, s[k]]); return out; };
  const series = [];
  if (typ.val) series.push({ name: `Typical (median of ${typ.n} normal captures)`, pts: toPts(typ.val), color: 'var(--typ)', width: 3.5 });
  series.push({ name: mode === 'avg' ? 'This capture, average of nodes' : `This capture, node ${mode.slice(1)}`, pts: toPts(spec), color: mode === 'avg' ? 'var(--trace)' : NODE_COLOR[mode] });
  const vlines = [];
  if (bl) bl.freq.forEach((f, i) => { if (fin(f)) vlines.push({ x: f, cls: 'base' }); });
  if (Array.isArray(c.freq)) c.freq.forEach((f, i) => {
    f = +f; if (!fin(f)) return;
    const pc = freqPct(c, i, bl);
    vlines.push({ x: f, cls: 'now' + (pc != null && pc < -3 ? ' low' : ''), label: `${fmt(f, 2)} Hz${pc != null ? ' (' + fmtPct(pc) + ')' : ''}` });
  });
  $('#spec-sub').innerHTML = `Where the vibration energy sits. Solid lines mark this capture's natural frequencies${bl ? ', dashed lines the healthy ones' : ''}.${typ.val ? '' : ` The grey typical curve appears once at least 5 normal captures have previews (now ${typ.n}).`}`;
  lineChart(el, {
    label: 'Vibration spectrum', series, vlines, xMin: 0, xMax: fmax, height: el.clientWidth < 500 ? 230 : 280,
    fmtY: v => fmt(v, 0), fmtX: v => v + (v === 0 ? ' Hz' : ''),
    tipTitle: x => fmt(x, 2) + ' Hz', fmtTip: v => fmt(v, 1) + ' dB',
    tipExtra: () => '<div class="tx">dB of mg² per Hz</div>',
  });
}
function renderLiveState() {
  const lu = +S.liveUntil, left = fin(lu) ? lu - nowS() : -1;
  const on = left > 0;
  $('#live-state').hidden = !on; $('#live-stop').hidden = !on; $('#live-btn').hidden = on;
  if (on) { const m = Math.floor(left / 60), s = Math.floor(left % 60); $('#live-count').textContent = `Live for ${m}:${String(s).padStart(2, '0')} more`; }
}

/* ---------- raw .npz ---------- */
const RAW = { cur: null, axis: 'z' };
async function unzip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), len = u8.byteLength;
  let eocd = -1;
  for (let i = len - 22; i >= Math.max(0, len - 22 - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This is not a .npz (zip) file.');
  let count = dv.getUint16(eocd + 10, true), cdOff = dv.getUint32(eocd + 16, true);
  if (count === 0xFFFF || cdOff === 0xFFFFFFFF) {
    const loc = eocd - 20;
    if (loc >= 0 && dv.getUint32(loc, true) === 0x07064b50) {
      const z = Number(dv.getBigUint64(loc + 8, true));
      if (dv.getUint32(z, true) === 0x06064b50) { count = Number(dv.getBigUint64(z + 32, true)); cdOff = Number(dv.getBigUint64(z + 48, true)); }
    }
  }
  const out = new Map(), td = new TextDecoder();
  let p = cdOff;
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('The zip directory is damaged.');
    const method = dv.getUint16(p + 10, true);
    let csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true), lho = dv.getUint32(p + 42, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    const name = td.decode(u8.subarray(p + 46, p + 46 + nl));
    for (let e = p + 46 + nl, end = e + xl; e + 4 <= end;) {
      const hid = dv.getUint16(e, true), sz = dv.getUint16(e + 2, true);
      if (hid === 1) {
        let q = e + 4;
        if (usize === 0xFFFFFFFF) { usize = Number(dv.getBigUint64(q, true)); q += 8; }
        if (csize === 0xFFFFFFFF) { csize = Number(dv.getBigUint64(q, true)); q += 8; }
        if (lho === 0xFFFFFFFF) { lho = Number(dv.getBigUint64(q, true)); q += 8; }
      }
      e += 4 + sz;
    }
    p += 46 + nl + xl + cl;
    if (dv.getUint32(lho, true) !== 0x04034b50) throw new Error('A file inside the zip is damaged: ' + name);
    const lnl = dv.getUint16(lho + 26, true), lxl = dv.getUint16(lho + 28, true);
    if (csize === 0xFFFFFFFF) { // sizes only in the local zip64 extra
      for (let e = lho + 30 + lnl, end = e + lxl; e + 4 <= end;) { const hid = dv.getUint16(e, true), sz = dv.getUint16(e + 2, true); if (hid === 1 && sz >= 16) { usize = Number(dv.getBigUint64(e + 4, true)); csize = Number(dv.getBigUint64(e + 12, true)); } e += 4 + sz; }
    }
    const ds = lho + 30 + lnl + lxl, comp = u8.subarray(ds, ds + csize);
    if (method === 0) out.set(name, comp);
    else if (method === 8) out.set(name, await inflate(comp, 'deflate-raw'));
    else throw new Error(`Unsupported compression (method ${method}) in ${name}.`);
  }
  return out;
}
function parseNpy(u8) {
  if (u8[0] !== 0x93 || String.fromCharCode(u8[1], u8[2], u8[3], u8[4], u8[5]) !== 'NUMPY') throw new Error('not a .npy array');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), major = u8[6];
  let hl, off;
  if (major === 1) { hl = dv.getUint16(8, true); off = 10; } else { hl = dv.getUint32(8, true); off = 12; }
  const header = new TextDecoder(major >= 3 ? 'utf-8' : 'latin1').decode(u8.subarray(off, off + hl));
  const descr = (header.match(/'descr'\s*:\s*'([^']+)'/) || [])[1] || '';
  const fortran = /'fortran_order'\s*:\s*True/.test(header);
  const shape = ((header.match(/'shape'\s*:\s*\(([^)]*)\)/) || [])[1] || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
  const count = shape.reduce((a, b) => a * b, 1);
  const body = u8.subarray(off + hl), bd = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const m = /^([<>|=]?)([a-zA-Z])(\d+)$/.exec(descr);
  if (!m) throw new Error('unsupported dtype ' + descr);
  const le = m[1] !== '>', kind = m[2], size = +m[3];
  let data;
  if (kind === 'U') {
    data = [];
    for (let i = 0; i < count; i++) { let s = ''; for (let j = 0; j < size; j++) { const cp = bd.getUint32((i * size + j) * 4, le); if (!cp) break; s += String.fromCodePoint(cp); } data.push(s); }
  } else if (kind === 'S' || kind === 'a') {
    data = [];
    for (let i = 0; i < count; i++) { let s = ''; for (let j = 0; j < size; j++) { const c = body[i * size + j]; if (!c) break; s += String.fromCharCode(c); } data.push(s); }
  } else {
    const rd = {
      b1: o => body[o], i1: o => bd.getInt8(o), u1: o => body[o], i2: o => bd.getInt16(o, le), u2: o => bd.getUint16(o, le),
      i4: o => bd.getInt32(o, le), u4: o => bd.getUint32(o, le), i8: o => Number(bd.getBigInt64(o, le)), u8: o => Number(bd.getBigUint64(o, le)),
      f4: o => bd.getFloat32(o, le), f8: o => bd.getFloat64(o, le),
    }[kind + size];
    if (!rd) throw new Error('unsupported dtype ' + descr);
    data = kind === 'f' && size === 4 ? new Float32Array(count) : new Float64Array(count);
    for (let i = 0; i < count; i++) data[i] = rd(i * size);
  }
  return { descr, kind, size, shape, fortran, data };
}
const scalarOf = a => a && a.data && a.data.length ? a.data[0] : null;
async function parseRaw(u8, label) {
  const files = await unzip(u8), arr = {};
  for (const [name, bytes] of files) { if (!/\.npy$/.test(name)) continue; try { arr[name.replace(/\.npy$/, '').split('/').pop()] = parseNpy(bytes); } catch (e) { /* object arrays are skipped */ } }
  const x = arr.x;
  if (!x) throw new Error('This .npz has no "x" array, so it is not a raw capture file.');
  const names = arr.channel_names ? Array.from(arr.channel_names.data, String) : null;
  const fs = +scalarOf(arr.fs) || 200, ts = +scalarOf(arr.ts), id = scalarOf(arr.capture_id), lsb = +scalarOf(arr.lsb_g);
  let A = x.shape[0], B = x.shape.length > 1 ? x.shape[1] : 1;
  if (x.shape.length === 1) { A = 1; B = x.shape[0]; }
  let chFirst = true;
  if (names && names.length === B && names.length !== A) chFirst = false;
  const C = chFirst ? A : B, N = chFirst ? B : A;
  const isInt = x.kind === 'i' || x.kind === 'u';
  const factor = isInt ? (fin(lsb) && lsb > 0 ? lsb * 1000 : 3.9) : 1000;
  const idx = (a, b) => x.fortran ? a + b * A : a * B + b;
  const chans = [];
  for (let c = 0; c < C; c++) {
    const d = new Float32Array(N); let mean = 0;
    for (let i = 0; i < N; i++) { const v = x.data[chFirst ? idx(c, i) : idx(i, c)] * factor; d[i] = v; mean += v; }
    mean /= N || 1;
    for (let i = 0; i < N; i++) d[i] -= mean;
    const name = (names && names[c]) || `ch${c + 1}`;
    const nm = /^(n\d+)/i.exec(name), ax = /([xyz])$/i.exec(name);
    chans.push({ name, node: nm ? nm[1].toLowerCase() : null, axis: ax ? ax[1].toLowerCase() : null, data: d, offset: mean });
  }
  const key = String(id || label || 'raw-' + (S.raws.size + 1));
  return { key, id: id ? String(id) : null, label, ts: fin(ts) ? ts : null, fs, N, dur: N / fs, chans, descr: x.descr, isInt, lsbKnown: fin(lsb) && lsb > 0 };
}
async function openRawBytes(u8, label, fromBroker) {
  try {
    const raw = await parseRaw(u8, label);
    S.raws.set(raw.key, raw); RAW.cur = raw.key;
    toast(fromBroker ? `Full-resolution data for capture ${raw.id || raw.key} arrived.` : `Opened ${label}.`);
    if (currentPage() === 'vibration') renderRaw();
  } catch (e) {
    $('#raw-view').innerHTML = `<div class="notice bad">Could not read ${esc(label)}: ${esc(e.message)}</div>`;
  }
}
function renderRaw() {
  const view = $('#raw-view'), ctl = $('#raw-controls');
  ctl.hidden = !S.raws.size;
  if (!S.raws.size) { view.innerHTML = '<div class="empty-chart">No raw file open. Open a .npz file, or ask the base station for the capture shown above.</div>'; return; }
  const sel = $('#raw-select');
  sel.innerHTML = [...S.raws.values()].reverse().map(r => `<option value="${esc(r.key)}">${esc(r.id ? 'Capture ' + r.id : r.label)}${r.ts ? ', ' + esc(fmtDT(r.ts)) : ''}</option>`).join('');
  if (!S.raws.has(RAW.cur)) RAW.cur = [...S.raws.keys()].pop();
  sel.value = RAW.cur;
  const raw = S.raws.get(RAW.cur);
  $$('#raw-axis button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === RAW.axis));
  let chs = raw.chans.filter(c => c.axis === RAW.axis);
  const axisKnown = chs.length > 0;
  if (!axisKnown) chs = raw.chans;
  const conv = raw.isInt ? (raw.lsbKnown ? 'stored as counts, converted with the file\'s scale' : 'stored as counts; no scale in the file, so 3.9 mg per count is assumed') : 'stored in g';
  view.innerHTML = `<p class="raw-meta">${raw.id ? 'Capture ' + esc(raw.id) + ', ' : ''}${raw.ts ? esc(fmtDT(raw.ts)) + ', ' : ''}${raw.fs} samples a second for ${fmt(raw.dur, 1)} s, ${raw.chans.length} channels (${conv}). The steady part (gravity and offset) is removed.${axisKnown ? '' : ' Channel names have no axis letter, so all channels are shown.'}</p><div class="chart" id="raw-waves"></div><h3 style="margin-top:16px">Spectrum, computed here</h3><p class="sub">Hann-window Welch average with 5.12 s segments.</p><div class="chart" id="raw-spec"></div>`;
  waveStack($('#raw-waves'), { label: 'Raw waveforms', fs: raw.fs, dur: raw.dur, unit: 'mg', chans: chs.map(c => ({ name: c.name, label: c.name, sub: c.node ? NODE_PLACE[c.node] : '', data: c.data, color: NODE_COLOR[c.node] || 'var(--trace)' })) });
  const series = chs.map(c => {
    const w = welch(c.data, raw.fs, 5.12), pts = [];
    for (let k = 0; k < w.psd.length; k++) pts.push([k * w.df, 10 * Math.log10(Math.max(w.psd[k], 1e-12))]);
    return { name: c.name, pts, color: NODE_COLOR[c.node] || 'var(--trace)' };
  });
  const bl = baseline();
  lineChart($('#raw-spec'), {
    label: 'Raw spectrum', series, xMin: 0, xMax: raw.fs / 2, height: 260,
    vlines: bl ? bl.freq.filter(fin).map(f => ({ x: f, cls: 'base' })) : [],
    fmtY: v => fmt(v, 0), tipTitle: x => fmt(x, 2) + ' Hz', fmtTip: v => fmt(v, 1) + ' dB',
  });
}

/* ================= trends ================= */
const TR = { range: '24h', rows: 100, last: 0, key: '' };
function renderTrends(force) {
  const spans = { '6h': 6 * 3600, '24h': 86400, '7d': 7 * 86400, all: Infinity };
  const span = spans[TR.range], end = nowRef(), start = span === Infinity ? (S.caps[0]?.ts ?? end - 86400) : end - span;
  const key = TR.range + '|' + $('#tr-score').clientWidth;
  if (!force && key === TR.key && performance.now() - TR.last < 10000) return;
  TR.key = key; TR.last = performance.now();
  $$('#tr-range button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === TR.range));
  const caps = S.caps.filter(c => c.ts >= start && c.ts <= end + 60);
  const bl = baseline();
  const hourly = (span === Infinity ? end - start : span) > 86400 + 1;
  let rows;
  if (hourly) {
    const b = new Map();
    for (const c of caps) { const h = Math.floor(c.ts / 3600); if (!b.has(h)) b.set(h, []); b.get(h).push(c); }
    rows = [...b.entries()].sort((x, y) => x[0] - y[0]).map(([h, g]) => ({
      ts: h * 3600 + 1800, n: g.length, ratio: median(g.map(c => c.ratio)), maxRatio: Math.max(...g.map(c => fin(c.ratio) ? c.ratio : -1)),
      fpc: [0, 1, 2].map(i => median(g.map(c => freqPct(c, i, bl)))), mac: [0, 1, 2].map(i => median(g.map(c => Array.isArray(c.mac) ? +c.mac[i] : NaN))), temp: median(g.map(c => +c.temp)),
      state: g.some(c => c.state === 'ALARM') ? 'ALARM' : g.some(c => c.state === 'WARNING') ? 'WARNING' : 'NORMAL',
    }));
  } else rows = caps.map(c => ({ ts: c.ts, id: c.id, ratio: c.ratio, fpc: [0, 1, 2].map(i => freqPct(c, i, bl)), mac: [0, 1, 2].map(i => Array.isArray(c.mac) ? +c.mac[i] : null), temp: +c.temp, state: c.state, c }));
  const gap = hourly ? 3 * 3600 : 1800;
  $('#tr-sub').textContent = caps.length ? `${plural(caps.length, 'capture')} from ${fmtDT(caps[0].ts)} to ${fmtDT(caps[caps.length - 1].ts)}.${hourly ? ' Charts show hourly medians.' : ''}` : 'No captures in this range.';
  const common = { xTime: true, xMin: start, xMax: end, gap, height: 200 };
  const emptyMsg = S.caps.length ? 'No captures in this range. Try a longer one.' : 'No captures yet. Connect, or open a history file on the <a href="#connect">Connect page</a>.';
  lineChart($('#tr-score'), {
    ...common, label: 'Anomaly score', yMin: 0, refs: [{ y: 1, label: 'alarm level', cls: 'alarm' }], empty: emptyMsg,
    series: [{ name: hourly ? 'Hourly median score' : 'Anomaly score', pts: rows.map(r => [r.ts, r.ratio, r]), color: 'var(--trace)', dotClass: p => p[2].state === 'ALARM' ? 'bad' : p[2].state === 'WARNING' ? 'warn' : null }],
    onClick: hourly ? null : p => openCapture(p[2].id),
    fmtTip: (v, s, p) => fmt(v, 2) + (hourly && fin(p[2].maxRatio) ? ` <span class="c-mute">highest ${fmt(p[2].maxRatio, 2)}</span>` : ''),
    tipExtra: (x, rs) => hourly ? `<div class="tx">${rs[0]?.p[2].n} captures in this hour</div>` : '<div class="tx">Click to open its vibration</div>',
  });
  lineChart($('#tr-freq'), {
    ...common, label: 'Frequency change', refs: [{ y: -3, label: MINUS + '3 %', cls: 'warn' }, { y: 0, cls: 'zero' }],
    empty: bl ? emptyMsg : 'Needs at least 5 good normal captures to set the healthy baseline.',
    series: [0, 1, 2].map(i => ({ name: `Mode ${i + 1}${bl ? ' (' + fmt(bl.freq[i], 2) + ' Hz)' : ''}`, pts: rows.map(r => [r.ts, r.fpc[i]]), color: MODE_COLOR[i] })),
    fmtY: v => (v > 0 ? '+' : '') + fmt(v, 1), fmtTip: v => fmtPct(v, 2),
  });
  $('#tr-freq-sub').textContent = bl ? `Change from the healthy baseline (median of the first ${bl.n} normal captures). A drop of more than 3 % deserves a look.` : 'A drop of more than 3 % deserves a look.';
  lineChart($('#tr-mac'), {
    ...common, label: 'Mode shape match', yMax: 1, empty: emptyMsg,
    series: [0, 1, 2].map(i => ({ name: `Mode ${i + 1}`, pts: rows.map(r => [r.ts, r.mac[i]]), color: MODE_COLOR[i] })),
    fmtY: v => fmt(v, 2), fmtTip: v => fmt(v, 3),
  });
  lineChart($('#tr-temp'), {
    ...common, label: 'Deck temperature', empty: emptyMsg,
    series: [{ name: 'Deck temperature', pts: rows.map(r => [r.ts, r.temp]), color: 'var(--c2)' }],
    fmtY: v => fmt(v, 0) + '°', fmtTip: v => fmt(v, 1) + ' °C',
  });
  renderTrendTable(caps, bl);
}
function renderTrendTable(caps, bl) {
  const list = caps.slice().reverse(), shown = list.slice(0, TR.rows);
  $('#tr-count').textContent = list.length ? `Newest first, ${shown.length} of ${list.length}` : '';
  const head = `<thead><tr><th>Time</th><th>Capture</th><th>State</th><th class="r">Score</th>${[1, 2, 3].map(i => `<th class="r">Mode ${i}</th>`).join('')}<th class="r">Temp</th><th>Quality</th></tr></thead>`;
  const body = shown.map(c => {
    const f = [0, 1, 2].map(i => { const v = Array.isArray(c.freq) ? +c.freq[i] : NaN, pc = freqPct(c, i, bl); return fin(v) ? `${fmt(v, 2)}${pc != null ? ` <span class="${pc < -3 ? 'c-bad' : 'c-mute'}">${fmtPct(pc)}</span>` : ''}` : '–'; });
    return `<tr><td>${esc(fmtDT(c.ts))}</td><td><a href="#vibration/${encodeURIComponent(c.id)}">${esc(c.id)}</a>${S.prevs.has(c.id) ? '' : ' <span class="c-mute" title="No waveform preview">(score only)</span>'}</td><td><span class="badge ${STATE_CLS[c.state] || ''}">${STATE_WORD[c.state] || esc(c.state || '')}</span></td><td class="r">${fmt(c.ratio, 2)}</td>${f.map(x => `<td class="r">${x}</td>`).join('')}<td class="r">${fin(+c.temp) ? fmt(+c.temp, 1) + ' °C' : '–'}</td><td>${c.q ? 'good' : `<span class="c-warn">${esc((c.flags || []).join(', ').replace(/_/g, ' ') || 'problem')}</span>`}</td></tr>`;
  }).join('');
  $('#tr-table').innerHTML = list.length ? head + '<tbody>' + body + '</tbody>' : '<tbody><tr><td style="padding:16px">No captures in this range.</td></tr></tbody>';
  $('#tr-more').hidden = list.length <= TR.rows;
}

/* ================= events ================= */
const EV = { filter: 'all' };
function renderEvents() {
  $$('#ev-filter button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === EV.filter));
  let list = S.events.slice().reverse();
  if (EV.filter === 'state') list = list.filter(e => e.type === 'state' && (e.to === 'ALARM' || e.to === 'WARNING' || e.from === 'ALARM' || e.from === 'WARNING'));
  if (EV.filter === 'fault') list = list.filter(e => e.type === 'fault' || e.type === 'recovered');
  const shown = list.slice(0, 400);
  $('#ev-list').innerHTML = shown.length ? timelineHTML(shown, true) + (list.length > shown.length ? `<p class="hint">Showing the newest 400 of ${list.length}.</p>` : '') : `<div class="empty-chart">${S.events.length ? 'No events of this kind.' : 'No events yet. The base station reports each change of state and each fault; older ones come from the history file.'}</div>`;
}

/* ================= system ================= */
function renderSystem() {
  const hb = lastHb(), now = nowRef();
  const on = S.online === '1' ? '<span class="badge ok">Online</span>' : S.online === '0' ? '<span class="badge bad">Offline</span>' : '<span class="badge">Online status unknown</span>';
  $('#sys-online').innerHTML = on;
  $('#sys-sub').textContent = hb ? `From the heartbeat received ${fmtAgo(hb._ts, nowS())} (one every 15 minutes).` : 'From the latest heartbeat (sent every 15 minutes).';
  if (!hb) {
    $('#sys-facts').innerHTML = '<div class="empty-chart" style="margin-top:10px">No heartbeat yet. The base station sends one every 15 minutes; use "Request status" below to ask for one now.</div>';
  } else {
    const mo = hb.modem || {}, lu = +S.liveUntil;
    const fact = (k, v, small) => `<div><dt>${k}</dt><dd>${v}${small ? ` <small>${small}</small>` : ''}</dd></div>`;
    $('#sys-facts').innerHTML = `<dl class="facts">
      ${fact('Running for', esc(fmtDur(+hb.uptime_s)))}
      ${fact('Processor temperature', fin(+hb.cpu_temp_c) ? fmt(+hb.cpu_temp_c, 1) + ' °C' : '–', +hb.cpu_temp_c > 75 ? 'hot' : '')}
      ${fact('Free disk space', fin(+hb.disk_free_gb) ? fmt(+hb.disk_free_gb, 1) + ' GB' : '–')}
      ${fact('Waiting to send', fin(+hb.backlog) ? plural(+hb.backlog, 'message') : '–')}
      ${fact('Mobile signal', fin(+mo.signal_pct) ? Math.round(+mo.signal_pct) + ' %' : '–', esc([mo.tech, mo.operator].filter(Boolean).join(' with ')))}
      ${fact('Live view', fin(lu) && lu > nowS() ? 'on' : 'off', fin(lu) && lu > nowS() ? 'until ' + fmtClock(lu) : '')}
    </dl>`;
  }
  const st = nodeStatuses();
  $('#sys-nodes').innerHTML = `<div class="nodes-list">${NODES.map(n => {
    const e = hb && Array.isArray(hb.nodes) ? hb.nodes.find(x => x && (x.node_id === n || x.node === n)) : null;
    return `<div class="nrow"><span class="d" style="background:var(--${st[n].cls || 'ink3'})"></span><div><b>Node ${n.slice(1)}</b> <span class="t">${NODE_PLACE[n]}</span><div class="t">${e && fin(+e.age_s) ? `last packet ${fmtDur(+e.age_s)} before the heartbeat` : 'not in the latest heartbeat'}</div></div><span class="badge ${st[n].cls}">${esc(st[n].text)}</span></div>`;
  }).join('')}</div>`;
  const faults = hb && Array.isArray(hb.faults) ? hb.faults : [];
  $('#sys-faults').innerHTML = !hb ? '<p class="hint">Faults are listed in each heartbeat.</p>' : faults.length ? `<ul class="timeline">${faults.map(f => `<li><span class="mk warn"></span><div class="what">${esc(String(f).replace(/_/g, ' '))}</div></li>`).join('')}</ul>` : '<p class="hint"><span class="c-ok">✓</span> None. Everything the base station checks is working.</p>';
  renderCmdLog();
}
