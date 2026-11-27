import React from 'react';
import {
  FileText,
  Heart,
  Image as ImageIcon,
  Send,
  Sliders,
  UserCircle,
  Users,
  Zap,
} from 'lucide-react';

export interface AutoPublishTriggersView {
  posts: boolean;
  likesShares: boolean;
  friendsWebrings: boolean;
  media: boolean;
  profile: boolean;
}

export interface AutoPublishSettingsData {
  enabled: boolean;
  delaySeconds: 30 | 120 | 600 | 3600;
  triggers?: AutoPublishTriggersView;
}

export interface AutoPublishStatusData {
  state: 'idle' | 'pending' | 'running';
  dueAt: string | null;
  reasons: string[];
  lastResult: { status: string; message: string; at?: string } | null;
}

export interface AdvancedSettingsViewProps {
  personaLabel: string;
  destination: 'local' | 'github' | 'remote';
  autoPublish: AutoPublishSettingsData;
  autoPublishStatus: AutoPublishStatusData | null;
  paused: boolean;
  onUpdateAutoPublish: (patch: {
    enabled?: boolean;
    delaySeconds?: 30 | 120 | 600 | 3600;
    triggers?: Partial<AutoPublishTriggersView>;
  }) => void;
  onUpdateDestination: (destination: 'local' | 'github' | 'remote') => void;
  onPublishNow: () => void;
  onCancelPending: () => void;
  onOpenPublishSettings: () => void;
}

const DELAYS: Array<{ seconds: 30 | 120 | 600 | 3600; label: string }> = [
  { seconds: 30, label: '30 seconds' },
  { seconds: 120, label: '2 minutes' },
  { seconds: 600, label: '10 minutes' },
  { seconds: 3600, label: '1 hour' },
];

const DEFAULT_TRIGGERS: AutoPublishTriggersView = {
  posts: true,
  likesShares: true,
  friendsWebrings: true,
  media: true,
  profile: true,
};

const TRIGGER_ITEMS: Array<{
  key: keyof AutoPublishTriggersView;
  label: string;
  description: string;
  icon: React.ReactNode;
}> = [
  {
    key: 'posts',
    label: 'Post Publishing',
    description:
      'Auto-export and publish your site (and notify connected Webring Hubs) whenever you create, edit, or delete wall posts or comments.',
    icon: <FileText className="w-4 h-4 text-emerald-400 shrink-0" />,
  },
  {
    key: 'likesShares',
    label: 'Likes & Shares',
    description:
      'Auto-export and publish when you like, share, or recommend links (including Community Library picks).',
    icon: <Heart className="w-4 h-4 text-pink-400 shrink-0" />,
  },
  {
    key: 'friendsWebrings',
    label: 'Adding / Updating Friends or Webrings',
    description:
      'Auto-export and publish when you add or edit friends, change friend visibility, or join/leave a webring.',
    icon: <Users className="w-4 h-4 text-sky-400 shrink-0" />,
  },
  {
    key: 'media',
    label: 'Adding / Updating Media Libraries',
    description:
      'Auto-export and publish when you create or edit photo albums, import new photos, or update captions.',
    icon: <ImageIcon className="w-4 h-4 text-amber-400 shrink-0" />,
  },
  {
    key: 'profile',
    label: 'Updating Profile Details',
    description:
      'Auto-export and publish when you update your display name, bio, Now status, avatar/banner, theme, or profile links.',
    icon: <UserCircle className="w-4 h-4 text-indigo-400 shrink-0" />,
  },
];

