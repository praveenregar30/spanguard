#!/usr/bin/env python3
"""
broker_test.py - a fake Raspberry Pi base station for testing the bridge dashboard.

It logs in to the MQTT broker with the *Pi's* username and password and behaves like
the real base station:

  * shm/<site>/online      retained "1" (and "0" as its last will)
  * shm/<site>/state       retained {state, since, why}
  * shm/<site>/heartbeat   at start and every 15 minutes
  * shm/<site>/capture     + shm/<site>/preview every 10 s (every 3 s during live view)
  * shm/<site>/event       when the state changes
  * listens on shm/<site>/cmd and answers on shm/<site>/cmd_reply:
      ping, status, live_view {minutes}, live_stop, send_raw {capture_id}
      (other commands get ok:false). Commands with the wrong token get ok:false.

Install:   pip install paho-mqtt
Run:       python broker_test.py --host xxxx.ala.asia-southeast1.emqxsl.com \
               --user pi_user --password pi_pass --token my-command-token
Options:   --site bridge01  --port 8883  --no-tls (plain port 1883)
           --damage         simulate a 6 % stiffness loss so the dashboard goes to alarm
           --dry-run DIR    no broker: write one capture/preview/heartbeat and a raw .npz to DIR

Ctrl+C stops it; the broker then publishes the last will ("0") so the dashboard shows offline.
"""
import argparse
import base64
import io
import json
import math
import os
import random
import ssl
import struct
import sys
import threading
import time
import zipfile
import zlib
from datetime import datetime, timezone

F0 = [4.2, 13.3, 16.3]
NODES = ["n1", "n2", "n3"]
NODE_U = {"n1": 0.25, "n2": 0.5, "n3": 0.75}
FS_SRC, FS_PREV, DUR = 200, 50, 30


# ---------------------------------------------------------------- simulation
def simulate(freqs, rng, n_events):
    """Three lightly damped modal resonators (shapes sin(k*pi*x)), exact discretisation, 200 Hz.
    Returns (dict node -> list of vertical acceleration in mg, events [[start_s, end_s]])."""
    n, dt = FS_SRC * DUR, 1.0 / FS_SRC
    events = []
    for _ in range(n_events):
        s = rng.uniform(0, DUR - 2)
        events.append([s, min(DUR, s + rng.uniform(3, 6)), rng.uniform(0.5, 1.8), rng.choice([1, -1])])
    events.sort()
    zeta, wgt = [0.014, 0.017, 0.021], [1.0, 0.6, 0.42]
    modes = []
    for k in range(3):
        w = 2 * math.pi * freqs[k]
        z = zeta[k]
        wd = w * math.sqrt(1 - z * z)
        e, c, s = math.exp(-z * w * dt), math.cos(wd * dt), math.sin(wd * dt)
        modes.append(dict(w=w, z=z, a11=e * (c + z * w / wd * s), a12=e * s / wd,
                          a21=-e * w * w / wd * s, a22=e * (c - z * w / wd * s), q=0.0, v=0.0))
    phi = {nd: [math.sin((k + 1) * math.pi * NODE_U[nd]) for k in range(3)] for nd in NODES}
    acc = {nd: [0.0] * n for nd in NODES}
    entries = {round(e[0] * FS_SRC) for e in events} | {round(e[1] * FS_SRC) for e in events}
    for i in range(-800, n):
        t = i * dt
        for k, md in enumerate(modes):
            f = rng.gauss(0, 0.04)
            if i >= 0:
                for (s, e, m, d) in events:
                    if s <= t <= e:
                        u = (t - s) / (e - s)
                        pos = u if d > 0 else 1 - u
                        f += m * math.sin((k + 1) * math.pi * pos) * 0.3 * rng.gauss(0, 1)
                if i in entries:
                    f += 2.2
            md["v"] += f
            q2 = md["a11"] * md["q"] + md["a12"] * md["v"]
            v2 = md["a21"] * md["q"] + md["a22"] * md["v"]
            md["q"], md["v"] = q2, v2
            if i >= 0:
                a = -(md["w"] ** 2 * md["q"] + 2 * md["z"] * md["w"] * md["v"]) * wgt[k]
                for nd in NODES:
                    acc[nd][i] += phi[nd][k] * a
    # scale so the quiet part is about 0.5 mg rms, then add sensor noise
    quiet = [i for i in range(0, n, 4) if not any(s - 0.2 <= i * dt <= e + 2.5 for (s, e, _, _) in events)]
    if len(quiet) > 150:
        ss = sum(acc[nd][i] ** 2 for nd in NODES for i in quiet) / (3 * len(quiet))
        scale = 0.5 / math.sqrt(ss)
    else:
        ss = sum(v * v for nd in NODES for v in acc[nd]) / (3 * n)
        scale = 3.0 / math.sqrt(ss)
    for nd in NODES:
        acc[nd] = [v * scale + rng.gauss(0, 0.25) for v in acc[nd]]
    return acc, [[round(s, 2), round(e, 2)] for (s, e, _, _) in events]


