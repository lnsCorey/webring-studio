import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  powerMonitor,
  protocol,
  safeStorage,
  session,
  shell,
  Tray,
} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { pathToFileURL } from 'url';
import { ActivePersonaContext, PersonaManager } from './services/personaManager';
import { buildEditContextMenu } from './editContextMenu';
import { LocalPreviewServer } from './services/localPreviewServer';
import { WebringMcpServer } from './mcp/mcpServer';
import { McpHttpServer } from './mcp/mcpHttpServer';
import { DEMO_PEER_FOLDER_NAME } from './db/legacyDemoContent';
import { checkExportFolder, ExportFolderRefusedError } from './services/siteGenerator';
import { spkiFingerprint } from './db/database';
import { isRingMemberFlagged } from './services/ringService';
import {
  describePreset,
  jobNextRunAt,
  JobResult,
  PersonaSchedule,
  PublishDestination,
  ScheduledJobKind,
  Scheduler,
  SchedulerConfig,
} from './services/scheduler';
import { notifyWebringHubs, publishTo, runScheduledPublish, runSyncAll, summarizeSync } from './services/jobs';
import { AutoPublisher } from './services/autoPublisher';
import { parseProxyUrl, ProxyUnavailableError } from './security/proxyAgent';
import { onKeyVaultFallback } from './security/keyVault';
import { GitHubDeviceLogin } from './services/githubAuth';
import {
  checkLiveSite,
  configureGitHubSite,
  connectGitHub,
  dismissSetup,
  getSetupStatus,
  publishGitHubSite,
} from './services/setupService';
import { planWindowProxy, WindowProxyPlan } from './security/windowProxy';
import {
  cleanUpLibrary,
  deleteAlbumWithFiles,
  deletePhotoWithFiles,
  importPhotosIntoAlbum,
  replacePhotoImage,
  setProfileImageFromFile,
} from './services/mediaLibrary';
import { showSplash } from './splash';
import { savePost, unsavePost } from './services/savedPosts';

// Lets the Studio window show Media Library images: studio-media://local/<path> maps to the
// active persona's library file for media/<path>. Must be registered before the app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'studio-media', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
import {
  CreatePersonaInput,
  ModerationAction,
  parseFriendNoticeUri,
  parseRingRequestUri,
  parseWebringUri,
} from '../src/shared/schema';

let mainWindow: BrowserWindow | null = null;
let personaManager: PersonaManager;
let localPreviewServer: LocalPreviewServer;
let webringMcpServer: WebringMcpServer;
let mcpHttpServer: McpHttpServer;
let scheduler: Scheduler;
let autoPublisher: AutoPublisher;
let tray: Tray | null = null;
let isQuitting = false;
let startupComplete = false;
let windowProxyPlan: WindowProxyPlan | null = null;

/** What the security banner shows for the active persona (studio:get-security-status). */
interface SecurityStatus {
  keyVaultAvailable: boolean;
  proxyUnavailable: boolean;
  /** How many agent changes wait for the user's review (0 when none). */
  agentChangesHeld: number;
}

function getSecurityStatus(): SecurityStatus {
  const db = personaManager.getActiveContext().db;
  return {
    keyVaultAvailable: db.isKeyVaultAvailable(),
    proxyUnavailable: Boolean(db.getProxySettings().unavailable),
    agentChangesHeld: db.getHeldAgentChanges().length,
  };
}

let lastSecurityStatus = '';

/** Tells the window when the security status changed (keychain, proxy, persona). */
function pushSecurityStatus(force = false): void {
  let status: SecurityStatus;
  try {
    status = getSecurityStatus();
  } catch {
    return;
  }
  const key = JSON.stringify(status);
  if (!force && key === lastSecurityStatus) return;
  lastSecurityStatus = key;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('studio:security-status-changed', status);
}

/**
 * Points the Studio window's network session at the active persona's proxy, so friends' images and
 * ring hubs loaded in the window take the same route as syncs. Cheap to call after anything that
 * might change the active persona or its proxy setting: it only reconfigures on a change.
 */
async function applyWindowProxy(): Promise<void> {
  // Anything that changes the route (persona, proxy) can change the security status too
  pushSecurityStatus();
  let plan: WindowProxyPlan;
  try {
    plan = planWindowProxy(personaManager.getActiveContext().db.getProxySettings());
  } catch (err) {
    // Saved settings are validated, so this shouldn't happen; keep the current route rather than
    // silently dropping a proxy the user turned on
    console.error('Could not apply the persona proxy to the Studio window:', err);
    return;
  }
  if (windowProxyPlan?.key === plan.key) {
    windowProxyPlan = plan;
    return;
  }
  windowProxyPlan = plan;
  await session.defaultSession.setProxy(plan.config);
  // Drop connections opened over the previous route so nothing keeps using it
  await session.defaultSession.closeAllConnections();
}

// An HTTP proxy that asks for a login gets the one saved in the persona's proxy URL
app.on('login', (event, _webContents, _details, authInfo, callback) => {
  const credentials = windowProxyPlan?.credentials;
  if (!authInfo.isProxy || !credentials) return;
  event.preventDefault();
  callback(credentials.username, credentials.password);
});

const publishPaths = () => ({ userDataDir: app.getPath('userData'), tempDir: app.getPath('temp') });
/** GitHub sign-in for the setup wizard and MCP agents (pending codes are kept in memory only) */
const githubDeviceLogin = new GitHubDeviceLogin();

/** Applies "start at login": launches hidden in the tray with --background. */
function applyLoginItem(config: SchedulerConfig) {
  if (process.platform === 'linux') return; // Not supported by Electron on Linux
  app.setLoginItemSettings({ openAtLogin: config.startAtLogin, args: ['--background'] });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow(true);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function personaLabel(personaId: string): string {
  return personaManager.listPersonaRecords().find((p) => p.id === personaId)?.label || personaId;
}

/**
 * Hosts such as GitHub Pages take a few minutes to show a publish, so a Webring Hub ping that was
 * still waiting is retried a few times after it (the next Sync All also retries). Each try opens
 * its own persona context and is serialised with that persona's other jobs.
 */
const WEBRING_HUB_FOLLOW_UP_DELAYS_MS = [2, 6, 15].map((m) => m * 60 * 1000);
const webringHubFollowUps = new Map<string, NodeJS.Timeout[]>();

function scheduleWebringHubFollowUp(personaId: string): void {
  for (const timer of webringHubFollowUps.get(personaId) || []) clearTimeout(timer);
  const timers = WEBRING_HUB_FOLLOW_UP_DELAYS_MS.map((delay) => {
    const timer = setTimeout(() => {
      void scheduler
        .runExclusive(personaId, () =>
          personaManager.withPersonaContext(personaId, async (ctx) => {
            if (ctx.webringHubService.hasPendingPings()) await notifyWebringHubs(ctx);
          })
        )
        .catch(() => undefined);
    }, delay);
    timer.unref?.();
    return timer;
  });
  webringHubFollowUps.set(personaId, timers);
}

/** After a scheduled job or an auto-publish: hub follow-ups, failure notice, tray and UI refresh. */
/** The export folder picker: the only way to set the export folder. Checks it, then saves it. */
async function pickExportFolder(): Promise<string | null> {
  if (!mainWindow) return null;
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose Export Folder for Static Profile Website',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  const chosen = res.filePaths[0];
  const ctx = personaManager.getActiveContext();
  const saved = ctx.db.getProfile().publishSettings.exportPath;
  if (!checkExportFolder(chosen, saved).ok) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Folder not used',
      message: new ExportFolderRefusedError().message,
    });
    return null;
  }
  ctx.db.updateProfile({ publishSettings: { ...ctx.db.getProfile().publishSettings, exportPath: chosen } });
  return chosen;
}

