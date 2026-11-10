
/* ================= motion layer =================
   Everything here is decoration on top of real data: counters that count to the new value,
   a spring gauge, sparklines, the header seismograph, data packets from the nodes to the base
   station, the sliding tab indicator, scene depth and page entrances.
   prefers-reduced-motion turns all of it into still frames. */
let ENTER_UNTIL = 0;
const entering = () => !RM.matches && performance.now() < ENTER_UNTIL;

/* ---- counters ---- */
const TWP = new Map();
let TW_BOOT = true;
const easeOut = t => 1 - Math.pow(1 - t, 3);
function twFormat(v, el) { const d = +el.dataset.d || 0; return el.dataset.f === 'pct' ? fmtPct(v, d) : fmt(v, d); }
function tweenIn(root) {
  if (!root) return;
  root.querySelectorAll('[data-tw]').forEach(el => {
    const k = el.dataset.tw, to = +el.dataset.v;
    if (!fin(to)) return;
    const from = TWP.has(k) ? TWP.get(k) : (TW_BOOT ? 0 : to);
    TWP.set(k, to);
    if (RM.matches || Math.abs(from - to) < 1e-9) { el.textContent = twFormat(to, el); return; }
    const t0 = performance.now(), dur = TW_BOOT ? 1200 : 700;
    el.textContent = twFormat(from, el);
    const tick = now => {
      const p = Math.min(1, (now - t0) / dur);
      el.textContent = twFormat(from + (to - from) * easeOut(p), el);
      if (p < 1 && el.isConnected) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/* ---- gauge: needle on a spring, arc fills ---- */
function animateGauge(root) {
  const g = root && root.querySelector('.gauge');
  if (!g) return;
  const f = +g.dataset.f, prev = TWP.has('gauge') ? TWP.get('gauge') : (TW_BOOT ? 0 : f);
  TWP.set('gauge', f);
  const nd = g.querySelector('.g-needle-g'), arc = g.querySelector('.g-val');
  const apply = (v, anim) => {
    if (nd) { nd.style.transition = anim ? 'transform 1.1s cubic-bezier(.34,1.5,.5,1)' : 'none'; nd.style.transform = `rotate(${(v * 180).toFixed(2)}deg)`; }
    if (arc) { arc.style.transition = anim ? 'stroke-dashoffset .9s cubic-bezier(.3,.8,.3,1)' : 'none'; arc.style.strokeDashoffset = (1 - v).toFixed(4); arc.style.opacity = v > 0.004 ? 1 : 0; }
  };
  if (RM.matches) { apply(f, false); return; }
  apply(prev, false);
  g.getBoundingClientRect();
  requestAnimationFrame(() => apply(f, true));
}

/* ---- sparkline ---- */
function sparkSVG(vals) {
  const v = vals.filter(fin);
  if (v.length < 3) return '';
  const W = 120, H = 24;
  let lo = Math.min(...v), hi = Math.max(...v);
  if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
  const pts = vals.map((y, i) => fin(y) ? [i / (vals.length - 1) * W, H - 3 - (y - lo) / (hi - lo) * (H - 6)] : null);
  let d = '', pen = false;
  for (const p of pts) { if (!p) { pen = false; continue; } d += (pen ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); pen = true; }
  const last = [...pts].reverse().find(Boolean);
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"><path d="${d}"/><circle class="spark-end" cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.6"/></svg>`;
}

/* ---- headline ---- */
let HT_PREV = '';
function heroFresh(title) { const f = title !== HT_PREV; HT_PREV = title; return f && !RM.matches; }
function splitWords(t) { return t.split(' ').map((w, i) => `<span class="w" style="--d:${i}">${w}</span>`).join(' '); }

/* ---- header seismograph: the latest capture, scrolling in real time ---- */
const SEIS = { wave: null, fs: 50, amp: 1, t: 0, last: 0, id: null, flash: 0 };
async function seismoRefresh() {
  const pl = prevList(), p = pl[pl.length - 1];
  if (!p || p.id === SEIS.id) return;
  const d = await decodePreview(p);
  if (!d) return;
  const w = (d.nodes.n2 && d.nodes.n2.wave) || NODES.map(n => d.nodes[n]?.wave).find(Boolean);
  if (!w) return;
  SEIS.id = p.id; SEIS.wave = w; SEIS.fs = d.fs; SEIS.amp = robustAmp([{ data: w }]);
  if (RM.matches) seismoDraw();
}
function seismoDraw(ts) {
  const c = $('#seismo');
  if (!c || c.offsetParent === null) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1), W = c.clientWidth, H = c.clientHeight;
  if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const col = getComputedStyle(c).color;
  ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1.3; ctx.lineJoin = 'round';
  ctx.globalAlpha = 0.25; ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
  const w = SEIS.wave;
  if (!w) return;
  const win = 5 * SEIS.fs, n = w.length, head = Math.floor(SEIS.t * SEIS.fs) % n;
  ctx.beginPath();
  for (let k = 0; k <= win; k++) {
    const i = (head - win + k + n * 4) % n, x = k / win * W;
    const y = H / 2 - clamp(w[i] / SEIS.amp, -1, 1) * (H / 2 - 3);
    if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  }
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, 'transparent'); grad.addColorStop(0.35, col); grad.addColorStop(1, col);
  ctx.globalAlpha = 1; ctx.strokeStyle = grad; ctx.stroke();
  const ly = H / 2 - clamp(w[head] / SEIS.amp, -1, 1) * (H / 2 - 3);
  ctx.beginPath(); ctx.arc(W - 1.5, ly, 2.4 + SEIS.flash * 3, 0, Math.PI * 2); ctx.fill();
}
function seismoLoop(ts) {
  requestAnimationFrame(seismoLoop);
  if (document.hidden || RM.matches) return;
  const dt = SEIS.last ? Math.min(0.1, (ts - SEIS.last) / 1000) : 0;
  if (dt < 1 / 40 && SEIS.last) return;
  SEIS.last = ts; SEIS.t += dt; SEIS.flash = Math.max(0, SEIS.flash - dt * 2);
  seismoDraw(ts);
}

/* ---- a new capture arrived: pill blip, packets from nodes to the base station, 4G burst ---- */
function liveBlip() {
  const dot = $('#conn-pill .dot');
  if (dot) { dot.classList.remove('blip'); void dot.offsetWidth; dot.classList.add('blip'); }
  SEIS.flash = 1;
  seismoRefresh();
  if (RM.matches || document.hidden || currentPage() !== 'overview') return;
  const st = R.nst || {};
  $$('#bridge .packet').forEach((c, i) => {
    if (st[c.dataset.node] && st[c.dataset.node].key === 'silent') return;
    setTimeout(() => c.querySelectorAll('animateMotion, animate').forEach(a => { try { a.beginElement(); } catch (e) { } }), i * 160);
  });
  const tx = $('#bridge .tx');
  if (tx) setTimeout(() => { tx.classList.remove('on'); void tx.getBoundingClientRect(); tx.classList.add('on'); }, 1500);
}

/* ---- sliding tab indicator ---- */
function moveInk() {
  const ink = $('.tab-ink'), a = $('.tabs a[aria-current="page"]');
  if (!ink || !a) return;
  ink.style.width = Math.max(0, a.offsetWidth - 24) + 'px';
  ink.style.transform = `translateX(${a.offsetLeft + 12}px)`;
}

/* ---- page entrance: panels rise in sequence, charts reveal ---- */
function pageEnter(pg) {
  if (RM.matches) return;
  const sec = $(`#page-${pg}`);
  if (!sec) return;
  [...sec.children].forEach((c, i) => c.style.setProperty('--i', Math.min(i, 8)));
  sec.classList.remove('enter'); void sec.offsetWidth; sec.classList.add('enter');
  ENTER_UNTIL = performance.now() + 1300;
}

/* ---- scene depth on mouse move ---- */
function setupParallax() {
  const wrap = $('.bridge-wrap');
  if (!wrap) return;
  const layers = $$('#bridge [data-depth]');
  let raf = 0, px = 0, py = 0;
  wrap.addEventListener('pointermove', e => {
    if (RM.matches || e.pointerType !== 'mouse') return;
    const r = wrap.getBoundingClientRect();
    px = (e.clientX - r.left) / r.width - 0.5; py = (e.clientY - r.top) / r.height - 0.5;
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; layers.forEach(g => { const k = +g.dataset.depth; g.style.transform = `translate(${(-px * k).toFixed(2)}px, ${(-py * k * 0.4).toFixed(2)}px)`; }); });
  });
  wrap.addEventListener('pointerleave', () => layers.forEach(g => { g.style.transform = ''; }));
}

function setupMotion() {
  setupParallax();
  window.addEventListener('resize', moveInk);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveInk);
  $('.tabs').addEventListener('scroll', moveInk, { passive: true });
  requestAnimationFrame(seismoLoop);
}
