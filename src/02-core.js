'use strict';
/* ================= constants and helpers ================= */
const MQTT_URL = 'https://cdn.jsdelivr.net/npm/mqtt@5.10.1/dist/mqtt.min.js';
const SQLJS_URL = 'https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/sql-asm.js';
const NODES = ['n1', 'n2', 'n3'];
const NODE_U = { n1: 0.25, n2: 0.5, n3: 0.75 };
const NODE_PLACE = { n1: 'quarter span', n2: 'mid-span', n3: 'three-quarter span' };
const NODE_COLOR = { n1: 'var(--c1)', n2: 'var(--c2)', n3: 'var(--c3)' };
const MODE_COLOR = ['var(--c1)', 'var(--c2)', 'var(--c3)'];
const RM = window.matchMedia('(prefers-reduced-motion: reduce)');

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nowS = () => Date.now() / 1000;
const fin = v => typeof v === 'number' && isFinite(v);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function median(arr) {
  const b = arr.filter(fin).sort((x, y) => x - y);
  if (!b.length) return null;
  const m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
}
const MINUS = '−';
function fmt(v, d = 2) { return fin(v) ? (v < 0 ? MINUS : '') + Math.abs(v).toFixed(d) : '–'; }
function fmtPct(v, d = 1) {
  if (!fin(v)) return '–';
  const r = +v.toFixed(d);
  if (r === 0) return (0).toFixed(d) + ' %';
  return (r > 0 ? '+' : MINUS) + Math.abs(r).toFixed(d) + ' %';
}
function fmtDur(sec) {
  if (!fin(sec)) return '–';
  sec = Math.max(0, sec);
  if (sec < 60) return Math.round(sec) + ' s';
  const m = Math.floor(sec / 60);
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60);
  if (h < 48) return h + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
  const d = Math.floor(h / 24);
  return d + ' days' + (h % 24 ? ' ' + (h % 24) + ' h' : '');
}
function fmtAgo(ts, ref) {
  if (!fin(ts)) return 'never';
  const s = (ref ?? nowS()) - ts;
  if (s < 45) return 'just now';
  return fmtDur(s) + ' ago';
}
function fmtClock(ts, secs) { return new Date(ts * 1000).toLocaleTimeString([], secs ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' }); }
function fmtDay(ts) { return new Date(ts * 1000).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }); }
function fmtDT(ts) {
  if (!fin(ts)) return '–';
  const d = new Date(ts * 1000), n = new Date();
  if (d.toDateString() === n.toDateString()) return 'today ' + fmtClock(ts);
  return fmtDay(ts) + ', ' + fmtClock(ts);
}
function dayKey(ts) { const d = new Date(ts * 1000); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
function safeJSON(t) { try { return typeof t === 'string' ? JSON.parse(t) : t; } catch (e) { return null; } }
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }

let toastTimer = 0;
function toast(msg, ms = 3800) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

const scriptP = {};
function loadScript(url) {
  if (scriptP[url]) return scriptP[url];
  return (scriptP[url] = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = url; s.async = true; s.crossOrigin = 'anonymous';
    s.onload = () => res();
    s.onerror = () => { delete scriptP[url]; s.remove(); rej(new Error('Could not load ' + url.split('/npm/')[1].split('/')[0] + ' from cdn.jsdelivr.net. Check the internet connection' + (inArtifactViewer() ? ', or open the downloaded file directly instead of inside the claude.ai viewer.' : '.'))); };
    document.head.appendChild(s);
  }));
}
function inArtifactViewer() {
  const h = location.hostname || '';
  let anc = '';
  try { anc = [...(location.ancestorOrigins || [])].join(' '); } catch (e) { }
  return /claude\.ai|claudeusercontent|anthropic/i.test(h + ' ' + anc + ' ' + document.referrer);
}

/* readable "why" text: "freq_m1 lower than expected (-6.6 sd)" */
function humanWhy(why) {
  if (!why) return '';
  return String(why).split(/;\s*/).filter(Boolean).map(part => {
    let p = part.trim();
    p = p.replace(/\bfreq_m(\d)\b/g, 'mode $1 frequency')
      .replace(/\bmac_m(\d)\b/g, 'mode $1 shape match')
      .replace(/\brms_n(\d)\b/g, 'vibration level at node $1')
      .replace(/\bdamp_m(\d)\b/g, 'mode $1 damping')
      .replace(/\b(n\d)_(\w+)/g, '$1 $2')
      .replace(/\(\s*([+\-−]?)(\d+(?:\.\d+)?)\s*sd\s*\)/g, (m, s, n) => `(${n}× the usual spread)`);
    return p.charAt(0).toUpperCase() + p.slice(1);
  }).join('. ') + '.';
}