function handleJobFinished(personaId: string, job: ScheduledJobKind, result: JobResult, title: string): void {
  if (job === 'publish' && result.status === 'ok') scheduleWebringHubFollowUp(personaId);
  // Held for review isn't a failure: say why it didn't publish, once
  if (result.status === 'held' && Notification.isSupported()) {
    const note = new Notification({
      title: `${title} skipped — agent changes need review`,
      body: `${personaLabel(personaId)}: an agent's changes won't be published until you review them in Webring Studio.`,
    });
    note.on('click', () => showMainWindow());
    note.show();
  }
  const config = scheduler.loadConfig();
  if (result.status === 'failed' && config.notifyOnFailure && Notification.isSupported()) {
    new Notification({
      title: `${title} failed: ${personaLabel(personaId)}`,
      body: result.message.slice(0, 200),
    }).show();
  }
  refreshTrayMenu();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('studio:schedule-updated', { personaId, job, result });
  }
}

/**
 * A local change that friends should see: starts (or joins) the persona's pending auto-publish
 * when it's turned on. Never throws, so it can't fail the change itself.
 */
function noteLocalChange(personaId: string, reason: string, options?: { fromAgent?: boolean }): void {
  try {
    autoPublisher?.noteLocalChange(personaId, reason, options);
  } catch {
    // Auto-publish is a convenience; the change is saved either way
  }
  // An agent's change is held: the banner and the review panel show it
  if (options?.fromAgent) pushSecurityStatus(true);
}

/**
 * Before a publish the user started: while an agent's changes are held, it goes ahead only when
 * the user chose to include them (the app asks first), which releases the hold.
 */
function releaseHeldChangesFor(personaId: string, ctx: ActivePersonaContext, includeAgentChanges: boolean): void {
  const held = ctx.db.getHeldAgentChanges().length;
  if (!held) return;
  if (!includeAgentChanges) {
    throw new Error(`${held} agent change(s) are waiting for your review. Review them, or publish including them.`);
  }
  ctx.db.clearHeldAgentChanges();
  autoPublisher?.approveAgentChanges(personaId);
  pushSecurityStatus(true);
}

const noteActiveChange = (reason: string) => noteLocalChange(personaManager.getActivePersonaId(), reason);

/** Runs a pull (one friend, joined rings) in the background under the persona's lock, then refreshes the UI. */
function pullInBackground(personaId: string, fn: (ctx: ActivePersonaContext) => Promise<unknown>): void {
  void scheduler
    .runExclusive(personaId, () => personaManager.withPersonaContext(personaId, fn))
    .catch(() => undefined)
    .then(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('studio:schedule-updated');
    });
}

/** Every persona's schedule with its next run, for the UI, tray and MCP. */
function scheduleOverview() {
  const config = scheduler.loadConfig();
  const personas = personaManager.listPersonaRecords().map((record) => {
    const schedule: PersonaSchedule = scheduler.getPersonaSchedule(record.id);
    const next = (job: ScheduledJobKind) =>
      schedule[job].enabled && !config.paused ? jobNextRunAt(schedule[job]).toISOString() : null;
    return {
      personaId: record.id,
      label: record.label,
      schedule,
      autoPublishStatus: autoPublisher ? autoPublisher.status(record.id) : null,
      nextSyncAt: next('sync'),
      nextPublishAt: next('publish'),
      describe: {
        sync: describePreset(schedule.sync.preset),
        publish: describePreset(schedule.publish.preset),
      },
    };
  });
  return {
    app: {
      runInBackground: config.runInBackground,
      startAtLogin: config.startAtLogin,
      paused: config.paused,
      notifyOnFailure: config.notifyOnFailure,
    },
    personas,
    history: config.history.map((h) => ({ ...h, label: personaLabel(h.personaId) })),
    running: scheduler.isRunning(),
  };
}

function refreshTrayMenu() {
  if (!tray) return;
  const overview = scheduleOverview();
  const upcoming = overview.personas
    .flatMap((p) => [
      p.nextSyncAt ? { at: p.nextSyncAt, text: `${p.label}: sync` } : null,
      p.nextPublishAt ? { at: p.nextPublishAt, text: `${p.label}: publish` } : null,
    ])
    .filter((x): x is { at: string; text: string } => Boolean(x))
    .sort((a, b) => a.at.localeCompare(b.at))[0];
  const activeId = personaManager.getActivePersonaId();
  const nextLabel = overview.app.paused
    ? 'Schedules paused'
    : upcoming
      ? `Next: ${upcoming.text} at ${new Date(upcoming.at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
      : 'No schedules set';
  tray.setToolTip(`Webring Studio — ${nextLabel}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Webring Studio', click: () => showMainWindow() },
      { type: 'separator' },
      { label: nextLabel, enabled: false },
      {
        label: `Sync now (${personaLabel(activeId)})`,
        click: () => void scheduler.runNow(activeId, 'sync'),
      },
      {
        label: `Publish now (${personaLabel(activeId)})`,
        click: () => void scheduler.runNow(activeId, 'publish'),
      },
      {
        label: overview.app.paused ? 'Resume schedules' : 'Pause schedules',
        click: () => {
          scheduler.setAppSettings({ paused: !overview.app.paused });
          void autoPublisher.refresh();
          refreshTrayMenu();
          mainWindow?.webContents.send('studio:schedule-updated');
          if (overview.app.paused) void scheduler.tick();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit Webring Studio',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ])
  );
}

/** Branded images generated from images/logo-icon.png by scripts/generate-icons.py. */
const assetPath = (name: string) => path.join(__dirname, '../../electron/assets', name);

function createTray() {
  // macOS menu bars want a monochrome template; Windows and Linux trays show the colour logo
  const isMac = process.platform === 'darwin';
  const iconPath = assetPath(isMac ? 'trayTemplate.png' : 'trayIcon.png');
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  if (isMac) icon.setTemplateImage(true);
  tray = new Tray(icon);
  if (icon.isEmpty() && process.platform === 'darwin') tray.setTitle('◎');
  tray.on('click', () => {
    if (process.platform !== 'darwin') showMainWindow();
  });
  refreshTrayMenu();
}

async function initServices() {
  const userDataDir = app.getPath('userData');
  // Seal each persona's Ed25519 private key with the OS keychain while the app is running
  personaManager = new PersonaManager(userDataDir, {
    keyCipher: {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plainText) => safeStorage.encryptString(plainText),
      decrypt: (cipherText) => safeStorage.decryptString(cipherText),
    },
  });
  // A secret saved without the keychain (with consent) shows the security banner at once
  onKeyVaultFallback(() => pushSecurityStatus(true));
  localPreviewServer = new LocalPreviewServer();
  webringMcpServer = new WebringMcpServer(
    personaManager,
    userDataDir,
    localPreviewServer,
    (entry) => {
      // An agent can switch persona or change the proxy
      void applyWindowProxy();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('studio:mcp-activity', entry);
      }
    }
  );
  scheduler = new Scheduler({
    configPath: path.join(userDataDir, 'scheduler.json'),
    listPersonaIds: () => personaManager.listPersonaRecords().map((p) => p.id),
    runner: {
      sync: (personaId) =>
        personaManager.withPersonaContext(personaId, async (ctx) => {
          try {
            return summarizeSync(await runSyncAll(ctx));
          } catch (err) {
            // Reported once by the scheduler; the banner explains it
            if (err instanceof ProxyUnavailableError) pushSecurityStatus(true);
            throw err;
          }
        }),
      publish: (personaId, destination, syncFirst) =>
        personaManager.withPersonaContext(personaId, (ctx) =>
          runScheduledPublish(ctx, destination, syncFirst, publishPaths())
        ),
    },
    onJobFinished: (personaId, job, result) => handleJobFinished(personaId, job, result, `Scheduled ${job}`),
  });
  applyLoginItem(scheduler.loadConfig());

  autoPublisher = new AutoPublisher({
    scheduler,
    listPersonaIds: () => personaManager.listPersonaRecords().map((p) => p.id),
    publish: (personaId, destination) =>
      personaManager.withPersonaContext(personaId, (ctx) =>
        runScheduledPublish(ctx, destination, true, publishPaths())
      ),
    hasUnpublishedChanges: (personaId) =>
      personaManager.withPersonaContext(personaId, async (ctx) => {
        // Only personas that have published before: a first publish is the user's call
        const published = ctx.db.getProfile().publishSettings.lastPublishedFingerprint;
        return Boolean(published) && ctx.siteGenerator.contentFingerprint() !== published;
      }),
    onStatusChange: () => {
      refreshTrayMenu();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('studio:schedule-updated');
    },
    // The stored hold (survives a restart) and releasing it
    loadAgentHold: (personaId) =>
      personaManager.withPersonaContext(personaId, async (ctx) => ctx.db.getHeldAgentChanges().length),
    clearAgentHold: (personaId) =>
      personaManager.withPersonaContext(personaId, async (ctx) => ctx.db.clearHeldAgentChanges()),
    // Tell the user when a countdown starts, while there's still time to cancel it
    onArmed: (personaId, seconds) => {
      if ((!mainWindow || !mainWindow.isVisible() || !mainWindow.isFocused()) && Notification.isSupported()) {
        const note = new Notification({
          title: `Auto-publishing ${personaLabel(personaId)}`,
          body: `Your site will publish in ${seconds}s. Click to review or cancel.`,
        });
        note.on('click', () => {
          showMainWindow();
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('studio:show-auto-publish');
        });
        note.show();
      }
    },
    onFinished: (personaId, result) => handleJobFinished(personaId, 'publish', result, 'Auto-publish'),
  });

  // Older versions generated a fictional demo friend's site here; it's no longer used
  fs.rmSync(path.join(userDataDir, DEMO_PEER_FOLDER_NAME), { recursive: true, force: true });
  webringMcpServer.attachScheduler(scheduler);
  webringMcpServer.attachAppServices({
    publishPaths,
    deviceLogin: githubDeviceLogin,
    openExternal: (url) => {
      if (/^https:\/\/github\.com\//i.test(url)) void shell.openExternal(url);
    },
    onPublished: scheduleWebringHubFollowUp,
    onLocalChange: noteLocalChange,
    onAutoPublishSettingsChanged: (personaId) => void autoPublisher.refresh([personaId]),
    // An agent's request is waiting: the window shows the approval modal; if it isn't focused,
    // a notification brings it forward
    onApprovalRequested: (approval) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('studio:mcp-approval-requested', approval);
      if ((!mainWindow || !mainWindow.isFocused()) && Notification.isSupported()) {
        const note = new Notification({ title: 'Agent request needs approval', body: approval.summary });
        note.on('click', () => showMainWindow());
        note.show();
      }
    },
  });

  mcpHttpServer = new McpHttpServer(webringMcpServer, {
    settingsPath: path.join(userDataDir, 'mcp-http.json'),
  });
  await mcpHttpServer.start(0);
}

