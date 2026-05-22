import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fetchInfo } from '../services/ytdlp.js';
import { addJob, getJob, listJobs, removeJob } from '../services/queue.js';
import { deleteJobDir } from '../services/cleanup.js';

const router = Router();

router.post('/fetch-info', async (req, res) => {
  const { url } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'invalid url' });
  try {
    const info = await fetchInfo(url);
    res.json(info);
  } catch (e) {
    const msg = String(e.message || e);
    if (/Private video|Sign in|age/i.test(msg)) {
      return res.status(403).json({ error: 'Video is private, age-restricted, or requires sign-in.' });
    }
    if (/HTTP Error 429|Too Many Requests/i.test(msg)) {
      return res.status(429).json({ error: 'YouTube is rate-limiting this server. Try again later.' });
    }
    res.status(500).json({ error: msg.slice(0, 400) });
  }
});

/**
 * POST /api/download
 * Accepts either a single job or a batch.
 *
 * Single:  { url, mode, quality, container, subtitles, embed, format_id?, title?, thumbnail? }
 * Batch:   { items: [{url,title,thumbnail}, ...], mode, quality, container,
 *            subtitles, embed, groupId, groupTitle }
 *
 * Backwards compat: legacy { url, quality, format_id } still works (mode defaults to 'both').
 */
router.post('/download', async (req, res) => {
  const body = req.body || {};
  try {
    const shared = {
      mode: body.mode || 'both',
      quality: body.quality || '1080',
      container: body.container,
      format_id: body.format_id,
      subtitles: body.subtitles || { enabled: false },
      embed: body.embed || {},
    };

    // Batch path
    if (Array.isArray(body.items) && body.items.length) {
      const groupId = body.groupId || crypto.randomUUID();
      const groupTitle = body.groupTitle || `Batch ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
      const total = body.items.length;
      const ids = [];
      for (let i = 0; i < total; i++) {
        const it = body.items[i];
        if (!it?.url) continue;
        const job = await addJob({
          ...shared,
          url: it.url,
          title: it.title,
          thumbnail: it.thumbnail,
          groupId,
          groupTitle,
          orderInGroup: i + 1,
          totalInGroup: total,
        });
        ids.push(String(job.id));
      }
      return res.json({ batch: true, groupId, groupTitle, job_ids: ids });
    }

    // Single
    if (!body.url) return res.status(400).json({ error: 'url required' });
    const job = await addJob({
      ...shared,
      url: body.url,
      title: body.title,
      thumbnail: body.thumbnail,
    });
    res.json({ job_id: String(job.id) });
  } catch (e) {
    const msg = String(e.message || e);
    console.error('[api/download] failed:', msg);
    if (/ECONNREFUSED|Redis|ENOTFOUND/i.test(msg)) {
      return res.status(503).json({
        error: 'Queue offline: Redis is not reachable. Start Redis (docker compose up redis) and retry.',
      });
    }
    res.status(500).json({ error: msg.slice(0, 400) });
  }
});

router.get('/queue', async (_req, res) => {
  res.json({ jobs: await listJobs() });
});

router.delete('/job/:id', async (req, res) => {
  await removeJob(req.params.id);
  deleteJobDir(req.params.id);
  res.json({ ok: true });
});

router.get('/download/:id/file', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  const state = await job.getState();
  if (state !== 'completed') return res.status(409).json({ error: `job not ready (${state})` });
  const filePath = job.returnvalue?.filePath || job.data?.filePath;
  if (!filePath || !fs.existsSync(filePath)) return res.status(410).json({ error: 'file expired' });
  const filename = path.basename(filePath);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on('close', () => {
    setTimeout(() => deleteJobDir(String(job.id)), 5000);
  });
});

export default router;
