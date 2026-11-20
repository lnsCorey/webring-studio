import { describe, expect, it } from 'vitest';
import { ringsForHubSearch } from '../src/studio/WebringHubPanels';

const ME = 'https://me.example';

describe('ringsForHubSearch (webring tags and filter for hub search results)', () => {
  it('uses every member of an active hosted ring, and the rotation of a joined ring', () => {
    const rings = ringsForHubSearch(
      [
        {
          id: 'joined-1',
          name: 'Zine Ring',
          status: 'member',
          prevSiteUrl: 'https://prev.example/',
          nextSiteUrl: 'https://next.example',
          rotationUrls: ['https://prev.example', 'https://next.example', 'https://other.example'],
        },
      ],
      [
        {
          id: 'hosted-1',
          name: 'Art Ring',
          status: 'active',
          maintainerIsMember: true,
          members: [{ siteUrl: 'https://alice.example' }, { siteUrl: 'bob.example/' }],
        },
      ],
      ME
    );
    expect(rings.map((r) => r.name)).toEqual(['Art Ring', 'Zine Ring']);
    const [art, zine] = rings;
    // Addresses are normalized the same way search results are
    expect([...art.memberUrls].sort()).toEqual(['https://alice.example', 'https://bob.example', ME]);
    expect([...zine.memberUrls].sort()).toEqual([
      ME,
      'https://next.example',
      'https://other.example',
      'https://prev.example',
    ]);
  });

  it('leaves out rings the persona is not in', () => {
    const rings = ringsForHubSearch(
      [
        { id: 'a', name: 'Requested', status: 'requested', rotationUrls: ['https://x.example'] },
        { id: 'b', name: 'Removed', status: 'removed' },
      ],
      [{ id: 'c', name: 'Closed', status: 'closed', maintainerIsMember: true, members: [{ siteUrl: 'https://y.example' }] }],
      ME
    );
    expect(rings).toEqual([]);
  });

  it("doesn't tag the persona's own site in a hosted ring it isn't a member of", () => {
    const [ring] = ringsForHubSearch(
      [],
      [{ id: 'h', name: 'Hosted', status: 'active', maintainerIsMember: false, members: [{ siteUrl: 'https://a.example' }] }],
      ME
    );
    expect(ring.memberUrls.has(ME)).toBe(false);
    expect(ring.memberUrls.has('https://a.example')).toBe(true);
  });
});
