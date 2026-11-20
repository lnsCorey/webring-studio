import * as path from 'path';
import { Worker } from 'worker_threads';
import * as jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

/**
 * Turns a local photo into web-ready files: decoded, rotated upright (EXIF orientation),
 * downscaled, and re-encoded. Re-encoding from raw pixels drops every metadata block (EXIF,
 * including GPS location, XMP, comments), so nothing about the camera or place is published.
 * Pure JavaScript (jpeg-js, pngjs): runs in Electron, the MCP CLI and tests alike, with
 * nothing to compile.
 */

export type ImageFormat = 'jpeg' | 'png';

export interface RawImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel */
  data: Uint8Array;
}

export interface EncodedImage {
  buffer: Buffer;
  width: number;
  height: number;
  format: ImageFormat;
  mimeType: string;
  extension: string;
}

export const WEB_MAX_SIDE = 2048;
export const THUMB_MAX_SIDE = 480;
const JPEG_QUALITY = 85;
const THUMB_JPEG_QUALITY = 80;
/** Refuse absurdly large inputs instead of exhausting memory while decoding. */
const MAX_INPUT_MEGAPIXELS = 120;

export class UnsupportedImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedImageError';
  }
}

export function detectImageFormat(buffer: Buffer): ImageFormat | null {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  return null;
}

/** Reads the EXIF orientation tag (1–8) from a JPEG, or 1 when there isn't one. */
export function readJpegOrientation(buffer: Buffer): number {
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) return 1;
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker === 0xda) return 1; // start of scan: no more metadata
    if (marker === 0xe1 && buffer.toString('ascii', offset + 4, offset + 10) === 'Exif\0\0') {
      const tiff = offset + 10;
      if (tiff + 8 > buffer.length) return 1;
      const little = buffer.toString('ascii', tiff, tiff + 2) === 'II';
      const u16 = (at: number) => (little ? buffer.readUInt16LE(at) : buffer.readUInt16BE(at));
      const u32 = (at: number) => (little ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at));
      const ifd = tiff + u32(tiff + 4);
      if (ifd + 2 > buffer.length) return 1;
      const entries = u16(ifd);
      for (let i = 0; i < entries; i++) {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > buffer.length) return 1;
        if (u16(entry) === 0x0112) {
          const value = u16(entry + 8);
          return value >= 1 && value <= 8 ? value : 1;
        }
      }
      return 1;
    }
    offset += 2 + length;
  }
  return 1;
}

export function decodeImage(buffer: Buffer): { image: RawImage; format: ImageFormat } {
  const format = detectImageFormat(buffer);
  if (format === 'jpeg') {
    const decoded = jpeg.decode(buffer, {
      useTArray: true,
      formatAsRGBA: true,
      maxResolutionInMP: MAX_INPUT_MEGAPIXELS,
      maxMemoryUsageInMB: 1024,
    });
    const upright = applyOrientation(
      { width: decoded.width, height: decoded.height, data: decoded.data },
      readJpegOrientation(buffer)
    );
    return { image: upright, format };
  }
  if (format === 'png') {
    // Check PNG IHDR dimensions (bytes 16..24) before allocating a decoded RGBA buffer
    if (buffer.length >= 24 && buffer.toString('ascii', 12, 16) === 'IHDR') {
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      if (width === 0 || height === 0 || width * height > MAX_INPUT_MEGAPIXELS * 1_000_000) {
        throw new UnsupportedImageError('This image is too large to process.');
      }
    }
    const decoded = PNG.sync.read(buffer);
    if (decoded.width * decoded.height > MAX_INPUT_MEGAPIXELS * 1_000_000) {
      throw new UnsupportedImageError('This image is too large to process.');
    }
    return { image: { width: decoded.width, height: decoded.height, data: decoded.data }, format };
  }
  throw new UnsupportedImageError(
    'Only JPEG and PNG photos are supported. Convert HEIC, WebP or other formats to JPEG first.'
  );
}

