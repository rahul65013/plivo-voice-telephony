# Plivo + Sarvam AI Voice Streaming Server — Deployment & Ops Guide

**Stack:** Plivo (telephony) → EC2 Node.js WebSocket server → Sarvam AI (STT, en-IN) → your backend (LLM reply) → Plivo REST API (play audio back to caller)

This document is the single source of truth for standing this system up from a fresh AWS account, redeploying after code changes, and debugging it live. Written so a new engineer (or future-you) can go from zero to a working call with no missing steps.

---

## 1. Architecture

```
Caller's phone
      │
      ▼
   Plivo (PSTN)
      │  answers call → fetches /answer webhook
      ▼
EC2 Node.js server (Express + ws)
   /answer   → returns Plivo XML with <Stream> pointing to wss://.../stream
   /stream   → WebSocket: receives mulaw audio chunks from Plivo
   /hangup   → webhook fired when call ends
   /make-call→ REST endpoint you call to originate an outbound call
      │
      ▼ (per call)
CallSession
   - decodes mulaw → PCM16 (audioUtils.js)
   - streams PCM16 to Sarvam AI STT over WebSocket (sarvamSTT.js)
      │
      ▼
Sarvam AI STT (en-IN, model saaras:v3)
   - returns transcript events + VAD (speech start/end) signals
      │
      ▼
Your backend API (BACKEND_API_URL)
   - receives { callUUID, userText, fullTranscript }
   - generates a reply (your LLM/logic)
   - converts reply to speech (any TTS)
   - returns { audioUrl } — must be a public MP3/WAV
      │
      ▼
Plivo REST API — playSound(callUUID, audioUrl)
   - plays the audio back to the caller
```

Key design point: the EC2 server is a thin real-time transport layer (audio in/out, STT). All "intelligence" (LLM + TTS) lives in your own backend, decoupled behind one HTTP call.

---

## 2. Prerequisites

| Item | Notes |
|---|---|
| AWS account | Fresh account is fine — no pre-existing setup needed |
| Plivo account | Need `PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN`, and a purchased/rented `PLIVO_FROM_NUMBER` |
| Sarvam AI account | Need `SARVAM_API_KEY` from https://dashboard.sarvam.ai |
| A domain (or nip.io fallback) | Plivo requires `wss://` — it will not connect to a raw IP |
| GitHub repo for the code | Recommended so `git pull` works for redeploys (see §9) |

---

## 3. AWS Console Setup (browser only — no CLI required)

Use this path if you don't have/want the AWS CLI configured locally.

### 3.1 Region
Go to https://console.aws.amazon.com → top-right region selector → set to **Asia Pacific (Mumbai) `ap-south-1`** if serving India traffic.

### 3.2 Create a Key Pair
1. EC2 → left sidebar → **Network & Security → Key Pairs**
2. **Create key pair**
   - Name: `plivo-server-key`
   - Type: `RSA`
   - Format: `.pem` (Mac/Linux) or `.ppk` (Windows/PuTTY)
3. Browser auto-downloads the private key — **save it, it cannot be re-downloaded**.
4. Fix permissions locally:
   ```bash
   chmod 400 ~/Downloads/plivo-server-key.pem
   ```

> Note: if you use **EC2 Instance Connect** (§4) instead of SSH, you may not even need this key pair for day-to-day access — but keep it anyway as a fallback SSH path.

### 3.3 Create a Security Group
EC2 → **Network & Security → Security Groups → Create security group**

- Name: `plivo-server-sg`
- Description: `Plivo WebSocket server`
- Inbound rules:

  | Type | Protocol | Port | Source | Purpose |
  |---|---|---|---|---|
  | SSH | TCP | 22 | My IP | SSH access |
  | HTTP | TCP | 80 | 0.0.0.0/0 | Certbot SSL challenge |
  | HTTPS | TCP | 443 | 0.0.0.0/0 | Plivo webhooks + `wss://` |

- Outbound: leave default (all traffic allowed — server needs to reach Sarvam AI and Plivo).

