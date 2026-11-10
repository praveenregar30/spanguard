
/* ================= remote commands ================= */
let TOKEN = '';
const CMDS = [];
const CMD_NAME = { ping: 'Ping', status: 'Status', sms_test: 'Test SMS', set_mode: 'Set mode', send_raw: 'Raw file', live_view: 'Live view', live_stop: 'Stop live' };
function sendCmd(cmd, extra = {}) {
  if (!TOKEN) {
    toast('Enter the command token first.');
    if (currentPage() === 'vibration') { $('#vib-token-row').hidden = false; $('#vib-token').focus(); } else $('#sys-token').focus();
    return false;
  }
  if (!DEMO.on && !(MQ.client && MQ.connected)) { toast('Not connected to the broker. Connect first on the Connect page.'); return false; }
  const entry = { cmd, t: nowS(), status: 'sent', detail: 'sent, waiting for a reply' };
  CMDS.unshift(entry); if (CMDS.length > 40) CMDS.pop();
  entry.timer = setTimeout(() => { if (entry.status === 'sent') { entry.status = 'none'; entry.detail = 'No reply after 30 s. The base station may be offline or busy uploading.'; renderCmdLog(); } }, 30000);
  const msg = { cmd, token: TOKEN, ...extra };
  if (DEMO.on) demoCommand(msg);
  else MQ.client.publish(`shm/${S.site}/cmd`, JSON.stringify(msg), { qos: 1 }, err => { if (err) { entry.status = 'fail'; entry.detail = 'Could not send: ' + err.message; renderCmdLog(); } });
  renderCmdLog();
  return true;
}
function onCmdReply(j) {
  if (!j || !j.cmd) return;
  let e = CMDS.find(x => x.cmd === j.cmd && x.status === 'sent');
  if (!e) { e = { cmd: j.cmd, t: nowS() }; CMDS.unshift(e); }
  clearTimeout(e.timer);
  e.status = j.ok ? 'ok' : 'fail';
  e.detail = j.ok ? (j.detail || 'done') : (j.error || j.detail || 'failed');
  if ('live_until' in j) S.liveUntil = j.live_until;
  if (j.cmd === 'live_view' && j.ok) { VIB.follow = true; }
  toast(`${CMD_NAME[j.cmd] || j.cmd}: ${j.ok ? (j.detail || 'done') : (j.error || 'failed')}`);
  renderCmdLog(); scheduleRender();
}
function renderCmdLog() {
  const el = $('#cmd-log');
  if (!CMDS.length) { el.innerHTML = '<li class="c-mute" style="display:block">Nothing sent yet.</li>'; return; }
  el.innerHTML = CMDS.map(e => `<li><span class="c-mute">${esc(fmtClock(e.t, true))}</span><b>${esc(CMD_NAME[e.cmd] || e.cmd)}</b><span class="lr ${e.status === 'ok' ? 'c-ok' : e.status === 'sent' ? 'c-mute' : 'c-bad'}">${esc(e.detail)}</span></li>`).join('');
}

