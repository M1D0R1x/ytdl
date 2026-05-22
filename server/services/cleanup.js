import fs from 'fs';
import path from 'path';

const TMP_DIR = process.env.TMP_DIR || '/tmp/neon-ytdl';
const MAX_AGE_MS = 60 * 60 * 1000; // 1h

export function initCleanup() {
  setInterval(sweep, 10 * 60 * 1000);
  sweep();
}

function sweep() {
  if (!fs.existsSync(TMP_DIR)) return;
  const now = Date.now();
  for (const entry of fs.readdirSync(TMP_DIR)) {
    const p = path.join(TMP_DIR, entry);
    try {
      const st = fs.statSync(p);
      if (now - st.mtimeMs > MAX_AGE_MS) {
        fs.rmSync(p, { recursive: true, force: true });
      }
    } catch {}
  }
}

export function deleteJobDir(jobId) {
  const p = path.join(TMP_DIR, jobId);
  fs.rmSync(p, { recursive: true, force: true });
}
