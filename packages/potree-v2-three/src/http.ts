/** A non-2xx HTTP response, or a success status other than the one required. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Delay requested by Retry-After, in milliseconds. Cross-origin servers must expose the header. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }

  /** The server asked clients to slow down (429 or 503); the request itself may succeed later. */
  get throttled(): boolean { return this.status === 429 || this.status === 503; }
}

/** Parse Retry-After as delay-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const date = Date.parse(text);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Build the error for a failed response and stop receiving its body. */
export async function responseError(url: URL, response: Response): Promise<HttpError> {
  await cancelBody(response.body);
  return new HttpError(
    `GET ${url} failed: HTTP ${response.status}`, response.status, parseRetryAfter(response.headers.get('Retry-After')),
  );
}

/**
 * Request precisely one byte range. Potree v2 requires HTTP Range support, so only
 * 206 is accepted, except 200 for a range from offset 0: a server may answer a range
 * covering the whole file with the file itself, and a longer file fails once the body
 * exceeds the range. The body is read up to the requested size without trusting
 * Content-Length, which may be missing (chunked) or describe compressed bytes.
 */
export async function fetchRange(
  url: URL, offset: bigint, size: bigint, fetcher: typeof fetch, signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (size === 0n) return new ArrayBuffer(0);
  if (offset < 0n || size < 0n) throw new Error('Negative Potree byte range');
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Potree byte range is too large');
  const end = offset + size - 1n;
  const response = await fetcher(url, {
    headers: { Range: `bytes=${offset}-${end}` }, signal,
  });
  const wholeFile = response.status === 200 && offset === 0n;
  if (response.status !== 206 && !wholeFile) {
    // Stop the transfer: a server ignoring Range would otherwise send the whole file.
    if (!response.ok) throw await responseError(url, response);
    await cancelBody(response.body);
    throw new HttpError(
      `GET ${url}: expected HTTP 206 for byte range, got ${response.status}; the server must support Range requests`,
      response.status,
    );
  }
  if (wholeFile) return readExactly(response, Number(size), url, true);
  // Content-Range is only readable cross-origin when the server exposes it.
  const contentRange = response.headers.get('Content-Range');
  if (contentRange) {
    const match = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/i.exec(contentRange);
    if (!match || BigInt(match[1]!) !== offset || BigInt(match[2]!) !== end) {
      await cancelBody(response.body);
      throw new Error(`GET ${url}: unexpected Content-Range ${contentRange}`);
    }
  }
  return readExactly(response, Number(size), url);
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    // The request has already failed; the cancellation error adds nothing.
  }
}

/** `wholeFile`: a 200 response to a range from offset 0, valid only when the file is exactly that range. */
async function readExactly(response: Response, size: number, url: URL, wholeFile = false): Promise<ArrayBuffer> {
  const tooLong = () => wholeFile
    ? new HttpError(
      `GET ${url}: expected HTTP 206 for byte range, got 200 with a longer body; the server must support Range requests`,
      200,
    )
    : new Error(`GET ${url}: response is longer than the requested ${size} bytes`);
  if (!response.body) {
    const data = await response.arrayBuffer();
    if (data.byteLength > size) throw tooLong();
    if (data.byteLength !== size) throw new Error(`GET ${url}: expected ${size} bytes, got ${data.byteLength}`);
    return data;
  }
  const output = new Uint8Array(size);
  const reader = response.body.getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (received + value.byteLength > size) {
      await reader.cancel().catch(() => {});
      throw tooLong();
    }
    output.set(value, received);
    received += value.byteLength;
  }
  if (received !== size) throw new Error(`GET ${url}: short byte range, got ${received} of ${size} bytes`);
  return output.buffer;
}
