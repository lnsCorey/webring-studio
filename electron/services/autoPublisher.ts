import {
  autoPublishTriggerForReason,
  type JobResult,
  type PersonaSchedule,
  type PublishDestination,
  type SchedulerConfig,
} from './scheduler';

/**
 * Auto-publish: a short while after a local change (a post, like, share, photo import, new friend
 * or ring), sync and publish the persona's site so the change reaches friends without a manual
 * Publish. Federation stays pull-only: nothing is pushed to peers, friends still see the change
 * at their next sync.
 *
 * The first change starts a timer for the persona's delay; later changes join the same pending
 * publish without resetting it, so a steady trickle of likes can't postpone it forever. A change
 * that arrives while a publish is running starts one more pending publish after it.
 */

export type AutoPublishState = 'idle' | 'pending' | 'running';

export interface AutoPublishStatus {
  state: AutoPublishState;
  /** When the pending publish runs (ISO), while pending. */
  dueAt: string | null;
  /** What changed since the last publish, e.g. "post", "friend" (local only, for the UI). */
  reasons: string[];
  /**
   * True while an agent's changes wait for the user's review: nothing publishes them (auto,
   * scheduled or an agent's publish) until they're released. Survives a restart (stored in the
   * persona as agent_changes_held).
   */
  agentHeld?: boolean;
  lastResult: JobResult | null;
}

export interface AutoPublisherScheduler {
  loadConfig(): SchedulerConfig;
  getPersonaSchedule(personaId: string): PersonaSchedule;
  runExclusive<T>(personaId: string, fn: () => Promise<T>): Promise<T>;
  recordHistory(personaId: string, job: 'publish', result: JobResult): void;
}

export interface AutoPublisherOptions {
  scheduler: AutoPublisherScheduler;
  /** Sync first, then publish if the site changed (runScheduledPublish in the app). Runs under the lock. */
  publish: (personaId: string, destination: PublishDestination) => Promise<JobResult>;
  /** Persona ids that exist, for resuming pending publishes at start-up. */
  listPersonaIds: () => string[];
  /** True when the persona has local changes that haven't been published yet. */
  hasUnpublishedChanges: (personaId: string) => Promise<boolean>;
  /** Quiet period after the last change before firing (default 10s). */
  quietPeriodSeconds?: number;
  /** Maximum extension beyond firstChange + delaySeconds (default 60s). */
  maxExtensionSeconds?: number;
  now?: () => Date;
  onStatusChange?: (personaId: string, status: AutoPublishStatus) => void;
  onBeforePublish?: (personaId: string, status: AutoPublishStatus) => void;
  /** A countdown started: the site publishes in `seconds` unless the user cancels. */
  onArmed?: (personaId: string, seconds: number, status: AutoPublishStatus) => void;
  /** How many agent changes the persona has held (its stored hold), read on refresh(). */
  loadAgentHold?: (personaId: string) => Promise<number>;
  /** Clears the persona's stored hold, when the user releases it. */
  clearAgentHold?: (personaId: string) => Promise<void>;
  onFinished?: (personaId: string, result: JobResult) => void;
}

interface Entry {
  state: AutoPublishState;
  dueAt: number | null;
  firstChangeAt: number | null;
  lastChangeAt: number | null;
  timer: NodeJS.Timeout | null;
  reasons: Set<string>;
  agentHeld: boolean;
  /** A change arrived during the running publish */
  rerun: boolean;
  lastResult: JobResult | null;
  running: Promise<JobResult> | null;
}

export class AutoPublisher {
  private entries = new Map<string, Entry>();

  constructor(private options: AutoPublisherOptions) {}

  private now(): number {
    return (this.options.now ? this.options.now() : new Date()).getTime();
  }

  private entry(personaId: string): Entry {
    let entry = this.entries.get(personaId);
    if (!entry) {
      entry = {
        state: 'idle',
        dueAt: null,
        firstChangeAt: null,
        lastChangeAt: null,
        timer: null,
        reasons: new Set(),
        agentHeld: false,
        rerun: false,
        lastResult: null,
        running: null,
      };
      this.entries.set(personaId, entry);
    }
    return entry;
  }

  /** The persona's settings when auto-publish may run now (on, and schedules not paused). */
  private activeSettings(personaId: string): PersonaSchedule['autoPublish'] | null {
    if (this.options.scheduler.loadConfig().paused) return null;
    const settings = this.options.scheduler.getPersonaSchedule(personaId).autoPublish;
    return settings?.enabled ? settings : null;
  }