### 3.4 Launch the EC2 Instance
EC2 → **Instances → Launch instances**

- Name: `plivo-sarvam-server`
- AMI: **Ubuntu Server 22.04 LTS**, 64-bit (x86)
- Instance type: `t3.small` (2 vCPU / 2GB — good for ~50 concurrent calls). Use `t3.micro` (free tier) just to test cheaply first.
- Key pair: `plivo-server-key`
- Network settings → Edit:
  - Auto-assign public IP: **Enable**
  - Firewall: select existing security group → `plivo-server-sg`
- Storage: bump to **20 GiB**, volume type `gp3`
- Click **Launch instance**

### 3.5 Get the Public IP
Instances → click `plivo-sarvam-server` → copy **Public IPv4 address**.
Wait until **Instance State = Running** and **Status checks = 2/2 passed** (~2 min).

### 3.6 Point a Domain at EC2
Add a DNS **A record** at your domain provider (Route 53, Cloudflare, Namecheap, GoDaddy):

```
Type:  A
Name:  calls              → creates calls.yourdomain.com
Value: <EC2_PUBLIC_IP>
TTL:   300
```

No domain yet? Use a free instant option:
```
# If EC2 IP is 13.233.45.67:
13.233.45.67.nip.io
```
This resolves instantly with zero DNS setup — use it as `SERVER_BASE_URL`.

Verify propagation:
```bash
nslookup calls.yourdomain.com   # should return the EC2 IP
```

---

## 4. Connecting to EC2 Without Local SSH

If your local internet/network doesn't allow outbound SSH, use **EC2 Instance Connect** — a browser-based terminal, no SSH client or key needed from your side.

1. AWS Console → EC2 → Instances → select `plivo-sarvam-server`
2. Click **Connect** (top right) → **EC2 Instance Connect** tab
3. Username: `ubuntu` (prefilled) → **Connect**
4. A terminal opens directly in the browser — you're now on the instance.

### Getting code onto the instance without SSH/rsync

**Option A — Clone from GitHub (preferred)**
```bash
cd /home/ubuntu
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git plivo-server
cd plivo-server
```
Private repo — use a Personal Access Token:
```bash
git clone https://YOUR_GITHUB_TOKEN@github.com/YOUR_USERNAME/YOUR_REPO.git plivo-server
```

**Option B — Paste files directly in the browser terminal**
Useful if the code isn't in GitHub yet. Full file contents are in §7 below — create each with `cat > path << 'EOF' ... EOF`.

**Option C — Transfer via S3 (best for large codebases / slow local internet)**
```bash
# Local machine
zip -r plivo-server.zip . --exclude "node_modules/*" --exclude ".git/*"
aws s3 cp plivo-server.zip s3://YOUR-BUCKET-NAME/plivo-server.zip

# EC2 browser terminal
cd /home/ubuntu
aws s3 cp s3://YOUR-BUCKET-NAME/plivo-server.zip .
unzip plivo-server.zip -d plivo-server
cd plivo-server
```

| Situation | Best option |
|---|---|
| Code already on GitHub | A |
| Code only local, slow/no internet | C (S3) |
| Just want it running fast, no repo yet | B (paste files) |

---

## 5. Installing the Runtime on EC2

Run these once, in order, on the EC2 instance (via Instance Connect or SSH):

```bash
# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version     # v20.x.x
npm --version

# PM2 (process manager — keeps the app alive, restarts on crash/reboot)
sudo npm install -g pm2
pm2 --version

# Nginx (reverse proxy + TLS termination) + Certbot (free SSL)
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo systemctl enable nginx
sudo systemctl start nginx

# Log directory used by the app's logger
sudo mkdir -p /var/log/plivo-server
sudo chown ubuntu:ubuntu /var/log/plivo-server
```

---

## 6. Project Bootstrap (if `package.json` doesn't exist yet)

```bash
mkdir -p /home/ubuntu/plivo-server/src
mkdir -p /home/ubuntu/plivo-server/infra
cd /home/ubuntu/plivo-server

npm init -y
npm install ws express plivo axios dotenv winston
```