/** Rotates/flips pixels so the image displays upright without needing EXIF. */
export function applyOrientation(image: RawImage, orientation: number): RawImage {
  if (orientation <= 1 || orientation > 8) return image;
  const { width: w, height: h, data } = image;
  const swap = orientation >= 5;
  const outW = swap ? h : w;
  const outH = swap ? w : h;
  const out = new Uint8Array(outW * outH * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx: number;
      let ny: number;
      switch (orientation) {
        case 2: nx = w - 1 - x; ny = y; break;
        case 3: nx = w - 1 - x; ny = h - 1 - y; break;
        case 4: nx = x; ny = h - 1 - y; break;
        case 5: nx = y; ny = x; break;
        case 6: nx = h - 1 - y; ny = x; break;
        case 7: nx = h - 1 - y; ny = w - 1 - x; break;
        default: nx = y; ny = w - 1 - x; break; // 8
      }
      const src = (y * w + x) * 4;
      const dst = (ny * outW + nx) * 4;
      out[dst] = data[src];
      out[dst + 1] = data[src + 1];
      out[dst + 2] = data[src + 2];
      out[dst + 3] = data[src + 3];
    }
  }
  return { width: outW, height: outH, data: out };
}

/**
 * Downscales so the longest side is at most `maxSide`, averaging every source pixel that falls
 * in each destination pixel (area averaging), which avoids the shimmer of nearest-neighbour.
 * Images already small enough are returned unchanged.
 */