function createWindow(show = true) {
  mainWindow = new BrowserWindow({
    show,
    // Window and taskbar icon on Windows and Linux (macOS uses the app/dock icon)
    icon: assetPath('app-icon.png'),
    width: 1380,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'Webring Studio — Decentralized Profile & Ring Manager',
    backgroundColor: '#090d16',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Deny all browser permission requests (camera, mic, geolocation, notifications, etc.)
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });

  // Prevent subframes (e.g. preview iframe) from navigating to non-loopback remote origins
  mainWindow.webContents.on('will-frame-navigate', (event) => {
    const url = event.url || '';
    if (!url || url.startsWith('about:') || url.startsWith('data:')) return;
    try {
      const parsed = new URL(url);
      if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') return;
    } catch {
      // Fall through to prevent
    }
    event.preventDefault();
  });

  // Links inside Studio (Markdown previews, posts) never open in an Electron window, which would
  // get Studio's preload API: web links go to the default browser, anything else is ignored
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const appUrl = mainWindow?.webContents.getURL() || '';
    const sameDocument = url.split('#')[0] === appUrl.split('#')[0];
    if (sameDocument) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url) && !url.startsWith(process.env.VITE_DEV_SERVER_URL || '\u0000')) void shell.openExternal(url);
  });

  // Right-click menu: Cut/Copy/Paste and spelling in text fields, Copy for selected text, and
  // Copy Link / Open in Browser for web links
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const contents = mainWindow?.webContents;
    if (!contents) return;
    const template = buildEditContextMenu(params, {
      replaceMisspelling: (word) => contents.replaceMisspelling(word),
      addToDictionary: (word) => contents.session.addWordToSpellCheckerDictionary(word),
      copyText: (text) => clipboard.writeText(text),
      openExternal: (url) => void shell.openExternal(url),
    });
    if (template.length) Menu.buildFromTemplate(template).popup({ window: mainWindow ?? undefined });
  });

  // In background mode, closing the window hides it so schedules keep running in the tray
  mainWindow.on('close', (event) => {
    if (!isQuitting && scheduler?.loadConfig().runInBackground) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl && !app.isPackaged) {
    // Development only: the window's own pages also get the CSP as a header. It's the relaxed
    // dev policy (Vite needs inline scripts and a websocket); packaged builds load index.html from
    // disk, where its strict meta CSP applies.
    const origin = new URL(devServerUrl).origin;
    session.defaultSession.webRequest.onHeadersReceived({ urls: [`${origin}/*`] }, (details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self' 'unsafe-inline' http://localhost:*; style-src 'self' 'unsafe-inline'; " +
              "img-src 'self' data: https: studio-media:; media-src 'self' studio-media:; font-src 'self' data:; " +
              "connect-src 'self' ws://localhost:* http://localhost:*; frame-src http://127.0.0.1:*; object-src 'none'; " +
              "base-uri 'none'; form-action 'none'",
          ],
        },
      });
    });
    mainWindow.loadURL(devServerUrl);
  } else {
    const indexHtmlPath = path.join(__dirname, '../../dist/index.html');
    mainWindow.loadFile(indexHtmlPath);
  }
}

