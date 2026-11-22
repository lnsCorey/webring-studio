import { describe, it, expect } from 'vitest';
import {
  filterAndSortItems,
  albumEngagementCounts,
  photoEngagementCounts,
} from '../src/studio/studioFilters';
import type { EndorsementItem, SharedItem } from '../src/shared/schema';

const sampleItems: SharedItem[] = [
  {
    id: '1',
    type: 'post',
    category: 'status',
    title: 'Hello IndieWeb',
    targetUrl: 'https://alice.example/posts/1',
    canonicalUrl: 'https://alice.example/api/items.json#1',
    commentary: 'Building a new retro platformer.',
    mediaUrl: '',
    tags: ['gamedev', 'retro'],
    createdAt: '2026-11-20T10:00:00Z',
  },
  {
    id: '2',
    type: 'like',
    category: 'article',
    title: 'Great Synth Essay',
    targetUrl: 'https://bob.example/synth',
    canonicalUrl: 'https://alice.example/api/items.json#2',
    commentary: 'Loved the FM synthesis walkthrough.',
    mediaUrl: '',
    tags: ['music'],
    createdAt: '2026-11-21T15:00:00Z',
  },
  {
    id: '3',
    type: 'share',
    category: 'general',
    title: 'Webring Manifesto',
    targetUrl: 'https://carol.example/manifesto',
    canonicalUrl: 'https://alice.example/api/items.json#3',
    commentary: 'Sharing with the neighborhood.',
    mediaUrl: '',
    tags: ['indieweb'],
    createdAt: '2026-11-21T12:00:00Z',
  },
];

describe('filterAndSortItems', () => {
  it('sorts chronologically newest-first', () => {
    const out = filterAndSortItems(sampleItems, 'all', '');
    expect(out.map((i) => i.id)).toEqual(['2', '3', '1']);
  });

  it('filters by item type', () => {
    expect(filterAndSortItems(sampleItems, 'like', '').map((i) => i.id)).toEqual(['2']);
    expect(filterAndSortItems(sampleItems, 'share', '').map((i) => i.id)).toEqual(['3']);
    expect(filterAndSortItems(sampleItems, 'post', '').map((i) => i.id)).toEqual(['1']);
  });

  it('searches across title, commentary, and tags', () => {
    expect(filterAndSortItems(sampleItems, 'all', 'FM synthesis').map((i) => i.id)).toEqual(['2']);
    expect(filterAndSortItems(sampleItems, 'all', 'gamedev').map((i) => i.id)).toEqual(['1']);
    expect(filterAndSortItems(sampleItems, 'all', 'indieweb').map((i) => i.id)).toEqual(['3', '1']);
  });
});

describe('album & photo engagement counts', () => {
  const endorsements: EndorsementItem[] = [
    {
      id: 'e1',
      type: 'like',
      targetCanonicalUrl: 'https://alice.example/albums/trip.html',
      authorName: 'Bob',
      authorSiteUrl: 'https://bob.example',
      authorAvatarUrl: '',
      sourceItemUrl: 'https://bob.example/api/items.json#1',
      verifiedSignature: true,
      commentary: '',
      createdAt: '2026-11-21T00:00:00Z',
    },
    {
      id: 'e2',
      type: 'share',
      targetCanonicalUrl: 'https://alice.example/media/p1.jpg',
      authorName: 'Carol',
      authorSiteUrl: 'https://carol.example',
      authorAvatarUrl: '',
      sourceItemUrl: 'https://carol.example/api/items.json#2',
      verifiedSignature: true,
      commentary: '',
      createdAt: '2026-11-21T01:00:00Z',
    },
  ];

  it('aggregates likes and shares for album and individual photo', () => {
    const album = {
      id: 'alb-1',
      pageUrl: 'albums/trip.html',
      photos: [{ id: 'p1', url: 'media/p1.jpg' }],
    };
    expect(albumEngagementCounts(album, 'https://alice.example', endorsements)).toEqual({
      likes: 1,
      shares: 1,
    });
    expect(photoEngagementCounts(album.photos[0], 'https://alice.example', endorsements)).toEqual({
      likes: 0,
      shares: 1,
    });
  });
});
