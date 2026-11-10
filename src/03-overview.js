
/* ================= overview: bridge replay ================= */
const BX0 = 80, BSPAN = 840, BY = 190, DECK_T = 10, EXAG = 12;
function inv3(m) {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det], [B / det, (a * i - c * g) / det, -(a * f - c * d) / det], [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}
/* deck shape = sum of the first three sine modes that passes exactly through the 3 nodes, zero at the abutments */
const MINV = inv3([0.25, 0.5, 0.75].map(u => [1, 2, 3].map(k => Math.sin(k * Math.PI * u))));
const R = { id: null, p: null, dec: null, t: 0, dur: 30, playing: false, pending: null, raf: 0, last: 0, amp: 1, sel: null, dragging: false, seq: 0, nst: {} };

function replayReset() {
  R.id = null; R.p = null; R.dec = null; R.t = 0; R.pending = null; R.playing = false; R.seq++;
  stopLoop();
  const tr = $('#traces'); if (tr) tr.innerHTML = '';
}
function setupBridge() {
  $('#node-layer').innerHTML = NODES.map(n => `<g class="node none" data-node="${n}" tabindex="0" role="button" aria-pressed="false" aria-label="Node ${n.slice(1)} at ${NODE_PLACE[n]}. Show its readings."><circle class="pulse" r="9"/><line class="leader" x1="0" y1="11" x2="0" y2="33"/><circle class="hit" r="26"/><circle class="halo" r="15"/><circle class="ring" r="9"/><circle class="core" r="3.5"/><text class="lbl" y="52">${n}</text></g>`).join('');
  $$('#node-layer .node').forEach(g => {
    g.addEventListener('click', () => selectNode(g.dataset.node));
    g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectNode(g.dataset.node); } });
  });
  $('#cars').innerHTML = [0, 1, 2].map(i => `<g class="car" visibility="hidden"><g class="car-in"><path class="body" style="fill:${i === 1 ? 'var(--c2)' : 'var(--trace)'}" d="M-17 -4V-10L-9 -11.5L-5 -17H7L12 -11.5L17 -10V-4Z"/><path class="win" d="M-3.6 -15.4H6L9.6 -11.6H-6.6Z"/><circle class="wheel" cx="-10" cy="-3.4" r="3.4"/><circle class="wheel" cx="10" cy="-3.4" r="3.4"/></g></g>`).join('');
  $('#play').addEventListener('click', () => {
    if (!R.dec) return;
    R.playing = !R.playing;
    if (R.playing && R.t >= R.dur - 0.05) R.t = 0;
    setPlayIcon(); updateNewerBtn();
    if (R.playing) startLoop();
  });
  const sc = $('#scrub');
  sc.addEventListener('pointerdown', () => { R.dragging = true; });
  const endDrag = () => { R.dragging = false; R.last = performance.now(); };
  sc.addEventListener('pointerup', endDrag); sc.addEventListener('change', endDrag); sc.addEventListener('blur', endDrag);
  sc.addEventListener('input', () => { R.t = +sc.value; frame(R.t); });
  $('#newer').addEventListener('click', () => { if (R.pending) replayLoad(R.pending, !RM.matches); });
  setPlayIcon();
}
function setPlayIcon() {
  const b = $('#play');
  b.innerHTML = R.playing ? ICON.pause : ICON.play;
  b.setAttribute('aria-label', R.playing ? 'Pause' : 'Play');
}
function updateNewerBtn() { $('#newer').hidden = !(R.pending && R.pending !== R.id && !R.playing); }
function selectNode(n) {
  R.sel = R.sel === n ? null : n;
  $$('#node-layer .node').forEach(g => { const on = g.dataset.node === R.sel; g.classList.toggle('sel', on); g.setAttribute('aria-pressed', on); });
  $$('#traces .trace').forEach(t => t.classList.toggle('sel', t.dataset.node === R.sel));
  renderNodeInfo();
}
function strongestMoment(dec) {
  const ws = NODES.map(n => dec.nodes[n]?.wave).filter(Boolean);
  if (!ws.length) return 0;
  const n = Math.min(...ws.map(w => w.length)), win = Math.max(1, Math.round(dec.fs * 0.5));
  let best = 0, bi = 0, acc = 0;
  const e = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (const w of ws) s += w[i] * w[i]; e[i] = s; }
  for (let i = 0; i < n; i++) { acc += e[i]; if (i >= win) acc -= e[i - win]; if (acc > best) { best = acc; bi = i - win / 2; } }
  return clamp(bi / dec.fs, 0, dec.dur);
}
async function replayLoad(id, autoplay) {
  const p = S.prevs.get(id); if (!p) return;
  const seq = ++R.seq;
  const dec = await decodePreview(p);
  if (seq !== R.seq || !dec) return;
  stopLoop();
  R.id = id; R.p = p; R.dec = dec; R.dur = dec.dur || 30;
  if (R.pending === id) R.pending = null;
  R.amp = robustAmp(NODES.map(n => ({ data: dec.nodes[n]?.wave })).filter(c => c.data));
  R.disp = {};
  for (const n of NODES) { const w = dec.nodes[n]?.wave; if (w && w.length > 8) R.disp[n] = lowpass(w, dec.fs, 3.2); }
  R.damp = robustAmp(NODES.map(n => ({ data: R.disp[n] })).filter(c => c.data));
  $('#scrub').max = R.dur;
  buildTraces();
  if (RM.matches) { R.t = strongestMoment(dec); R.playing = false; }
  else { R.t = 0; R.playing = !!autoplay; }
  setPlayIcon(); updateNewerBtn(); renderBridgeSub(); renderNodeInfo(); updateBridgeEmpty();
  frame(R.t);
  if (R.playing) startLoop();
}
function onNewPreview(p) {
  const pl = prevList(), newest = pl[pl.length - 1];
  if (newest && newest.id !== p.id) return;
  if (!R.id) { replayLoad(p.id, !RM.matches); return; }
  if (R.id === p.id) return;
  R.pending = p.id; updateNewerBtn();
}
function startLoop() { if (R.raf) return; R.last = performance.now(); R.raf = requestAnimationFrame(step); }
function stopLoop() { if (R.raf) cancelAnimationFrame(R.raf); R.raf = 0; }
function step(ts) {
  R.raf = 0;
  if (currentPage() !== 'overview' || document.hidden) return;
  const dt = Math.min(0.1, Math.max(0, (ts - R.last) / 1000)); R.last = ts;
  if (R.playing && !R.dragging) {
    R.t += dt;
    if (R.t >= R.dur) {
      if (R.pending) { const id = R.pending; R.t = R.dur; frame(R.t); replayLoad(id, true); return; }
      R.t = 0;
    }
  }
  frame(R.t);
  if (R.playing) R.raf = requestAnimationFrame(step);
}
/* zero-phase 2nd-order low-pass (Butterworth, run forward and backward) */
function lowpass(x, fs, fc) {
  const K = Math.tan(Math.PI * fc / fs), q = Math.SQRT1_2, n = 1 / (1 + K / q + K * K);
  const b0 = K * K * n, b1 = 2 * b0, a1 = 2 * (K * K - 1) * n, a2 = (1 - K / q + K * K) * n;
  const run = src => {
    const out = new Float32Array(src.length);
    let x1 = src[0] || 0, x2 = x1, y1 = x1, y2 = x1;
    for (let i = 0; i < src.length; i++) { const v = b0 * src[i] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = src[i]; y2 = y1; y1 = v; out[i] = v; }
    return out;
  };
  return run(run(x).reverse()).reverse();
}
/* static deflection of a simply supported span under a point load at a (0..1); 1 = mid-span load seen at mid-span */
function influence(u, a) {
  if (a <= 0 || a >= 1 || u <= 0 || u >= 1) return 0;
  const b = 1 - a;
  const w = u <= a ? b * u * (1 - b * b - u * u) / 6 : a * (1 - u) * (1 - a * a - (1 - u) * (1 - u)) / 6;
  return w / 0.0208333;
}
function frame(t) {
  const d = R.dec, y = [0, 0, 0], lv = [0, 0, 0], phone = window.innerWidth < 640;
  const EX = phone ? 6 : 4, SAG = phone ? 6 : 3.5, LIM = phone ? 12 : 8;
  if (d) {
    const fi = t * d.fs;
    NODES.forEach((n, j) => {
      const w = d.nodes[n]?.wave; if (!w || !w.length) return;
      const i0 = clamp(Math.floor(fi), 0, w.length - 1), i1 = Math.min(w.length - 1, i0 + 1), fr = clamp(fi - i0, 0, 1);
      lv[j] = Math.min(1, Math.abs(w[i0] * (1 - fr) + w[i1] * fr) / R.amp);
      const dw = R.disp && R.disp[n]; if (!dw) return;
      y[j] = EX * Math.tanh((dw[i0] * (1 - fr) + dw[i1] * fr) / R.damp);
    });
  }
  const a = [0, 1, 2].map(r => MINV[r][0] * y[0] + MINV[r][1] * y[1] + MINV[r][2] * y[2]);
  const loads = d ? d.events.map((e, i) => ({ s: +e[0], e: +e[1], i })).filter(e => e.e > e.s && t >= e.s && t <= e.e).map(ev => {
    const u = (t - ev.s) / (ev.e - ev.s), dir = ev.i % 2 ? -1 : 1;
    return { ev, dir, pos: -0.07 + 1.14 * (dir > 0 ? u : 1 - u), m: 0.75 + ((ev.i * 37) % 10) / 20 };
  }) : [];
  const disp = u => {
    if (u <= 0 || u >= 1) return 0;
    let v = a[0] * Math.sin(Math.PI * u) + a[1] * Math.sin(2 * Math.PI * u) + a[2] * Math.sin(3 * Math.PI * u);
    for (const L of loads) v -= SAG * L.m * influence(u, L.pos);
    return LIM * Math.tanh(v / LIM);
  };
  const K = 48;
  let top = '', bot = '', posts = '', rail = '';
  for (let i = 0; i <= K; i++) {
    const u = i / K, x = (BX0 + u * BSPAN).toFixed(1), yy = BY - disp(u);
    top += (i ? 'L' : 'M') + x + ' ' + yy.toFixed(1);
    rail += (i ? 'L' : 'M') + x + ' ' + (yy - 15).toFixed(1);
    if (i % 2 === 0) posts += 'M' + x + ' ' + yy.toFixed(1) + 'v-15';
  }
  for (let i = K; i >= 0; i--) { const u = i / K; bot += 'L' + (BX0 + u * BSPAN).toFixed(1) + ' ' + (BY - disp(u) + DECK_T).toFixed(1); }
  $('#deck').setAttribute('d', top + bot + 'Z');
  $('#rail').setAttribute('d', rail);
  $('#posts').setAttribute('d', posts);
  $$('#node-layer .node').forEach(g => {
    const n = g.dataset.node, u = NODE_U[n], L = lv[NODES.indexOf(n)];
    g.setAttribute('transform', `translate(${(BX0 + u * BSPAN).toFixed(1)} ${(BY - disp(u) + DECK_T / 2).toFixed(1)})`);
    const pl = g.firstElementChild;
    if (pl && pl.classList.contains('pulse')) { pl.setAttribute('r', (phone ? 20 * (1 + 0.9 * L) : 9 * (1 + 2.2 * L)).toFixed(1)); pl.style.opacity = ((phone ? 0.28 : 0.4) * L).toFixed(3); }
  });
  $$('#cars .car').forEach((g, k) => {
    const L = loads[k];
    if (!L) { g.setAttribute('visibility', 'hidden'); return; }
    const x = BX0 + L.pos * BSPAN, yy = BY - disp(L.pos);
    const slope = -(disp(L.pos + 0.01) - disp(L.pos - 0.01)) / (0.02 * BSPAN);
    g.setAttribute('visibility', 'visible');
    g.setAttribute('transform', `translate(${x.toFixed(1)} ${yy.toFixed(1)}) rotate(${(Math.atan(slope) * 180 / Math.PI).toFixed(2)})`);
    g.firstElementChild.setAttribute('transform', `scale(${L.dir} 1)`);
  });
  const pct = (R.dur ? t / R.dur * 100 : 0).toFixed(3) + '%';
  $$('#traces .ph').forEach(ph => { ph.style.left = pct; });
  $('#clock').textContent = `${t.toFixed(1)} s of ${Math.round(R.dur)}`;
  const sc = $('#scrub'); if (!R.dragging) sc.value = t;
  sc.setAttribute('aria-valuetext', `${t.toFixed(1)} seconds of ${Math.round(R.dur)}`);
}
function tracePath(w, amp) {
  const n = w.length, cols = Math.min(500, n);
  let d = '';
  for (let c = 0; c < cols; c++) {
    const i0 = Math.floor(c * n / cols), i1 = Math.max(i0 + 1, Math.floor((c + 1) * n / cols));
    let lo = Infinity, hi = -Infinity;
    for (let k = i0; k < i1; k++) { if (w[k] < lo) lo = w[k]; if (w[k] > hi) hi = w[k]; }
    const x = ((c + 0.5) / cols * 1000).toFixed(1);
    d += (c ? 'L' : 'M') + x + ' ' + (30 - clamp(hi / amp, -1, 1) * 27).toFixed(1) + 'L' + x + ' ' + (30 - clamp(lo / amp, -1, 1) * 27).toFixed(1);
  }
  return d;
}
function buildTraces() {
  const d = R.dec, box = $('#traces');
  if (!d) { box.innerHTML = ''; return; }
  box.innerHTML = NODES.map(n => {
    const nd = d.nodes[n];
    const ev = d.events.map(([s, e]) => `<rect class="ev-band" x="${(s / d.dur * 1000).toFixed(1)}" y="0" width="${Math.max(0, (e - s) / d.dur * 1000).toFixed(1)}" height="60"/>`).join('');
    return `<div class="trace${R.sel === n ? ' sel' : ''}" data-node="${n}"><div class="tl" data-node="${n}"><i style="background:${NODE_COLOR[n]}"></i><b>${n}</b><span>${NODE_PLACE[n]}</span></div><div class="tw"><svg viewBox="0 0 1000 60" preserveAspectRatio="none" aria-hidden="true">${ev}<line class="zero" x1="0" x2="1000" y1="30" y2="30"/>${nd?.wave ? `<path class="tr" d="${tracePath(nd.wave, R.amp)}" style="stroke:${NODE_COLOR[n]}"/>` : ''}</svg>${nd?.wave ? '' : `<span class="tw-empty">${nd && nd.n !== 0 ? 'bad data, no waveform' : 'no data from this node'}</span>`}<div class="ph"></div></div></div>`;
  }).join('');
  $$('#traces .tw').forEach(tw => {
    const seek = e => { const r = tw.getBoundingClientRect(); R.t = clamp((e.clientX - r.left) / r.width, 0, 1) * R.dur; frame(R.t); };
    tw.addEventListener('pointerdown', e => { seek(e); tw.setPointerCapture?.(e.pointerId); R.dragging = true; });
    tw.addEventListener('pointermove', e => { if (R.dragging && e.buttons) seek(e); });
    tw.addEventListener('pointerup', () => { R.dragging = false; R.last = performance.now(); });
  });
  $$('#traces .tl').forEach(tl => tl.addEventListener('click', () => selectNode(tl.dataset.node)));
}
function applyNodeClasses() {
  $$('#node-layer .node').forEach(g => {
    const n = g.dataset.node, st = R.nst[n] || { key: 'none' };
    let cls = st.key;
    if (R.dec && cls === 'ok' && R.dec.nodes[n] && R.dec.nodes[n].ok === false) cls = 'bad';
    g.classList.remove('ok', 'bad', 'silent', 'none'); g.classList.add(cls);
    g.setAttribute('aria-label', `Node ${n.slice(1)} at ${NODE_PLACE[n]}, ${st.text || 'no data'}. Show its readings.`);
  });
}
function renderBridgeSub() {
  const el = $('#bp-sub'), p = R.p;
  if (!p) { el.textContent = 'Each capture is 30 seconds of vibration.'; return; }
  const ne = (p.events || []).length;
  el.innerHTML = `Capture ${esc(p.id)}, ${esc(fmtDT(p.ts))}. ${ne ? plural(ne, 'vehicle crossing') : 'No vehicles crossed'}.${p.live ? ' <span class="badge info">live window</span>' : ''}${RM.matches ? ' Showing the strongest moment.' : ''}`;
}
function updateBridgeEmpty() {
  const box = $('#bridge-empty');
  if (R.dec) { box.hidden = true; return; }
  box.hidden = false;
  let msg;
  if (S.caps.length && !S.prevs.size) msg = '<b>No vibration preview yet.</b><br>Scores are arriving, but no preview has come in. The next capture should bring one.';
  else if (MQ.connected) msg = '<b>Waiting for the first capture.</b><br>The base station sends one every 5 minutes.';
  else msg = '<b>Nothing to replay yet.</b><br>Connect to your broker, open a history file, or start the demo on the <a href="#connect">Connect page</a>.';
  box.firstElementChild.innerHTML = msg;
}
function renderNodeInfo() {
  const box = $('#node-info'), n = R.sel;
  if (!n) { box.innerHTML = '<p class="hint" style="margin:0">Select a node on the bridge (or its trace label) to see its readings.</p>'; return; }
  const nd = R.dec?.nodes[n], st = R.nst[n] || { cls: '', text: 'no data' };
  const spikes = nd ? nd.spikes.length : 0, bad = nd ? nd.glitches.length : 0;
  let pk = '–';
  if (nd && fin(nd.peak)) { pk = fmt(nd.peak, 1) + ' mg'; if (fin(nd.peakT)) pk += ` <small class="c-mute">at ${fmt(nd.peakT, 1)} s</small>`; }
  box.innerHTML = `<div class="ni-head"><b>Node ${n.slice(1)}</b><span class="sub" style="margin:0">at ${NODE_PLACE[n]}</span><span class="badge ${st.cls}">${esc(st.text)}</span>${nd && nd.ok === false ? '<span class="badge warn">bad data in this capture</span>' : ''}</div>
  <dl class="ni">
    <div><dt>Vibration level (rms)</dt><dd>${nd && fin(nd.rms) ? fmt(nd.rms, 2) + ' mg' : '–'}</dd></div>
    <div><dt>Largest peak</dt><dd>${pk}</dd></div>
    <div><dt>Spikes</dt><dd>${nd ? spikes : '–'}</dd></div>
    <div><dt>Bad reads</dt><dd>${nd ? bad : '–'}</dd></div>
    <div><dt>Last reported</dt><dd>${esc(fmtAgo(st.heard, nowRef()))}</dd></div>
  </dl>`;
}

