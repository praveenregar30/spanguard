# Bridge health monitor

A web dashboard for a road-bridge structural health monitoring system. Three ESP32 + ADXL345 sensor nodes sit at a quarter, half and three quarters of the span. Every 5 minutes a Raspberry Pi records 30 seconds of vibration, scores it with an autoencoder, and sends the results through an MQTT broker over 4G. This dashboard shows those results.

- **One file, no build step.** `index.html` holds everything. Open it from disk in Chrome, or host it on any static site (GitHub Pages works).
- **Demo mode** starts automatically when nothing is configured, with a simulated week of data. Use "Simulate 6% stiffness loss" to watch the alarm logic.
- **Live data** comes from the broker over WebSockets (`wss://<address>:8084/mqtt`).
- **History** comes from the laptop receiver's `remote.sqlite`, opened with the file picker on the Connect page.

## Files

| File | What it is |
|---|---|
| `index.html` | The dashboard. This is the only file you need to open or host. |
| `broker_test.py` | A fake Raspberry Pi for testing. It publishes captures, previews, heartbeats and events in the exact message formats, and answers commands. |
| `src/` | The same dashboard split into parts for editing. Run `sh src/build.sh` to rebuild `index.html`. |

## Connect the dashboard to your Raspberry Pi

1. **Create the broker.** In EMQX Cloud, create a Serverless deployment. Its overview page shows the connection address (it ends in `.emqxsl.com`) and the ports: 8883 for MQTT over TLS (the Pi uses this) and 8084 for WebSocket over TLS (the dashboard uses this).
2. **Create two logins** under the deployment's authentication settings: one for the Pi and one for the dashboard. Keeping them separate means a leaked dashboard password cannot pretend to be the Pi.
3. **Point the Pi at the broker.** The Pi's sender connects to `<address>:8883` with TLS and the Pi login, and publishes under `shm/<site>/` (default site ID `bridge01`). `broker_test.py` is a working reference for every topic and message format.
4. **Test without the Pi first:**
   ```
   pip install paho-mqtt
   python broker_test.py --host <address> --user <pi user> --password <pi password> --token <choose a token>
   ```
5. **Open the dashboard,** go to Connect, paste the address, enter the dashboard login and site ID, tick "Remember on this device" if you want, and press Connect. The header changes to "Live" and a new capture appears every 10 seconds from the test script, or every 5 minutes from the real Pi.
6. **Commands** (ping, live view, raw file, and so on) need the command token that the Pi checks. Enter it on the System page. It is never stored.
7. **History:** the broker only passes on new messages. To see past days, open `remote.sqlite` from the laptop receiver on the Connect page.

If the connection fails, the Connect page says why in plain words: a wrong address, a wrong username or password, or a network that blocks port 8084 (common on campus and office Wi-Fi; try a phone hotspot).

## Message topics

All under `shm/<site>/`: `capture`, `preview`, `event`, `state` (retained), `online` (retained, also the Pi's last will), `heartbeat`, `cmd`, `cmd_reply`, and `raw/<capture_id>` (binary `.npz`). The fields are documented at the top of `broker_test.py` and in the code that builds each message there.
