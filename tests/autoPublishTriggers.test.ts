import { describe, it, expect } from 'vitest';
import {
  autoPublishTriggerForReason,
  defaultPersonaSchedule,
  normalizeAutoPublish,
  type PersonaSchedule,
  type SchedulerConfig,
} from '../electron/services/scheduler';
import { AutoPublisher } from '../electron/services/autoPublisher';

describe('Auto-Publish per-category triggers', () => {
  it('maps every local change reason to its Settings -> Advanced trigger category', () => {
    expect(autoPublishTriggerForReason('post')).toBe('posts');
    expect(autoPublishTriggerForReason('comment')).toBe('posts');
    expect(autoPublishTriggerForReason('deleted item')).toBe('posts');
    expect(autoPublishTriggerForReason('like')).toBe('likesShares');
    expect(autoPublishTriggerForReason('share')).toBe('likesShares');
    expect(autoPublishTriggerForReason('recommendation')).toBe('likesShares');
    expect(autoPublishTriggerForReason('friend')).toBe('friendsWebrings');
    expect(autoPublishTriggerForReason('webring')).toBe('friendsWebrings');
    expect(autoPublishTriggerForReason('album')).toBe('media');
    expect(autoPublishTriggerForReason('photo')).toBe('media');
    expect(autoPublishTriggerForReason('photos')).toBe('media');
    expect(autoPublishTriggerForReason('profile')).toBe('profile');
  });

  it('defaults all triggers to true for backward compatibility with existing configs', () => {
    const normalized = normalizeAutoPublish({ enabled: true, delaySeconds: 120 });
    expect(normalized.triggers).toEqual({
      posts: true,
      likesShares: true,
      friendsWebrings: true,
      media: true,
      profile: true,
    });
  });

  it('arms AutoPublisher only for enabled trigger categories', () => {
    const schedule: PersonaSchedule = {
      ...defaultPersonaSchedule(),
      autoPublish: normalizeAutoPublish({
        enabled: true,
        delaySeconds: 30,
        triggers: {
          posts: true,
          likesShares: false,
          friendsWebrings: false,
          media: false,
          profile: true,
        },
      }),
    };
    const config: SchedulerConfig = {
      runInBackground: true,
      startAtLogin: false,
      paused: false,
      notifyOnFailure: true,
      personas: { default: schedule },
      history: [],
    };
    const publisher = new AutoPublisher({
      scheduler: {
        loadConfig: () => config,
        getPersonaSchedule: () => schedule,
        runExclusive: async (_id, fn) => fn(),
        recordHistory: () => {},
      },
      publish: async () => ({ status: 'ok', at: new Date().toISOString(), message: 'ok' }),
      listPersonaIds: () => ['default'],
      hasUnpublishedChanges: async () => false,
    });

    // Disabled categories return null and do not arm
    expect(publisher.noteLocalChange('default', 'like')).toBeNull();
    expect(publisher.noteLocalChange('default', 'friend')).toBeNull();
    expect(publisher.noteLocalChange('default', 'photo')).toBeNull();
    expect(publisher.status('default').state).toBe('idle');

    // Enabled categories arm the pending publish
    const armedPost = publisher.noteLocalChange('default', 'post');
    expect(armedPost?.state).toBe('pending');
    expect(armedPost?.reasons).toContain('post');

    const armedProfile = publisher.noteLocalChange('default', 'profile');
    expect(armedProfile?.reasons).toContain('profile');

    publisher.dispose();
  });
});
