import * as http from 'http';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { StaticSiteGenerator } from './siteGenerator';

export interface TestExportPreviewResult {
  success: boolean;
  outputDir: string;
  previewUrl: string;
  port: number;
  filesWritten: Array<{
    relativePath: string;
    sizeBytes: number;
  }>;
  checks: {
    hasIndexHtml: boolean;
    hasNoJekyll: boolean;
    hasDidJson: boolean;
    hasManifestJson: boolean;
    publicFriendsExported: number;
    albumsExported: number;
    itemsExported: number;
  };
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
};

/**
 * Generates a local test export of the active persona's static website and serves it
 * over a loopback-only HTTP server (127.0.0.1) so the user can preview the exact
 * exported files (`index.html`, `/api/*.json`, `/.well-known/did.json`, `/media/*`)
 * in their browser or inside Webring Studio before publishing.
 */
const LIVE_PREVIEW_PATH = '/__studio-live-preview';

/** The preview server stops after this long with no requests, and starts again when needed. */
export const PREVIEW_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Whether a frame in Studio's window may navigate to `url`: only the preview server's own origin
 * (http://127.0.0.1:<its port>), never another loopback port or a data: URL. about:blank is the
 * empty frame.
 */
export function isAllowedPreviewFrameUrl(url: string, previewPort: number): boolean {
  if (url === 'about:blank' || url === 'about:srcdoc') return true;
  if (!previewPort) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && Number(parsed.port) === previewPort;
  } catch {
    return false;
  }
}

export class LocalPreviewServer {
  private server: http.Server | null = null;
  private currentRootDir: string | null = null;
  private currentPort: number = 0;
  /** Studio's live preview page (in memory), served at LIVE_PREVIEW_PATH. */
  private liveHtml = '';
  private liveVersion = 0;
  /** Kept across stops, so a restarted preview has the same origin (the window's CSP names it). */
  private preferredPort = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private starting: Promise<void> | null = null;
  public idleTimeoutMs = PREVIEW_IDLE_TIMEOUT_MS;
  /** Called after the idle timeout stopped the server. */
  public onIdleStop: (() => void) | null = null;

  /** The port the preview is served on (or will be when it next starts); 0 before any. */
  public get port(): number {
    return this.currentPort || this.preferredPort;
  }

  public get isRunning(): boolean {
    return Boolean(this.server);
  }

  /** Picks the preview's port before the window loads, so its CSP can name the one origin. */
  public async reservePort(): Promise<number> {
    if (this.preferredPort) return this.preferredPort;
    this.preferredPort = await new Promise<number>((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const addr = probe.address();
        const port = addr && typeof addr === 'object' ? addr.port : 0;
        probe.close(() => resolve(port));
      });
    });
    return this.preferredPort;
  }

  /** Any request (or new preview content) postpones the idle stop. */
  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.stop().then(() => this.onIdleStop?.());
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  /**
   * Serves the live preview page from this loopback server and returns its address. The Studio
   * window shows it in an iframe; a srcdoc frame would inherit the window's strict CSP and
   * couldn't run the page's own scripts.
   */
  public async serveLivePreview(html: string): Promise<string> {
    this.liveHtml = html;
    this.liveVersion++;
    await this.ensureServerStarted();
    this.touch();
    return `http://127.0.0.1:${this.currentPort}${LIVE_PREVIEW_PATH}?v=${this.liveVersion}`;
  }

  public async runTestExportAndServe(
    siteGenerator: StaticSiteGenerator,
    outputDir: string
  ): Promise<TestExportPreviewResult> {
    if (fs.existsSync(outputDir)) {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
    fs.mkdirSync(outputDir, { recursive: true });

    const generated = siteGenerator.generateToDirectory(outputDir);
    this.currentRootDir = outputDir;

    await this.ensureServerStarted();
    this.touch();

    const filesWritten = generated.filesWritten.map((relPath) => {
      const fullPath = path.join(outputDir, relPath);
      const stat = fs.existsSync(fullPath) ? fs.statSync(fullPath) : null;
      return {
        relativePath: relPath,
        sizeBytes: stat ? stat.size : 0,
      };
    });

    const previewUrl = `http://127.0.0.1:${this.currentPort}/`;

    return {
      success: true,
      outputDir,
      previewUrl,
      port: this.currentPort,
      filesWritten,
      checks: {
        hasIndexHtml: fs.existsSync(path.join(outputDir, 'index.html')),
        hasNoJekyll: fs.existsSync(path.join(outputDir, '.nojekyll')),
        hasDidJson:
          fs.existsSync(path.join(outputDir, '.well-known/did.json')) &&
          fs.existsSync(path.join(outputDir, 'did.json')),
        hasManifestJson: fs.existsSync(path.join(outputDir, 'api/manifest.json')),
        publicFriendsExported: generated.bundle.connections.friends.length,
        albumsExported: generated.bundle.albums.albums.length,
        itemsExported: generated.bundle.items.items.length,
      },
    };
  }

  private async ensureServerStarted(): Promise<void> {
    if (this.server && this.currentPort > 0) {
      return;
    }
    // Two previews asked for at once share one start
    if (!this.starting) {
      this.starting = (async () => {
        try {
          await this.listen(this.preferredPort);
        } catch (err) {
          // The remembered port was taken while stopped: use any free one
          if (!this.preferredPort || (err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
          await this.listen(0);
        }
        this.preferredPort = this.currentPort;
      })().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        this.touch();
        const host = (req.headers.host || '').toLowerCase();
        if (host !== `127.0.0.1:${this.currentPort}` && host !== `localhost:${this.currentPort}`) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Forbidden');
          return;
        }
        if ((req.url || '').split('?')[0] === LIVE_PREVIEW_PATH) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(this.liveHtml);
          return;
        }
        if (!this.currentRootDir) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('No active test export directory.');
          return;
        }

        let decodedPath: string;
        try {
          const rawUrl = (req.url || '/').split('?')[0].split('#')[0];
          decodedPath = decodeURIComponent(rawUrl === '/' ? '/index.html' : rawUrl);
        } catch {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Bad Request');
          return;
        }
        const safeRelPath = path.normalize(decodedPath).replace(/^(\.\.(\/|\\|$))+/, '');
        const fullPath = path.join(this.currentRootDir, safeRelPath);

        // Prevent directory traversal outside currentRootDir
        const resolvedRoot = path.resolve(this.currentRootDir);
        const resolvedTarget = path.resolve(fullPath);
        if (!resolvedTarget.startsWith(resolvedRoot)) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Forbidden');
          return;
        }

        if (!fs.existsSync(resolvedTarget) || fs.statSync(resolvedTarget).isDirectory()) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`Not Found: ${decodedPath}`);
          return;
        }

        const ext = path.extname(resolvedTarget).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'no-store',
        });
        fs.createReadStream(resolvedTarget).pipe(res);
      });

      srv.on('error', (err) => {
        reject(err);
      });

      srv.listen(port, '127.0.0.1', () => {
        const addr = srv.address();
        if (addr && typeof addr === 'object') {
          this.currentPort = addr.port;
        }
        this.server = srv;
        resolve();
      });
    });
  }

  /** Stops serving (preview closed, idle, or quitting). The next preview starts it again. */
  public stop(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    return new Promise((resolve) => {
      const server = this.server;
      if (!server) {
        resolve();
        return;
      }
      this.server = null;
      this.currentPort = 0;
      server.close(() => resolve());
      // Keep-alive connections from the frame would otherwise hold the port open
      server.closeAllConnections?.();
    });
  }
}

