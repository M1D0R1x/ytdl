import Bull from 'bull';
import { downloadJob, cancelJob } from './ytdlp.js';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '5', 10);

let queue;
let ioRef;

export function initQueue(io) {
  ioRef = io;
  queue = new Bull('downloads', REDIS_URL, {
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'fixed', delay: 3000 },
      removeOnComplete: false,
      removeOnFail: false,
    },
  });

  queue.process(MAX_CONCURRENT, async (job) => {
    const payload = job.data; // full Phase-1 payload (url, mode, quality, ...)
    const jobId = String(job.id);

    const emit = (event, data) => {
      ioRef.to(`job:${jobId}`).emit(event, { jobId, ...data });
      ioRef.emit('queue:update');
    };

    emit('job:start', { url: payload.url });

    const result = await downloadJob({
      jobId,
      payload,
      onProgress: (p) => {
        job.progress(p.percent || 0);
        emit('job:progress', p);
      },
      onLog: (line) => emit('job:log', { line: String(line).slice(0, 500) }),
    });

    await job.update({ ...payload, filePath: result.filePath, size: result.size });
    emit('job:done', { filePath: result.filePath, size: result.size });
    return { filePath: result.filePath, size: result.size };
  });

  queue.on('failed', (job, err) => {
    ioRef.to(`job:${job.id}`).emit('job:error', { jobId: String(job.id), message: err.message });
    ioRef.emit('queue:update');
  });
  queue.on('completed', () => ioRef.emit('queue:update'));
}

export function getQueue() { return queue; }

export async function addJob(data) {
  const job = await queue.add(data);
  ioRef.emit('queue:update');
  return job;
}

export async function listJobs() {
  const states = ['waiting', 'active', 'completed', 'failed', 'delayed'];
  const all = await Promise.all(states.map((s) => queue.getJobs([s], 0, 50)));
  const flat = all.flat();
  return Promise.all(flat.map(async (j) => ({
    id: String(j.id),
    state: await j.getState(),
    progress: j.progress(),
    data: {
      url: j.data.url,
      mode: j.data.mode,
      quality: j.data.quality,
      container: j.data.container,
      title: j.data.title,
      thumbnail: j.data.thumbnail,
      groupId: j.data.groupId,
      groupTitle: j.data.groupTitle,
      orderInGroup: j.data.orderInGroup,
      totalInGroup: j.data.totalInGroup,
    },
    failedReason: j.failedReason,
    finishedOn: j.finishedOn,
  })));
}

export async function getJob(id) { return queue.getJob(id); }

export async function removeJob(id) {
  cancelJob(String(id));
  const j = await queue.getJob(id);
  if (j) await j.remove();
  ioRef.emit('queue:update');
  return true;
}

export async function shutdownQueue() {
  if (queue) await queue.close();
}