/* ================= data store ================= */
const S = {
  site: 'bridge01',
  caps: [], capById: new Map(),
  prevs: new Map(),
  events: [], evKeys: new Set(),
  hbs: [],
  piState: null, online: null, onlineTs: null,
  raws: new Map(),
  liveUntil: null,
  file: null,
  ver: 0,
  lastMsg: null,
};
function resetData() {
  S.caps = []; S.capById = new Map(); S.prevs = new Map(); S.events = []; S.evKeys = new Set(); S.hbs = [];
  S.piState = null; S.online = null; S.onlineTs = null; S.liveUntil = null; S.file = null; S.raws = new Map(); S.lastMsg = null;
  S.ver++;
  replayReset();
  VIB.id = null; VIB.follow = true; RAW.cur = null;
}
function normCap(c) {
  if (!c || c.id == null) return null;
  c.id = String(c.id); c.ts = +c.ts;
  if (!fin(c.ts)) return null;
  if (c.ratio != null) c.ratio = +c.ratio;
  if (!c.nodes || typeof c.nodes !== 'object') c.nodes = {};
  return c;
}
function addCapture(c) {
  c = normCap(c); if (!c) return;
  const ex = S.capById.get(c.id);
  if (ex) { const i = S.caps.indexOf(ex); if (i >= 0) S.caps[i] = c; }
  else {
    const a = S.caps;
    if (!a.length || a[a.length - 1].ts <= c.ts) a.push(c);
    else { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m].ts <= c.ts) lo = m + 1; else hi = m; } a.splice(lo, 0, c); }
  }
  S.capById.set(c.id, c); S.ver++;
}
function addCapturesBulk(list) {
  for (const c0 of list) { const c = normCap(c0); if (!c) continue; if (S.capById.has(c.id)) { const i = S.caps.indexOf(S.capById.get(c.id)); if (i >= 0) S.caps[i] = c; } else S.caps.push(c); S.capById.set(c.id, c); }
  S.caps.sort((a, b) => a.ts - b.ts); S.ver++;
}
function addPreview(p, quiet) {
  if (!p || p.id == null) return;
  p.id = String(p.id); p.ts = +p.ts;
  S.prevs.set(p.id, p); S.ver++;
  if (!quiet) onNewPreview(p);
}
function addEvent(e) {
  if (!e || !e.type) return;
  e.ts = +e.ts || nowS();
  const k = [e.ts, e.type, e.to || '', e.what || '', e.capture_id || ''].join('|');
  if (S.evKeys.has(k)) return;
  S.evKeys.add(k);
  const a = S.events;
  if (!a.length || a[a.length - 1].ts <= e.ts) a.push(e); else { a.push(e); a.sort((x, y) => x.ts - y.ts); }
  S.ver++;
}
function addHeartbeat(h, ts) {
  if (!h || typeof h !== 'object') return;
  h._ts = fin(+ts) ? +ts : nowS();
  const a = S.hbs;
  if (!a.length || a[a.length - 1]._ts <= h._ts) a.push(h); else { a.push(h); a.sort((x, y) => x._ts - y._ts); }
  if (a.length > 3000) a.splice(0, a.length - 3000);
  if (h.live_until !== undefined && h === a[a.length - 1]) S.liveUntil = h.live_until;
  S.ver++;
}
const lastCap = () => S.caps[S.caps.length - 1] || null;
const lastHb = () => S.hbs[S.hbs.length - 1] || null;
let _plv = -1, _pl = [];
function prevList() { if (_plv !== S.ver) { _pl = [...S.prevs.values()].sort((a, b) => a.ts - b.ts); _plv = S.ver; } return _pl; }
function isLive() { return DEMO.on || !!(MQ.client && MQ.connected); }
function nowRef() { if (isLive()) return nowS(); const l = lastCap(); return l ? Math.max(l.ts, lastHb()?._ts || 0) : nowS(); }

