# NEON ▸ YTDL

A self-hosted YouTube downloader with a cyberpunk terminal UI.
**React + Vite** frontend · **Express + Bull + Socket.io** backend · **yt-dlp + ffmpeg + aria2c** under the hood.

> ⚠️ Downloading YouTube content may violate YouTube's Terms of Service.
> Intended for personal/educational use on content you have rights to.
> Shared hosts (Render/Railway/Fly free tiers) get IP-banned by YouTube quickly — a small VPS works best.

---

## Requirements

- **Node.js** ≥ 18
- **Redis** ≥ 6 (job queue)
- **yt-dlp**, **ffmpeg**, **aria2c** (the `setup.sh` script installs these via Homebrew on macOS or apt on Linux)

---

## Quick start (local, macOS / Linux)

```bash
# 1. install system deps (yt-dlp, ffmpeg, aria2c) + node modules
chmod +x setup.sh && ./setup.sh

# 2. start Redis — pick ONE
brew services start redis          # macOS (Homebrew)
sudo systemctl start redis-server  # Linux (systemd)
docker run -d --name redis -p 6379:6379 redis:7-alpine   # any OS with Docker

# verify Redis is up
redis-cli ping     # → PONG

# 3. configure env + run both client and server
cp server/.env.example server/.env
npm install
npm run dev
```

Open **http://localhost:5173** — Vite proxies `/api/*` and `/socket.io` to the backend on `:5050`.

### Stopping

`Ctrl+C` once stops the dev processes. The backend handles `SIGTERM` cleanly — in-flight downloads are cancelled and Redis connections closed.

---

## One-command Docker (recommended for deploy)

```bash
docker compose up --build
# open http://localhost:5050
```

This brings up the app + Redis. Built client is served by Express on `:5050` (no separate Vite needed).

To rebuild after a code change:

```bash
docker compose up --build --force-recreate
```

---

## Available npm scripts

Run from the repo root:

| Command | What it does |
|---|---|
| `npm install` | Installs root + `client/` + `server/` deps (via workspaces) |
| `npm run dev` | Runs Vite (5173) **and** Express (5050) concurrently |
| `npm run dev:client` | Vite only |
| `npm run dev:server` | Nodemon-backed Express only |
| `npm run build` | Builds the React client into `client/dist` |
| `npm start` | Runs the production server (serves built client + API on `:5050`) |

---

## Features (Phase 1)

- **Stream type selector** — VIDEO+AUDIO · VIDEO ONLY · AUDIO ONLY
- **Mode-aware quality picker** — resolutions (144p → 8K) for video, bitrates (64 → 320 kbps) for audio, with live size estimates
- **Container picker** — mp4 / mkv / webm for video, mp3 / m4a / opus / wav / flac for audio
- **Subtitles** — pick languages, embed into video, or download as sidecar (incl. auto-generated)
- **Embed options** — thumbnail (cover art for audio), metadata (title/artist/album), chapter markers
- **Batch mode** — start a batch (`⌘/Ctrl+B`), paste multiple URLs, share one config, queue all at once
- **Playlist → batch** — fetch a playlist URL and send all entries to a batch
- **Grouped queue view** — batch jobs visually nested under their batch title
- **Keyboard shortcuts** — `⌘/Ctrl+B` toggle batch · `Enter` add URL / fetch · `Esc` cancel batch
- **Toast notifications** — connect, queued, ready, errors

## API reference

| Method | Path | Body / Returns |
|---|---|---|
| POST | `/api/fetch-info` | `{ url }` → video metadata (incl. per-format `filesize`, available `subtitles`, `auto_subtitles`) or playlist info |
| POST | `/api/download` | Single: `{ url, mode, quality, container, subtitles, embed, format_id?, title?, thumbnail? }` → `{ job_id }`. Batch: `{ items:[{url,title,thumbnail}], mode, quality, container, subtitles, embed, groupId?, groupTitle? }` → `{ batch:true, groupId, job_ids:[] }` |
| GET | `/api/download/:id/file` | streams merged file, deletes after delivery |
| GET | `/api/queue` | active/queued/completed/failed jobs (incl. `groupId`, `groupTitle`, `orderInGroup`) |
| DELETE | `/api/job/:id` | cancels job, removes from queue, deletes files |
| GET | `/healthz` | `{ ok: true }` |

**Payload schema**:

```jsonc
{
  "mode": "both | video | audio",
  "quality": "best | 4320 | 2160 | 1440 | 1080 | 720 | 480 | 360 | 240 | 144   // video
              | 320 | 256 | 192 | 128 | 64                                       // audio (kbps)",
  "container": "mp4 | mkv | webm | mp3 | m4a | opus | wav | flac",
  "subtitles": { "enabled": true, "langs": ["en","es"], "embed": false, "auto": false },
  "embed":     { "thumbnail": true, "metadata": true, "chapters": false }
}
```

**WebSocket events** on `/socket.io`:
`job:start` · `job:progress` (percent, speed, eta, totalSize) · `job:done` · `job:error` · `queue:update`

---

## Environment variables (`server/.env`)

| Name | Default | Purpose |
|---|---|---|
| `PORT` | `5050` | HTTP/WS port |
| `BASE_URL` | `http://localhost:5050` | Used for absolute links |
| `REDIS_URL` | `redis://localhost:6379` | Bull queue backend |
| `TMP_DIR` | `/tmp/neon-ytdl` | Where downloaded files land before delivery |
| `MAX_CONCURRENT` | `5` | Parallel downloads |
| `MAX_FILESIZE_MB` | `2048` | Refuse files larger than this |

---

## Deploy to a VPS

```bash
git clone <your-fork> && cd ytdl
./setup.sh
cp server/.env.example server/.env  # edit REDIS_URL / BASE_URL
npm run build
NODE_ENV=production npm start
```

Front a reverse proxy (Caddy / Nginx) for TLS and WebSocket upgrade. The Express server already serves `client/dist` when present, so a single port is enough.

---

## Troubleshooting

**`MaxRetriesPerRequestError` / `ECONNREFUSED` on startup**
Redis isn't running. Start it (see Quick start step 2) and `redis-cli ping` should return `PONG`.

**`/api/download` returns 503 `Queue offline`**
Same root cause — Redis isn't reachable from the server process.

**`yt-dlp: command not found`**
Re-run `./setup.sh`, or install manually: `brew install yt-dlp ffmpeg aria2` (macOS) / `sudo apt install -y python3-pip ffmpeg aria2 && pip install -U yt-dlp` (Debian/Ubuntu).

**HTTP 429 from YouTube**
You're rate-limited. Wait a few minutes; consider rotating IP or running on a residential VPS.

**Vite proxy `socket hang up` / `ECONNREFUSED`**
The backend on `:5050` crashed or never started. Check the `[SERVER]` lines in the terminal.

---

## How it works (under the hood)

- `yt-dlp` is invoked with `--concurrent-fragments 8 --buffer-size 16K --no-part --merge-output-format mp4`, plus `--downloader aria2c --downloader-args "aria2c:-x16 -s16 -k1M"` when `aria2c` is installed.
- Audio modes (`audio-mp3`, `audio-m4a`) use `--extract-audio` at best quality.
- Progress is parsed line-by-line from yt-dlp's `--newline --progress` output and pushed over Socket.io.
- A background sweeper deletes files in `TMP_DIR` older than 1 hour, and files are removed shortly after successful delivery.