Verify:
```bash
ls node_modules | grep -E "ws|express|plivo|axios|dotenv|winston"
```

If cloning a repo that already has `package.json`:
```bash
cd /home/ubuntu/plivo-server
npm install
```

---

## 7. Source Files

Directory layout:
```
plivo-server/
├── .env
├── ecosystem.config.js
├── infra/
│   └── nginx.conf
└── src/
    ├── audioUtils.js
    ├── callSession.js
    ├── logger.js
    ├── sarvamSTT.js
    └── server.js
```

### `src/logger.js`
Winston logger — colorized console output in dev, JSON + rotating file logs (`/var/log/plivo-server/`) in production.

### `src/audioUtils.js`
Converts Plivo's inbound `mulaw` base64 audio payload into `PCM16` (`mulawBase64ToPcm16`), which is the format Sarvam AI's streaming STT expects.

### `src/sarvamSTT.js`
`SarvamSTT` class — opens a WebSocket to `wss://api.sarvam.ai/v1/speech-to-text/streaming` with:
- `model=saaras:v3`, `language_code=en-IN`, `sample_rate=8000`, `input_audio_codec=pcm_s16le`
- VAD enabled (`high_vad_sensitivity`, `vad_signals`)
- Buffers audio if the socket isn't ready yet (`audioQueue`)
- Auto-reconnects up to 3 times on abnormal close (code `1006`) with exponential backoff
- Emits `onTranscript(text)` and `onVAD(signal)` callbacks

### `src/callSession.js`
`CallSession` — one instance per active call:
- Feeds decoded audio into `SarvamSTT`
- On each transcript: appends to `fullTranscript`, then POSTs `{ callUUID, userText, fullTranscript }` to `BACKEND_API_URL`
- Takes the returned `audioUrl` and calls `plivoClient.calls.playSound(callUUID, audioUrl, { loop: 1, legs: "aleg" })`
- Guards against overlapping backend calls with `isProcessing`
- Treats "call already ended" (404) from Plivo as a soft warning, not a crash

### `src/server.js`
Express + `ws` server:
- Validates required env vars on boot and exits if any are missing
- `GET /health` → `{ status: "ok", uptime }`
- `GET /answer` → returns Plivo XML `<Stream>` pointing at `wss://<domain>/stream` (inbound audio only, `keepCallAlive: true`)
- `POST /hangup` → logs call end
- `POST /make-call` → originates an outbound call via Plivo, given `{ toNumber }`
- WebSocket `/stream` handler: on `start` creates a `CallSession`; on `media` forwards the audio payload; on `stop` ends the session and cleans up
- Graceful shutdown on `SIGTERM`/`SIGINT` — ends all active sessions before exiting

> Full verbatim code for each file is preserved in the project's Git history / original chat thread. This guide documents structure and behavior; pull the actual files from GitHub (§4, Option A) rather than re-typing them by hand where possible.

### `ecosystem.config.js` (PM2 config)
- App name: `plivo-server`, entry: `src/server.js`, single fork instance
- `max_memory_restart: 512M`, auto-restart on crash, `min_uptime: 10s`, `max_restarts: 10`
- Logs to `/var/log/plivo-server/out.log` and `error.log`

### `.env` (never commit this)
```bash
PORT=8080
NODE_ENV=production
SERVER_BASE_URL=https://YOUR_DOMAIN_HERE

PLIVO_AUTH_ID=YOUR_PLIVO_AUTH_ID
PLIVO_AUTH_TOKEN=YOUR_PLIVO_AUTH_TOKEN
PLIVO_FROM_NUMBER=+1XXXXXXXXXX

SARVAM_API_KEY=YOUR_SARVAM_KEY
SARVAM_LANGUAGE=en-IN

BACKEND_API_URL=https://your-backend.com/api/call-response
BACKEND_API_KEY=YOUR_BACKEND_API_KEY
```