/* ================= MQTT ================= */
const MQ = { client: null, connected: false, status: 'idle', msg: '', cls: '', host: null, url: null, t0: 0, timer: 0 };
function normalizeBroker(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  s = s.replace(/(\.emqxsl\.com)+/gi, '.emqxsl.com');
  if (/^wss?:\/\//i.test(s)) {
    try { const u = new URL(s); if (!u.pathname || u.pathname === '/') u.pathname = '/mqtt'; return { url: u.toString(), host: u.hostname }; } catch (e) { return null; }
  }
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0].split(':')[0].toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s)) return null;
  return { url: `wss://${s}:8084/mqtt`, host: s };
}
function setConn(status, msg, cls) { MQ.status = status; MQ.msg = msg || ''; MQ.cls = cls || ''; renderConnMsg(); renderHeader(); }
function explainMqttError(err, elapsed) {
  const m = String((err && (err.message || err)) || '').toLowerCase(), code = err && err.code;
  const viewer = inArtifactViewer() ? ' This page is running inside the claude.ai viewer, which blocks outside connections: download the file and open it directly in Chrome instead.' : '';
  if (/not authori[sz]ed|bad user ?name or password|authenticat/.test(m) || [4, 5, 134, 135].includes(code))
    return 'The broker turned down the username or password. Check the dashboard login you created in the EMQX console (it is separate from the Pi\'s login) and try again.';
  if (/connack timeout|timed? ?out/.test(m) || (!m && elapsed >= 8000))
    return 'The broker did not answer. Either this network blocks port 8084 (common on office, campus and hotel Wi-Fi) or the address is wrong. Check the address, or try again on a phone hotspot.' + viewer;
  if (!m || /enotfound|getaddrinfo|name_not_resolved|unknown host|dns|websocket/.test(m))
    return `Could not reach ${MQ.host || 'the broker'}. The address is probably wrong or misspelled; copy it again from the EMQX console. If it is right, this network may be blocking port 8084.` + viewer;
  return 'Could not connect: ' + (err.message || err) + '.' + viewer;
}
function mqttDisconnect(silent) {
  clearTimeout(MQ.timer);
  if (MQ.client) { const c = MQ.client; MQ.client = null; try { c.removeAllListeners && c.removeAllListeners(); c.on && c.on('error', () => { }); c.end(true); } catch (e) { } }
  MQ.connected = false;
  if (!silent) setConn('idle', 'Disconnected.');
}
async function mqttConnect(cfg) {
  const nb = normalizeBroker(cfg.addr);
  if (!nb) { setConn('error', 'That does not look like a broker address. Paste the address shown in the EMQX console, for example k1a2b3c4.ala.asia-southeast1.emqxsl.com.', 'bad'); return; }
  if (!cfg.user) { setConn('error', 'Enter the dashboard username.', 'bad'); return; }
  mqttDisconnect(true);
  if (DEMO.on) stopDemo();
  const site = (cfg.site || 'bridge01').trim();
  if (site !== S.site) { if (S.file) resetData(); S.site = site; }
  MQ.host = nb.host; MQ.url = nb.url;
  setConn('connecting', `Connecting to ${nb.url}`, 'info');
  try { await loadScript(MQTT_URL); } catch (e) { setConn('error', e.message, 'bad'); return; }
  if (!window.mqtt || !window.mqtt.connect) { setConn('error', 'The MQTT library did not load properly. Reload the page and try again.', 'bad'); return; }
  let client, ever = false, lastErr = null;
  MQ.t0 = Date.now();
  try {
    client = window.mqtt.connect(nb.url, { username: cfg.user, password: cfg.pass || '', clientId: 'shm-dash-' + Math.random().toString(16).slice(2, 10), clean: true, connectTimeout: 15000, reconnectPeriod: 0, keepalive: 60, protocolVersion: 4 });
  } catch (e) { setConn('error', explainMqttError(e, 0), 'bad'); return; }
  MQ.client = client;
  const fail = (err) => {
    if (MQ.client !== client) return;
    clearTimeout(MQ.timer);
    setConn('error', explainMqttError(err, Date.now() - MQ.t0), 'bad');
    MQ.client = null; MQ.connected = false;
    try { client.end(true); } catch (e) { }
    renderHeader(); scheduleRender();
  };
  MQ.timer = setTimeout(() => { if (!ever) fail(new Error('connack timeout')); }, 16000);
  client.on('connect', () => {
    if (MQ.client !== client) return;
    ever = true; clearTimeout(MQ.timer);
    MQ.connected = true; client.options.reconnectPeriod = 5000;
    client.subscribe(`shm/${S.site}/#`, { qos: 1 }, (err, granted) => {
      if (err || (granted && granted.some(g => g.qos === 128))) setConn('error', `Connected, but this login may not read shm/${S.site}/#. Check the broker's access rules for the dashboard user.`, 'bad');
    });
    setConn('connected', `Connected to ${MQ.host}. Listening on shm/${S.site}/. New captures arrive every 5 minutes; for older data, open the history file.`, 'ok');
    scheduleRender(true);
  });
  client.on('message', (topic, payload, packet) => onMqttMessage(topic, payload, packet));
  client.on('error', err => { lastErr = err; if (!ever) fail(err); else setConn('reconnecting', 'Connection problem: ' + explainMqttError(err, 0), 'bad'); });
  client.on('close', () => {
    if (MQ.client !== client) return;
    if (!ever) { fail(lastErr); return; }
    MQ.connected = false; setConn('reconnecting', 'Connection lost. Trying again every 5 seconds.', 'bad'); scheduleRender();
  });
  client.on('reconnect', () => { if (MQ.client === client) setConn('reconnecting', 'Reconnecting to the broker.', 'info'); });
  client.on('offline', () => { if (MQ.client === client && ever) { MQ.connected = false; setConn('reconnecting', 'Offline. Will reconnect when the network is back.', 'bad'); } });
}
function onMqttMessage(topic, payload, packet) {
  const pre = `shm/${S.site}/`;
  if (!topic.startsWith(pre)) return;
  const sub = topic.slice(pre.length);
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload || []);
  S.lastMsg = nowS();
  if (sub.startsWith('raw/')) { if (bytes.length) openRawBytes(bytes.slice(), sub, true); return; }
  if (!bytes.length) return;
  const text = new TextDecoder().decode(bytes);
  if (sub === 'online') { S.online = text.trim().replace(/"/g, '') === '1' ? '1' : '0'; S.onlineTs = packet && packet.retain ? null : nowS(); scheduleRender(); return; }
  const j = safeJSON(text);
  if (!j) return;
  switch (sub) {
    case 'capture': addCapture(j); break;
    case 'preview': addPreview(j); break;
    case 'event': addEvent(j); break;
    case 'state': S.piState = j; break;
    case 'heartbeat': addHeartbeat(j, nowS()); break;
    case 'cmd_reply': onCmdReply(j); break;
    default: return;
  }
  scheduleRender();
}

/* ================= history file (SQLite) ================= */
async function openSqlite(file) {
  const msg = $('#file-msg');
  msg.innerHTML = `<div class="notice info">Reading ${esc(file.name)}…</div>`;
  try {
    await loadScript(SQLJS_URL);
    const SQL = await window.initSqlJs();
    const db = new SQL.Database(new Uint8Array(await file.arrayBuffer()));
    const all = (sql, p = []) => { try { const st = db.prepare(sql); st.bind(p); const o = []; while (st.step()) o.push(st.get()); st.free(); return o; } catch (e) { return null; } };
    const capSites = all('SELECT DISTINCT site FROM captures');
    if (!capSites) throw new Error('it has no captures table. Is this the remote.sqlite file from the laptop receiver?');
    const sites = capSites.map(r => String(r[0]));
    let site = S.site, note = '';
    if (sites.length && !sites.includes(site)) { note = ` It had nothing for site "${esc(site)}", so it shows "${esc(sites[0])}".`; site = sites[0]; }
    if (DEMO.on) stopDemo();
    else if (site !== S.site) resetData();
    S.site = site; $('#f-site').value = site;
    const caps = (all('SELECT json FROM captures WHERE site=? ORDER BY ts', [site]) || []).map(r => safeJSON(r[0])).filter(Boolean);
    addCapturesBulk(caps);
    for (const r of all('SELECT ts, json FROM events WHERE site=? ORDER BY ts', [site]) || []) { const e = safeJSON(r[1]); if (e) { if (!fin(+e.ts)) e.ts = +r[0]; addEvent(e); } }
    for (const r of all('SELECT ts, json FROM heartbeats WHERE site=? ORDER BY ts', [site]) || []) { const h = safeJSON(r[1]); if (h) addHeartbeat(h, +r[0]); }
    for (const r of all('SELECT key, value, ts FROM status WHERE site=?', [site]) || []) {
      if (r[0] === 'state') { const v = safeJSON(r[1]); if (v && (!S.piState || !MQ.connected)) S.piState = v; }
      if (r[0] === 'online' && !MQ.connected) { S.online = String(r[1]).replace(/"/g, '').trim() === '1' ? '1' : '0'; S.onlineTs = fin(+r[2]) ? +r[2] : null; }
    }
    let np = 0;
    for (const r of all('SELECT json FROM previews WHERE site=? ORDER BY ts', [site]) || []) { const p = safeJSON(r[0]); if (p) { addPreview(p, true); np++; } }
    db.close();
    S.file = { name: file.name, caps: caps.length, prevs: np, from: caps[0]?.ts, to: caps[caps.length - 1]?.ts };
    replayReset(); VIB.follow = true; VIB.key = ''; TR.key = '';
    msg.innerHTML = caps.length
      ? `<div class="notice ok">Loaded ${esc(file.name)}: ${plural(caps.length, 'capture')} from ${esc(fmtDT(caps[0].ts))} to ${esc(fmtDT(caps[caps.length - 1].ts))}, ${plural(np, 'waveform preview')}, ${plural(S.events.length, 'event')}.${note}</div>`
      : `<div class="notice">The file opened, but it has no captures for site "${esc(site)}".${note}</div>`;
    renderHeader(); scheduleRender(true);
  } catch (e) {
    msg.innerHTML = `<div class="notice bad">Could not read ${esc(file.name)}: ${esc(e.message)}</div>`;
  }
}

/* ================= demo mode ================= */
const DEMO = { on: false, timer: 0, damage: 0, mode: 'monitor', liveUntil: 0, ratios: [], state: 'NORMAL', since: 0, overWhy: '', start: 0, learnEnd: 0, silent: null, boot: 0, tick: 0 };
const F0 = [4.2, 13.3, 16.3];
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function gauss(r) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function poisson(r, lam) { const L = Math.exp(-lam); let k = 0, p = 1; do { k++; p *= r(); } while (p > L); return k - 1; }
function capId(ts) { return new Date(ts * 1000).toISOString().slice(0, 19).replace(/[-:]/g, ''); }
function demoTemp(ts, r) {
  const d = new Date(ts * 1000), h = d.getHours() + d.getMinutes() / 60, day = Math.floor(ts / 86400);
  const off = [0, 1.6, -1.2, 2.3, 0.6, -0.9, 1.3, 0.2][((day % 8) + 8) % 8];
  return 15 + off + 6.5 * Math.sin(2 * Math.PI * (h - 9) / 24) + (r ? gauss(r) * 0.2 : 0);
}
function demoCapture(ts) {
  const id = capId(ts), r = mulberry32(hashStr(id));
  const T = demoTemp(ts, r), dmg = DEMO.damage;
  const freq = F0.map((f, k) => +(f * (1 - 0.0009 * (T - 15)) * (1 + gauss(r) * 0.0016) * Math.sqrt(1 - dmg * [1, 0.7, 0.45][k])).toFixed(3));
  const mac = [0.993, 0.978, 0.958].map((m, k) => +clamp(m - Math.abs(gauss(r)) * [0.003, 0.006, 0.01][k] - dmg * [0.15, 0.6, 0.35][k], 0, 1).toFixed(3));
  const silent = DEMO.silent && ts >= DEMO.silent[0] && ts < DEMO.silent[1];
  const badNode = r() < 0.012 ? NODES[Math.floor(r() * 3)] : null;
  const collect = DEMO.mode === 'collect' || ts < DEMO.learnEnd;
  let ratio = null, why;
  if (collect) why = 'recording to learn normal behaviour';
  else if (dmg > 0) { ratio = 1.5 + r() * 0.9; why = `freq_m1 lower than expected (-${(6 + r() * 1.5).toFixed(1)} sd); mac_m2 lower than expected (-${(4 + r()).toFixed(1)} sd)`; }
  else if (r() < 0.006) { ratio = 1.03 + r() * 0.35; why = ['rms_n2 higher than expected (+4.8 sd)', 'freq_m3 higher than expected (+3.9 sd)', 'mac_m3 lower than expected (-3.6 sd)'][Math.floor(r() * 3)]; }
  else { ratio = Math.exp(Math.log(0.4) + gauss(r) * 0.27); why = 'all features within the normal range'; }
  if (ratio != null) ratio = +ratio.toFixed(3);
  const nodes = {}, flags = [];
  for (const n of NODES) {
    if (silent && n === 'n3') continue;
    nodes[n] = n === badNode ? null : +((ratio ?? 0.3) * (0.75 + r() * 0.5)).toFixed(3);
  }
  if (silent) flags.push('n3 silent');
  if (badNode) flags.push(badNode + ' dropout');
  let state = 'NORMAL';
  if (ratio != null) {
    DEMO.ratios.push(ratio); if (DEMO.ratios.length > 5) DEMO.ratios.shift();
    if (ratio > 1) DEMO.overWhy = why;
    const cnt = DEMO.ratios.filter(v => v > 1).length;
    state = cnt >= 3 ? 'ALARM' : cnt > 0 ? 'WARNING' : 'NORMAL';
  } else DEMO.ratios = [];
  if (state !== DEMO.state) {
    addEvent({ type: 'state', from: DEMO.state, to: state, capture_id: id, ts, ratio, why: state === 'NORMAL' ? '' : DEMO.overWhy });
    DEMO.state = state; DEMO.since = ts;
  }
  const thr = 0.0215;
  return { site: S.site, id, ts, mode: collect ? 'collect' : 'monitor', state, q: flags.length === 0, flags, score: ratio == null ? null : +(ratio * thr).toFixed(5), ratio, thr, why, temp: +T.toFixed(2), freq, mac, nodes };
}
/* modal simulation: three lightly damped resonators, mode shapes sin(k pi x), exact discretisation, 200 Hz */
function demoSim(cap) {
  const r = mulberry32(hashStr(cap.id + ':w'));
  const fs = 200, N = 6000, dt = 1 / fs, dur = 30;
  const hour = new Date(cap.ts * 1000).getHours();
  const busy = (hour >= 8 && hour < 10) || (hour >= 17 && hour < 19), day = hour >= 6 && hour < 22;
  const nEv = Math.min(6, poisson(r, busy ? 3.4 : day ? 1.9 : 0.35));
  const events = [];
  for (let i = 0; i < nEv; i++) { const len = 3 + r() * 3, s = r() * (dur - 2); events.push({ s, e: Math.min(dur, s + len), m: 0.5 + r() * 1.3, dir: r() < 0.5 ? 1 : -1 }); }
  events.sort((a, b) => a.s - b.s);
  const f = Array.isArray(cap.freq) ? cap.freq : F0, zeta = [0.014, 0.017, 0.021], wgt = [1, 0.6, 0.42];
  const modes = [0, 1, 2].map(k => {
    const w = 2 * Math.PI * f[k], z = zeta[k], wd = w * Math.sqrt(1 - z * z), e = Math.exp(-z * w * dt), c = Math.cos(wd * dt), s = Math.sin(wd * dt);
    return { w, z, a11: e * (c + z * w / wd * s), a12: e * s / wd, a21: -e * w * w / wd * s, a22: e * (c - z * w / wd * s), q: 0, v: 0 };
  });
  const phi = NODES.map(n => [1, 2, 3].map(k => Math.sin(k * Math.PI * NODE_U[n])));
  const acc = NODES.map(() => new Float32Array(N));
  const entry = events.map(ev => Math.round(ev.s * fs)), exit = events.map(ev => Math.round(ev.e * fs));
  for (let i = -800; i < N; i++) {
    const t = i * dt;
    for (let k = 0; k < 3; k++) {
      const md = modes[k];
      let F = gauss(r) * 0.04;
      if (i >= 0) for (let j = 0; j < events.length; j++) {
        const ev = events[j];
        if (t >= ev.s && t <= ev.e) { const u = (t - ev.s) / (ev.e - ev.s), pos = ev.dir > 0 ? u : 1 - u; F += ev.m * Math.sin((k + 1) * Math.PI * pos) * 0.3 * gauss(r); }
        if (i === entry[j] || i === exit[j]) F += ev.m * 2.2 * (k === 1 ? 0.6 : 1);
      }
      md.v += F;
      const q2 = md.a11 * md.q + md.a12 * md.v, v2 = md.a21 * md.q + md.a22 * md.v;
      md.q = q2; md.v = v2;
      if (i >= 0) { const a = -(md.w * md.w * md.q + 2 * md.z * md.w * md.v) * wgt[k]; for (let j = 0; j < 3; j++) acc[j][i] += phi[j][k] * a; }
    }
  }
  // scale so the quiet part has about 0.5 mg rms
  let ss = 0, cnt = 0;
  for (let i = 0; i < N; i++) {
    const t = i * dt;
    if (events.some(ev => t >= ev.s - 0.2 && t <= ev.e + 2.5)) continue;
    for (let j = 0; j < 3; j++) { ss += acc[j][i] * acc[j][i]; cnt++; }
  }
  let scale;
  if (cnt > 600) scale = 0.5 / Math.sqrt(ss / cnt);
  else { ss = 0; for (let j = 0; j < 3; j++) for (let i = 0; i < N; i++) ss += acc[j][i] * acc[j][i]; scale = 3 / Math.sqrt(ss / (3 * N)); }
  for (let j = 0; j < 3; j++) for (let i = 0; i < N; i++) acc[j][i] = acc[j][i] * scale + gauss(r) * 0.25;
  const spikes = [], glitches = [];
  if (r() < 0.2) { const j = Math.floor(r() * 3), i = Math.floor(r() * (N - 4)), mg = (28 + r() * 45) * (r() < 0.5 ? -1 : 1); acc[j][i] += mg; acc[j][i + 1] += mg * 0.45; spikes.push({ j, i, mg: acc[j][i] }); }
  if (r() < 0.1) { const k = 1 + Math.floor(r() * 2); for (let g = 0; g < k; g++) glitches.push({ j: Math.floor(r() * 3), i: Math.floor(r() * N), mg: (40 + r() * 80) * (r() < 0.5 ? -1 : 1) }); }
  return { acc, events, spikes, glitches, fs, N };
}
function demoPreview(cap, live) {
  const sim = demoSim(cap), r = mulberry32(hashStr(cap.id + ':p'));
  const fs = 50, n = 1500, df = 50 / 256, nodes = [], dnodes = {};
  NODES.forEach((nm, j) => {
    const present = Object.prototype.hasOwnProperty.call(cap.nodes, nm);
    if (!present) { nodes.push({ node: nm, ok: false, rms: null, peak: null, noise: null, n: 0, scale: null, coding: 'delta', wave: null, spec: null, spikes: [], glitches: [] }); dnodes[nm] = { ok: false, n: 0, wave: null, spec: null, spikes: [], glitches: [] }; return; }
    const bad = cap.nodes[nm] == null;
    const w = new Float32Array(n), src = sim.acc[j];
    for (let i = 0; i < n; i++) w[i] = (src[4 * i] + src[4 * i + 1] + src[4 * i + 2] + src[4 * i + 3]) / 4;
    const spikes = sim.spikes.filter(s => s.j === j).map(s => { const i = Math.floor(s.i / 4); w[i] = s.mg; return [+(i / fs).toFixed(2), +s.mg.toFixed(1)]; });
    let glitches = sim.glitches.filter(g => g.j === j).map(g => [+(Math.floor(g.i / 4) / fs).toFixed(2), +g.mg.toFixed(1)]);
    if (bad) {
      const st = Math.floor(r() * 900), len = 300 + Math.floor(r() * 300), v = 10 + r() * 20;
      for (let i = st; i < Math.min(n, st + len); i++) w[i] = v;
      for (let g = 0; g < 6; g++) glitches.push([+(r() * 30).toFixed(2), +((60 + r() * 200) * (r() < 0.5 ? -1 : 1)).toFixed(1)]);
      glitches.sort((a, b) => a[0] - b[0]);
    }
    const ws = waveStats(w);
    let dd = 0; for (let i = 1; i < n; i++) dd += (w[i] - w[i - 1]) ** 2;
    const noise = Math.sqrt(dd / (n - 1) / 2);
    const W = welch(w, fs, 5.12);
    const specInt = Array.from(W.psd, p => Math.round(100 * Math.log10(Math.max(p, 1e-12))));
    nodes.push({ node: nm, ok: !bad, rms: +ws.rms.toFixed(3), peak: +ws.peak.toFixed(2), noise: +noise.toFixed(3), n, scale: 0.01, coding: 'delta', wave: null, spec: specInt, spikes, glitches });
    dnodes[nm] = { ok: !bad, n, wave: w, spec: Float32Array.from(specInt, v => v / 10), rms: ws.rms, peak: ws.peak, peakT: ws.peakI / fs, noise, spikes, glitches };
  });
  const events = sim.events.map(e => [+e.s.toFixed(2), +e.e.toFixed(2)]);
  const p = { site: S.site, id: cap.id, ts: cap.ts, state: cap.state, mode: cap.mode, q: cap.q, ratio: cap.ratio, why: cap.why, fs, src_fs: 200, dur: 30, df, events, live: !!live, nodes };
  p._dec = { fs, dur: 30, df, events, nodes: dnodes };
  return p;
}
function demoHB(ts) {
  const r = mulberry32(hashStr('hb' + Math.floor(ts)));
  const silent = DEMO.silent && ts >= DEMO.silent[0] && ts < DEMO.silent[1];
  return {
    uptime_s: Math.round(ts - DEMO.boot), cpu_temp_c: +(47 + (demoTemp(ts) - 15) * 0.6 + r() * 2).toFixed(1),
    disk_free_gb: +(23.4 - (ts - DEMO.start) / 86400 * 0.12).toFixed(2), backlog: 0,
    modem: { signal_pct: Math.round(clamp(66 + gauss(r) * 6, 5, 100)), tech: '4G', operator: 'Jio' },
    nodes: NODES.map(n => ({ node_id: n, age_s: silent && n === 'n3' ? Math.round(ts - DEMO.silent[0]) : Math.round(2 + r() * 25) })),
    faults: silent ? ['node n3 silent'] : [], live_until: DEMO.liveUntil > ts ? DEMO.liveUntil : null,
  };
}
function demoGenerateHistory() {
  const step = 300, end = Math.floor(nowS() / step) * step - step, start = end - 7 * 86400;
  DEMO.start = start; DEMO.boot = start - 5 * 3600; DEMO.learnEnd = start + 12 * 3600;
  const sStart = start + Math.round(4.4 * 86400 / step) * step; DEMO.silent = [sStart, sStart + 7200];
  const modem = start + Math.round(2.6 * 86400 / step) * step;
  const caps = [];
  for (let ts = start; ts <= end; ts += step) {
    if (ts === sStart) addEvent({ type: 'fault', what: 'node n3 silent', ts });
    if (ts === sStart + 7200) addEvent({ type: 'recovered', what: 'node n3 reporting again', ts });
    if (ts === modem) addEvent({ type: 'fault', what: '4G connection lost, captures kept for later', ts });
    if (ts === modem + 1500) addEvent({ type: 'recovered', what: '4G connection back, backlog sent', ts });
    caps.push(demoCapture(ts));
    if ((ts - start) % 900 === 0) addHeartbeat(demoHB(ts), ts);
  }
  addCapturesBulk(caps);
  for (const c of caps.slice(-80)) addPreview(demoPreview(c, false), true);
  S.piState = { state: DEMO.state, since: DEMO.since || start, why: DEMO.state === 'NORMAL' ? '' : DEMO.overWhy };
  S.online = '1'; S.onlineTs = start;
}
function demoTick() {
  if (!DEMO.on) return;
  const ts = nowS(), live = DEMO.liveUntil > ts;
  const cap = demoCapture(ts);
  addCapture(cap);
  addPreview(demoPreview(cap, live));
  if (S.prevs.size > 300) { const old = prevList().slice(0, S.prevs.size - 300); for (const p of old) if (p.id !== R.id && p.id !== VIB.id) S.prevs.delete(p.id); S.ver++; }
  S.piState = { state: DEMO.state, since: DEMO.since, why: DEMO.state === 'NORMAL' ? '' : DEMO.overWhy };
  if (++DEMO.tick % 15 === 0) addHeartbeat(demoHB(ts), ts);
  if (DEMO.liveUntil && !live) { DEMO.liveUntil = 0; S.liveUntil = null; toast('Live view ended.'); }
  scheduleRender();
}
function demoCommand(msg) {
  const reply = (o, delay = 700) => setTimeout(() => { if (DEMO.on) onCmdReply({ cmd: msg.cmd, ...o }); }, delay);
  switch (msg.cmd) {
    case 'ping': reply({ ok: true, detail: 'pong from the demo base station' }); break;
    case 'status': reply({ ok: true, detail: 'heartbeat sent' }); setTimeout(() => { if (DEMO.on) { addHeartbeat(demoHB(nowS()), nowS()); scheduleRender(true); } }, 900); break;
    case 'sms_test': reply({ ok: true, detail: 'test SMS queued for 2 numbers (demo: nothing is really sent)' }); break;
    case 'set_mode': DEMO.mode = msg.mode === 'collect' ? 'collect' : 'monitor'; reply({ ok: true, detail: 'mode is now ' + DEMO.mode }); break;
    case 'send_raw': {
      const c = S.capById.get(String(msg.capture_id));
      if (!c) { reply({ ok: false, error: 'no capture with ID ' + msg.capture_id }); break; }
      reply({ ok: true, detail: 'sending raw/' + c.id });
      setTimeout(async () => { if (!DEMO.on) return; try { openRawBytes(await demoRawNpz(c), 'raw/' + c.id, true); } catch (e) { toast('Demo raw file failed: ' + e.message); } }, 1600);
      break;
    }
    case 'live_view': { const m = clamp(Math.round(+msg.minutes || 10), 1, 30); DEMO.liveUntil = nowS() + m * 60; reply({ ok: true, detail: `live view on for ${m} min`, live_until: DEMO.liveUntil }); break; }
    case 'live_stop': DEMO.liveUntil = 0; reply({ ok: true, detail: 'live view stopped', live_until: null }); break;
    default: reply({ ok: false, error: 'unknown command' });
  }
}
/* builds a real .npz (zip of .npy files, deflate) so the demo exercises the same reader as real files */
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function npyBytes(descr, shape, data) {
  const shp = shape.length === 0 ? '()' : shape.length === 1 ? `(${shape[0]},)` : `(${shape.join(', ')})`;
  let h = `{'descr': '${descr}', 'fortran_order': False, 'shape': ${shp}, }`;
  h += ' '.repeat((64 - (10 + h.length + 1) % 64) % 64) + '\n';
  const out = new Uint8Array(10 + h.length + data.length);
  out.set([0x93, 78, 85, 77, 80, 89, 1, 0]); out[8] = h.length & 255; out[9] = h.length >> 8;
  for (let i = 0; i < h.length; i++) out[10 + i] = h.charCodeAt(i);
  out.set(data, 10 + h.length);
  return out;
}
function utf32(strs, width) { const b = new Uint8Array(strs.length * width * 4), dv = new DataView(b.buffer); strs.forEach((s, i) => { [...s].slice(0, width).forEach((ch, j) => dv.setUint32((i * width + j) * 4, ch.codePointAt(0), true)); }); return b; }
function f8(v) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); return b; }
async function zipFiles(files) {
  const parts = [], cd = [], enc = new TextEncoder();
  let off = 0;
  for (const f of files) {
    const comp = await deflate(f.bytes, 'deflate-raw'), crc = crc32(f.bytes), name = enc.encode(f.name);
    const lh = new Uint8Array(30 + name.length), dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(8, 8, true); dv.setUint16(12, 0x21, true);
    dv.setUint32(14, crc, true); dv.setUint32(18, comp.length, true); dv.setUint32(22, f.bytes.length, true); dv.setUint16(26, name.length, true);
    lh.set(name, 30);
    cd.push({ name, crc, cs: comp.length, us: f.bytes.length, off });
    parts.push(lh, comp); off += lh.length + comp.length;
  }
  const cdStart = off;
  for (const e of cd) {
    const h = new Uint8Array(46 + e.name.length), dv = new DataView(h.buffer);
    dv.setUint32(0, 0x02014b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 20, true); dv.setUint16(10, 8, true); dv.setUint16(14, 0x21, true);
    dv.setUint32(16, e.crc, true); dv.setUint32(20, e.cs, true); dv.setUint32(24, e.us, true); dv.setUint16(28, e.name.length, true); dv.setUint32(42, e.off, true);
    h.set(e.name, 46); parts.push(h); off += h.length;
  }
  const end = new Uint8Array(22), dv = new DataView(end.buffer);
  dv.setUint32(0, 0x06054b50, true); dv.setUint16(8, cd.length, true); dv.setUint16(10, cd.length, true); dv.setUint32(12, off - cdStart, true); dv.setUint32(16, cdStart, true);
  parts.push(end);
  const out = new Uint8Array(off + 22); let p = 0; for (const x of parts) { out.set(x, p); p += x.length; }
  return out;
}
async function demoRawNpz(cap) {
  const sim = demoSim(cap), N = sim.N, r = mulberry32(hashStr(cap.id + ':raw')), names = [];
  const x = new Float32Array(9 * N);
  NODES.forEach((n, j) => ['x', 'y', 'z'].forEach((a, ai) => {
    names.push(n + a);
    const row = (j * 3 + ai) * N, present = Object.prototype.hasOwnProperty.call(cap.nodes, n);
    for (let i = 0; i < N; i++) {
      const v = !present ? 0 : a === 'z' ? sim.acc[j][i] : sim.acc[j][i] * (a === 'x' ? 0.12 : 0.3) + gauss(r) * 0.35;
      x[row + i] = ((a === 'z' ? 1000 : 0) + v) / 1000;
    }
  }));
  for (const g of sim.glitches) x[(g.j * 3 + 2) * N + g.i] = (1000 + g.mg) / 1000;
  return zipFiles([
    { name: 'x.npy', bytes: npyBytes('<f4', [9, N], new Uint8Array(x.buffer)) },
    { name: 'channel_names.npy', bytes: npyBytes('<U3', [9], utf32(names, 3)) },
    { name: 'fs.npy', bytes: npyBytes('<f8', [], f8(200)) },
    { name: 'ts.npy', bytes: npyBytes('<f8', [], f8(cap.ts)) },
    { name: 'capture_id.npy', bytes: npyBytes(`<U${cap.id.length}`, [], utf32([cap.id], cap.id.length)) },
  ]);
}
function startDemo() {
  if (DEMO.on) return;
  mqttDisconnect(true); setConn('idle', '');
  resetData();
  Object.assign(DEMO, { on: true, damage: 0, mode: 'monitor', liveUntil: 0, ratios: [], state: 'NORMAL', since: 0, overWhy: '', tick: 0 });
  demoGenerateHistory();
  DEMO.timer = setInterval(demoTick, 4000);
  updateDemoUI(); renderHeader(); scheduleRender(true);
}
function stopDemo() {
  if (!DEMO.on) return;
  clearInterval(DEMO.timer); DEMO.on = false; DEMO.damage = 0;
  resetData(); updateDemoUI(); renderHeader(); scheduleRender(true);
}
function toggleDamage() {
  if (!DEMO.on) { startDemo(); }
  DEMO.damage = DEMO.damage ? 0 : 0.06;
  updateDemoUI();
  toast(DEMO.damage ? 'Stiffness reduced by 6 %. An alarm needs 3 of the next 5 captures above 1.0, about 12 seconds here.' : 'Stiffness restored. The alarm clears once the last 5 captures are back under 1.0.', 6000);
  location.hash = '#overview';
}
function updateDemoUI() {
  const lab = DEMO.damage ? 'Restore stiffness' : 'Simulate 6% stiffness loss';
  $('#dmg-btn').textContent = lab; $('#demo-dmg2').textContent = lab;
  $('#demo-toggle').textContent = DEMO.on ? 'Stop demo' : 'Start demo';
  $('#demo-bar').hidden = !DEMO.on;
  $$('[data-token]').forEach(i => { i.placeholder = DEMO.on ? 'Any text works in the demo' : 'Needed to send commands'; });
}

/* ================= connect page, header ================= */
function renderHeader() {
  $('#site-name').textContent = 'Site ' + S.site;
  let cls = '', txt = 'Not connected';
  if (DEMO.on) { cls = 'demo'; txt = 'Demo'; }
  else if (MQ.connected) { cls = 'live'; txt = 'Live'; }
  else if (MQ.status === 'connecting') { cls = 'busy'; txt = 'Connecting'; }
  else if (MQ.status === 'reconnecting') { cls = 'busy'; txt = 'Reconnecting'; }
  else if (S.file) { txt = 'History file'; }
  else if (MQ.status === 'error') { cls = 'err'; }
  $('#conn-pill').className = 'pill ' + cls;
  $('#conn-text').textContent = txt;
  $('#demo-bar').hidden = !DEMO.on;
}
function renderConnMsg() {
  const el = $('#conn-msg');
  el.innerHTML = MQ.msg ? `<div class="notice ${MQ.cls}">${esc(MQ.msg)}</div>` : '';
  $('#f-disconnect').disabled = !MQ.client;
  const busy = MQ.status === 'connecting';
  $('#f-connect').disabled = busy;
  $('#f-connect').textContent = busy ? 'Connecting…' : MQ.client ? 'Reconnect' : 'Connect';
}
function renderConnect() { renderConnMsg(); updateDemoUI(); }
function readForm() {
  return { addr: $('#f-addr').value.trim(), user: $('#f-user').value.trim(), pass: $('#f-pass').value, site: $('#f-site').value.trim() || 'bridge01' };
}
function updateAddrHelp() {
  const v = $('#f-addr').value, nb = normalizeBroker(v), help = $('#f-addr-help');
  if (!v.trim()) { help.textContent = 'Paste the address from the EMQX console. It becomes wss://address:8084/mqtt.'; return; }
  if (/(\.emqxsl\.com){2,}/i.test(v)) { $('#f-addr').value = v.replace(/(\.emqxsl\.com)+/gi, '.emqxsl.com'); }
  help.textContent = nb ? 'Will connect to ' + nb.url : 'This does not look like an address yet.';
}

/* ================= router, rendering, init ================= */
const PAGES = { overview: renderOverview, vibration: renderVibration, trends: renderTrends, events: renderEvents, system: renderSystem, connect: renderConnect };
function currentPage() { const h = (location.hash || '').slice(1).split('/')[0]; return PAGES[h] ? h : 'overview'; }
let rq = false, rqForce = false, lastR = 0;
function scheduleRender(force) {
  if (force) rqForce = true;
  if (rq) return;
  rq = true;
  setTimeout(() => requestAnimationFrame(() => { rq = false; const f = rqForce; rqForce = false; lastR = performance.now(); renderAll(f); }), Math.max(0, 200 - (performance.now() - lastR)));
}
function renderAll(force) {
  renderHeader();
  try { PAGES[currentPage()](force); } catch (e) { console.error(e); }
}
let lastPage = null;
function route() {
  const parts = (location.hash || '#overview').slice(1).split('/');
  const pg = PAGES[parts[0]] ? parts[0] : 'overview';
  $$('.page').forEach(s => { s.hidden = s.dataset.page !== pg; });
  $$('.tabs a').forEach(a => { if (a.dataset.page === pg) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  if (pg === 'vibration' && parts[1]) { VIB.id = decodeURIComponent(parts.slice(1).join('/')); VIB.follow = false; }
  if (pg !== 'overview') stopLoop();
  VIB.key = ''; TR.key = '';
  if (lastPage && lastPage !== pg) { window.scrollTo(0, 0); const h = $(`#page-${pg} h2`); $('#main').focus({ preventScroll: true }); if (h) $('#main').setAttribute('aria-label', h.textContent); }
  lastPage = pg;
  const cur = $(`.tabs a[data-page="${pg}"]`); if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  renderAll(true);
  if (pg === 'vibration') renderRaw();
}
function effTheme() { const t = document.documentElement.dataset.theme; return t || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); }
function setThemeIcon() { const d = effTheme() === 'dark', b = $('#theme-btn'); b.innerHTML = d ? ICON.sun : ICON.moon; b.setAttribute('aria-label', d ? 'Switch to light mode' : 'Switch to dark mode'); }
function wireUI() {
  $('#theme-btn').addEventListener('click', () => { const next = effTheme() === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; lsSet('shm-theme', next); setThemeIcon(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', setThemeIcon);
  $('#dmg-btn').addEventListener('click', toggleDamage);
  $('#demo-dmg2').addEventListener('click', toggleDamage);
  $('#demo-toggle').addEventListener('click', () => { if (DEMO.on) stopDemo(); else { startDemo(); location.hash = '#overview'; } });
  // vibration
  $('#vib-select').addEventListener('change', e => { if (e.target.value) setVibId(e.target.value, false); });
  $('#vib-prev').addEventListener('click', () => { const pl = prevList(), i = pl.findIndex(p => p.id === VIB.id); const t = i > 0 ? pl[i - 1] : (i < 0 ? pl[pl.length - 1] : null); if (t) setVibId(t.id, false); });
  $('#vib-next').addEventListener('click', () => { const pl = prevList(), i = pl.findIndex(p => p.id === VIB.id); if (i >= 0 && i < pl.length - 1) setVibId(pl[i + 1].id, false); });
  $('#vib-follow').addEventListener('change', e => { VIB.follow = e.target.checked; if (VIB.follow) { try { history.replaceState(null, '', '#vibration'); } catch (er) { } } renderVibration(true); });
  $$('#spec-mode button').forEach(b => b.addEventListener('click', () => { VIB.spec = b.dataset.v; $$('#spec-mode button').forEach(x => x.setAttribute('aria-pressed', x === b)); renderVibration(true); }));
  $('#live-btn').addEventListener('click', () => { if (sendCmd('live_view', { minutes: 10 })) { VIB.follow = true; $('#vib-follow').checked = true; } });
  $('#live-stop').addEventListener('click', () => sendCmd('live_stop'));
  $('#req-raw').addEventListener('click', () => { if (!VIB.id) { toast('No capture selected.'); return; } sendCmd('send_raw', { capture_id: VIB.id }); });
  $('#npz-file').addEventListener('change', async e => { const f = e.target.files[0]; if (f) await openRawBytes(new Uint8Array(await f.arrayBuffer()), f.name, false); e.target.value = ''; });
  $('#raw-select').addEventListener('change', e => { RAW.cur = e.target.value; renderRaw(); });
  $$('#raw-axis button').forEach(b => b.addEventListener('click', () => { RAW.axis = b.dataset.v; renderRaw(); }));
  // trends, events
  $$('#tr-range button').forEach(b => b.addEventListener('click', () => { TR.range = b.dataset.v; TR.rows = 100; renderTrends(true); }));
  $('#tr-more').addEventListener('click', () => { TR.rows += 200; renderTrends(true); });
  $$('#ev-filter button').forEach(b => b.addEventListener('click', () => { EV.filter = b.dataset.v; renderEvents(); }));
  // commands
  $$('[data-token]').forEach(i => i.addEventListener('input', () => { TOKEN = i.value; $$('[data-token]').forEach(o => { if (o !== i) o.value = i.value; }); }));
  $$('[data-cmd]').forEach(b => b.addEventListener('click', () => {
    const c = b.dataset.cmd, extra = {};
    if (c === 'set_mode') extra.mode = $('#cmd-mode').value;
    if (c === 'send_raw') { const id = $('#cmd-raw-id').value.trim() || VIB.id; if (!id) { toast('Enter a capture ID first.'); return; } extra.capture_id = id; }
    if (c === 'live_view') extra.minutes = clamp(Math.round(+$('#cmd-live-min').value || 10), 1, 30);
    sendCmd(c, extra);
  }));
  // connect
  $('#conn-form').addEventListener('submit', e => {
    e.preventDefault();
    const cfg = readForm();
    if ($('#f-remember').checked) lsSet('shm-dash-conn', JSON.stringify(cfg)); else lsSet('shm-dash-conn', null);
    mqttConnect(cfg);
  });
  $('#f-addr').addEventListener('input', updateAddrHelp);
  $('#f-addr').addEventListener('blur', updateAddrHelp);
  $('#f-disconnect').addEventListener('click', () => { mqttDisconnect(false); scheduleRender(true); });
  $('#f-forget').addEventListener('click', () => { lsSet('shm-dash-conn', null); $('#f-remember').checked = false; toast('Saved connection details removed from this device.'); });
  $('#f-pass-show').addEventListener('click', e => { const p = $('#f-pass'), show = p.type === 'password'; p.type = show ? 'text' : 'password'; e.target.textContent = show ? 'Hide' : 'Show'; e.target.setAttribute('aria-pressed', show); });
  $('#f-sqlite').addEventListener('change', e => { const f = e.target.files[0]; if (f) openSqlite(f); e.target.value = ''; });
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, () => drop.classList.remove('over')));
  drop.addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) openSqlite(f); });
  // global
  window.addEventListener('hashchange', route);
  let rt = 0;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { VIB.key = ''; TR.key = ''; renderAll(true); if (currentPage() === 'vibration') renderRaw(); }, 200); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && currentPage() === 'overview' && R.playing) startLoop(); });
  RM.addEventListener?.('change', () => { if (RM.matches) { R.playing = false; setPlayIcon(); } });
}
function init() {
  const th = lsGet('shm-theme'); if (th === 'dark' || th === 'light') document.documentElement.dataset.theme = th;
  setThemeIcon();
  setupBridge(); wireUI();
  if (inArtifactViewer()) $('#artifact-note').hidden = false;
  const saved = safeJSON(lsGet('shm-dash-conn'));
  if (saved && typeof saved === 'object') {
    $('#f-addr').value = saved.addr || ''; $('#f-user').value = saved.user || ''; $('#f-pass').value = saved.pass || ''; $('#f-site').value = saved.site || 'bridge01';
    $('#f-remember').checked = true; S.site = saved.site || 'bridge01'; updateAddrHelp();
  }
  route();
  if (saved && saved.addr && saved.user) mqttConnect(saved);
  else startDemo();
  setInterval(() => { if (currentPage() === 'vibration') renderLiveState(); }, 1000);
  setInterval(() => scheduleRender(), 20000);
}
init();
