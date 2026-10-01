import { parentPort } from 'node:worker_threads';

globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
globalThis.self = globalThis;
globalThis.fetch = async () => {
  throw new Error('Decoder Worker must not fetch point data');
};
await import('../dist/decode-worker.js');
parentPort.on('message', (data) => globalThis.onmessage({ data }));