  public status(personaId: string): AutoPublishStatus {
    const entry = this.entries.get(personaId);
    if (!entry) return { state: 'idle', dueAt: null, reasons: [], agentHeld: false, lastResult: null };
    return {
      state: entry.state,
      dueAt: entry.state === 'pending' && entry.dueAt !== null ? new Date(entry.dueAt).toISOString() : null,
      reasons: [...entry.reasons],
      agentHeld: entry.agentHeld,
      lastResult: entry.lastResult,
    };
  }

  private emit(personaId: string): void {
    this.options.onStatusChange?.(personaId, this.status(personaId));
  }

  private arm(personaId: string, entry: Entry, delaySeconds: number): void {
    if (entry.timer) clearTimeout(entry.timer);
    const now = this.now();
    entry.firstChangeAt = entry.firstChangeAt ?? now;
    entry.lastChangeAt = entry.lastChangeAt ?? now;
    const quietMs = (this.options.quietPeriodSeconds ?? 10) * 1000;
    const maxExtMs = (this.options.maxExtensionSeconds ?? 60) * 1000;
    const baseDue = entry.firstChangeAt + delaySeconds * 1000;
    const quietDue = entry.lastChangeAt + quietMs;
    const targetDue = Math.min(baseDue + maxExtMs, Math.max(baseDue, quietDue));
    const waitMs = Math.max(0, targetDue - now);
    entry.state = 'pending';
    entry.dueAt = targetDue;
    entry.timer = setTimeout(() => void this.fire(personaId, false), waitMs);
    entry.timer.unref?.();
    try {
      this.options.onArmed?.(personaId, Math.round(waitMs / 1000), this.status(personaId));
    } catch {
      // A notification is best-effort
    }
  }

  /**
   * Records a local change. Returns the status when an auto-publish is (or stays) pending, or
   * null when auto-publish is off or paused for this persona.
   * Changes marked `fromAgent: true` hold auto-publish until a human approves or publishes manually.
   */
  public noteLocalChange(
    personaId: string,
    reason: string,
    options?: { fromAgent?: boolean }
  ): AutoPublishStatus | null {
    const entry = this.entry(personaId);
    if (options?.fromAgent) {
      entry.agentHeld = true;
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      if (entry.state === 'pending') {
        entry.state = 'idle';
        entry.dueAt = null;
      }
    }
    const settings = this.activeSettings(personaId);
    if (!settings) {
      if (options?.fromAgent) {
        entry.reasons.add(reason);
        this.emit(personaId);
      }
      return null;
    }
    if (!options?.fromAgent) {
      const triggerKey = autoPublishTriggerForReason(reason);
      if (triggerKey && settings.triggers && settings.triggers[triggerKey] === false) {
        return null;
      }
    }
    entry.reasons.add(reason);
    const now = this.now();
    entry.firstChangeAt = entry.firstChangeAt ?? now;
    entry.lastChangeAt = now;
    if (entry.agentHeld) {
      this.emit(personaId);
      return this.status(personaId);
    }
    if (entry.state === 'running') {
      entry.rerun = true;
    } else if (entry.state === 'idle' || entry.state === 'pending') {
      this.arm(personaId, entry, settings.delaySeconds);
    }
    this.emit(personaId);
    return this.status(personaId);
  }

  /** Releases an agent-change hold (and its stored copy) and resumes auto-publish if enabled. */
  public approveAgentChanges(personaId: string): AutoPublishStatus {
    const entry = this.entry(personaId);
    entry.agentHeld = false;
    void this.options.clearAgentHold?.(personaId).catch(() => undefined);
    const settings = this.activeSettings(personaId);
    if (settings && entry.state === 'idle' && entry.reasons.size > 0) {
      this.arm(personaId, entry, settings.delaySeconds);
    }
    this.emit(personaId);
    return this.status(personaId);
  }

  /**
   * Publishes the pending changes now (the "Publish now" button), or waits for a running one.
   * While agent changes are held, it doesn't publish unless the user chose to include them.
   */
  public publishNow(personaId: string, options: { includeAgentChanges?: boolean } = {}): Promise<JobResult> {
    const entry = this.entry(personaId);
    if (entry.agentHeld) {
      if (!options.includeAgentChanges) {
        return Promise.resolve({
          at: new Date(this.now()).toISOString(),
          status: 'held',
          message: 'Agent changes awaiting review',
        });
      }
      this.approveAgentChanges(personaId);
    }
    if (entry.state === 'running' && entry.running) return entry.running;
    return this.fire(personaId, true);
  }

