import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { buildYtDlpArgs } from './buildYtDlpArgs.js';

const TMP_DIR = process.env.TMP_DIR || '/tmp/neon-ytdl';

export async function fetchInfo(url) {
  const flatArgs = ['-J', '--flat-playlist', '--no-warnings', url];
  const { stdout } = await execCapture('yt-dlp', flatArgs);
  const info = JSON.parse(stdout);

  if (info._type === 'playlist' && Array.isArray(info.entries)) {
    return {
      type: 'playlist',
      title: info.title,
      id: info.id,
      count: info.entries.length,
      entries: info.entries.slice(0, 200).map((e) => ({
        id: e.id,
        title: e.title,
        url: e.url || `https://www.youtube.com/watch?v=${e.id}`,
        duration: e.duration,
      })),
    };
  }

  const single = await execCapture('yt-dlp', ['-J', '--no-warnings', '--no-playlist', url]);
  const v = JSON.parse(single.stdout);
  const formats = (v.formats || [])
    .filter((f) => f.vcodec !== 'none' || f.acodec !== 'none')
    .map((f) => ({
      format_id: f.format_id,
      ext: f.ext,
      quality: f.format_note || (f.height ? `${f.height}p` : f.abr ? `${f.abr}kbps` : f.format),
      height: f.height || null,
      fps: f.fps || null,
      abr: f.abr || null,
      filesize: f.filesize || f.filesize_approx || null,
      vcodec: f.vcodec,
      acodec: f.acodec,
      type: f.vcodec === 'none' ? 'audio' : (f.acodec === 'none' ? 'video' : 'muxed'),
    }));

  // available subtitle languages
  const subs = Object.keys(v.subtitles || {});
  const autoSubs = Object.keys(v.automatic_captions || {});

  return {
    type: 'video',
    id: v.id,
    title: v.title,
    thumbnail: v.thumbnail,
    duration: v.duration,
    uploader: v.uploader,
    view_count: v.view_count,
    formats,
    subtitles: subs,
    auto_subtitles: autoSubs,
  };
}

function execCapture(cmd, args) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args);
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => stdout += d);
    c.stderr.on('data', (d) => stderr += d);
    c.on('error', reject);
    c.on('close', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr || `exit ${code}`)));
  });
}

/**
 * Download for a job. Accepts the full Phase-1 payload.
 * Emits progress via onProgress({percent, speed, eta}).
 */
export function downloadJob({ jobId, payload, onProgress, onLog }) {
  const outDir = path.join(TMP_DIR, jobId);
  fs.mkdirSync(outDir, { recursive: true });
  const outTpl = path.join(outDir, '%(title).180s.%(ext)s');

  const args = buildYtDlpArgs(payload, { outTpl, hasAria2c: hasBinary('aria2c') });

  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    activeChildren.set(jobId, child);

    const handleLine = (line) => {
      onLog?.(line);
      const m = line.match(/\[download\]\s+(\d+\.\d+)%\s+of\s+~?\s*([\d.]+\w+)\s+at\s+([\d.]+\w+\/s)\s+ETA\s+([\d:]+)/);
      if (m) {
        onProgress?.({
          percent: parseFloat(m[1]),
          totalSize: m[2],
          speed: m[3],
          eta: m[4],
        });
      }
    };

    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i; while ((i = buf.indexOf('\n')) !== -1) {
        handleLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.on('data', (d) => onLog?.(d.toString()));

    child.on('error', reject);
    child.on('close', (code) => {
      activeChildren.delete(jobId);
      if (code !== 0) return reject(new Error(`yt-dlp exited ${code}`));
      const files = fs.readdirSync(outDir).map((f) => {
        const p = path.join(outDir, f);
        return { p, size: fs.statSync(p).size };
      }).sort((a, b) => b.size - a.size);
      if (!files.length) return reject(new Error('no output file'));
      resolve({ filePath: files[0].p, size: files[0].size });
    });
  });
}

const activeChildren = new Map();
export function cancelJob(jobId) {
  const c = activeChildren.get(jobId);
  if (c) { c.kill('SIGTERM'); activeChildren.delete(jobId); return true; }
  return false;
}

function hasBinary(name) {
  const which = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { execSync } = require('child_process');
    execSync(`${which} ${name}`, { stdio: 'ignore' });
    return true;
  } catch { return false; }
}
