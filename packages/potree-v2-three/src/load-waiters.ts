function abortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError');
}

interface Waiter {
  resolve(): void;
  reject(reason: unknown): void;
}

/** Promises of whenLoaded(), settled by the update() that finds the view loaded. */
export class LoadWaiters {
  private readonly waiters = new Set<Waiter>();

  wait(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.waiters.delete(waiter);
        reject(signal!.reason);
      };
      const waiter: Waiter = {
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        reject: reason => {
          signal?.removeEventListener('abort', onAbort);
          reject(reason);
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.add(waiter);
    });
  }

  resolveAll(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const waiter of waiters) waiter.resolve();
  }

  /** Reject every waiter with an AbortError, as when the cloud is disposed. */
  abortAll(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const waiter of waiters) waiter.reject(abortError());
  }
}