# ---------------------------------------------------------------- spectrum (pure python FFT)
def fft(re, im):
    n = len(re)
    j = 0
    for i in range(1, n):
        bit = n >> 1
        while j & bit:
            j ^= bit
            bit >>= 1
        j ^= bit
        if i < j:
            re[i], re[j] = re[j], re[i]
            im[i], im[j] = im[j], im[i]
    size = 2
    while size <= n:
        ang = -2 * math.pi / size
        wr, wi = math.cos(ang), math.sin(ang)
        h = size // 2
        for start in range(0, n, size):
            cr, ci = 1.0, 0.0
            for k in range(h):
                a, b = start + k, start + k + h
                tr = re[b] * cr - im[b] * ci
                ti = re[b] * ci + im[b] * cr
                re[b], im[b] = re[a] - tr, im[a] - ti
                re[a] += tr
                im[a] += ti
                cr, ci = cr * wr - ci * wi, cr * wi + ci * wr
        size *= 2


def welch(x, fs, nper=256):
    w = [0.5 - 0.5 * math.cos(2 * math.pi * i / nper) for i in range(nper)]
    u = sum(v * v for v in w)
    nb = nper // 2 + 1
    psd = [0.0] * nb
    segs = 0
    for s in range(0, len(x) - nper + 1, nper // 2):
        seg = x[s:s + nper]
        mean = sum(seg) / nper
        re = [(seg[i] - mean) * w[i] for i in range(nper)]
        im = [0.0] * nper
        fft(re, im)
        for k in range(nb):
            psd[k] += re[k] ** 2 + im[k] ** 2
        segs += 1
    sc = 1.0 / (fs * u * max(1, segs))
    return [p * sc * (1 if k in (0, nb - 1) else 2) for k, p in enumerate(psd)], fs / nper


# ---------------------------------------------------------------- message builders
def encode_wave(values):
    """mg -> int16 (delta coded when it fits) -> zlib -> base64. Returns (b64, scale, coding)."""
    peak = max(1e-6, max(abs(v) for v in values))
    scale = peak / 16000.0
    ints = [int(round(v / scale)) for v in values]
    deltas = [ints[0]] + [ints[i] - ints[i - 1] for i in range(1, len(ints))]
    if all(-32768 <= d <= 32767 for d in deltas):
        data, coding = deltas, "delta"
    else:
        data, coding = ints, "plain"
    raw = struct.pack("<%dh" % len(data), *data)
    return base64.b64encode(zlib.compress(raw, 9)).decode("ascii"), round(scale, 8), coding


def capture_id(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y%m%dT%H%M%S")


class FakePi:
    def __init__(self, site, damage=False, seed=None):
        self.site = site
        self.damage = 0.06 if damage else 0.0
        self.rng = random.Random(seed)
        self.ratios = []
        self.state = "NORMAL"
        self.since = time.time()
        self.over_why = ""
        self.live_until = None
        self.start = time.time()
        self.last_acc = {}          # capture_id -> (acc, events, ts) for send_raw
        self.mode = "monitor"

    def make(self, ts, live=False):
        r = self.rng
        cid = capture_id(ts)
        hour = datetime.fromtimestamp(ts).hour
        temp = 15 + 6.5 * math.sin(2 * math.pi * (hour + datetime.fromtimestamp(ts).minute / 60 - 9) / 24) + r.gauss(0, 0.2)
        stiff = [math.sqrt(1 - self.damage * f) for f in (1, 0.7, 0.45)]
        freq = [round(f * (1 - 0.0009 * (temp - 15)) * (1 + r.gauss(0, 0.0016)) * s, 3) for f, s in zip(F0, stiff)]
        mac = [round(min(1, m - abs(r.gauss(0, sd)) - self.damage * d), 3)
               for m, sd, d in zip([0.993, 0.978, 0.958], [0.003, 0.006, 0.01], [0.15, 0.6, 0.35])]
        if self.mode == "collect":
            ratio, why = None, "recording to learn normal behaviour"
        elif self.damage:
            ratio = round(1.5 + r.random() * 0.9, 3)
            why = "freq_m1 lower than expected (-%.1f sd); mac_m2 lower than expected (-%.1f sd)" % (6 + r.random() * 1.5, 4 + r.random())
        elif r.random() < 0.03:
            ratio, why = round(1.03 + r.random() * 0.3, 3), "rms_n2 higher than expected (+4.8 sd)"
        else:
            ratio, why = round(math.exp(math.log(0.4) + r.gauss(0, 0.27)), 3), "all features within the normal range"
        bad = r.choice(NODES) if r.random() < 0.05 else None
        flags = [bad + " dropout"] if bad else []
        event = None
        if ratio is not None:
            self.ratios = (self.ratios + [ratio])[-5:]
            if ratio > 1:
                self.over_why = why
            n_over = sum(1 for v in self.ratios if v > 1)
            state = "ALARM" if n_over >= 3 else "WARNING" if n_over else "NORMAL"
        else:
            state = "NORMAL"
        if state != self.state:
            event = {"type": "state", "from": self.state, "to": state, "capture_id": cid, "ts": ts,
                     "ratio": ratio, "why": "" if state == "NORMAL" else self.over_why}
            self.state, self.since = state, ts
        thr = 0.0215
        capture = {"site": self.site, "id": cid, "ts": ts, "mode": self.mode, "state": state, "q": not flags,
                   "flags": flags, "score": None if ratio is None else round(ratio * thr, 5), "ratio": ratio,
                   "thr": thr, "why": why, "temp": round(temp, 2), "freq": freq, "mac": mac,
                   "nodes": {nd: (None if nd == bad else round((ratio or 0.3) * r.uniform(0.75, 1.25), 3)) for nd in NODES}}

        busy = 8 <= hour < 10 or 17 <= hour < 19
        lam = 3.4 if busy else 1.9 if 6 <= hour < 22 else 0.4
        n_ev = min(6, sum(1 for _ in range(12) if r.random() < lam / 12))
        acc, events = simulate(freq, r, n_ev)
        self.last_acc[cid] = (acc, events, ts)
        while len(self.last_acc) > 30:
            self.last_acc.pop(next(iter(self.last_acc)))
        nodes = []
        for nd in NODES:
            src = acc[nd]
            wave = [sum(src[4 * i:4 * i + 4]) / 4 for i in range(len(src) // 4)]
            spikes, glitches = [], []
            if r.random() < 0.2:
                i = r.randrange(len(wave))
                wave[i] += r.choice([-1, 1]) * r.uniform(28, 70)
                spikes.append([round(i / FS_PREV, 2), round(wave[i], 1)])
            if r.random() < 0.1:
                glitches.append([round(r.uniform(0, DUR), 2), round(r.choice([-1, 1]) * r.uniform(40, 120), 1)])
            rms = math.sqrt(sum(v * v for v in wave) / len(wave))
            noise = math.sqrt(sum((wave[i] - wave[i - 1]) ** 2 for i in range(1, len(wave))) / (len(wave) - 1) / 2)
            psd, df = welch(wave, FS_PREV, 256)
            b64, scale, coding = encode_wave(wave)
            nodes.append({"node": nd, "ok": nd != bad, "rms": round(rms, 3), "peak": round(max(abs(v) for v in wave), 2),
                          "noise": round(noise, 3), "n": len(wave), "scale": scale, "coding": coding, "wave": b64,
                          "spec": [int(round(100 * math.log10(max(p, 1e-12)))) for p in psd],
                          "spikes": spikes, "glitches": glitches})
        preview = {"site": self.site, "id": cid, "ts": ts, "state": state, "mode": self.mode, "q": capture["q"],
                   "ratio": ratio, "why": why, "fs": FS_PREV, "src_fs": FS_SRC, "dur": DUR, "df": FS_PREV / 256,
                   "events": events, "live": live, "nodes": nodes}
        return capture, preview, event

    def heartbeat(self):
        return {"uptime_s": int(time.time() - self.start), "cpu_temp_c": round(48 + self.rng.random() * 3, 1),
                "disk_free_gb": 22.8, "backlog": 0,
                "modem": {"signal_pct": int(60 + self.rng.random() * 15), "tech": "4G", "operator": "Test network"},
                "nodes": [{"node_id": nd, "age_s": int(2 + self.rng.random() * 20)} for nd in NODES],
                "faults": [], "live_until": self.live_until if self.live_until and self.live_until > time.time() else None}

    def raw_npz(self, cid):
        """numpy-style .npz: x int16 counts (channels x samples, lsb_g in g/count), channel_names, fs, ts, capture_id."""
        acc, _, ts = self.last_acc[cid]
        lsb = 0.0039
        names, rows = [], []
        for nd in NODES:
            for ax, gain, g0 in (("x", 0.12, 0), ("y", 0.3, 0), ("z", 1.0, 1000.0)):
                names.append(nd + ax)
                rows.append([max(-32768, min(32767, int(round((g0 + v * gain + self.rng.gauss(0, 0.3)) / 1000 / lsb)))) for v in acc[nd]])
        n = len(rows[0])

        def npy(descr, shape, payload):
            shp = "()" if not shape else "(%d,)" % shape[0] if len(shape) == 1 else "(" + ", ".join(map(str, shape)) + ")"
            h = "{'descr': '%s', 'fortran_order': False, 'shape': %s, }" % (descr, shp)
            h += " " * ((64 - (10 + len(h) + 1) % 64) % 64) + "\n"
            return b"\x93NUMPY\x01\x00" + struct.pack("<H", len(h)) + h.encode("latin1") + payload

        def ustr(strs, width):
            return b"".join(s.ljust(width, "\0").encode("utf-32-le") for s in strs)

        arrays = {
            "x": npy("<i2", [len(rows), n], b"".join(struct.pack("<%dh" % n, *row) for row in rows)),
            "channel_names": npy("<U3", [len(names)], ustr(names, 3)),
            "fs": npy("<f8", [], struct.pack("<d", FS_SRC)),
            "ts": npy("<f8", [], struct.pack("<d", ts)),
            "capture_id": npy("<U%d" % len(cid), [], ustr([cid], len(cid))),
            "lsb_g": npy("<f8", [], struct.pack("<d", lsb)),
        }
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for name, data in arrays.items():
                # numpy.savez writes each member with force_zip64=True; do the same
                with zf.open(name + ".npy", "w", force_zip64=True) as f:
                    f.write(data)
        return buf.getvalue()


# ---------------------------------------------------------------- MQTT
def make_client(cid):
    import paho.mqtt.client as mqtt
    try:
        return mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=cid)
    except AttributeError:  # paho-mqtt 1.x
        return mqtt.Client(client_id=cid)


def run(args):
    pi = FakePi(args.site, damage=args.damage)
    base = "shm/%s/" % args.site
    client = make_client("fake-pi-%04x" % random.randrange(65536))
    client.username_pw_set(args.user, args.password)
    client.will_set(base + "online", "0", qos=1, retain=True)
    if not args.no_tls:
        client.tls_set(cert_reqs=ssl.CERT_REQUIRED)
    lock = threading.Lock()
    connected = threading.Event()

    def pub(sub, obj, retain=False):
        payload = obj if isinstance(obj, (bytes, str)) else json.dumps(obj, separators=(",", ":"))
        client.publish(base + sub, payload, qos=1, retain=retain)

    def reply(cmd, ok, detail="", **extra):
        msg = {"cmd": cmd, "ok": ok, "detail": detail}
        msg.update(extra)
        pub("cmd_reply", msg)
        print("  reply:", msg)

    def on_connect(c, userdata, flags, rc, *rest):
        if rc != 0:
            print("Connection refused:", rc, "(wrong Pi username/password?)")
            return
        print("Connected as the Pi. Publishing on", base)
        c.subscribe(base + "cmd", qos=1)
        pub("online", "1", retain=True)
        pub("state", {"state": pi.state, "since": pi.since, "why": ""}, retain=True)
        pub("heartbeat", pi.heartbeat())
        connected.set()

    def on_message(c, userdata, msg):
        try:
            j = json.loads(msg.payload.decode("utf-8"))
        except Exception:
            return
        cmd = j.get("cmd")
        print("command:", {k: v for k, v in j.items() if k != "token"})
        if j.get("token") != args.token:
            reply(cmd, False, error="wrong command token")
            return
        with lock:
            if cmd == "ping":
                reply("ping", True, "pong from the test Pi")
            elif cmd == "status":
                pub("heartbeat", pi.heartbeat())
                reply("status", True, "heartbeat sent")
            elif cmd == "live_view":
                minutes = max(1, min(30, int(j.get("minutes", 10) or 10)))
                pi.live_until = time.time() + minutes * 60
                reply("live_view", True, "live view on for %d min" % minutes, live_until=pi.live_until)
            elif cmd == "live_stop":
                pi.live_until = None
                reply("live_stop", True, "live view stopped", live_until=None)
            elif cmd == "send_raw":
                cid = str(j.get("capture_id", ""))
                if cid in pi.last_acc:
                    reply("send_raw", True, "sending raw/" + cid)
                    pub("raw/" + cid, pi.raw_npz(cid))
                else:
                    reply("send_raw", False, error="only the last 30 captures of this test run are available")
            else:
                reply(cmd, False, error="not supported by the test script")

    client.on_connect = on_connect
    client.on_message = on_message
    print("Connecting to %s:%d %s..." % (args.host, args.port, "(TLS)" if not args.no_tls else "(no TLS)"))
    client.connect(args.host, args.port, keepalive=60)
    client.loop_start()
    if not connected.wait(20):
        print("No connection after 20 s. Check host, port, and the Pi's username/password.")
        client.loop_stop()
        sys.exit(1)
    last_hb = time.time()
    try:
        while True:
            live = bool(pi.live_until and pi.live_until > time.time())
            with lock:
                prev_state = pi.state
                cap, prev, ev = pi.make(time.time(), live=live)
                pub("capture", cap)
                pub("preview", prev)
                if ev:
                    pub("event", ev)
                if pi.state != prev_state:
                    pub("state", {"state": pi.state, "since": pi.since, "why": ev["why"] if ev else ""}, retain=True)
            print("%s capture %s  state %-7s ratio %s  preview %.1f kB%s" % (
                time.strftime("%H:%M:%S"), cap["id"], cap["state"], cap["ratio"],
                len(json.dumps(prev)) / 1024, "  (live)" if live else ""))
            if time.time() - last_hb >= 900:
                pub("heartbeat", pi.heartbeat())
                last_hb = time.time()
            if pi.live_until and pi.live_until <= time.time():
                pi.live_until = None
            time.sleep(3 if live else 10)
    except KeyboardInterrupt:
        print("\nStopping. The broker will publish online = 0 (last will).")
        client.loop_stop()
        client.socket().close() if client.socket() else None


def dry_run(folder):
    os.makedirs(folder, exist_ok=True)
    pi = FakePi("bridge01", seed=1)
    cap, prev, _ = pi.make(time.time())
    for name, obj in (("capture.json", cap), ("preview.json", prev), ("heartbeat.json", pi.heartbeat())):
        with open(os.path.join(folder, name), "w") as f:
            json.dump(obj, f)
    with open(os.path.join(folder, "raw_%s.npz" % cap["id"]), "wb") as f:
        f.write(pi.raw_npz(cap["id"]))
    print("Wrote capture, preview (%.1f kB), heartbeat and raw_%s.npz to %s" % (len(json.dumps(prev)) / 1024, cap["id"], folder))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Fake Pi base station for the bridge dashboard.")
    ap.add_argument("--host", help="broker address, e.g. xxxx.ala.asia-southeast1.emqxsl.com")
    ap.add_argument("--port", type=int, default=None, help="default 8883 (TLS) or 1883 with --no-tls")
    ap.add_argument("--user", help="the Pi's broker username")
    ap.add_argument("--password", help="the Pi's broker password")
    ap.add_argument("--site", default="bridge01")
    ap.add_argument("--token", default="test-token", help="command token the dashboard must send")
    ap.add_argument("--no-tls", action="store_true")
    ap.add_argument("--damage", action="store_true", help="simulate a 6%% stiffness loss")
    ap.add_argument("--dry-run", metavar="DIR", help="write sample messages to DIR instead of connecting")
    a = ap.parse_args()
    if a.dry_run:
        dry_run(a.dry_run)
        sys.exit(0)
    if not (a.host and a.user):
        ap.error("--host and --user are required (or use --dry-run DIR)")
    a.host = a.host.strip().replace("wss://", "").replace("mqtts://", "").split("/")[0].split(":")[0]
    while a.host.endswith(".emqxsl.com.emqxsl.com"):
        a.host = a.host[: -len(".emqxsl.com")]
    if a.port is None:
        a.port = 1883 if a.no_tls else 8883
    run(a)
