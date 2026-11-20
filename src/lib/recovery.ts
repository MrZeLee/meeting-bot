import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { Logger } from 'winston';
import { tempFolder } from '../middleware/disk-uploader';
import { getStorageProvider } from '../uploader/providers/factory';
import { extensionToContentType } from '../types';

// Crash recovery. Mount a volume at dist/_tempvideo and a recording survives a
// crashed or replaced container: on the next start the partial file is uploaded
// and the bot rejoins the meeting it was in. The rejoin records into a new
// file, so a crash leaves two recordings: before and after.

const activeJobFile = path.join(tempFolder, 'active-job.json');
// A meeting that keeps crashing the bot must not rejoin forever.
const MAX_RESUMES = 3;

interface ActiveJob {
  path: string; // e.g. /zoom/join
  body: unknown; // the original join request
  resumes: number;
  // Set once recording started. A join that never got that far (lobby, bot
  // block) is not worth rejoining after a restart.
  recording?: boolean;
}

export const saveActiveJob = (job: ActiveJob): void => {
  fs.mkdirSync(tempFolder, { recursive: true });
  fs.writeFileSync(activeJobFile, JSON.stringify(job));
};

export const markActiveJobRecording = (): void => {
  try {
    const job: ActiveJob = JSON.parse(fs.readFileSync(activeJobFile, 'utf8'));
    saveActiveJob({ ...job, recording: true });
  } catch {
    // No saved job (e.g. a Redis-queued one): nothing to mark.
  }
};

export const clearActiveJob = (): void => {
  fs.rmSync(activeJobFile, { force: true });
};

const listRecordings = (dir: string): string[] => {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listRecordings(full);
    return full === activeJobFile ? [] : [full];
  });
};

/** Upload leftovers from before the restart, then rejoin the interrupted meeting. */
export const recoverAfterRestart = async (port: number, logger: Logger): Promise<void> => {
  // Snapshot first: the rejoin below starts writing a new file in the same folder.
  const leftovers = listRecordings(tempFolder);

  if (fs.existsSync(activeJobFile)) {
    try {
      const job: ActiveJob = JSON.parse(fs.readFileSync(activeJobFile, 'utf8'));
      clearActiveJob();
      if (!job.recording) {
        logger.info('Not rejoining: the interrupted meeting never started recording', { path: job.path });
      } else if (job.resumes >= MAX_RESUMES) {
        logger.error('Not rejoining: the meeting already restarted the bot too often', { path: job.path, resumes: job.resumes });
      } else {
        logger.warn('Rejoining the meeting interrupted by a restart', { path: job.path, resumes: job.resumes + 1 });
        await axios.post(`http://127.0.0.1:${port}${job.path}`, job.body, {
          headers: { 'x-resume-count': String(job.resumes + 1) },
        });
      }
    } catch (error) {
      logger.error('Could not rejoin the interrupted meeting', error);
    }
  }

  for (const filePath of leftovers) {
    // Teams' ffmpeg file sits at the top level; the others under <userId>/.
    const relative = path.relative(tempFolder, filePath);
    const userId = relative.includes(path.sep) ? relative.split(path.sep)[0] : 'recovered';
    const key = `meeting-bot/${userId}/recovered-${path.basename(filePath)}`;
    try {
      const ok = await getStorageProvider().uploadFile({
        filePath,
        key,
        contentType: extensionToContentType[path.extname(filePath)] ?? 'video/webm',
        logger,
        partSize: 50 * 1024 * 1024,
        concurrency: 4,
      });
      if (!ok) throw new Error('upload returned false');
      fs.rmSync(filePath, { force: true });
      logger.info('Uploaded a recording left over from before the restart', { key });
    } catch (error) {
      // Kept on disk; the next start tries again.
      logger.error('Could not upload a leftover recording', { filePath, error });
    }
  }
};