/* healthy baseline: median of the first 50 good NORMAL captures */
let _blv = -1, _bl = null;
function baseline() {
  if (_blv === S.ver) return _bl;
  _blv = S.ver;
  const good = [];
  for (const c of S.caps) {
    if (c.q && c.state === 'NORMAL' && Array.isArray(c.freq) && c.freq.length >= 3) { good.push(c); if (good.length >= 50) break; }
  }
  if (good.length < 5) return (_bl = null);
  return (_bl = {
    n: good.length,
    freq: [0, 1, 2].map(i => median(good.map(c => +c.freq[i]))),
    mac: [0, 1, 2].map(i => median(good.map(c => Array.isArray(c.mac) ? +c.mac[i] : NaN))),
  });
}
function freqPct(c, i, bl) {
  bl = bl || baseline();
  if (!bl || !c || !Array.isArray(c.freq) || !fin(+c.freq[i]) || !fin(bl.freq[i])) return null;
  return (c.freq[i] / bl.freq[i] - 1) * 100;
}

/* node status: reporting / bad data / silent (> 10 min) */
function nodeStatuses() {
  const now = nowRef(), last = lastCap(), hb = lastHb();
  const out = {};
  for (const n of NODES) {
    let heard = null;
    for (let i = S.caps.length - 1, k = 0; i >= 0 && k < 600; i--, k++) {
      const c = S.caps[i];
      if (c.nodes && Object.prototype.hasOwnProperty.call(c.nodes, n)) { heard = c.ts; break; }
    }
    if (hb && Array.isArray(hb.nodes)) {
      const e = hb.nodes.find(x => x && (x.node_id === n || x.node === n));
      if (e && fin(+e.age_s)) { const t = hb._ts - e.age_s; if (heard == null || t > heard) heard = t; }
    }
    const bad = !!(last && last.nodes && Object.prototype.hasOwnProperty.call(last.nodes, n) && last.nodes[n] == null);
    let st;
    if (heard == null) st = { key: 'silent', cls: 'bad', text: 'no data yet' };
    else if (now - heard > 600) st = { key: 'silent', cls: 'bad', text: 'silent for ' + fmtDur(now - heard) };
    else if (bad) st = { key: 'bad', cls: 'warn', text: 'bad data' };
    else st = { key: 'ok', cls: 'ok', text: 'reporting' };
    st.heard = heard;
    out[n] = st;
  }
  if (!last && !hb) for (const n of NODES) out[n] = { key: 'none', cls: '', text: 'no data yet', heard: null };
  return out;
}

/* ================= preview decoding ================= */
function b64ToBytes(b64) { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
async function streamThrough(u8, ctor, fmt) {
  if (typeof window[ctor] === 'undefined') throw new Error('This browser cannot unpack compressed data. Use a current version of Chrome, Edge, Firefox or Safari.');
  const st = new Blob([u8]).stream().pipeThrough(new window[ctor](fmt));
  return new Uint8Array(await new Response(st).arrayBuffer());
}
const inflate = (u8, fmt) => streamThrough(u8, 'DecompressionStream', fmt);
const deflate = (u8, fmt) => streamThrough(u8, 'CompressionStream', fmt);
async function decodeWave(nd) {
  if (!nd || !nd.wave) return null;
  const raw = await inflate(b64ToBytes(nd.wave), 'deflate');
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const n = raw.byteLength >> 1, out = new Float32Array(n), sc = +nd.scale || 1, delta = nd.coding === 'delta';
  let acc = 0;
  for (let i = 0; i < n; i++) { const v = dv.getInt16(i * 2, true); if (delta) { acc += v; out[i] = acc * sc; } else out[i] = v * sc; }
  return out;
}
function waveStats(w) {
  let pk = 0, pi = 0, ss = 0;
  for (let i = 0; i < w.length; i++) { const a = Math.abs(w[i]); ss += w[i] * w[i]; if (a > pk) { pk = a; pi = i; } }
  return { peak: pk, peakI: pi, rms: Math.sqrt(ss / Math.max(1, w.length)) };
}
function decodePreview(p) {
  if (!p) return Promise.resolve(null);
  if (p._dec) return Promise.resolve(p._dec);
  if (p._decP) return p._decP;
  return (p._decP = (async () => {
    const fs = +p.fs || 50, dur = +p.dur || 30;
    const nodes = {};
    for (const nd of (Array.isArray(p.nodes) ? p.nodes : [])) {
      if (!nd || !nd.node) continue;
      let wave = null, err = null;
      try { wave = await decodeWave(nd); } catch (e) { err = e.message; }
      const st = wave ? waveStats(wave) : null;
      nodes[nd.node] = {
        ok: nd.ok !== false, n: nd.n, wave, err,
        spec: Array.isArray(nd.spec) ? Float32Array.from(nd.spec, v => v / 10) : null,
        rms: fin(+nd.rms) ? +nd.rms : st?.rms, peak: fin(+nd.peak) ? +nd.peak : st?.peak,
        peakT: st ? st.peakI / fs : null, noise: nd.noise,
        spikes: Array.isArray(nd.spikes) ? nd.spikes : [], glitches: Array.isArray(nd.glitches) ? nd.glitches : [],
      };
    }
    p._dec = { fs, dur, df: +p.df || fs / 256, events: Array.isArray(p.events) ? p.events : [], nodes };
    return p._dec;
  })());
}

/* ================= signal processing ================= */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), h = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < h; k++) {
        const a = i + k, b = a + h;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nc = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nc;
      }
    }
  }
}
/* Hann-window Welch PSD, 50 % overlap, segment about segSec long (power of two). Units: input^2 / Hz */
function welch(x, fs, segSec = 5.12) {
  let n = Math.pow(2, Math.round(Math.log2(Math.max(8, segSec * fs))));
  while (n > x.length && n > 8) n >>= 1;
  const w = new Float64Array(n); let U = 0;
  for (let i = 0; i < n; i++) { w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n); U += w[i] * w[i]; }
  const re = new Float64Array(n), im = new Float64Array(n), nb = n / 2 + 1, psd = new Float64Array(nb);
  let segs = 0;
  for (let s = 0; s + n <= x.length; s += n / 2) {
    let mean = 0; for (let i = 0; i < n; i++) mean += x[s + i]; mean /= n;
    for (let i = 0; i < n; i++) { re[i] = (x[s + i] - mean) * w[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < nb; k++) psd[k] += re[k] * re[k] + im[k] * im[k];
    segs++;
  }
  const sc = 1 / (fs * U * Math.max(1, segs));
  for (let k = 0; k < nb; k++) psd[k] *= sc * (k === 0 || k === nb - 1 ? 1 : 2);
  return { psd, df: fs / n, n };
}

