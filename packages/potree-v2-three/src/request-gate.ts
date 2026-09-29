import { HttpError } from './http.js';

/** Longest pause for a throttled origin without a Retry-After header. */
const MAX_BACKOFF_MS = 30_000;
/** Upper bound for a server-provided Retry-After. */
const MAX_RETRY_AFTER_MS = 5 * 60_000;
/** Poll interval while the pause has ended but no request slot is free. */
const SLOT_POLL_MS = 50;

function abortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** True for a response asking the client to slow down (429 or 503). */
export function isThrottled(error: unknown): error is HttpError {
  return error instanceof HttpError && error.throttled;
}

/**
 * Request admission shared by every point cloud loaded from one origin. A 429 or
 * 503 pauses all new requests, honouring Retry-After, and halves the concurrency
 * limit; successes raise it again by one per window, as in TCP congestion control.
 * Callers choose what to request whenever slots are available, so priorities
 * reflect the view at that moment rather than when the pause began.
 */
export class RequestGate {
  private static readonly gates = new Map<string, RequestGate>();

  /** The shared gate for `url`'s origin. */
  static for(url: URL): RequestGate {
    let gate = RequestGate.gates.get(url.origin);
    if (!gate) {
      gate = new RequestGate();
      RequestGate.gates.set(url.origin, gate);
    }
    return gate;
  }

  private inFlight = 0;
  /** Adaptive concurrency limit; unlimited until the origin throttles. */
  private limit = Infinity;
  private successesAtLimit = 0;
  private resumeAt = 0;
  private backoffMs = 0;

  /** Requests that may start now; per-cloud limits still apply on top of this. */
  available(now = performance.now()): number {
    if (now < this.resumeAt) return 0;
    return Math.max(0, this.limit - this.inFlight);
  }

  /** Current adaptive limit, or Infinity while the origin has not throttled. */
  get concurrencyLimit(): number { return this.limit; }

  /** Run one request, counting it against the limit and learning from its outcome. */
  async request<T>(task: () => Promise<T>, baseDelayMs: number): Promise<T> {
    this.inFlight++;
    try {
      const result = await task();
      this.noteSuccess();
      return result;
    } catch (error) {
      if (isThrottled(error)) this.noteThrottled(error.retryAfterMs, baseDelayMs);
      throw error;
    } finally {
      this.inFlight--;
    }
  }

  /**
   * Retry `task` while the origin throttles, waiting for the gate each time.
   * For requests that no update loop will retry, such as the initial load.
   */
  async retry<T>(task: () => Promise<T>, attempts: number, signal?: AbortSignal): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      await this.whenOpen(signal);
      try {
        return await task();
      } catch (error) {
        if (!isThrottled(error) || attempt >= attempts) throw error;
      }
    }
  }

  private async whenOpen(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw abortError();
      const now = performance.now();
      if (this.available(now) > 0) return;
      await sleep(now < this.resumeAt ? this.resumeAt - now : SLOT_POLL_MS, signal);
    }
  }

  private noteSuccess(): void {
    // Responses to requests sent before a pause say nothing about the server now.
    if (performance.now() < this.resumeAt) return;
    this.backoffMs = 0;
    if (this.limit === Infinity) return;
    if (++this.successesAtLimit >= this.limit) {
      this.limit++;
      this.successesAtLimit = 0;
    }
  }

  private noteThrottled(retryAfterMs: number | undefined, baseDelayMs: number): void {
    const now = performance.now();
    // Requests sent together are throttled together; react once per pause.
    if (now < this.resumeAt) {
      if (retryAfterMs !== undefined) {
        this.resumeAt = Math.max(this.resumeAt, now + Math.min(retryAfterMs, MAX_RETRY_AFTER_MS));
      }
      return;
    }
    // inFlight includes the throttled request itself.
    this.limit = Math.max(1, Math.floor(Math.min(this.limit, this.inFlight) / 2));
    this.successesAtLimit = 0;
    this.backoffMs = Math.min(this.backoffMs > 0 ? this.backoffMs * 2 : Math.max(baseDelayMs, 1), MAX_BACKOFF_MS);
    const delay = retryAfterMs !== undefined ? Math.min(retryAfterMs, MAX_RETRY_AFTER_MS) : this.backoffMs;
    this.resumeAt = now + delay;
  }
}
