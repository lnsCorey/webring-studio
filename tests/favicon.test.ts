import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { StudioDatabase } from '../electron/db/database';
import { MediaLibrary, setProfileImageFromFile } from '../electron/services/mediaLibrary';
import { StaticSiteGenerator } from '../electron/services/siteGenerator';
import { makeFaviconImages } from '../electron/services/imagePipeline';

function makeSolidPng(width: number, height: number, r: number, g: number, b: number): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height * 4; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png, { colorType: 6 });
}

describe('Profile photo favicon generation', () => {
  const dirs: string[] = [];
  const mkTemp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webring-favicon-'));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    while (dirs.length) {
      fs.rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it('center-crops non-square images into 64x64 PNG and 32x32 PNG-in-ICO favicons', () => {
    const src = makeSolidPng(300, 150, 20, 120, 240);
    const { png, ico } = makeFaviconImages(src);

    expect(png.width).toBe(64);
    expect(png.height).toBe(64);
    const decoded = PNG.sync.read(png.buffer);
    expect([decoded.width, decoded.height]).toEqual([64, 64]);
    expect([decoded.data[0], decoded.data[1], decoded.data[2]]).toEqual([20, 120, 240]);

    // Standard ICO header: reserved=0, type=1, count=1, 32x32, offset=22
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(1);
    expect(ico.readUInt8(6)).toBe(32);
    expect(ico.readUInt8(7)).toBe(32);
    expect(ico.readUInt32LE(18)).toBe(22);
    const embeddedPng = PNG.sync.read(ico.subarray(22));
    expect([embeddedPng.width, embeddedPng.height]).toEqual([32, 32]);
  });

  it('writes favicon.png and favicon.ico from the profile photo, overwrites on change, and removes when cleared', async () => {
    const dir = mkTemp();
    const db = new StudioDatabase(path.join(dir, 'studio.db'));
    const mediaDir = path.join(dir, 'media-store');
    const library = new MediaLibrary(mediaDir);
    const generator = new StaticSiteGenerator(db, mediaDir);
    const outDir = path.join(dir, 'out');

    try {
      db.updateProfile({ displayName: 'Alice', siteUrl: 'https://alice.example' });
      const avatar1 = path.join(dir, 'a1.png');
      const avatar2 = path.join(dir, 'a2.png');
      fs.writeFileSync(avatar1, makeSolidPng(200, 120, 220, 40, 40));
      fs.writeFileSync(avatar2, makeSolidPng(120, 200, 40, 200, 90));

      // 1. First profile photo
      await setProfileImageFromFile(db, library, 'avatar', avatar1);
      const gen1 = generator.generateToDirectory(outDir);
      expect(gen1.filesWritten).toContain('favicon.png');
      expect(gen1.filesWritten).toContain('favicon.ico');
      const fav1Png = fs.readFileSync(path.join(outDir, 'favicon.png'));
      const fav1Ico = fs.readFileSync(path.join(outDir, 'favicon.ico'));
      const html1 = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
      const v1Match = html1.match(/href="\.\/favicon\.png\?v=([0-9a-f]{12})"/);
      expect(v1Match).not.toBeNull();
      expect(html1).toContain(`href="./favicon.ico?v=${v1Match![1]}"`);

      // 2. Replace profile photo -> favicons are overwritten and cache-buster changes
      await setProfileImageFromFile(db, library, 'avatar', avatar2);
      const gen2 = generator.generateToDirectory(outDir);
      expect(gen2.filesWritten).toContain('favicon.png');
      expect(gen2.filesWritten).toContain('favicon.ico');
      const fav2Png = fs.readFileSync(path.join(outDir, 'favicon.png'));
      const fav2Ico = fs.readFileSync(path.join(outDir, 'favicon.ico'));
      expect(fav2Png.equals(fav1Png)).toBe(false);
      expect(fav2Ico.equals(fav1Ico)).toBe(false);
      const html2 = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
      const v2Match = html2.match(/href="\.\/favicon\.png\?v=([0-9a-f]{12})"/);
      expect(v2Match).not.toBeNull();
      expect(v2Match![1]).not.toBe(v1Match![1]);

      // 3. Clear profile photo -> stale favicon files are removed
      db.updateProfile({ avatarUrl: '' });
      const gen3 = generator.generateToDirectory(outDir);
      expect(gen3.filesWritten).not.toContain('favicon.png');
      expect(gen3.filesWritten).not.toContain('favicon.ico');
      expect(fs.existsSync(path.join(outDir, 'favicon.png'))).toBe(false);
      expect(fs.existsSync(path.join(outDir, 'favicon.ico'))).toBe(false);
      const html3 = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
      expect(html3).not.toContain('./favicon.png');
    } finally {
      db.close();
    }
  });
});