export const AdvancedSettingsView: React.FC<AdvancedSettingsViewProps> = ({
  personaLabel,
  destination,
  autoPublish,
  autoPublishStatus,
  paused,
  onUpdateAutoPublish,
  onUpdateDestination,
  onPublishNow,
  onCancelPending,
  onOpenPublishSettings,
}) => {
  const triggers: AutoPublishTriggersView = {
    ...DEFAULT_TRIGGERS,
    ...(autoPublish.triggers || {}),
  };

  const enabledCount = Object.values(triggers).filter(Boolean).length;

  const handleToggleTrigger = (key: keyof AutoPublishTriggersView, checked: boolean) => {
    if (checked && !autoPublish.enabled) {
      // Turning on a specific category while master auto-publish is off enables auto-publish
      // with only that category checked (plus any already checked if user wants to add more).
      onUpdateAutoPublish({
        enabled: true,
        triggers: { ...triggers, [key]: true },
      });
      return;
    }
    onUpdateAutoPublish({
      triggers: { [key]: checked },
    });
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12">
      <div>
        <h2 className="text-2xl font-bold flex items-center gap-2.5 text-white">
          <Sliders className="w-6 h-6 text-indigo-400" />
          Advanced Settings
        </h2>
        <p className="text-sm text-slate-400 mt-1">
          Configure automatic site export, publishing, and Webring Hub push behavior for{' '}
          <span className="text-slate-200 font-medium">{personaLabel}</span>.
        </p>
      </div>

      {/* Auto-Publishing & Push Content */}
      <section className="rounded-2xl bg-slate-900 border border-slate-800 p-6 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-400" />
              Automatic Export &amp; Publishing
            </h3>
            <p className="text-xs text-slate-400 max-w-2xl">
              When enabled, Webring Studio automatically exports your static site, publishes it to your
              chosen destination, and sends signed webhook pings to your connected Webring Hubs after
              the actions you choose below.
            </p>
          </div>
          <label className="inline-flex items-center gap-2.5 px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoPublish.enabled}
              onChange={(e) => onUpdateAutoPublish({ enabled: e.target.checked })}
              className="accent-indigo-500 w-4 h-4"
            />
            <span className="text-xs font-semibold text-white">
              {autoPublish.enabled ? 'Auto-Publish On' : 'Auto-Publish Off'}
            </span>
          </label>
        </div>

        {paused && (
          <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 px-4 py-2.5 text-xs text-amber-200">
            Background schedules are currently paused in <strong>Publish → Schedule</strong>. Resume
            schedules for auto-publishing to run automatically.
          </div>
        )}

        {/* Destination & Delay controls */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4 rounded-xl bg-slate-950 border border-slate-800">
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-slate-400 font-semibold mb-1.5">
              Publish Destination
            </label>
            <select
              value={destination}
              onChange={(e) => onUpdateDestination(e.target.value as 'local' | 'github' | 'remote')}
              className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-xs text-slate-100"
            >
              <option value="local">Local Export Folder</option>
              <option value="github">GitHub Pages</option>
              <option value="remote">SFTP / FTP Host</option>
            </select>
          </div>
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-slate-400 font-semibold mb-1.5">
              Wait Before Publishing
            </label>
            <select
              value={autoPublish.delaySeconds}
              onChange={(e) =>
                onUpdateAutoPublish({
                  delaySeconds: Number(e.target.value) as AutoPublishSettingsData['delaySeconds'],
                })
              }
              className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-xs text-slate-100"
            >
              {DELAYS.map((d) => (
                <option key={d.seconds} value={d.seconds}>
                  {d.label} (batches rapid edits together)
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Per-Activity Auto-Publish Triggers */}
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <h4 className="text-xs uppercase tracking-wider font-semibold text-slate-400">
              Trigger Auto-Publish On ({enabledCount} of {TRIGGER_ITEMS.length} enabled)
            </h4>
            <div className="flex items-center gap-2 text-[11px]">
              <button
                type="button"
                onClick={() =>
                  onUpdateAutoPublish({
                    enabled: true,
                    triggers: {
                      posts: true,
                      likesShares: true,
                      friendsWebrings: true,
                      media: true,
                      profile: true,
                    },
                  })
                }
                className="text-indigo-300 hover:underline"
              >
                Enable all
              </button>
              <span className="text-slate-600">·</span>
              <button
                type="button"
                onClick={() =>
                  onUpdateAutoPublish({
                    triggers: {
                      posts: false,
                      likesShares: false,
                      friendsWebrings: false,
                      media: false,
                      profile: false,
                    },
                  })
                }
                className="text-slate-400 hover:text-slate-200 hover:underline"
              >
                Disable all
              </button>
            </div>
          </div>

          <div className="divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-950 overflow-hidden">
            {TRIGGER_ITEMS.map((item) => {
              const isChecked = autoPublish.enabled && triggers[item.key];
              return (
                <label
                  key={item.key}
                  className="flex items-start gap-3 p-3.5 hover:bg-slate-900/60 transition cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={(e) => handleToggleTrigger(item.key, e.target.checked)}
                    className="mt-0.5 accent-indigo-500 w-4 h-4 shrink-0"
                  />
                  <div className="mt-0.5">{item.icon}</div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-slate-100">{item.label}</div>
                    <p className="text-xs text-slate-400 mt-0.5">{item.description}</p>
                  </div>
                </label>
              );
            })}
          </div>
        </div>

        {/* Live Status & Manual Actions */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-800 text-xs">
          <div className="text-slate-400">
            {autoPublishStatus?.state === 'running' ? (
              <span className="text-indigo-300 font-medium">Publishing changes now…</span>
            ) : autoPublishStatus?.state === 'pending' ? (
              <span className="text-amber-300 font-medium">
                Pending publish ({autoPublishStatus.reasons.join(', ') || 'local changes'})
              </span>
            ) : autoPublishStatus?.lastResult ? (
              <span
                className={
                  autoPublishStatus.lastResult.status === 'failed'
                    ? 'text-rose-300'
                    : 'text-slate-400'
                }
              >
                Last run: {autoPublishStatus.lastResult.message}
              </span>
            ) : (
              <span>No pending auto-publish jobs.</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {autoPublishStatus?.state === 'pending' && (
              <>
                <button
                  type="button"
                  onClick={onPublishNow}
                  className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-semibold inline-flex items-center gap-1.5"
                >
                  <Send className="w-3.5 h-3.5" />
                  Publish now
                </button>
                <button
                  type="button"
                  onClick={onCancelPending}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200"
                >
                  Cancel
                </button>
              </>
            )}
            <button
              type="button"
              onClick={onOpenPublishSettings}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200"
            >
              Configure Publish Targets →
            </button>
          </div>
        </div>
      </section>
    </div>
  );
};
