import { Worker } from 'node:worker_threads';

export class WorkerLimiter {
  constructor(max) {
    const parsed = Number(max);
    this.maxActive = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
    this.active = 0;
    this.queue = [];
    this.workerUrl = new URL('./worker.js', import.meta.url);
  }

  run(data) {
    return new Promise((resolve, reject) => {
      this.queue.push({ data, resolve, reject });
      this.#dispatch();
    });
  }

  #dispatch() {
    while (this.active < this.maxActive && this.queue.length > 0) {
      const task = this.queue.shift();
      this.active += 1;

      const worker = new Worker(this.workerUrl, { workerData: task.data });
      let finished = false;

      const finish = (callback, value) => {
        if (finished) {
          return;
        }

        finished = true;
        this.active -= 1;
        callback(value);
        this.#dispatch();
      };

      worker.on('message', (resultado) => {
        finish(task.resolve, resultado);
        worker.terminate().catch(() => {});
      });

      worker.on('error', (error) => {
        finish(task.reject, error);
      });

      worker.on('exit', (code) => {
        if (!finished) {
          finish(task.reject, new Error(`Worker finalizo con codigo ${code}`));
        }
      });
    }
  }
}

export const limiter = new WorkerLimiter(Number(process.env.MAX_WORKERS ?? 2));
