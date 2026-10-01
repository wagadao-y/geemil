type Codec = {
  init: () => Promise<unknown>;
  decode: <T>(data: Uint8Array, size: number, consume: (output: Uint8Array) => T) => T;
};
type CodecGlobal = typeof globalThis & { PotreeBrotliDecodeOnly?: Codec };

let ready: Promise<Codec> | undefined;

async function createCodec(): Promise<Codec> {
  // The vendored bundle registers on self and embeds its decode-only WASM.
  if (typeof self === 'undefined') Object.assign(globalThis, { self: globalThis });
  await import('./vendor/brotli-decode-only.js');
  const codec = (globalThis as CodecGlobal).PotreeBrotliDecodeOnly;
  if (!codec) throw new Error('google/brotli WASM decoder failed to initialize');
  await codec.init();
  return codec;
}

function codecReady(): Promise<Codec> {
  if (!ready) {
    const pending = createCodec();
    ready = pending;
    void pending.catch(() => {
      if (ready === pending) ready = undefined;
    });
  }
  return ready;
}

/** Load and instantiate the decoder ahead of the first decompression. */
export async function initBrotli(): Promise<void> {
  await codecReady();
}

/**
 * Decompress `input` and pass the output to `consume` as a view into WASM memory,
 * which is released when `consume` returns: copy anything that must outlive it.
 */
export async function decompressBrotli<T>(
  input: Uint8Array,
  expectedSize: number,
  consume: (data: Uint8Array) => T,
): Promise<{ result: T; setupMs: number; brotliMs: number; consumeMs: number }> {
  const setupStart = performance.now();
  const codec = await codecReady();
  const setupMs = performance.now() - setupStart;
  const decodeStart = performance.now();
  let consumeStart = decodeStart;
  const result = codec.decode(input, expectedSize, (data) => {
    consumeStart = performance.now();
    if (data.byteLength !== expectedSize) {
      throw new Error(`Brotli decoder returned ${data.byteLength} bytes, expected ${expectedSize}`);
    }
    return consume(data);
  });
  return {
    result,
    setupMs,
    brotliMs: consumeStart - decodeStart,
    consumeMs: performance.now() - consumeStart,
  };
}
