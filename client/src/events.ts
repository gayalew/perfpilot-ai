import { eventsUrl, getJob, type Job } from './api.ts';
import type { JobEventInput } from './jobState.ts';

/**
 * Follow a job's server-sent events. The browser sends Last-Event-ID on its own
 * when EventSource reconnects. After three failures in a row, fall back to polling
 * the job every 3 seconds. A stream that closes after job-end is not a failure.
 */
export function watchJob(jobId: string, onEvent: (event: JobEventInput) => void, onJob?: (job: Job) => void): () => void {
  let ended = false;
  let failures = 0;
  let poll: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  let polling = false;
  const source = new EventSource(eventsUrl(jobId), { withCredentials: true });

  const stop = () => {
    closed = true;
    source.close();
    if (poll) clearInterval(poll);
  };

  const startPoll = () => {
    if (polling || closed) return;
    polling = true;
    source.close();
    const tick = () => {
      getJob(jobId)
        .then((job) => {
          onJob?.(job);
          if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') stop();
        })
        .catch(() => {
          /* the next tick tries again */
        });
    };
    tick();
    poll = setInterval(tick, 3000);
  };

  source.onmessage = (message) => {
    failures = 0;
    let data: { type?: unknown; payload?: unknown };
    try {
      data = JSON.parse(message.data) as { type?: unknown; payload?: unknown };
    } catch {
      return;
    }
    if (typeof data.type !== 'string') return;
    const id = Number(message.lastEventId);
    if (data.type === 'job-end') ended = true;
    onEvent({ id: Number.isFinite(id) ? id : undefined, type: data.type, payload: data.payload });
    if (ended) stop();
  };

  source.onerror = () => {
    if (closed || ended || polling) {
      source.close();
      return;
    }
    failures += 1;
    if (failures >= 3) startPoll();
  };

  return stop;
}
