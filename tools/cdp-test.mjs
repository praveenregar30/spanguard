// tiny CDP driver: node cdp.mjs <steps.json>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const steps = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const port = 9333 + Math.floor(Math.random() * 500);
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, '--user-data-dir=' + process.env.TEMP + '/cdp-prof-' + port, 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pend = new Map(); const logs = [];
async function connect() {
  for (let i = 0; i < 50; i++) { try { const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p = l.find(x => x.type === 'page'); if (p) return p.webSocketDebuggerUrl; } catch (e) {} await sleep(200); }
  throw new Error('no chrome');
}
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
try {
  ws = new WebSocket(await connect());
  await new Promise(r => ws.onopen = r);
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) logs.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description).join(' '));
    else if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)); };
  await send('Runtime.enable'); await send('Page.enable');
  for (const s of steps) {
    if (s.size) await send('Emulation.setDeviceMetricsOverride', { width: s.size[0], height: s.size[1], deviceScaleFactor: 1, mobile: s.size[0] < 500 });
    if (s.dark !== undefined) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: s.dark ? 'dark' : 'light' }, { name: 'prefers-reduced-motion', value: s.rm ? 'reduce' : 'no-preference' }] });
    if (s.nav) { await send('Page.navigate', { url: s.nav }); await sleep(s.wait ?? 2500); }
    if (s.eval) { const r = await send('Runtime.evaluate', { expression: s.eval, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) logs.push('EVAL ERR: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); else if (r.result.value !== undefined) console.log('eval>', typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value)); }
    if (s.sleep) await sleep(s.sleep);
    if (s.shot) { const full = s.full !== false; const m = await send('Page.getLayoutMetrics'); const h = Math.ceil(Math.min(m.cssContentSize.height, s.maxH || 4000)); const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full, clip: full ? { x: 0, y: 0, width: m.cssContentSize.width, height: h, scale: 1 } : undefined }); fs.writeFileSync(s.shot, Buffer.from(r.data, 'base64')); console.log('shot', s.shot); }
  }
} catch (e) { console.log('DRIVER ERROR', e.message); }
console.log(logs.length ? 'CONSOLE:\n' + logs.join('\n') : 'no console errors');
try { ws.close(); } catch (e) {} chrome.kill(); process.exit(0);