### `infra/nginx.conf`
- Port 80: serves the Certbot ACME challenge, redirects everything else to HTTPS
- Port 443 (SSL):
  - `/stream` → proxied to `127.0.0.1:8080` with `Upgrade`/`Connection` headers set for WebSocket, `proxy_read_timeout`/`proxy_send_timeout` set to `86400s` (long-lived calls), buffering off
  - `/` → standard reverse proxy to the Node app, 30s timeout
  - Access/error logs at `/var/log/nginx/plivo-server.*`

Sanity check after creating/editing files:
```bash
cd /home/ubuntu/plivo-server
node -e "
['./src/logger.js','./src/audioUtils.js','./src/sarvamSTT.js','./src/callSession.js','./src/server.js'].forEach(f => {
  try { require(f); console.log('OK', f); } catch(e) { console.log('ERR', f, e.message); }
});
"
```
All five files must print `OK` before proceeding.

---

## 8. Nginx + SSL + PM2 — Bring It Live

### 8.1 Configure Nginx
```bash
sudo cp /home/ubuntu/plivo-server/infra/nginx.conf \
        /etc/nginx/sites-available/plivo-server

sudo sed -i 's/YOUR_DOMAIN_HERE/calls.yourdomain.com/g' \
        /etc/nginx/sites-available/plivo-server

sudo ln -sf /etc/nginx/sites-available/plivo-server \
            /etc/nginx/sites-enabled/plivo-server
sudo rm -f /etc/nginx/sites-enabled/default

sudo nginx -t                # must say "syntax is ok"
sudo systemctl reload nginx
```

### 8.2 Get SSL Certificate
```bash
sudo certbot --nginx \
  -d calls.yourdomain.com \
  --non-interactive \
  --agree-tos \
  --email your@email.com \
  --redirect

sudo systemctl status certbot.timer   # confirms auto-renewal is scheduled
sudo certbot renew --dry-run          # optional: test renewal works
```

### 8.3 Start the App with PM2
```bash
cd /home/ubuntu/plivo-server
NODE_ENV=production pm2 start ecosystem.config.js --env production

pm2 status     # should show plivo-server | online

pm2 save
pm2 startup systemd -u ubuntu --hp /home/ubuntu | tail -1 | sudo bash
```

### 8.4 Verify End to End
```bash
curl http://localhost:8080/health
curl https://calls.yourdomain.com/health
# {"status":"ok","uptime":"..."}  — confirms Node + Nginx + SSL are all wired correctly
```

---

## 9. Plivo Dashboard Configuration

1. https://console.plivo.com → **Voice → Applications → New Application**
   - App Name: `Sarvam STT Server`
   - Answer URL: `https://calls.yourdomain.com/answer` — Method: `GET`
   - Hangup URL: `https://calls.yourdomain.com/hangup` — Method: `POST`
   - Save
2. **Phone Numbers → Your Numbers** → select your number → set **Voice Application** to `Sarvam STT Server` → Update

---

## 10. Testing a Call

```bash
curl -X POST https://calls.yourdomain.com/make-call \
  -H "Content-Type: application/json" \
  -d '{"toNumber": "+91XXXXXXXXXX"}'
# {"success":true,"requestUuid":"..."}
```

Watch it live:
```bash
pm2 logs plivo-server
```

Expected sequence:
```
[WS] New Plivo connection from 54.x.x.x
[WS] CALL STARTED — abc-123 | audio/x-mulaw 8000Hz
[abc-123] STT connected to Sarvam AI
[abc-123] Speaking...
[abc-123] TRANSCRIPT: "Hello who is this"
[abc-123] USER SAID   : "Hello who is this"
[abc-123] Calling backend: https://your-backend.com/api/call-response
[abc-123] Got audioUrl: https://cdn.your-backend.com/reply.mp3
[abc-123] Audio playing to caller
[WS] CALL STOPPED — abc-123
[abc-123] CALL ENDED — duration: 40.1s
```

