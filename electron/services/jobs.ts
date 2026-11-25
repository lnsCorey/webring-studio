import * as fs from 'fs';
import { requireUsableProxy } from '../security/proxyAgent';
import * as path from 'path';
import { ActivePersonaContext } from './personaManager';
import { PublishResult } from './publisher';
import { CrawlSiteResult } from './ringCrawler';
import { WebringHubPingResult } from './webringHubService';
import { HostedRingSyncResult, JoinedRingSyncResult } from './ringService';
import { JobResult, PublishDestination } from './scheduler';

/**
 * Sync All and publishing for one persona context, shared by the Studio buttons, the MCP tools
 * and the scheduler so they all behave the same.
 */

export interface SyncAllResult {
  friends: CrawlSiteResult[];
  rings: { joined: JoinedRingSyncResult[]; hosted: HostedRingSyncResult[] };
  /** Webring Hub pings that were waiting for the live site to show the last publish. */
  webringHubs: WebringHubPingResult[];
}

export async function runSyncAll(ctx: ActivePersonaContext): Promise<SyncAllResult> {
  // A proxy that can't be unlocked stops the whole run with one ProxyUnavailableError, before
  // any friend, ring or hub is contacted
  requireUsableProxy(ctx.db.getProxySettings());
  const friends = await ctx.ringCrawler.crawlAllFriends();
  const joined = await ctx.ringService.syncJoinedRings();
  const hosted = await ctx.ringService.syncHostedRings();
  const webringHubs = await notifyWebringHubs(ctx);
  return { friends, rings: { joined, hosted }, webringHubs };
}

/**
 * Asks the Webring Hubs this site is listed in to re-read it, once the live site shows the last
 * publish (GitHub Pages can take minutes). Best effort: never throws, never fails a job.
 */
export async function notifyWebringHubs(ctx: ActivePersonaContext): Promise<WebringHubPingResult[]> {
  try {
    return await ctx.webringHubService.flushPendingPings();
  } catch {
    return [];
  }
}

export function summarizeSync(result: SyncAllResult): JobResult {
  const failedFriends = result.friends.filter((r) => !r.success && !r.blocked && !r.deferred).length;
  const deferredFriends = result.friends.filter((r) => r.deferred).length;
  const friendsWithProblems = result.friends.filter((r) => r.success && r.documentErrors?.length).length;
  const ringErrors = result.rings.joined.filter((r) => r.outcome === 'error').length;
  const parts = [`${result.friends.filter((r) => r.success).length}/${result.friends.length} friends synced`];
  if (result.rings.joined.length) parts.push(`${result.rings.joined.length} joined ring(s) checked`);
  const leavers = result.rings.hosted.reduce((acc, r) => acc + r.autoRemoved.length, 0);
  if (leavers) parts.push(`${leavers} member(s) left your rings`);
  if (friendsWithProblems) parts.push(`${friendsWithProblems} with sync problems`);
  const rollbacks = result.friends.reduce((acc, r) => acc + (r.rollbacksBlocked || 0), 0);
  if (rollbacks) parts.push(`${rollbacks} rollback(s) blocked`);
  if (failedFriends) parts.push(`${failedFriends} friend site(s) unreachable`);
  if (deferredFriends) parts.push(`${deferredFriends} unreachable lately (skipped for now)`);
  if (ringErrors) parts.push(`${ringErrors} ring(s) couldn't be checked`);
  const pinged = (result.webringHubs || []).filter((d) => d.outcome === 'pinged').length;
  if (pinged) parts.push(`${pinged} Webring Hub listing(s) refreshed`);
  return {
    at: new Date().toISOString(),
    // Some unreachable peers are normal; the job itself still worked
    status: 'ok',
    message: parts.join(', '),
  };
}

export interface PublishPaths {
  userDataDir: string;
  tempDir: string;
}

export function defaultExportPath(ctx: ActivePersonaContext, paths: PublishPaths): string {
  const profile = ctx.db.getProfile();
  const folder = ctx.persona.id === 'default' ? 'exported-profile-site' : `exported-profile-site-${ctx.persona.id}`;
  return profile.publishSettings?.exportPath || path.join(paths.userDataDir, folder);
}

/**
 * Publishes the persona's site to a destination using its saved settings. Refuses (without
 * publishing anything) when the destination isn't set up.
 */
export async function publishTo(
  ctx: ActivePersonaContext,
  destination: PublishDestination,
  paths: PublishPaths,
  overrides?: { targetDir?: string }
): Promise<PublishResult> {
  const result = await publishToDestination(ctx, destination, paths, overrides);
  if (result.success) {
    ctx.webringHubService.markPublished(ctx.db.getPublishedManifestUpdatedAt());
    try {
      await ctx.webringHubService.emitPublishPings();
    } catch {
      // Failed pings or locked proxies never roll back or fail a completed publish.
    }
  }
  return result;
}

async function publishToDestination(
  ctx: ActivePersonaContext,
  destination: PublishDestination,
  paths: PublishPaths,
  overrides?: { targetDir?: string }
): Promise<PublishResult> {
  const masked = ctx.db.getProfile().publishSettings;
  if (destination === 'local') {
    const settings = masked;
    const outDir = overrides?.targetDir || defaultExportPath(ctx, paths);
    const result = ctx.sitePublisher.publishToLocalDirectory(outDir);
    if (result.success && settings.exportPath !== outDir) {
      ctx.db.updateProfile({ publishSettings: { exportPath: outDir } });
    }
    return result;
  }
  // Credentials are decrypted only here, right before connecting
  const settings = ctx.db.withStoredCredentials(masked);
  if (destination === 'remote') {
    if (!settings.host?.trim() || !settings.username?.trim()) {
      return {
        success: false,
        mode: settings.protocol,
        destination: '',
        filesPublished: 0,
        message: 'SFTP/FTP publishing needs a host and username. Set them in the Publish tab.',
      };
    }
    const stagingDir = path.join(paths.tempDir, `webring-studio-staging-${ctx.persona.id}`);
    fs.rmSync(stagingDir, { recursive: true, force: true });
    return ctx.sitePublisher.publishToRemoteHost(settings, stagingDir);
  }
  const stagingDir = path.join(paths.tempDir, `webring-studio-github-staging-${ctx.persona.id}`);
  fs.rmSync(stagingDir, { recursive: true, force: true });
  return ctx.sitePublisher.publishToGitHubPages(settings, stagingDir);
}

/**
 * The scheduled publish: optionally sync first, then publish only if the site would change.
 */
export async function runScheduledPublish(
  ctx: ActivePersonaContext,
  destination: PublishDestination,
  syncFirst: boolean,
  paths: PublishPaths
): Promise<JobResult> {
  // An agent's changes wait for the user's review: no scheduled or automatic publish includes them
  if (ctx.db.getHeldAgentChanges().length > 0) {
    return { at: new Date().toISOString(), status: 'held', message: 'Agent changes awaiting review' };
  }
  if (syncFirst) {
    await runSyncAll(ctx);
  }
  const fingerprint = ctx.siteGenerator.contentFingerprint();
  if (fingerprint === ctx.db.getProfile().publishSettings.lastPublishedFingerprint) {
    return { at: new Date().toISOString(), status: 'skipped', message: 'No changes since the last publish.' };
  }
  const result = await publishTo(ctx, destination, paths);
  return {
    at: new Date().toISOString(),
    status: result.success ? 'ok' : 'failed',
    message: result.message,
  };
}