/* ================= overview: headline, instruments, chart, lists ================= */
const STATE_WORD = { NORMAL: 'Normal', WARNING: 'Warning', ALARM: 'Alarm' };
const STATE_CLS = { NORMAL: 'ok', WARNING: 'warn', ALARM: 'bad' };
function computeHeadline() {
  const last = lastCap(), now = nowRef(), live = isLive(), hb = lastHb(), st = nodeStatuses();
  if (!last && !hb && S.online == null) {
    if (MQ.connected) return { cls: 'info', icon: 'wait', title: 'Waiting for the base station', text: `Connected to the broker, but nothing has arrived on shm/${esc(S.site)}/ yet. Captures come every 5 minutes; if this lasts, check the site ID on the Connect page.` };
    return { cls: 'mute', icon: 'plug', title: 'No data yet', text: 'Connect to your broker or open a remote.sqlite history file on the <a href="#connect">Connect page</a>. You can also start the demo there.' };
  }
  const recent = S.caps.slice(-5).filter(c => fin(c.ratio)), over = recent.filter(c => c.ratio > 1).length;
  const state = (S.piState && S.piState.state) || last?.state || 'NORMAL';
  const why = humanWhy((state !== 'NORMAL' && S.piState && S.piState.why) || last?.why);
  const stale = live && last && now - last.ts > 20 * 60;
  let r;
  if (S.online === '0' || stale) {
    r = { cls: 'bad', icon: 'offline', title: 'Base station offline', text: S.online === '0' ? `The base station dropped off the network${S.onlineTs ? ' ' + fmtAgo(S.onlineTs, now) : ''}. Check its power and the 4G signal at the site; readings resume on their own when it reconnects.` : `No capture has arrived for ${fmtDur(now - last.ts)}. Check the base station's power and the 4G signal at the site.` };
  } else if (last && last.mode === 'collect') {
    r = { cls: 'info', icon: 'learn', title: 'Learning what normal looks like', text: 'The base station is recording captures to learn how this bridge normally vibrates. Scoring starts once it has enough of them.' };
  } else if (state === 'ALARM') {
    r = { cls: 'bad', icon: 'bad', title: 'Alarm: inspect the bridge', text: `${over || 3} of the last 5 captures scored above the alarm level. Arrange a visual inspection of the bridge.${why ? ' ' + esc(why) : ''}` };
  } else if (state === 'WARNING') {
    r = { cls: 'warn', icon: 'warn', title: 'Something has changed', text: `${over || 'Some'} of the last 5 captures scored above the alarm level. A very heavy vehicle or strong wind can do this; it becomes an alarm at 3 out of 5.${why ? ' ' + esc(why) : ''}` };
  } else {
    const issues = NODES.filter(n => st[n].key !== 'ok');
    const faults = hb && Array.isArray(hb.faults) ? hb.faults : [];
    if (issues.length || faults.length) {
      r = { cls: 'warn', icon: 'sensor', title: 'Normal, but a sensor needs attention', text: (issues.length ? issues.map(n => `Node ${n.slice(1)} at ${NODE_PLACE[n]} ${st[n].key === 'silent' ? 'has been ' + st[n].text : 'is sending bad data'}`).join('. ') + '.' : `The base station reports: ${esc(faults.join(', '))}.`) + ' The bridge itself scores normally.' };
    } else {
      const rr = last?.ratio;
      r = { cls: 'ok', icon: 'ok', title: 'Behaving normally', text: `The latest captures match how this bridge usually vibrates. Score ${fmt(rr, 2)}, ${fin(rr) && rr < 0.75 ? 'well under' : 'under'} the alarm level of 1.0.` };
    }
  }
  let since = null;
  if (S.piState && S.piState.state === state && fin(+S.piState.since)) since = +S.piState.since;
  else if (last) { since = last.ts; for (let i = S.caps.length - 1; i >= 0; i--) { if ((S.caps[i].state || 'NORMAL') !== state) break; since = S.caps[i].ts; } }
  r.since = since; r.last = last; r.state = state;
  return r;
}
function renderHero() {
  const h = computeHeadline(), now = nowRef(), el = $('#hero'), fresh = heroFresh(h.title);
  el.className = 'hero ' + h.cls;
  const fileNote = !isLive() && S.file && h.last ? `<span>From the history file</span>` : '';
  el.innerHTML = `<div class="hero-icon${fresh ? ' draw' : ''}" aria-hidden="true"><svg class="orbit" viewBox="0 0 100 100"><circle cx="50" cy="50" r="47"/></svg>${ICON[h.icon]}</div><div><h1>${fresh ? splitWords(h.title) : h.title}</h1><p>${h.text}</p></div>
  <div class="meta">${h.last ? `<span>Last capture <b>${esc(fmtAgo(h.last.ts, nowS()))}</b></span>` : ''}${fin(h.since) ? `<span>Like this for <b>${esc(fmtDur(now - h.since))}</b></span>` : ''}${fileNote}</div>`;
  const alarm = h.state === 'ALARM' && h.icon === 'bad';
  document.body.classList.toggle('is-alarm', alarm);
  document.title = (alarm ? 'Alarm: ' : h.icon === 'warn' ? 'Changed: ' : '') + 'Bridge health monitor';
  const tab = $('.tabs a[data-page="overview"]');
  tab.innerHTML = 'Overview' + (alarm || h.icon === 'offline' ? '<span class="tab-dot" aria-label="needs attention"></span>' : '');
}
function gaugeSVG(r, col) {
  const cx = 52, cy = 54, Rr = 42, f = fin(r) ? clamp(r / 2, 0, 1) : 0;
  const arc = `M${cx - Rr} ${cy}A${Rr} ${Rr} 0 0 1 ${cx + Rr} ${cy}`;
  return `<svg class="gauge" viewBox="0 0 104 62" aria-hidden="true" data-f="${f}"><path class="g-bg" d="${arc}"/><path class="g-val" pathLength="1" style="stroke:${col}" d="${arc}"/><line class="g-tick" x1="${cx}" x2="${cx}" y1="${cy - Rr - 7}" y2="${cy - Rr + 8}"/>${fin(r) ? `<g class="g-needle-g"><line class="g-needle" x1="${cx}" y1="${cy}" x2="${cx - Rr + 13}" y2="${cy}"/></g><circle cx="${cx}" cy="${cy}" r="3.5" fill="var(--ink)"/>` : ''}<text x="4" y="61">0</text><text x="94" y="61">2</text></svg>`;
}
function renderStrip() {
  const last = lastCap(), bl = baseline(), hb = lastHb(), now = nowRef();
  const ratio = last?.ratio;
  const gcol = !fin(ratio) ? 'var(--ink3)' : ratio >= 1 ? 'var(--bad)' : ratio >= 0.8 ? 'var(--warn)' : 'var(--ok)';
  const i1 = `<div class="inst"><div class="lab">Anomaly score</div><div class="gauge-row">${gaugeSVG(ratio, gcol)}<div><div class="big" style="color:${fin(ratio) && ratio >= 1 ? 'var(--bad)' : 'inherit'}">${fin(ratio) ? `<span data-tw="score" data-v="${ratio}" data-d="2">${fmt(ratio, 2)}</span>` : '–'}</div><div class="note">${last && last.mode === 'collect' ? 'not scored while learning' : 'alarm level is 1.0'}</div>${sparkSVG(S.caps.slice(-72).map(c => c.ratio))}</div></div></div>`;
  const rows = [0, 1, 2].map(i => {
    const f = Array.isArray(last?.freq) ? +last.freq[i] : NaN, pc = freqPct(last, i, bl);
    return `<span class="m">Mode ${i + 1}</span><span class="v">${fin(f) ? `<span data-tw="f${i}" data-v="${f}" data-d="2">${fmt(f, 2)}</span>` : '–'} <small class="c-mute" style="font-size:14px">Hz</small></span><span class="d${pc != null && pc < -3 ? ' low' : ''}">${pc == null ? '' : `<span data-tw="p${i}" data-v="${pc}" data-d="1" data-f="pct">${fmtPct(pc)}</span>`}</span>`;
  }).join('');
  const i2 = `<div class="inst"><div class="lab">Natural frequencies</div><div class="freqs">${rows}</div><div class="note">${bl ? `change from healthy (median of the first ${bl.n} normal captures)` : 'healthy baseline needs 5 good normal captures'}</div></div>`;
  const midnight = new Date(now * 1000); midnight.setHours(0, 0, 0, 0);
  const t0 = midnight.getTime() / 1000;
  let tmin = Infinity, tmax = -Infinity;
  for (let i = S.caps.length - 1; i >= 0 && S.caps[i].ts >= t0; i--) { const v = +S.caps[i].temp; if (fin(v)) { tmin = Math.min(tmin, v); tmax = Math.max(tmax, v); } }
  const temp = +last?.temp;
  const i3 = `<div class="inst"><div class="lab">Deck temperature</div><div class="big">${fin(temp) ? `<span data-tw="temp" data-v="${temp}" data-d="1">${fmt(temp, 1)}</span>` : '–'}<small>°C</small></div><div class="note">${fin(tmin) ? `today ${fmt(tmin, 1)} to ${fmt(tmax, 1)} °C` : 'no readings today'}</div>${sparkSVG(S.caps.filter(c => c.ts >= now - 86400).filter((c, i, arr) => i % Math.max(1, Math.floor(arr.length / 96)) === 0).map(c => +c.temp))}</div>`;
  let tot = 0, good = 0; const flags = {};
  for (let i = S.caps.length - 1; i >= 0 && S.caps[i].ts >= now - 86400; i--) {
    const c = S.caps[i]; tot++; if (c.q) good++;
    else for (const f of (Array.isArray(c.flags) && c.flags.length ? c.flags : ['unspecified quality problem'])) flags[f] = (flags[f] || 0) + 1;
  }
  const top = Object.entries(flags).sort((a, b) => b[1] - a[1])[0];
  const gp = tot ? good / tot * 100 : null;
  const i4 = `<div class="inst"><div class="lab">Good captures, 24 h</div><div class="big" style="color:${gp != null && gp < 80 ? 'var(--warn)' : 'inherit'}">${gp == null ? '–' : `<span data-tw="good" data-v="${Math.floor(gp)}" data-d="0">${Math.floor(gp)}</span>`}<small>%</small></div><div class="note">${!tot ? 'no captures in 24 h' : top ? `most common problem: ${esc(String(top[0]).replace(/_/g, ' '))} (${top[1]})` : `all ${tot} were clean`}</div></div>`;
  const mo = hb?.modem || {}, sig = +mo.signal_pct;
  const bars = [20, 40, 60, 80].map((t, k) => `<i class="${fin(sig) && sig >= t - 10 ? 'on' : ''}" style="height:${6 + k * 5}px"></i>`).join('');
  const i5 = `<div class="inst"><div class="lab">Mobile signal</div><div class="big"><span class="sigbars" aria-hidden="true">${bars}</span>${fin(sig) ? `<span data-tw="sig" data-v="${Math.round(sig)}" data-d="0">${Math.round(sig)}</span>` : '–'}<small>%</small></div><div class="note">${hb ? esc([mo.tech, mo.operator].filter(Boolean).join(' with ') || 'network unknown') : 'no heartbeat yet'}</div></div>`;
  $('#strip').innerHTML = i1 + i2 + i3 + i4 + i5;
  tweenIn($('#strip')); animateGauge($('#strip'));
  if (last) TW_BOOT = false;
}
function openCapture(id) { location.hash = '#vibration/' + encodeURIComponent(id); }
function renderOvChart() {
  const end = nowRef(), start = end - 86400;
  const pts = [];
  for (let i = S.caps.length - 1; i >= 0 && S.caps[i].ts >= start; i--) { const c = S.caps[i]; pts.push([c.ts, fin(c.ratio) ? c.ratio : null, c]); }
  pts.reverse();
  lineChart($('#ov-score'), {
    label: (() => { const v = pts.filter(p => fin(p[1])); if (!v.length) return 'Anomaly score over the last 24 hours: no scored captures.'; const hi = Math.max(...v.map(p => p[1])); return `Anomaly score over the last 24 hours. Latest ${fmt(v[v.length - 1][1], 2)}, highest ${fmt(hi, 2)}, alarm level 1.0. ${v.filter(p => p[1] > 1).length} captures above it.`; })(),
    series: [{ name: 'Anomaly score', pts, color: 'var(--trace)', dotClass: p => p[2].state === 'ALARM' ? 'bad' : (p[2].state === 'WARNING' || p[1] > 1) ? 'warn' : null }],
    xTime: true, xMin: start, xMax: end, yMin: 0, gap: 1800,
    refs: [{ y: 1, label: 'alarm level', cls: 'alarm' }],
    onClick: p => openCapture(p[2].id),
    fmtTip: (v, s, p) => fmt(v, 2) + ' <span class="c-mute">' + (STATE_WORD[p[2].state] || '') + '</span>',
    tipExtra: (x, rows) => { const c = rows[0]?.p[2]; return c && c.why && c.state !== 'NORMAL' ? `<div class="tx">${esc(humanWhy(c.why))}</div>` : (S.prevs.has(c?.id) ? '<div class="tx">Click to open its vibration</div>' : ''); },
    empty: S.caps.length ? 'No scored captures in the last 24 hours.' : 'Scores appear here as captures arrive, every 5 minutes.',
  });
}
function renderOvNodes() {
  const st = R.nst, now = nowRef();
  $('#ov-nodes').innerHTML = NODES.map(n => `<div class="nrow"><span class="d" style="background:var(--${st[n].cls || 'ink3'})"></span><div><b>Node ${n.slice(1)}</b> <span class="t">${NODE_PLACE[n]}</span><div class="t">last heard ${esc(fmtAgo(st[n].heard, now))}</div></div><span class="badge ${st[n].cls}">${esc(st[n].text)}</span></div>`).join('');
}
function eventInfo(e) {
  if (e.type === 'state') {
    const to = e.to, from = e.from;
    const title = to === 'ALARM' ? 'Alarm raised' : to === 'WARNING' ? (from === 'ALARM' ? 'Alarm eased to a warning' : 'Warning: something changed') : (from ? 'Back to normal' : 'Normal');
    return { cls: STATE_CLS[to] || 'info', title, detail: [humanWhy(e.why), fin(+e.ratio) ? `Score ${fmt(+e.ratio, 2)}.` : ''].filter(Boolean).join(' '), cap: e.capture_id };
  }
  if (e.type === 'fault') return { cls: 'warn', title: 'Fault: ' + (e.what || 'unknown'), detail: '' };
  if (e.type === 'recovered') return { cls: 'ok', title: 'Recovered: ' + (e.what || ''), detail: '' };
  return { cls: 'info', title: e.type, detail: e.what || '' };
}
function timelineHTML(list, groupDays) {
  if (!list.length) return '';
  let html = '', cur = null, open = false;
  for (const e of list) {
    if (groupDays) {
      const k = dayKey(e.ts);
      if (k !== cur) { if (open) html += '</ul>'; cur = k; html += `<div class="day-head">${new Date(e.ts * 1000).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</div><ul class="timeline">`; open = true; }
    } else if (!open) { html += '<ul class="timeline">'; open = true; }
    const info = eventInfo(e);
    html += `<li><span class="mk ${info.cls}"></span><div class="when">${esc(groupDays ? fmtClock(e.ts) : fmtDT(e.ts))}</div><div class="what">${esc(info.title)}</div>${info.detail ? `<div class="why">${esc(info.detail)}</div>` : ''}${info.cap ? `<div class="why"><a href="#vibration/${encodeURIComponent(info.cap)}">Capture ${esc(info.cap)}</a></div>` : ''}</li>`;
  }
  return html + (open ? '</ul>' : '');
}
function renderOvEvents() {
  const list = S.events.slice(-6).reverse();
  $('#ov-events').innerHTML = list.length ? timelineHTML(list, false) : '<p class="hint">No events yet. State changes and faults will be listed here.</p>';
}
function renderOverview() {
  R.nst = nodeStatuses();
  renderHero(); renderStrip(); renderOvChart(); renderOvNodes(); renderOvEvents();
  applyNodeClasses();
  if (!R.id) { const pl = prevList(); if (pl.length) replayLoad(pl[pl.length - 1].id, !RM.matches); }
  else if (R.pending && !S.prevs.has(R.pending)) R.pending = null;
  updateBridgeEmpty(); updateNewerBtn(); renderNodeInfo();
  if (R.playing) startLoop(); else frame(R.t);
}