**Your backend contract** (the one piece you own end-to-end):
```javascript
// POST /api/call-response
app.post("/api/call-response", async (req, res) => {
  const { callUUID, userText, fullTranscript } = req.body;
  const replyText = await generateReply(userText);   // your LLM/logic
  const audioUrl  = await textToSpeechUrl(replyText); // any TTS provider
  res.json({ audioUrl });   // must be a publicly reachable MP3/WAV
});
```

---

## 11. Live Log Monitoring (Ongoing Ops)

```bash
pm2 logs plivo-server               # everything, live
pm2 logs plivo-server --lines 200   # with history
pm2 logs plivo-server --err         # errors only
pm2 logs plivo-server --out         # transcripts/events only
```
Ctrl+C stops watching — the server keeps running.

Direct log files (written by Winston in production mode):
```bash
tail -f /var/log/plivo-server/out.log
tail -f /var/log/plivo-server/error.log
tail -f /var/log/plivo-server/out.log /var/log/plivo-server/error.log
```

Other useful PM2 commands:
```bash
pm2 status                 # is it running?
pm2 restart plivo-server   # restart after a code change
pm2 stop plivo-server
pm2 flush plivo-server     # clear accumulated logs
```

---

## 12. Redeploying After a Code Change

Standard flow whenever you `git push` new code:

```bash
cd /home/ubuntu/plivo-server
git pull
npm install                # only needed if package.json changed
pm2 restart plivo-server
```

If you added new `.env` variables:
```bash
git pull
nano .env                  # add the new variables
pm2 restart plivo-server
```

Confirm the restart picked up clean code:
```bash
pm2 status
pm2 logs plivo-server --lines 20
```

**Critical:** never commit `.env` — it holds live API keys. Confirm `.gitignore` covers it:
```bash
cat .gitignore
# should include:
#   node_modules/
#   .env
#   *.log
```
If missing:
```bash
echo ".env" >> .gitignore
git add .gitignore
git commit -m "add .env to gitignore"
```

---

## 13. Known Issues / Troubleshooting Notes

- **`answer_url` 400 error from Plivo**: usually caused by a phone number arriving with a leading space and its `+` sign getting URL-encoded incorrectly. Fix by sanitizing numbers before use: `toNumber.replace(/\D/g, '')` (then re-prefix with `+<country code>` as needed).
- **DynamoDB fields (e.g. `toNumber`) not saving**: check that all required client initialization calls (e.g. the DynamoDB client setup) actually run in `server.js` before the first write — a missing init call silently no-ops writes rather than throwing.
- **Sarvam AI 403 on WebSocket connect**: almost always an auth header issue — confirm `api-subscription-key` header is set and the key is valid/active on https://dashboard.sarvam.ai.
- **Call ends but server tries to `playSound` anyway**: expected and handled — a `404`/"not found" from Plivo on `playSound` is logged as a warning (`Call already ended`), not thrown.
- **Nothing happens after a call connects**: check `pm2 logs` for `STT connected to Sarvam AI` — if that line never appears, the issue is the outbound WebSocket to Sarvam (network/firewall/API key), not Plivo.

---

## 14. Quick Reference — Full Setup Checklist

- [ ] AWS account ready, region set to `ap-south-1`
- [ ] Key pair created (`plivo-server-key`)
- [ ] Security group created (22/80/443)
- [ ] EC2 instance launched (Ubuntu 22.04, `t3.small`, 20GB gp3)
- [ ] Domain (or nip.io) pointed at EC2 public IP
- [ ] Connected via EC2 Instance Connect or SSH
- [ ] Node 20, PM2, Nginx, Certbot installed
- [ ] Code present (`git clone`, pasted, or via S3) with `package.json` + `node_modules` installed
- [ ] `.env` filled in with real Plivo/Sarvam/backend values
- [ ] Nginx site enabled, `nginx -t` passes
- [ ] SSL certificate issued via Certbot
- [ ] App started with PM2, `pm2 save` + `pm2 startup` run
- [ ] `/health` returns `200` over HTTPS
- [ ] Plivo Application created with Answer/Hangup URLs, assigned to phone number
- [ ] Test call made via `/make-call`, transcript + audio playback confirmed in `pm2 logs`
