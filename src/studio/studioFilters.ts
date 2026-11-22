import type { EndorsementItem, SharedItem, SharedItemType } from '../shared/schema';

export type ItemFilterType = 'all' | SharedItemType;

/**
 * Filters Posts, Likes, Shares, Recommendations & Comments by type and keyword search,
 * returning them in reverse-chronological order (newest first).
 */
export function filterAndSortItems(
  items: SharedItem[],
  filterType: ItemFilterType,
  searchQuery: string
): SharedItem[] {
  const q = searchQuery.trim().toLowerCase();
  const filtered = items.filter((item) => {
    if (filterType !== 'all' && item.type !== filterType) {
      return false;
    }
    if (!q) return true;
    const haystack = [
      item.title,
      item.commentary,
      item.targetUrl,
      item.category,
      ...(item.tags || []),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });

  return [...filtered].sort((a, b) => {
    const ta = Date.parse(a.createdAt || '') || 0;
    const tb = Date.parse(b.createdAt || '') || 0;
    return tb - ta;
  });
}

function normalizeBase(url: string): string {
  return String(url || '').trim().replace(/\/+$/, '');
}

/**
 * Counts discovered likes & shares targeting an album's canonical page URL or any of its photos.
 */
export function albumEngagementCounts(
  album: { id: string; pageUrl?: string; photos: Array<{ id: string; url: string }> },
  siteUrl: string,
  endorsements: EndorsementItem[]
): { likes: number; shares: number } {
  const base = normalizeBase(siteUrl);
  const targets = new Set<string>();
  if (album.pageUrl) {
    targets.add(album.pageUrl);
    if (base) targets.add(`${base}/${album.pageUrl.replace(/^\/+/, '')}`);
  }
  if (base) {
    targets.add(`${base}/api/albums.json#${album.id}`);
  }
  for (const p of album.photos) {
    if (p.url) {
      targets.add(p.url);
      if (base && !/^https?:\/\//i.test(p.url)) {
        targets.add(`${base}/${p.url.replace(/^\/+/, '')}`);
      }
    }
    if (base) targets.add(`${base}/api/albums.json#${p.id}`);
  }

  let likes = 0;
  let shares = 0;
  for (const e of endorsements) {
    if (!targets.has(e.targetCanonicalUrl)) continue;
    if (e.type === 'like') likes++;
    else if (e.type === 'share') shares++;
  }
  return { likes, shares };
}

/**
 * Counts discovered likes & shares targeting an individual photo.
 */
export function photoEngagementCounts(
  photo: { id: string; url: string },
  siteUrl: string,
  endorsements: EndorsementItem[]
): { likes: number; shares: number } {
  const base = normalizeBase(siteUrl);
  const targets = new Set<string>();
  if (photo.url) {
    targets.add(photo.url);
    if (base && !/^https?:\/\//i.test(photo.url)) {
      targets.add(`${base}/${photo.url.replace(/^\/+/, '')}`);
    }
  }
  if (base) targets.add(`${base}/api/albums.json#${photo.id}`);

  let likes = 0;
  let shares = 0;
  for (const e of endorsements) {
    if (!targets.has(e.targetCanonicalUrl)) continue;
    if (e.type === 'like') likes++;
    else if (e.type === 'share') shares++;
  }
  return { likes, shares };
}
