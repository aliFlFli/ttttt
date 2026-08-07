/**
 * A small concurrency-limited job queue.
 *
 * Without this, if N users send files at the same moment, the bot tries to
 * download/upload all of them in parallel, which can exhaust RAM, disk, and
 * bandwidth. This caps how many file jobs run at once; everything else waits
 * in line and gets an honest "queued, position X" message.
 */
export class JobQueue {
  constructor(concurrency = 2) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = []; // { task, resolve, reject, key }
  }

  /** Number of jobs waiting (not counting ones currently running). */
  get pending() {
    return this.queue.length;
  }

  /** Position (1-based) a not-yet-started job would take if enqueued now. */
  nextPosition() {
    return this.queue.length + 1;
  }

  /**
   * Enqueues an async task. Resolves/rejects when the task finishes.
   * onQueued(position) is called synchronously if the job has to wait.
   */
  run(task, onQueued) {
    return new Promise((resolve, reject) => {
      const job = { task, resolve, reject };
      if (this.running >= this.concurrency) {
        this.queue.push(job);
        if (onQueued) onQueued(this.queue.length);
      } else {
        this._start(job);
      }
    });
  }

  _start(job) {
    this.running++;
    Promise.resolve()
      .then(job.task)
      .then((result) => {
        job.resolve(result);
      })
      .catch((err) => {
        job.reject(err);
      })
      .finally(() => {
        this.running--;
        const next = this.queue.shift();
        if (next) this._start(next);
      });
  }
}