  /** Drops a pending auto-publish; the changes stay unpublished until the next publish. */
  public cancel(personaId: string): void {
    const entry = this.entries.get(personaId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    entry.rerun = false;
    // Cancelling a countdown doesn't release held agent changes
    if (entry.state === 'pending') {
      entry.state = 'idle';
      entry.dueAt = null;
      entry.reasons.clear();
    }
    this.emit(personaId);
  }

  /**
   * Re-reads settings after they change, at start-up or when schedules resume: cancels pending
   * publishes that are no longer allowed and starts one for any persona with unpublished changes.
   */
  public async refresh(personaIds: string[] = this.options.listPersonaIds()): Promise<void> {
    for (const personaId of personaIds) {
      // The stored hold (agent changes not yet reviewed) comes back after a restart
      if (this.options.loadAgentHold) {
        try {
          const held = (await this.options.loadAgentHold(personaId)) > 0;
          const entry = this.entry(personaId);
          if (entry.agentHeld !== held) {
            entry.agentHeld = held;
            this.emit(personaId);
          }
        } catch {
          // A persona that can't be opened is left alone
        }
      }
      const settings = this.activeSettings(personaId);
      const entry = this.entries.get(personaId);
      if (!settings) {
        if (entry?.state === 'pending') this.cancel(personaId);
        continue;
      }
      if (entry && entry.state !== 'idle') continue;
      let unpublished = false;
      try {
        unpublished = await this.options.hasUnpublishedChanges(personaId);
      } catch {
        // A persona that can't be opened is left alone
      }
      // A change may have started a pending publish while we were checking
      const current = this.entry(personaId);
      if (unpublished && current.state === 'idle') {
        current.reasons.add('unpublished changes');
        this.arm(personaId, current, settings.delaySeconds);
        this.emit(personaId);
      }
    }
  }

  private fire(personaId: string, force: boolean): Promise<JobResult> {
    const entry = this.entry(personaId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    if (!force && (!this.activeSettings(personaId) || entry.agentHeld)) {
      // Turned off, paused, or held pending human review of agent changes
      if (entry.agentHeld) {
        this.emit(personaId);
        return Promise.resolve({
          at: new Date(this.now()).toISOString(),
          status: 'held',
          message: 'Agent changes awaiting review',
        });
      }
      entry.state = 'idle';
      entry.dueAt = null;
      entry.reasons.clear();
      this.emit(personaId);
      return Promise.resolve({ at: new Date(this.now()).toISOString(), status: 'skipped', message: 'Auto-publish is off.' });
    }
    entry.state = 'running';
    entry.dueAt = null;
    entry.firstChangeAt = null;
    entry.lastChangeAt = null;
    this.options.onBeforePublish?.(personaId, this.status(personaId));
    entry.reasons.clear();
    entry.rerun = false;
    this.emit(personaId);

    const run = (async (): Promise<JobResult> => {
      let result: JobResult;
      try {
        const destination = this.options.scheduler.getPersonaSchedule(personaId).publish.destination;
        result = await this.options.scheduler.runExclusive(personaId, () => this.options.publish(personaId, destination));
      } catch (err) {
        result = {
          at: new Date(this.now()).toISOString(),
          status: 'failed',
          message: err instanceof Error ? err.message : String(err),
        };
      }
      const labelled = { ...result, message: `Auto-publish: ${result.message}` };
      try {
        this.options.scheduler.recordHistory(personaId, 'publish', labelled);
      } catch {
        // History is best-effort
      }
      entry.lastResult = labelled;
      entry.running = null;
      entry.state = 'idle';
      if (entry.rerun) {
        entry.rerun = false;
        const settings = this.activeSettings(personaId);
        if (settings) this.arm(personaId, entry, settings.delaySeconds);
        else entry.reasons.clear();
      }
      this.emit(personaId);
      this.options.onFinished?.(personaId, labelled);
      return labelled;
    })();
    entry.running = run;
    return run;
  }

  /** Clears every timer (app quit). Pending changes are picked up again by refresh() next launch. */
  public dispose(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
    }
  }
}