export function resizeToFit(image: RawImage, maxSide: number): RawImage {
  const { width: w, height: h, data } = image;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  if (scale >= 1) return image;
  const outW = Math.max(1, Math.round(w * scale));
  const outH = Math.max(1, Math.round(h * scale));
  const out = new Uint8Array(outW * outH * 4);
  const xRatio = w / outW;
  const yRatio = h / outH;
  for (let oy = 0; oy < outH; oy++) {
    const y0 = Math.floor(oy * yRatio);
    const y1 = Math.min(h, Math.max(y0 + 1, Math.floor((oy + 1) * yRatio)));
    for (let ox = 0; ox < outW; ox++) {
      const x0 = Math.floor(ox * xRatio);
      const x1 = Math.min(w, Math.max(x0 + 1, Math.floor((ox + 1) * xRatio)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let y = y0; y < y1; y++) {
        let i = (y * w + x0) * 4;
        for (let x = x0; x < x1; x++, i += 4) {
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          a += data[i + 3];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (oy * outW + ox) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return { width: outW, height: outH, data: out };
}

export function encodeImage(image: RawImage, format: ImageFormat, quality = JPEG_QUALITY): EncodedImage {
  if (format === 'png') {
    const png = new PNG({ width: image.width, height: image.height });
    png.data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
    return {
      buffer: PNG.sync.write(png, { colorType: 6 }),
      width: image.width,
      height: image.height,
      format,
      mimeType: 'image/png',
      extension: 'png',
    };
  }
  const encoded = jpeg.encode(
    { width: image.width, height: image.height, data: Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength) },
    quality
  );
  return {
    buffer: encoded.data,
    width: image.width,
    height: image.height,
    format,
    mimeType: 'image/jpeg',
    extension: 'jpg',
  };
}

/** Width and height from a JPEG's frame header (SOFn), without decoding it; null if not found. */
export function readJpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buffer[offset + 1];
    // Standalone markers have no length
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
      offset += marker === 0xff ? 1 : 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    if (marker === 0xda || length < 2) return null; // image data starts; no frame header seen
    offset += 2 + length;
  }
  return null;
}

/**
 * Cheap checks run before any decoding (on the main thread, before a worker is started): the
 * format is JPEG or PNG and the declared size is within the limit, so an oversized image is
 * refused without allocating its pixels.
 */
export function assertProcessableImage(buffer: Buffer): ImageFormat {
  const format = detectImageFormat(buffer);
  if (!format) {
    throw new UnsupportedImageError(
      'Only JPEG and PNG photos are supported. Convert HEIC, WebP or other formats to JPEG first.'
    );
  }
  const size =
    format === 'png'
      ? buffer.length >= 24 && buffer.toString('ascii', 12, 16) === 'IHDR'
        ? { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
        : null
      : readJpegDimensions(buffer);
  if (size && (size.width === 0 || size.height === 0 || size.width * size.height > MAX_INPUT_MEGAPIXELS * 1_000_000)) {
    throw new UnsupportedImageError('This image is too large to process.');
  }
  return format;
}

/** What to make from a source image: a photo's web copy and thumbnail, or one copy fitted to a size. */
export type ImageTask = { kind: 'web' } | { kind: 'fit'; maxSide: number };
export type ImageTaskResult<T extends ImageTask> = T extends { kind: 'web' }
  ? { web: EncodedImage; thumb: EncodedImage }
  : EncodedImage;

/** Runs an image task in the current thread (the worker calls this). */
export function runImageTask(buffer: Buffer, task: ImageTask): { web: EncodedImage; thumb: EncodedImage } | EncodedImage {
  if (task.kind === 'web') return makeWebImages(buffer);
  const { image, format } = decodeImage(buffer);
  return encodeImage(resizeToFit(image, task.maxSide), format);
}

const WORKER_TIMEOUT_MS = 20_000;
const WORKER_HEAP_MB = 512;

/** Where the compiled worker is: beside this file, or WEBRING_IMAGE_WORKER (the tests build one). */
function imageWorkerPath(): string {
  return process.env.WEBRING_IMAGE_WORKER || path.join(__dirname, 'imageWorker.js');
}

const reviveEncoded = (e: EncodedImage & { buffer: Uint8Array }): EncodedImage => ({
  ...e,
  buffer: Buffer.from(e.buffer.buffer, e.buffer.byteOffset, e.buffer.byteLength),
});

/**
 * Decodes, resizes and re-encodes an image in a worker thread, so a huge or hostile image can't
 * freeze or crash the app: the worker has its own memory limit and is stopped after 20 seconds.
 * The format and size checks run here first, so an oversized image never starts a worker.
 */
export async function processImage<T extends ImageTask>(
  buffer: Buffer,
  task: T,
  options: { timeoutMs?: number; workerPath?: string } = {}
): Promise<ImageTaskResult<T>> {
  assertProcessableImage(buffer);
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(options.workerPath || imageWorkerPath(), {
        resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
      });
    } catch (err) {
      reject(new Error(`Couldn't start the image worker: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new UnsupportedImageError('This image took too long to process.'))),
      options.timeoutMs ?? WORKER_TIMEOUT_MS
    );
    worker.once('message', (msg: { ok: true; result: unknown } | { ok: false; error: { name: string; message: string } }) =>
      finish(() => {
        if (!msg.ok) {
          reject(
            msg.error.name === 'UnsupportedImageError'
              ? new UnsupportedImageError(msg.error.message)
              : new UnsupportedImageError(`This image couldn't be processed: ${msg.error.message}`)
          );
          return;
        }
        const result = msg.result as Record<string, unknown>;
        resolve(
          (task.kind === 'web'
            ? {
                web: reviveEncoded(result.web as EncodedImage & { buffer: Uint8Array }),
                thumb: reviveEncoded(result.thumb as EncodedImage & { buffer: Uint8Array }),
              }
            : reviveEncoded(result as unknown as EncodedImage & { buffer: Uint8Array })) as ImageTaskResult<T>
        );
      })
    );
    worker.once('error', (err: Error & { code?: string }) =>
      finish(() =>
        reject(
          new UnsupportedImageError(
            err.code === 'ERR_WORKER_OUT_OF_MEMORY'
              ? 'This image is too large to process.'
              : "This image couldn't be processed."
          )
        )
      )
    );
    worker.once('exit', () => finish(() => reject(new UnsupportedImageError("This image couldn't be processed."))));
    worker.postMessage({ buffer, task });
  });
}

/** The published web copy and thumbnail for one photo. */
export function makeWebImages(source: Buffer): { web: EncodedImage; thumb: EncodedImage } {
  const { image, format } = decodeImage(source);
  const webPixels = resizeToFit(image, WEB_MAX_SIDE);
  const thumbPixels = resizeToFit(webPixels, THUMB_MAX_SIDE);
  return {
    web: encodeImage(webPixels, format, JPEG_QUALITY),
    thumb: encodeImage(thumbPixels, format, THUMB_JPEG_QUALITY),
  };
}