function handleDeepLinkUrl(rawUri: string) {
  // Ring requests only open the review screen; nothing is approved without the maintainer
  if (rawUri.startsWith('webring://ring-request') && parseRingRequestUri(rawUri) && mainWindow) {
    mainWindow.webContents.send('webring:ring-request', rawUri);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    return;
  }
  // Friend notices only open the review; nothing is added until the user clicks
  if (rawUri.startsWith('webring://friend-notice') && parseFriendNoticeUri(rawUri) && mainWindow) {
    mainWindow.webContents.send('webring:friend-notice', rawUri);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    return;
  }
  const parsed = parseWebringUri(rawUri);
  if (parsed && mainWindow) {
    mainWindow.webContents.send('webring:deep-link', parsed);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
}

// Register custom protocol `webring://`
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('webring', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('webring');
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    const uriArg = commandLine.find((arg) => arg.startsWith('webring://'));
    if (uriArg) {
      handleDeepLinkUrl(uriArg);
    }
    showMainWindow();
  });

  app.whenReady().then(async () => {
    // Launched at login: start quietly in the tray
    const startHidden =
      process.argv.includes('--background') ||
      (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);
    // Opening the personas reads their keys from the OS keychain, which can block on a macOS
    // Keychain prompt, so this comes before the splash
    await initServices();
    await applyWindowProxy();
    registerIpcHandlers();
    // The splash plays while the main window loads; skipped in the background, for a webring://
    // link launch, or with --no-splash
    const launchedByLink = process.argv.some((arg) => arg.startsWith('webring://'));
    const splashDone =
      startHidden || launchedByLink || process.argv.includes('--no-splash')
        ? null
        : showSplash(assetPath('splash.html'));
    protocol.handle('studio-media', (request) => {
      // Studio uses studio-media://local/<path>; the site preview's <base> gives studio-media://local/media/<path>
      const relative = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, '')).replace(/^media\//, '');
      const file = personaManager.getActiveContext().mediaLibrary.resolveLocalUrl(`media/${relative}`);
      if (!file || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });
    // Packaged builds get their icon from build/icon.*; when running from source, show the logo
    // in the dock and About panel instead of Electron's default
    if (process.platform === 'darwin' && !app.isPackaged && fs.existsSync(assetPath('dock-icon.png'))) {
      app.dock?.setIcon(nativeImage.createFromPath(assetPath('dock-icon.png')));
    }
    app.setAboutPanelOptions({ applicationName: 'Webring Studio', iconPath: assetPath('app-icon.png') });
    createWindow(!startHidden && !splashDone);
    if (splashDone) {
      // Show the main window in the splash's place once it has played (unless the tray or a
      // second launch already showed it)
      void splashDone.then(() => {
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) showMainWindow();
      });
    }
    createTray();
    scheduler.start();
    // Changes left unpublished when the app last quit get their auto-publish back
    void autoPublisher.refresh();
    // Catch up after sleep; the 60-second tick handles everything else
    powerMonitor.on('resume', () => void scheduler.tick());
    powerMonitor.on('unlock-screen', () => void scheduler.tick());
    startupComplete = true;

    // Check if launched with a webring:// URI
    const startupUri = process.argv.find((arg) => arg.startsWith('webring://'));
    if (startupUri) {
      setTimeout(() => handleDeepLinkUrl(startupUri), 1000);
    }
  });
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLinkUrl(url);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !scheduler?.loadConfig().runInBackground) {
    app.quit();
  }
});

// macOS also fires 'activate' on launch; only honour dock clicks once startup is done
app.on('activate', () => {
  if (startupComplete) showMainWindow();
});

app.on('before-quit', () => {
  isQuitting = true;
  scheduler?.stop();
  autoPublisher?.dispose();
});