/* ================= charts ================= */
function niceTicks(min, max, n = 5) {
  const span = max - min || 1, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), e = raw / mag;
  const step = (e >= 7.5 ? 10 : e >= 3.5 ? 5 : e >= 1.5 ? 2 : 1) * mag;
  const out = [];
  for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + step * 1e-9; v += step) out.push(+v.toFixed(10));
  return { ticks: out, step };
}
function timeTicks(min, max, n = 6) {
  const steps = [60, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800];
  const span = max - min, step = steps.find(s => span / s <= n) || 604800;
  const off = new Date(min * 1000).getTimezoneOffset() * 60;
  const out = [];
  for (let t = Math.ceil((min - off) / step) * step + off; t <= max; t += step) out.push(t);
  return { ticks: out, step, fmt: t => step >= 86400 ? fmtDay(t).replace(/,.*/, '') : (new Date(t * 1000).getHours() === 0 && new Date(t * 1000).getMinutes() === 0 ? new Date(t * 1000).toLocaleDateString([], { weekday: 'short' }) : fmtClock(t)) };
}
function nearestPt(pts, xv) {
  if (!pts.length) return null;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m][0] < xv) lo = m; else hi = m; }
  let best = null, bd = Infinity;
  for (let i = Math.max(0, lo - 3); i <= Math.min(pts.length - 1, hi + 3); i++) {
    const p = pts[i]; if (!p || !fin(p[1])) continue;
    const d = Math.abs(p[0] - xv); if (d < bd) { bd = d; best = p; }
  }
  if (!best) { for (let i = lo; i >= 0; i--) if (fin(pts[i][1])) { best = pts[i]; break; } }
  return best;
}
/* generic line chart. o: {series:[{name,pts:[[x,y,meta]],color,dash,dots,dotClass,width,noTip}], xTime, xMin,xMax,yMin,yMax, refs:[{y,label,cls}], vlines:[{x,label,cls}], bands:[[x0,x1]], height, gap, onClick, tipTitle, fmtY, fmtTip, empty, label} */
function lineChart(el, o) {
  const W = Math.max(260, Math.floor(el.clientWidth || 600)), H = o.height || (W < 500 ? 190 : 220);
  const m = { l: o.ml ?? 46, r: o.mr ?? 14, t: o.mt ?? 14, b: 26 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const series = (o.series || []).filter(s => s && s.pts);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, any = false;
  for (const s of series) for (const p of s.pts) {
    if (!p || !fin(p[1])) continue; any = true;
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
  if (!any) { el.innerHTML = `<div class="empty-chart">${o.empty || 'Nothing to show yet.'}</div>`; return; }
  if (o.xMin != null) x0 = o.xMin; if (o.xMax != null) x1 = o.xMax;
  for (const r of o.refs || []) if (fin(r.y) && !r.noFit) { y0 = Math.min(y0, r.y); y1 = Math.max(y1, r.y); }
  if (x1 === x0) { x0 -= 1; x1 += 1; }
  if (y1 === y0) { y0 -= 1; y1 += 1; }
  const pad = (y1 - y0) * 0.08;
  y0 = o.yMin != null ? o.yMin : y0 - pad; y1 = o.yMax != null ? Math.max(o.yMax, o.yMaxSoft ? y1 + pad : o.yMax) : y1 + pad;
  const X = v => m.l + (v - x0) / (x1 - x0) * pw, Y = v => m.t + (1 - (v - y0) / (y1 - y0)) * ph;
  const fy = o.fmtY || (v => fmt(v, Math.abs(y1 - y0) < 0.5 ? 2 : Math.abs(y1 - y0) < 5 ? 1 : 0));
  let svg = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(o.label || 'chart')}">`;
  svg += `<rect class="paper" x="${m.l}" y="${m.t}" width="${pw}" height="${ph}"/>`;
  for (const v of niceTicks(y0, y1, ph < 150 ? 3 : 5).ticks) {
    if (v < y0 || v > y1) continue;
    svg += `<line class="grid" x1="${m.l}" x2="${m.l + pw}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text x="${m.l - 6}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${fy(v)}</text>`;
  }
  const xt = o.xTime ? timeTicks(x0, x1, Math.max(3, Math.floor(pw / 95))) : niceTicks(x0, x1, Math.max(3, Math.floor(pw / 70)));
  for (const v of xt.ticks) {
    if (v < x0 || v > x1) continue;
    svg += `<line class="grid" x1="${X(v).toFixed(1)}" x2="${X(v).toFixed(1)}" y1="${m.t}" y2="${m.t + ph}"/><text x="${X(v).toFixed(1)}" y="${H - 7}" text-anchor="middle">${o.xTime ? xt.fmt(v) : (o.fmtX ? o.fmtX(v) : v)}</text>`;
  }
  for (const b of o.bands || []) {
    const a = clamp(X(b[0]), m.l, m.l + pw), z = clamp(X(b[1]), m.l, m.l + pw);
    if (z > a) svg += `<rect class="band" x="${a.toFixed(1)}" y="${m.t}" width="${(z - a).toFixed(1)}" height="${ph}"/>`;
  }
  for (const r of o.refs || []) {
    if (!fin(r.y) || r.y < y0 || r.y > y1) continue;
    svg += `<line class="ref ${r.cls || ''}" x1="${m.l}" x2="${m.l + pw}" y1="${Y(r.y).toFixed(1)}" y2="${Y(r.y).toFixed(1)}"/>`;
    if (r.label) svg += `<text class="ref-lab ${r.cls || ''}" x="${m.l + pw - 4}" y="${(Y(r.y) - 5).toFixed(1)}" text-anchor="end">${esc(r.label)}</text>`;
  }
  let lab = 0;
  for (const v of o.vlines || []) {
    if (!fin(v.x) || v.x < x0 || v.x > x1) continue;
    const xx = X(v.x).toFixed(1);
    svg += `<line class="vline ${v.cls || ''}" x1="${xx}" x2="${xx}" y1="${m.t}" y2="${m.t + ph}"/>`;
    if (v.label) { const right = X(v.x) > m.l + pw - 110; svg += `<text class="vlab ${v.cls || ''}" x="${(X(v.x) + (right ? -5 : 5)).toFixed(1)}" y="${m.t + 14 + (lab++ % 3) * 15}" text-anchor="${right ? 'end' : 'start'}">${esc(v.label)}</text>`; }
  }
  for (const s of series) {
    let d = '', pen = false, lx = null;
    for (const p of s.pts) {
      if (!p || !fin(p[1])) { pen = false; continue; }
      if (o.gap && lx != null && p[0] - lx > o.gap) pen = false;
      d += (pen ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(clamp(p[1], y0, y1)).toFixed(1);
      pen = true; lx = p[0];
    }
    svg += `<path class="ser" d="${d}" style="stroke:${s.color || 'var(--trace)'};${s.width ? 'stroke-width:' + s.width + 'px;' : ''}"${s.dash ? ' stroke-dasharray="' + s.dash + '"' : ''}/>`;
    if (s.dotClass) for (const p of s.pts) {
      if (!p || !fin(p[1])) continue;
      const c = s.dotClass(p); if (!c) continue;
      svg += `<circle class="dot ${c}" cx="${X(p[0]).toFixed(1)}" cy="${Y(clamp(p[1], y0, y1)).toFixed(1)}" r="3.6"/>`;
    }
  }
  svg += `<rect class="frame" x="${m.l}" y="${m.t}" width="${pw}" height="${ph}"/>`;
  svg += `<line class="xhair" y1="${m.t}" y2="${m.t + ph}" visibility="hidden"/><g class="hdots"></g>`;
  svg += `<rect class="hit${o.onClick ? ' clickable' : ''}" x="${m.l}" y="${m.t}" width="${pw}" height="${ph}"/></svg>`;
  const legSeries = series.filter(s => s.name && !s.noLegend);
  const legend = legSeries.length >= 2 ? `<div class="legend">${legSeries.map(s => `<span><i class="${s.dash ? 'dash' : ''}" style="border-color:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>` : '';
  el.innerHTML = legend + `<div class="chart-box">${svg}<div class="tip" hidden></div></div>`;
  const box = el.querySelector('.chart-box'), svgEl = box.querySelector('svg'), tip = box.querySelector('.tip'), xh = svgEl.querySelector('.xhair'), hd = svgEl.querySelector('.hdots'), hit = svgEl.querySelector('.hit');
  const toX = e => { const r = svgEl.getBoundingClientRect(); return x0 + ((e.clientX - r.left) * (W / r.width) - m.l) / pw * (x1 - x0); };
  const hide = () => { tip.hidden = true; xh.setAttribute('visibility', 'hidden'); hd.innerHTML = ''; };
  hit.addEventListener('pointermove', e => {
    const xv = toX(e); let snap = null; const rows = [];
    for (const s of series) { if (s.noTip) continue; const p = nearestPt(s.pts, xv); if (!p) continue; if (snap == null) snap = p[0]; rows.push({ s, p }); }
    if (snap == null) return hide();
    const xx = X(snap);
    xh.setAttribute('x1', xx); xh.setAttribute('x2', xx); xh.setAttribute('visibility', 'visible');
    hd.innerHTML = rows.map(r => `<circle class="hdot" cx="${X(r.p[0]).toFixed(1)}" cy="${Y(clamp(r.p[1], y0, y1)).toFixed(1)}" r="4.5" style="fill:${r.s.color || 'var(--trace)'}"/>`).join('');
    tip.innerHTML = `<div class="tt">${o.tipTitle ? o.tipTitle(snap, rows) : (o.xTime ? fmtDT(snap) : fmt(snap, 2))}</div>` +
      rows.map(r => `<div><i class="sw" style="background:${r.s.color || 'var(--trace)'}"></i>${esc(r.s.name || '')} <b>${o.fmtTip ? o.fmtTip(r.p[1], r.s, r.p) : fmt(r.p[1], 2)}</b></div>`).join('') +
      (o.tipExtra ? o.tipExtra(snap, rows) : '');
    tip.hidden = false;
    const br = box.getBoundingClientRect(), sx = xx * (br.width / W);
    const tw = tip.offsetWidth;
    tip.style.left = (sx + 14 + tw > br.width ? Math.max(0, sx - 14 - tw) : sx + 14) + 'px';
  });
  hit.addEventListener('pointerleave', hide);
  if (o.onClick) hit.addEventListener('click', e => { const s = series[o.clickSeries || 0]; const p = s && nearestPt(s.pts, toX(e)); if (p) o.onClick(p, s); });
}

/* stacked waveforms on a shared scale. o: {fs, chans:[{name,label,sub,data,color,spikes,glitches}], events, unit, onClick} */
function robustAmp(chans) {
  let amp = 0;
  for (const c of chans) {
    if (!c.data || !c.data.length) continue;
    const a = Float32Array.from(c.data, Math.abs).sort();
    amp = Math.max(amp, a[Math.floor(a.length * 0.998)] || 0, (a[a.length - 1] || 0) * 0.55);
  }
  return Math.max(0.5, amp * 1.12);
}
function waveStack(el, o) {
  const W = Math.max(260, Math.floor(el.clientWidth || 600));
  const chans = o.chans, rowH = o.rowH || (W < 500 ? 70 : 92), gap = 8;
  const m = { l: W < 500 ? 46 : 64, r: 10, t: 6, b: 26 }, pw = W - m.l - m.r;
  const H = m.t + chans.length * rowH + (chans.length - 1) * gap + m.b;
  const fs = o.fs, N = Math.max(1, ...chans.map(c => c.data ? c.data.length : 0)), dur = o.dur || N / fs;
  const amp = o.amp || robustAmp(chans);
  const X = t => m.l + t / dur * pw;
  let svg = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(o.label || 'Waveforms')}">`;
  chans.forEach((c, i) => {
    const top = m.t + i * (rowH + gap), mid = top + rowH / 2, half = rowH / 2 - 3;
    const Yv = v => mid - clamp(v / amp, -1, 1) * half;
    svg += `<rect class="paper" x="${m.l}" y="${top}" width="${pw}" height="${rowH}"/>`;
    for (const ev of o.events || []) { const a = X(clamp(ev[0], 0, dur)), z = X(clamp(ev[1], 0, dur)); if (z > a) svg += `<rect class="band" x="${a.toFixed(1)}" y="${top}" width="${(z - a).toFixed(1)}" height="${rowH}"/>`; }
    svg += `<line class="zero" x1="${m.l}" x2="${m.l + pw}" y1="${mid}" y2="${mid}"/>`;
    svg += `<text class="rowlab" x="${m.l - 8}" y="${mid - 2}" text-anchor="end">${esc(c.label || c.name)}</text>`;
    if (c.sub && W >= 500) svg += `<text class="rowsub" x="${m.l - 8}" y="${mid + 13}" text-anchor="end">${esc(c.sub)}</text>`;
    const d = c.data;
    if (d && d.length) {
      const n = d.length; let path = '';
      if (n <= pw * 2) { for (let k = 0; k < n; k++) path += (k ? 'L' : 'M') + X(k / fs).toFixed(1) + ' ' + Yv(d[k]).toFixed(1); }
      else {
        for (let col = 0; col < pw; col++) {
          const i0 = Math.floor(col * n / pw), i1 = Math.max(i0 + 1, Math.floor((col + 1) * n / pw));
          let lo = Infinity, hi = -Infinity;
          for (let k = i0; k < i1 && k < n; k++) { if (d[k] < lo) lo = d[k]; if (d[k] > hi) hi = d[k]; }
          const xx = (m.l + col + 0.5).toFixed(1);
          path += (col ? 'L' : 'M') + xx + ' ' + Yv(hi).toFixed(1) + 'L' + xx + ' ' + Yv(lo).toFixed(1);
        }
      }
      svg += `<path class="wave" d="${path}" style="stroke:${c.color || 'var(--trace)'}"/>`;
    } else svg += `<text x="${m.l + pw / 2}" y="${mid + 4}" text-anchor="middle" class="rowsub">${esc(c.empty || 'no data from this node in this capture')}</text>`;
    for (const s of c.spikes || []) if (fin(+s[0])) svg += `<circle class="spike" cx="${X(+s[0]).toFixed(1)}" cy="${Yv(+s[1] || 0).toFixed(1)}" r="4.2"><title>Spike ${fmt(+s[1], 1)} mg at ${fmt(+s[0], 2)} s</title></circle>`;
    for (const g of c.glitches || []) if (fin(+g[0])) svg += `<rect class="glitch" x="${(X(+g[0]) - 4).toFixed(1)}" y="${(Yv(+g[1] || 0) - 4).toFixed(1)}" width="8" height="8"><title>Bad read ${fmt(+g[1], 1)} mg at ${fmt(+g[0], 2)} s</title></rect>`;
    svg += `<rect class="frame" x="${m.l}" y="${top}" width="${pw}" height="${rowH}"/>`;
  });
  const bottom = H - m.b;
  for (const v of niceTicks(0, dur, Math.max(3, Math.floor(pw / 80))).ticks) if (v <= dur) svg += `<text x="${X(v).toFixed(1)}" y="${H - 7}" text-anchor="middle">${v}${v === 0 ? ' s' : ''}</text>`;
  svg += `<line class="xhair" y1="${m.t}" y2="${bottom}" visibility="hidden"/><rect class="hit${o.onClick ? ' clickable' : ''}" x="${m.l}" y="${m.t}" width="${pw}" height="${bottom - m.t}"/></svg>`;
  el.innerHTML = `<div class="legend"><span>Scale: each row spans ${MINUS}${fmt(amp, amp < 10 ? 1 : 0)} to +${fmt(amp, amp < 10 ? 1 : 0)} ${esc(o.unit || 'mg')}</span></div><div class="chart-box">${svg}<div class="tip" hidden></div></div>`;
  const box = el.querySelector('.chart-box'), svgEl = box.querySelector('svg'), tip = box.querySelector('.tip'), xh = svgEl.querySelector('.xhair'), hit = svgEl.querySelector('.hit');
  const toT = e => { const r = svgEl.getBoundingClientRect(); return clamp(((e.clientX - r.left) * (W / r.width) - m.l) / pw * dur, 0, dur); };
  hit.addEventListener('pointermove', e => {
    const t = toT(e), xx = X(t);
    xh.setAttribute('x1', xx); xh.setAttribute('x2', xx); xh.setAttribute('visibility', 'visible');
    const inEv = (o.events || []).some(ev => t >= ev[0] && t <= ev[1]);
    tip.innerHTML = `<div class="tt">${fmt(t, 2)} s</div>` + chans.map(c => {
      const v = c.data && c.data.length ? c.data[clamp(Math.round(t * fs), 0, c.data.length - 1)] : null;
      return `<div><i class="sw" style="background:${c.color || 'var(--trace)'}"></i>${esc(c.label || c.name)} <b>${v == null ? 'no data' : fmt(v, 2) + ' ' + (o.unit || 'mg')}</b></div>`;
    }).join('') + (inEv ? '<div class="tx">Vehicle on the bridge</div>' : '');
    tip.hidden = false;
    const br = box.getBoundingClientRect(), sx = xx * (br.width / W), tw = tip.offsetWidth;
    tip.style.left = (sx + 14 + tw > br.width ? Math.max(0, sx - 14 - tw) : sx + 14) + 'px';
  });
  hit.addEventListener('pointerleave', () => { tip.hidden = true; xh.setAttribute('visibility', 'hidden'); });
  if (o.onClick) hit.addEventListener('click', e => o.onClick(toT(e)));
}

/* small icon set */
const ICON = {
  ok: '<svg viewBox="0 0 36 36" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h28"/><path d="M8 20v-5M14 20v-5M22 20v-5M28 20v-5M6 15h24" stroke-width="2"/><path d="M12 28.5l4 3.5 8-8"/></svg>',
  warn: '<svg viewBox="0 0 36 36" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 22c3 0 3-8 6-8s3 14 6 14 3-20 6-20 3 14 6 14 3-6 6-6"/><circle cx="30" cy="7" r="1.5" fill="currentColor"/></svg>',
  bad: '<svg viewBox="0 0 36 36" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"><path d="M18 4 33 31H3Z"/><path d="M18 14v8"/><circle cx="18" cy="26.5" r="1.2" fill="currentColor"/></svg>',
  sensor: '<svg viewBox="0 0 36 36" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><rect x="11" y="13" width="14" height="14" rx="2"/><path d="M15 9a6 6 0 0 1 6 0M12 5.5a11 11 0 0 1 12 0"/><path d="M18 18v4"/><circle cx="18" cy="24.6" r=".8" fill="currentColor"/></svg>',
  offline: '<svg viewBox="0 0 36 36" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 18v14M12 32h12"/><path d="M11 11a10 10 0 0 1 14 0M6.5 6.5a16 16 0 0 1 23 0"/><path d="M5 30 31 4" /></svg>',
  learn: '<svg viewBox="0 0 36 36" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 29h28"/><path d="M7 25l6-7 6 4 9-11"/><path d="M23 11h5v5"/></svg>',
  wait: '<svg viewBox="0 0 36 36" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><circle cx="18" cy="18" r="13"/><path d="M18 10v8l5 4"/></svg>',
  plug: '<svg viewBox="0 0 36 36" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v8M24 4v8M8 12h20v6a10 10 0 0 1-20 0z"/><path d="M18 28v5"/></svg>',
  play: '<svg viewBox="0 0 20 20"><path d="M6 4v12l10-6z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 20 20"><path d="M5 4h3.5v12H5zM11.5 4H15v12h-3.5z" fill="currentColor"/></svg>',
  moon: '<svg viewBox="0 0 20 20"><path d="M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  sun: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="10" cy="10" r="3.6"/><path d="M10 1.8v2M10 16.2v2M1.8 10h2M16.2 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M4.2 15.8l1.4-1.4M14.4 5.6l1.4-1.4"/></svg>',
};
