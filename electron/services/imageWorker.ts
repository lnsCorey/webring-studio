import { parentPort } from 'worker_threads';
import { ImageTask, runImageTask } from './imagePipeline';

/**
 * Worker thread entry for imagePipeline.processImage: decodes, resizes and re-encodes one image
 * off the main thread, under its own memory limit, and posts back the result or the error.
 */
parentPort?.once('message', (msg: { buffer: Uint8Array; task: ImageTask }) => {
  try {
    const buffer = Buffer.from(msg.buffer.buffer, msg.buffer.byteOffset, msg.buffer.byteLength);
    parentPort!.postMessage({ ok: true, result: runImageTask(buffer, msg.task) });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    parentPort!.postMessage({ ok: false, error: { name: error.name, message: error.message } });
  }
});