function registerIpcHandlers() {
  ipcMain.handle('studio:get-bundle', async () => {
    const ctx = personaManager.getActiveContext();
    const bundle = ctx.db.buildSignedSiteBundle();
    const publishedBundle = ctx.db.buildSignedSiteBundle({ publish: true });
    const personaList = personaManager.listPersonas();
    const profileWithSettings = ctx.db.getProfile();
    const curatedFeed = ctx.db.getCuratedNetworkFeed();
    return {
      activePersonaId: personaList.activePersonaId,
      personas: personaList.personas,
      bundle,
      allFriends: ctx.db.getFriends(),
      allEndorsements: ctx.db.getEndorsements(),
      profileWithSettings,
      networkFeed: curatedFeed.entries,
      joinedRings: ctx.db.getJoinedRings(),
      hostedRings: ctx.db.getHostedRings().map((ring) => ({
        ...ring,
        members: ring.members.map((m) => ({ ...m, flagged: isRingMemberFlagged(m) })),
      })),
      feedExclusions: curatedFeed.excluded,
      moderation: ctx.db.getModeration(),
      changesSinceLastPublish: ctx.db.countChangesSince(
        profileWithSettings.publishSettings.lastPublishedAt
      ),
      publishedUpToDate:
        Boolean(profileWithSettings.publishSettings.lastPublishedFingerprint) &&
        ctx.siteGenerator.contentFingerprint(publishedBundle) ===
          profileWithSettings.publishSettings.lastPublishedFingerprint,
      // The preview shows the published page: recent items, with older ones under "Older posts"
      // Served from the loopback preview server: the window's CSP (script-src 'self') would block
      // the page's own scripts in a srcdoc frame, which inherits it
      previewUrl: await localPreviewServer.serveLivePreview(
        ctx.siteGenerator.buildStandaloneProfileHtml(publishedBundle, { preview: true })
      ),
      savedPosts: ctx.db.getSavedPosts(),
      feedRetentionDays: ctx.db.getFeedRetentionDays(),
      friendNotices: ctx.db.getFriendNotices(),
      friendSyncNotices: ctx.db.getFriendSyncNotices(),
      // One-time messages left by database upgrades; reading them removes them
      upgradeNotices: ctx.db.takeUpgradeNotices(),
      // This persona's own key fingerprint, for friends to compare when their Studio says it changed
      ownKeyFingerprint: spkiFingerprint(ctx.db.getKeys().publicKeyPem),
      mutualFriendUrls: ctx.db.getMutualFriendUrls(),
      proxySettings: ctx.db.getProxySettings(),
      keyRotations: ctx.db.getKeyRotations(),
    };
  });

  // Saved posts and the feed window (both local only)
  ipcMain.handle('studio:save-post', async (_e, canonicalUrl: string) => {
    const ctx = personaManager.getActiveContext();
    return savePost(ctx.db, ctx.mediaLibrary, String(canonicalUrl));
  });
  ipcMain.handle('studio:get-feed-album-photos', (_e, albumUrl: string) => {
    const ctx = personaManager.getActiveContext();
    return ctx.db.getFeedAlbumPhotos(String(albumUrl));
  });
  ipcMain.handle('studio:mark-feed-album-seen', (_e, albumUrl: string) => {
    const ctx = personaManager.getActiveContext();
    ctx.db.markFeedAlbumSeen(String(albumUrl));
    return { ok: true };
  });
  ipcMain.handle('studio:unsave-post', (_e, savedId: string) => {
    const ctx = personaManager.getActiveContext();
    unsavePost(ctx.db, ctx.mediaLibrary, String(savedId));
    return { ok: true };
  });
  ipcMain.handle('studio:saved-note', (_e, savedId: string, note: string) => {
    personaManager.getActiveContext().db.updateSavedNote(String(savedId), String(note || ''));
    return { ok: true };
  });
  ipcMain.handle('studio:set-feed-retention', (_e, days: number) => {
    return personaManager.getActiveContext().db.setFeedRetentionDays(Number(days));
  });

  ipcMain.handle('studio:list-personas', () => {
    return personaManager.listPersonas();
  });

  ipcMain.handle('studio:create-persona', async (_e, input: CreatePersonaInput) => {
    const result = personaManager.createPersona(input);
    await applyWindowProxy();
    return result;
  });

  ipcMain.handle('studio:switch-persona', async (_e, personaId: string) => {
    const result = personaManager.switchPersona(personaId);
    await applyWindowProxy();
    return result;
  });

  ipcMain.handle('studio:update-persona-label', (_e, personaId: string, label: string) => {
    return personaManager.updatePersonaLabel(personaId, label);
  });

  ipcMain.handle('studio:delete-persona', async (_e, personaId: string) => {
    const result = personaManager.deletePersona(personaId);
    await applyWindowProxy();
    return result;
  });

  // allowPlaintext: the user agreed to store a new password or token unencrypted (no keychain)
  ipcMain.handle('studio:update-profile', (_e, updates, options?: { allowPlaintext?: boolean }) => {
    const ctx = personaManager.getActiveContext();
    // The export folder is set only through the folder picker (studio:choose-export-folder)
    if (updates?.publishSettings && typeof updates.publishSettings === 'object') {
      updates = { ...updates, publishSettings: { ...updates.publishSettings } };
      delete updates.publishSettings.exportPath;
      // The SFTP key file is chosen only through studio:pick-sftp-key
      delete updates.publishSettings.sftpPrivateKeyPath;
    }
    const profile = ctx.db.updateProfile(updates, { allowPlaintext: options?.allowPlaintext === true });
    // A replaced profile photo or banner that was uploaded to the library is deleted here
    if (updates && typeof updates === 'object' && ('avatarUrl' in updates || 'bannerUrl' in updates)) {
      cleanUpLibrary(ctx.db, ctx.mediaLibrary);
    }
    return profile;
  });

  // Upload a local image as the profile photo or banner (picked here, or dropped in Studio)
  ipcMain.handle('studio:profile-set-image', async (_e, kind: 'avatar' | 'banner', filePath?: string) => {
    if (kind !== 'avatar' && kind !== 'banner') throw new Error('Unknown profile image.');
    let file = filePath;
    if (!file) {
      if (!mainWindow) return null;
      const result = await dialog.showOpenDialog(mainWindow, {
        title: kind === 'avatar' ? 'Choose Profile Photo' : 'Choose Banner Image',
        properties: ['openFile'],
        filters: [{ name: 'Images (JPEG, PNG)', extensions: ['jpg', 'jpeg', 'png'] }],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      file = result.filePaths[0];
    }
    const ctx = personaManager.getActiveContext();
    return { url: await setProfileImageFromFile(ctx.db, ctx.mediaLibrary, kind, file) };
  });

  ipcMain.handle('studio:create-album', (_e, input) => {
    return personaManager.getActiveContext().db.createAlbum(input);
  });

  ipcMain.handle('studio:delete-album', (_e, albumId: string) => {
    const ctx = personaManager.getActiveContext();
    deleteAlbumWithFiles(ctx.db, ctx.mediaLibrary, albumId);
    noteActiveChange('album');
    return { ok: true };
  });

  ipcMain.handle('studio:add-photo', (_e, input) => {
    const photo = personaManager.getActiveContext().db.addPhotoToAlbum(input);
    noteActiveChange('photo');
    return photo;
  });

  ipcMain.handle('studio:delete-photo', (_e, photoId: string) => {
    const ctx = personaManager.getActiveContext();
    deletePhotoWithFiles(ctx.db, ctx.mediaLibrary, photoId);
    noteActiveChange('photo');
    return { ok: true };
  });

  const photoFilters = [{ name: 'Photos (JPEG, PNG)', extensions: ['jpg', 'jpeg', 'png'] }];

  ipcMain.handle('studio:media-import-photos', async (_e, albumId: string, filePaths?: string[]) => {
    let files = filePaths;
    if (!files) {
      if (!mainWindow) return { added: [], failed: [] };
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Add Photos to Album',
        properties: ['openFile', 'multiSelections'],
        filters: photoFilters,
      });
      if (result.canceled) return { added: [], failed: [] };
      files = result.filePaths;
    }
    const ctx = personaManager.getActiveContext();
    const imported = await importPhotosIntoAlbum(ctx.db, ctx.mediaLibrary, albumId, files);
    if (imported.added.length > 0) noteActiveChange('photos');
    return imported;
  });

  // A single image for a wall post: same optimizing, metadata-stripping pipeline as album photos
  ipcMain.handle('studio:media-import-image', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Attach Image',
      properties: ['openFile'],
      filters: photoFilters,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const media = await personaManager.getActiveContext().mediaLibrary.importPhoto(result.filePaths[0], 'wall-posts');
    return { url: media.url, fileName: path.basename(result.filePaths[0]) };
  });

  ipcMain.handle('studio:media-replace-photo', async (_e, photoId: string) => {
    if (!mainWindow) return { replaced: false };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Replace Photo',
      properties: ['openFile'],
      filters: photoFilters,
    });
    if (result.canceled || result.filePaths.length === 0) return { replaced: false };
    const ctx = personaManager.getActiveContext();
    await replacePhotoImage(ctx.db, ctx.mediaLibrary, photoId, result.filePaths[0]);
    noteActiveChange('photo');
    return { replaced: true };
  });

  ipcMain.handle(
    'studio:media-update-photo',
    (_e, photoId: string, updates: { caption?: string; altText?: string; tags?: string[] }) => {
      const photo = personaManager.getActiveContext().db.updatePhotoDetails(photoId, updates);
      noteActiveChange('photo');
      return photo;
    }
  );

  ipcMain.handle('studio:media-move-photo', (_e, photoId: string, direction: 'up' | 'down') => {
    personaManager.getActiveContext().db.movePhoto(photoId, direction);
    noteActiveChange('album');
    return { ok: true };
  });

  ipcMain.handle(
    'studio:media-update-album',
    (_e, albumId: string, updates: { title?: string; description?: string; tags?: string[]; coverUrl?: string; postToFeed?: boolean; display?: 'card' | 'expanded' }) => {
      const album = personaManager.getActiveContext().db.updateAlbum(albumId, updates);
      noteActiveChange('album');
      return album;
    }
  );

  ipcMain.handle('studio:media-usage', () => {
    const ctx = personaManager.getActiveContext();
    cleanUpLibrary(ctx.db, ctx.mediaLibrary);
    return ctx.mediaLibrary.storageUsage();
  });

  ipcMain.handle('studio:forget-publish-history', () => {
    personaManager.getActiveContext().db.clearAllPublishLedgers();
    return { ok: true };
  });

  ipcMain.handle('studio:create-item', (_e, input) => {
    const item = personaManager.getActiveContext().db.createItem(input);
    noteActiveChange(String(item?.type || 'post'));
    return item;
  });

  ipcMain.handle('studio:update-item', (_e, itemId: string, updates) => {
    const ctx = personaManager.getActiveContext();
    const item = ctx.db.updateItem(itemId, updates);
    cleanUpLibrary(ctx.db, ctx.mediaLibrary); // a replaced or removed post image
    noteActiveChange(String(item?.type || 'post'));
    return item;
  });

  ipcMain.handle('studio:delete-item', (_e, itemId: string) => {
    const ctx = personaManager.getActiveContext();
    ctx.db.deleteItem(itemId);
    cleanUpLibrary(ctx.db, ctx.mediaLibrary);
    noteActiveChange('deleted item');
    return { ok: true };
  });

  ipcMain.handle('studio:add-friend', (_e, input) => {
    const personaId = personaManager.getActivePersonaId();
    const friend = personaManager.getActiveContext().db.addOrUpdateFriend(input);
    if (scheduler.getPersonaSchedule(personaId).autoPublish.enabled && friend?.siteUrl) {
      // Pull the new friend's site straight away so their posts show up without a Sync All
      pullInBackground(personaId, (ctx) => ctx.ringCrawler.crawlFriendSite(friend.siteUrl));
    }
    noteLocalChange(personaId, 'friend');
    return friend;
  });

  ipcMain.handle('studio:update-friend', (_e, friendId: string, updates) => {
    return personaManager.getActiveContext().db.updateFriend(String(friendId), updates || {});
  });

  ipcMain.handle('studio:rotate-keys', () => {
    return personaManager.getActiveContext().db.rotateSigningKeys();
  });

  // Pins only the candidate key whose fingerprint the user reviewed in the key-change dialog
  ipcMain.handle('studio:trust-friend-key', (_e, friendId: string, expectedFingerprint: string) => {
    return personaManager.getActiveContext().db.trustNewFriendKey(String(friendId), String(expectedFingerprint || ''));
  });

  ipcMain.handle(
    'studio:set-proxy-settings',
    async (_e, input: { enabled?: boolean; proxyUrl?: string }, options?: { allowPlaintext?: boolean }) => {
    const rawUrl = typeof input?.proxyUrl === 'string' ? input.proxyUrl.trim() : '';
    if (rawUrl) {
      parseProxyUrl(rawUrl);
    }
    const updated = personaManager.getActiveContext().db.setProxySettings(
      { enabled: input?.enabled, proxyUrl: rawUrl },
      { allowPlaintext: options?.allowPlaintext === true }
    );
    await applyWindowProxy();
    return updated;
  }
  );

  ipcMain.handle('studio:get-security-status', () => getSecurityStatus());

  ipcMain.handle('studio:set-friend-visibility', (_e, friendId: string, visibility: 'private' | 'public') => {
    const friend = personaManager.getActiveContext().db.setFriendVisibility(friendId, visibility);
    noteActiveChange('friend');
    return friend;
  });

  ipcMain.handle('studio:delete-friend', (_e, friendId: string) => {
    personaManager.getActiveContext().db.deleteFriend(friendId);
    noteActiveChange('friend');
    return { ok: true };
  });

  ipcMain.handle('studio:set-moderation', (_e, siteUrl: string, action: ModerationAction | null) => {
    return personaManager.getActiveContext().db.setModeration(siteUrl, action);
  });

  ipcMain.handle('studio:update-webring', (_e, ringId: string, updates) => {
    return personaManager.getActiveContext().db.updateWebring(ringId, updates);
  });

  ipcMain.handle('studio:delete-webring', (_e, ringId: string) => {
    personaManager.getActiveContext().db.deleteWebring(ringId);
    return { ok: true };
  });

  // Manual syncs and publishes share the scheduler's per-persona lock, capturing personaId once
  const withActiveLock = <T>(fn: (personaId: string, ctx: ActivePersonaContext) => Promise<T>) => {
    const personaId = personaManager.getActivePersonaId();
    return scheduler.runExclusive(personaId, () =>
      personaManager.withPersonaContext(personaId, (ctx) => fn(personaId, ctx))
    );
  };

  // Syncs one friend by site address. Reading a local folder as their site is for development only.
  ipcMain.handle('studio:crawl-friend', async (_e, siteUrl: string, localDirOverride?: string) => {
    const localDir = !app.isPackaged && typeof localDirOverride === 'string' && localDirOverride ? localDirOverride : undefined;
    return withActiveLock((_personaId, ctx) => ctx.ringCrawler.crawlFriendSite(String(siteUrl || ''), localDir));
  });

  ipcMain.handle('studio:crawl-all-friends', async (event) => {
    return withActiveLock(async (_personaId, ctx) => {
      // A proxy that can't be unlocked stops the run (ProxyUnavailableError) before anything connects
      try {
        ctx.ringCrawler.assertCanSync();
      } catch (err) {
        pushSecurityStatus(true);
        throw err;
      }
      const results = await ctx.ringCrawler.crawlAllFriends({
        // Progress for the Sync button: counts only, nothing about the sites
        onProgress: ({ done, total }) => {
          if (!event.sender.isDestroyed()) event.sender.send('studio:sync-progress', { done, total });
        },
      });
      await notifyWebringHubs(ctx);
      return results;
    });
  });

  // Webring Hubs (optional, per persona; see docs/architecture/webring-hub.md)
  // Re-reads /api/info (title, extensions) for hubs not checked within a day
  ipcMain.handle('studio:webring-hub-list', () => personaManager.getActiveContext().webringHubService.refreshStaleInfo());
  ipcMain.handle('studio:webring-hub-add', (_e, url: string) =>
    personaManager.getActiveContext().webringHubService.add(String(url || ''))
  );
  ipcMain.handle('studio:webring-hub-remove', (_e, url: string, options?: { force?: boolean }) =>
    personaManager.getActiveContext().webringHubService.remove(String(url || ''), { force: options?.force === true })
  );
  ipcMain.handle('studio:webring-hub-search', (_e, url: string, query: string, options?: { limit?: number; offset?: number }) =>
    personaManager
      .getActiveContext()
      .webringHubService.search(String(url || ''), String(query || ''), {
        limit: Number(options?.limit) || undefined,
        offset: Number(options?.offset) || undefined,
      })
  );
  ipcMain.handle('studio:webring-hub-set-listed', (_e, url: string, listed: boolean) =>
    withActiveLock(() => {
      const { webringHubService } = personaManager.getActiveContext();
      return listed ? webringHubService.listSite(String(url || '')) : webringHubService.unlistSite(String(url || ''));
    })
  );
  ipcMain.handle('studio:webring-hub-check-key', (_e, siteUrl: string) =>
    personaManager.getActiveContext().webringHubService.checkKeyWithWebringHubs(String(siteUrl || ''))
  );

  ipcMain.handle('studio:ring-request-join', async (_e, hubUrl: string) => {
    const personaId = personaManager.getActivePersonaId();
    const request = await personaManager.getActiveContext().ringService.requestToJoin(hubUrl);
    if (scheduler.getPersonaSchedule(personaId).autoPublish.enabled) {
      // Pick up the ring's member list as soon as the maintainer has published it
      pullInBackground(personaId, (ctx) => ctx.ringService.syncJoinedRings());
    }
    noteLocalChange(personaId, 'webring');
    return request;
  });

  ipcMain.handle('studio:ring-review-request', async (_e, link: string) => {
    return await personaManager.getActiveContext().ringService.reviewRequest(link);
  });

  ipcMain.handle(
    'studio:ring-decide-request',
    async (_e, link: string, decision: 'approve' | 'decline' | 'ban', reason?: string) => {
      const outcome = await personaManager.getActiveContext().ringService.decideRequest(link, decision, reason);
      // An approval only reaches the new member once the ring's files are published
      noteActiveChange('webring');
      return outcome;
    }
  );

  // "I added you" links and the "Added you" list (local only)
  ipcMain.handle('studio:friend-notice-create', (_e, friendSiteUrl: string) => {
    return personaManager.getActiveContext().ringService.createFriendNotice(String(friendSiteUrl)).link;
  });
  ipcMain.handle('studio:friend-notice-review', async (_e, link: string) => {
    return await personaManager.getActiveContext().ringService.reviewFriendNotice(String(link));
  });
  ipcMain.handle('studio:friend-notice-accept', async (_e, link: string) => {
    const personaId = personaManager.getActivePersonaId();
    const accepted = await personaManager.getActiveContext().ringService.acceptFriendNotice(String(link));
    noteLocalChange(personaId, 'friend');
    return accepted;
  });
  ipcMain.handle('studio:friend-notice-dismiss', (_e, siteUrl: string) => {
    personaManager.getActiveContext().db.dismissFriendNotice(String(siteUrl));
    return { ok: true };
  });
  // Rollback notices: a friend served an older copy of a document than one already verified
  ipcMain.handle('studio:friend-sync-notice-dismiss', (_e, siteUrl: string, doc: string) => {
    personaManager.getActiveContext().db.dismissFriendSyncNotice(String(siteUrl), 'rollback_blocked', String(doc));
    return { ok: true };
  });

  ipcMain.handle('studio:ring-sync-all', async () => {
    return withActiveLock(async () => {
      const { ringService } = personaManager.getActiveContext();
      return {
        joined: await ringService.syncJoinedRings(),
        hosted: await ringService.syncHostedRings(),
      };
    });
  });

  ipcMain.handle('studio:get-schedule', () => scheduleOverview());

  ipcMain.handle(
    'studio:set-schedule',
    async (
      _e,
      change:
        | {
            personaId: string;
            sync?: Record<string, unknown>;
            publish?: Record<string, unknown>;
            autoPublish?: Record<string, unknown>;
          }
        | { app: Partial<Pick<SchedulerConfig, 'runInBackground' | 'startAtLogin' | 'paused' | 'notifyOnFailure'>> }
    ) => {
      if ('app' in change) {
        const config = scheduler.setAppSettings(change.app);
        applyLoginItem(config);
        if (change.app.paused !== undefined) await autoPublisher.refresh();
      } else {
        scheduler.setPersonaSchedule(change.personaId, {
          sync: change.sync as Parameters<Scheduler['setPersonaSchedule']>[1]['sync'],
          publish: change.publish as Parameters<Scheduler['setPersonaSchedule']>[1]['publish'],
          autoPublish: change.autoPublish as Parameters<Scheduler['setPersonaSchedule']>[1]['autoPublish'],
        });
        // Turning auto-publish on picks up changes already waiting; turning it off cancels a pending one
        if (change.autoPublish) await autoPublisher.refresh([change.personaId]);
      }
      refreshTrayMenu();
      return scheduleOverview();
    }
  );

  ipcMain.handle('studio:run-job-now', async (_e, personaId: string, job: ScheduledJobKind) => {
    const result = await scheduler.runNow(personaId, job);
    return { result, overview: scheduleOverview() };
  });

  ipcMain.handle(
    'studio:auto-publish-now',
    async (_e, personaId: string, options?: { includeAgentChanges?: boolean }) => {
      const result = await autoPublisher.publishNow(String(personaId), {
        includeAgentChanges: options?.includeAgentChanges === true,
      });
      pushSecurityStatus(true);
      return { result, overview: scheduleOverview() };
    }
  );

  // Agent changes held for review (the review panel), and releasing them
  ipcMain.handle('studio:get-agent-changes', () => personaManager.getActiveContext().db.getHeldAgentChanges());
  ipcMain.handle('studio:release-agent-changes', () => {
    const personaId = personaManager.getActivePersonaId();
    personaManager.getActiveContext().db.clearHeldAgentChanges();
    const status = autoPublisher.approveAgentChanges(personaId);
    pushSecurityStatus(true);
    return status;
  });

  ipcMain.handle('studio:auto-publish-cancel', (_e, personaId: string) => {
    autoPublisher.cancel(String(personaId));
    return scheduleOverview();
  });

  ipcMain.handle('studio:hosted-ring-create', (_e, input: { name: string; description?: string }) => {
    const ring = personaManager.getActiveContext().db.createHostedRing(input);
    noteActiveChange('webring');
    return ring;
  });

  ipcMain.handle('studio:hosted-ring-update', (_e, ringId: string, updates) => {
    return personaManager.getActiveContext().db.updateHostedRing(ringId, updates);
  });

  ipcMain.handle('studio:host-legacy-ring', (_e, joinedRingId: string) => {
    return personaManager.getActiveContext().db.hostLegacyRing(joinedRingId);
  });

  ipcMain.handle('studio:hosted-ring-preview', (_e, ringId: string) => {
    return personaManager.getActiveContext().siteGenerator.buildRingPagePreviewHtml(ringId);
  });

  ipcMain.handle(
    'studio:hosted-ring-member',
    (
      _e,
      ringId: string,
      siteUrl: string,
      change: { action: 'remove' | 'ban' | 'unban' | 'hide' | 'show' | 'up' | 'down'; reason?: string }
    ) => {
      const { db } = personaManager.getActiveContext();
      switch (change.action) {
        case 'remove':
          return db.removeRingMember(ringId, siteUrl);
        case 'ban':
          return db.banRingMember(ringId, { siteUrl, reason: change.reason });
        case 'unban':
          return db.unbanRingMember(ringId, siteUrl);
        case 'hide':
        case 'show':
          return db.setRingMemberHidden(ringId, siteUrl, change.action === 'hide');
        case 'up':
        case 'down':
          return db.moveRingMember(ringId, siteUrl, change.action);
      }
    }
  );

  // The only way to change the export folder: the user picks it here, and it's checked and saved
  // in main (the window can't set the path, and MCP never can)
  ipcMain.handle('studio:choose-export-folder', () => pickExportFolder());

  // SFTP key file: picked here, never sent by the window. Returns only the file name to show.
  ipcMain.handle('studio:pick-sftp-key', async () => {
    if (!mainWindow) return null;
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose your SSH private key file',
      properties: ['openFile', 'showHiddenFiles'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const ctx = personaManager.getActiveContext();
    ctx.db.updateProfile({
      publishSettings: { ...ctx.db.getProfile().publishSettings, sftpPrivateKeyPath: res.filePaths[0], sftpAuthMethod: 'privateKey' },
    });
    return { fileName: path.basename(res.filePaths[0]) };
  });

  // The SFTP server key pinned for the current host, forgetting it, and trusting a changed one
  const sftpTarget = () => {
    const settings = personaManager.getActiveContext().db.getProfile().publishSettings;
    return { host: settings.host || '', port: settings.port || 22 };
  };
  ipcMain.handle('studio:get-sftp-host-key', () => {
    const { host, port } = sftpTarget();
    const db = personaManager.getActiveContext().db;
    return { pinned: host ? db.getSftpHostKey(host, port) : null, mismatch: db.getSftpHostKeyMismatch() };
  });
  ipcMain.handle('studio:forget-sftp-host-key', () => {
    const { host, port } = sftpTarget();
    if (host) personaManager.getActiveContext().db.forgetSftpHostKey(host, port);
    return { ok: true };
  });
  ipcMain.handle('studio:trust-sftp-host-key', (_e, presentedFingerprint: string) =>
    personaManager.getActiveContext().db.trustSftpHostKey(String(presentedFingerprint || ''))
  );

  // Exports to the saved folder; with none saved, the user picks one first. The window never
  // supplies a path (any first argument is ignored).
  ipcMain.handle('studio:export-local', async (_e, _ignored?: unknown, options?: { includeAgentChanges?: boolean }) => {
    if (!personaManager.getActiveContext().db.getProfile().publishSettings.exportPath) {
      const chosen = await pickExportFolder();
      if (!chosen) {
        return { success: false, mode: 'local', destination: '', filesPublished: 0, message: 'Export cancelled: no folder chosen.' };
      }
    }
    return withActiveLock(async (personaId, ctx) => {
      releaseHeldChangesFor(personaId, ctx, options?.includeAgentChanges === true);
      const result = await publishTo(ctx, 'local', publishPaths());
      if (result.success) scheduleWebringHubFollowUp(personaId);
      return result;
    });
  });

  ipcMain.handle('studio:test-export-preview', async (_e, openInBrowser?: boolean) => {
    const ctx = personaManager.getActiveContext();
    const previewDir = path.join(app.getPath('userData'), `test-preview-site-${ctx.persona.id}`);
    const result = await localPreviewServer.runTestExportAndServe(ctx.siteGenerator, previewDir);
    if (openInBrowser && result.previewUrl) {
      await shell.openExternal(result.previewUrl);
    }
    return result;
  });

  ipcMain.handle('studio:open-external', async (_e, url: string) => {
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      await shell.openExternal(url);
    }
    return { ok: true };
  });

  // A Media Library image (studio-media://local/<path> or media/<path>) in the computer's image viewer
  ipcMain.handle('studio:open-media', async (_e, url: string) => {
    if (typeof url !== 'string') return { ok: false };
    const relative = url.startsWith('studio-media:')
      ? decodeURIComponent(new URL(url).pathname.replace(/^\/+/, '')).replace(/^media\//, '')
      : url.replace(/^media\//, '');
    const file = personaManager.getActiveContext().mediaLibrary.resolveLocalUrl(`media/${relative}`);
    if (!file || !fs.existsSync(file)) return { ok: false };
    return { ok: (await shell.openPath(file)) === '' };
  });

  // The Publish tab sends its current form; save it, then publish with the saved settings
  const publishWithSettings = (destination: PublishDestination, settings: unknown, includeAgentChanges = false) =>
    withActiveLock(async (personaId, ctx) => {
      releaseHeldChangesFor(personaId, ctx, includeAgentChanges);
      const currentProfile = ctx.db.getProfile();
      ctx.db.updateProfile({
        publishSettings: {
          ...currentProfile.publishSettings,
          ...((settings as object) || {}),
        },
      });
      const result = await publishTo(ctx, destination, publishPaths());
      if (result.success) scheduleWebringHubFollowUp(personaId);
      return result;
    });

  ipcMain.handle('studio:publish-remote', async (_e, settings, options?: { includeAgentChanges?: boolean }) =>
    publishWithSettings('remote', settings, options?.includeAgentChanges === true)
  );

  ipcMain.handle('studio:publish-github', async (_e, settings, options?: { includeAgentChanges?: boolean }) =>
    publishWithSettings('github', settings, options?.includeAgentChanges === true)
  );

  // Guided setup (shared with the MCP tools through setupService)
  ipcMain.handle('studio:setup-status', (_e, options?: { checkGitHub?: boolean }) =>
    getSetupStatus(personaManager.getActiveContext(), { checkGitHub: Boolean(options?.checkGitHub) })
  );
  ipcMain.handle('studio:github-login-start', async () => {
    const login = await githubDeviceLogin.start();
    return { ...login, configured: true };
  });
  ipcMain.handle('studio:github-login-available', () => githubDeviceLogin.isConfigured());
  ipcMain.handle('studio:github-login-poll', async (_e, loginId: string, options?: { allowPlaintext?: boolean }) => {
    const result = await githubDeviceLogin.poll(String(loginId || ''));
    if (result.status !== 'approved') return result;
    // The token goes straight to the persona's sealed settings; the window never sees it
    const user = await connectGitHub(personaManager.getActiveContext(), result.token, {}, {
      allowPlaintext: options?.allowPlaintext === true,
    });
    return { status: 'approved', login: user.login };
  });
  ipcMain.handle('studio:github-connect-token', async (_e, token: string, options?: { allowPlaintext?: boolean }) =>
    connectGitHub(personaManager.getActiveContext(), String(token || ''), {}, {
      allowPlaintext: options?.allowPlaintext === true,
    })
  );
  ipcMain.handle('studio:setup-configure-site', (_e, options?: { repoName?: string; allowAddressChange?: boolean }) =>
    configureGitHubSite(personaManager.getActiveContext(), {
      repoName: typeof options?.repoName === 'string' && options.repoName.trim() ? options.repoName.trim() : undefined,
      allowAddressChange: options?.allowAddressChange === true,
    })
  );
  ipcMain.handle('studio:setup-publish', async (_e, options?: { includeAgentChanges?: boolean }) => {
    const personaId = personaManager.getActivePersonaId();
    releaseHeldChangesFor(personaId, personaManager.getActiveContext(), options?.includeAgentChanges === true);
    const result = await publishGitHubSite(personaManager.getActiveContext(), publishPaths());
    if (result.success) scheduleWebringHubFollowUp(personaId);
    refreshTrayMenu();
    return result;
  });
  ipcMain.handle('studio:setup-check-live', () => checkLiveSite(personaManager.getActiveContext()));
  ipcMain.handle('studio:setup-dismiss', (_e, dismissed: boolean) => {
    dismissSetup(personaManager.getActiveContext(), dismissed !== false);
    return { ok: true };
  });

  ipcMain.handle('studio:check-github-repo', async (_e, settings) => {
    const ctx = personaManager.getActiveContext();
    // The form shows a placeholder for a saved token; use the stored one in that case
    return await ctx.sitePublisher.checkGitHubRepo(ctx.db.withStoredCredentials(settings));
  });

  ipcMain.handle('studio:open-path', async (_e, targetPath: string) => {
    if (typeof targetPath !== 'string' || !targetPath.trim()) return { ok: false };
    const resolved = path.resolve(targetPath);
    // Only the persona's own folders: its export, its test preview, its media library and the logs
    const ctx = personaManager.getActiveContext();
    const allowedRoots = [
      ctx.db.getProfile().publishSettings?.exportPath,
      path.join(app.getPath('userData'), `test-preview-site-${ctx.persona.id}`),
      ctx.mediaLibrary.rootDir,
      app.getPath('logs'),
    ]
      .filter((p): p is string => Boolean(p && p.trim()))
      .map((p) => path.resolve(p));
    const isAllowed = allowedRoots.some(
      (root) => resolved === root || resolved.startsWith(root + path.sep)
    );
    if (!isAllowed) {
      throw new Error("Studio only opens this persona's export, preview, media and log folders.");
    }
    await shell.openPath(resolved);
    return { ok: true };
  });

  ipcMain.handle('studio:get-mcp-info', () => {
    const cliScriptPath = path.resolve(__dirname, 'mcp/cli.js');
    return {
      status: mcpHttpServer.getStatus(),
      // The developer tool runner exists only in dev builds
      devTools: !app.isPackaged,
      cliScriptPath,
      userDataDir: app.getPath('userData'),
      tools: webringMcpServer.getTools(),
      resources: webringMcpServer.getResources(),
      prompts: webringMcpServer.getPrompts(),
      activityLog: webringMcpServer.getActivityLog(),
      readOnlyMode: webringMcpServer.isReadOnlyMode(),
      allowPrivateData: webringMcpServer.isPrivateDataAllowed(),
      pendingApprovals: webringMcpServer.listPendingApprovals(),
      approvalHistory: webringMcpServer.listApprovalHistory(),
    };
  });

  ipcMain.handle('studio:set-mcp-read-only', (_e, enabled: boolean) => {
    webringMcpServer.setReadOnlyMode(Boolean(enabled));
    return { readOnlyMode: webringMcpServer.isReadOnlyMode() };
  });

  // "Allow agents to read private data": only this IPC (the MCP tab) changes it, never a tool
  ipcMain.handle('studio:set-mcp-private-data', (_e, enabled: boolean) => {
    webringMcpServer.setAllowPrivateData(enabled === true);
    return { allowPrivateData: webringMcpServer.isPrivateDataAllowed() };
  });

  ipcMain.handle('studio:resolve-mcp-approval', async (_e, id: string, approved: boolean) => {
    return await webringMcpServer.resolveApproval(String(id), approved === true);
  });
  ipcMain.handle('studio:deny-all-mcp-approvals', () => ({ denied: webringMcpServer.denyAllApprovals() }));

  // Developer builds only: run an MCP tool from the MCP tab as an agent would (same tiers,
  // read-only mode and approval modal). Packaged builds have no way for the window to call tools.
  if (!app.isPackaged) {
    ipcMain.handle('studio:dev-run-mcp-tool', async (_e, toolName: string, args?: Record<string, unknown>) =>
      webringMcpServer.executeToolCall(String(toolName), args && typeof args === 'object' ? args : {}, {
        enforcePolicy: true,
      })
    );
  }
}

