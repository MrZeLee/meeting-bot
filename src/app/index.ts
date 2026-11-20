import express from 'express';
import client from 'prom-client';
import config, { NODE_ENV } from '../config';
import mainDebug from '../test/debug';
import googleRouter from './google';
import microsoftRouter from './microsoft';
import zoomRouter from './zoom';
import { globalJobStore } from '../lib/globalJobStore';
import { RedisConsumerService } from '../connect/RedisConsumerService';
import { clearActiveJob, saveActiveJob } from '../lib/recovery';

const app = express();

app.use(express.json());

// Initialize Redis consumer service
export const redisConsumerService = new RedisConsumerService();

let isbusy = 0;
let gracefulShutdown = 0;

app.get('/isbusy', async (req, res) => {
  // Use the job store's isBusy status
  const jobStoreBusy = globalJobStore.isBusy() ? 1 : 0;
  return res.status(200).json({ success: true, data: jobStoreBusy });
});

// Stop the current recording early; it is finalized and uploaded as if the
// meeting had ended.
app.post('/stop', async (req, res) => {
  try {
    if (!(await globalJobStore.requestStop())) {
      return res.status(409).json({ success: false, error: 'Nothing is recording right now.' });
    }
    return res.status(202).json({ success: true, message: 'Stopping; the recording will be uploaded.' });
  } catch (error) {
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/health', async (req, res) => {
  // Simple health check endpoint for Docker
  return res.status(200).json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Create a Gauge metric for busy status (0 or 1)
const busyStatus = new client.Gauge({
  name: 'isbusy',
  help: 'busy status of the pod (1 = busy, 0 = available)'
});

const isavailable = new client.Gauge({
  name: 'isavailable',
  help: 'available status of the pod (1 = available, 0 = busy)'
});

app.get('/metrics', async (req, res) => {
  // Use the job store's isBusy status for metrics
  const jobStoreBusy = globalJobStore.isBusy() ? 1 : 0;
  busyStatus.set(jobStoreBusy);
  isavailable.set(1 - jobStoreBusy);
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

app.get('/debug', async (req, res, next) => {
  if (NODE_ENV === 'development') {
    next();
  }
  else {
    res.status(500).send({});
  }
}, async (req, res) => {
  await mainDebug('baf14', 'https://www.github.com');
  res.status(200).send({});
});

// Remember the meeting being joined, so recoverAfterRestart can rejoin it if the
// container dies mid-recording. Saved before the router runs (the job could end
// before the response does), and only when idle: a busy bot answers 409 and the
// running job's record must survive that. JobStore clears it when the job ends.
app.post(['/google/join', '/microsoft/join', '/zoom/join'], (req, res, next) => {
  if (globalJobStore.isBusy()) return next();
  saveActiveJob({ path: req.path, body: req.body, resumes: Number(req.get('x-resume-count')) || 0 });
  res.on('finish', () => {
    if (res.statusCode !== 202) clearActiveJob();
  });
  next();
});

app.use('/google', googleRouter);
app.use('/microsoft', microsoftRouter);
app.use('/zoom', zoomRouter);

export const setGracefulShutdown = (val: number) =>
  gracefulShutdown = val;

export const getGracefulShutdown = () => gracefulShutdown;

export const setIsBusy = (val: number) =>
  isbusy = val;

export const getIsBusy = () => isbusy;

// Start Redis consumer service only if Redis is enabled
if (config.isRedisEnabled) {
  redisConsumerService.start().catch((error) => {
    console.error('Failed to start Redis consumer service:', error);
  });
} else {
  console.info('Redis consumer service not started - Redis is disabled');
}

export default app;
