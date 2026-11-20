import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as jpegJs from 'jpeg-js';
import { PNG } from 'pngjs';
import { processImage, readJpegDimensions, UnsupportedImageError } from '../electron/services/imagePipeline';

/** A PNG whose header claims a huge size; only the first bytes matter to the pre-check. */
function pngClaiming(width: number, height: number): Buffer {
  const png = PNG.sync.write(Object.assign(new PNG({ width: 1, height: 1 }), { data: Buffer.alloc(4) }));
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

function jpeg(width: number, height: number): Buffer {
  return jpegJs.encode({ width, height, data: Buffer.alloc(width * height * 4, 128) }, 80).data;
}

/** A path that would make any worker fail to start, so an error mentioning it proves one was started. */
const NO_WORKER = path.join(os.tmpdir(), 'webring-no-such-worker.js');

describe('Security Phase 6: image decoding off the main thread', () => {
  it('refuses an oversized PNG or JPEG before starting a worker', async () => {
    await expect(processImage(pngClaiming(20000, 20000), { kind: 'web' }, { workerPath: NO_WORKER })).rejects.toThrow(
      new UnsupportedImageError('This image is too large to process.')
    );
    const big = jpeg(16, 16);
    const dims = readJpegDimensions(big)!;
    expect(dims).toEqual({ width: 16, height: 16 });
    // Rewrite the frame header to claim 20000 x 20000
    const sof = big.indexOf(Buffer.from([0xff, 0xc0]));
    big.writeUInt16BE(20000, sof + 5);
    big.writeUInt16BE(20000, sof + 7);
    await expect(processImage(big, { kind: 'web' }, { workerPath: NO_WORKER })).rejects.toThrow(/too large to process/);
    await expect(processImage(Buffer.from('GIF89a....'), { kind: 'web' }, { workerPath: NO_WORKER })).rejects.toThrow(
      /Only JPEG and PNG/
    );
  });

  it('decodes and resizes a normal JPEG in the worker', async () => {
    const out = await processImage(jpeg(400, 200), { kind: 'fit', maxSide: 100 });
    expect(out.mimeType).toBe('image/jpeg');
    expect([out.width, out.height]).toEqual([100, 50]);
    expect(Buffer.isBuffer(out.buffer)).toBe(true);
    const decoded = jpegJs.decode(out.buffer);
    expect([decoded.width, decoded.height]).toEqual([100, 50]);

    const both = await processImage(jpeg(3000, 1500), { kind: 'web' });
    expect([both.web.width, both.thumb.width]).toEqual([2048, 480]);
  });

  it('stops a worker that never answers, with a clear message', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webring-hung-worker-'));
    const hung = path.join(dir, 'hung.js');
    fs.writeFileSync(hung, 'setInterval(() => {}, 1000);');
    const started = Date.now();
    await expect(processImage(jpeg(8, 8), { kind: 'web' }, { workerPath: hung, timeoutMs: 300 })).rejects.toThrow(
      /took too long/
    );
    expect(Date.now() - started).toBeLessThan(5000);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports a worker that fails to start instead of hanging', async () => {
    await expect(processImage(jpeg(8, 8), { kind: 'web' }, { workerPath: NO_WORKER, timeoutMs: 5000 })).rejects.toThrow();
  });
});
