import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server as IOServer } from 'socket.io';
import path from 'path';
import fs from 'fs';
import apiRouter from './routes/api.js';
import { initQueue, shutdownQueue } from './services/queue.js';
import { initCleanup } from './services/cleanup.js';

const PORT = process.env.PORT || 5050;
const TMP_DIR = process.env.TMP_DIR || '/tmp/neon-ytdl';

fs.mkdirSync(TMP_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new IOServer(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e7,
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Inject io into req for routes that need to emit
app.use((req, _res, next) => { req.io = io; next(); });

app.use('/api', apiRouter);

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Optional: serve built client in production
const clientDist = path.resolve(process.cwd(), '../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

io.on('connection', (socket) => {
  socket.on('subscribe', (jobId) => socket.join(`job:${jobId}`));
  socket.on('unsubscribe', (jobId) => socket.leave(`job:${jobId}`));
});

initQueue(io);
initCleanup();

server.listen(PORT, () => {
  console.log(`\x1b[32m[neon-ytdl] server up on :${PORT}\x1b[0m`);
});

const graceful = async (sig) => {
  console.log(`\n[neon-ytdl] ${sig} received, shutting down...`);
  try {
    await shutdownQueue();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 8000).unref();
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
};
process.on('SIGTERM', () => graceful('SIGTERM'));
process.on('SIGINT', () => graceful('SIGINT'));
