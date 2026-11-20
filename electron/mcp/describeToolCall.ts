import type { ActivePersonaContext } from '../services/personaManager';

/**
 * One plain-language sentence for what an agent's tool call would do, shown in the approval modal
 * ("An agent wants to …"), in the review panel and with held changes. Lookups (album titles,
 * friend names, the publish host) use the target persona's own data, so the user sees names, not
 * ids. Every outward tool has its own sentence; tests check that none falls back.
 */
export function describeToolCall(name: string, args: Record<string, unknown>, ctx?: ActivePersonaContext): string {
  const str = (key: string) => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');
  const quoted = (text: string, max = 80) => `“${text.length > max ? `${text.slice(0, max - 1)}…` : text}”`;
  const safe = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };
  const db = ctx?.db;
  const albumTitle = (id: string) => safe(() => db?.getAlbums().find((a) => a.id === id)?.title) || id;
  const friend = (id: string) => safe(() => db?.getFriends().find((f) => f.id === id));
  const item = (id: string) => safe(() => db?.getItems().find((i) => i.id === id));
  const photo = (id: string) =>
    safe(() => db?.getAlbums().flatMap((a) => a.photos.map((p) => ({ ...p, albumTitle: a.title }))).find((p) => p.id === id));
  const publish = safe(() => db?.getProfile().publishSettings);
  const fingerprint = (fp: string) => {
    const clean = fp.replace(/[^0-9a-f]/gi, '').toUpperCase();
    return clean ? `${clean.slice(0, 8)} … ${clean.slice(-8)}` : 'none given';
  };
  const onOff = (value: unknown) => (value === false ? 'off' : 'on');
  const preset = (value: unknown): string => {
    const p = value as { kind?: string; minutes?: number; time?: string; weekday?: number } | undefined;
    if (!p || typeof p !== 'object') return 'on its current schedule';
    if (p.kind === 'interval' && p.minutes) {
      return p.minutes < 60 ? `every ${p.minutes} minutes` : `every ${p.minutes / 60} hour${p.minutes === 60 ? '' : 's'}`;
    }
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    if (p.kind === 'daily') return `every day at ${p.time || '?'}`;
    if (p.kind === 'weekly') return `every ${days[Number(p.weekday)] || 'week'} at ${p.time || '?'}`;
    return 'on a new schedule';
  };
  const destination = (value: string) => {
    if (value === 'github') {
      const repo = publish?.githubOwner && publish?.githubRepo ? ` (${publish.githubOwner}/${publish.githubRepo})` : '';
      return `GitHub Pages${repo}`;
    }
    if (value === 'remote' || value === 'sftp' || value === 'ftp') {
      const proto = (publish?.protocol || 'SFTP').toUpperCase();
      const host = publish?.host ? ` host ${publish.host}` : '';
      const dir = publish?.remotePath ? ` (${publish.remotePath})` : '';
      return `${proto}${host}${dir}`;
    }
    return `your export folder${publish?.exportPath ? ` (${publish.exportPath})` : ''}`;
  };

  switch (name) {
    case 'webring_publish':
      return `Publish your site to ${destination(str('destination') || 'local')}.`;
    case 'webring_export_static_site':
      return `Export your site to your saved export folder${publish?.exportPath ? ` (${publish.exportPath})` : ''}.`;
    case 'webring_run_scheduled_job':
      return str('job') === 'publish' ? 'Run your scheduled publish now.' : 'Run your scheduled sync now.';
    case 'webring_delete_item': {
      const it = item(str('itemId'));
      return `Delete your ${it?.type || 'item'} ${quoted(it?.title || str('itemId'))}.`;
    }
    case 'webring_delete_album':
      return `Delete the album ${quoted(albumTitle(str('albumId')))} and its photos.`;
    case 'webring_delete_photo': {
      const ph = photo(str('photoId'));
      return ph ? `Delete a photo${ph.caption ? ` (${quoted(ph.caption)})` : ''} from album ${quoted(ph.albumTitle)}.` : `Delete photo ${str('photoId')}.`;
    }
    case 'webring_delete_friend': {
      const f = friend(str('friendId'));
      return `Remove your friend ${f ? `${f.displayName} (${f.siteUrl})` : str('friendId')}.`;
    }
    case 'webring_trust_friend_key': {
      const f = friend(str('friendId'));
      return `Trust a new signing key for ${f ? f.siteUrl : str('friendId')} (fingerprint ${fingerprint(str('expectedFingerprint'))}).`;
    }
    case 'webring_rotate_keys':
      return 'Replace your signing key with a new one (friends follow it after your next publish).';
    case 'webring_set_proxy': {
      const url = str('proxyUrl').replace(/\/\/[^@/]*@/, '//***@');
      if (args.enabled === false) return 'Turn off your proxy, so syncing connects directly.';
      return url ? `Route your syncing through the proxy ${url}.` : `Turn your proxy ${onOff(args.enabled)}.`;
    }
    case 'webring_set_schedule': {
      const parts: string[] = [];
      if (args.publishEnabled === false) parts.push('turn off scheduled publishing');
      else if (args.publishEnabled !== undefined || args.publishPreset !== undefined) {
        parts.push(`turn on scheduled publishing ${preset(args.publishPreset)}`);
      }
      if (args.publishDestination !== undefined) parts.push(`publish to ${destination(String(args.publishDestination))}`);
      if (args.autoPublishEnabled === false) parts.push('turn off auto-publish');
      else if (args.autoPublishEnabled !== undefined || args.autoPublishDelaySeconds !== undefined) {
        const delay = Number(args.autoPublishDelaySeconds);
        parts.push(`turn on auto-publish${delay ? ` ${delay} seconds after each change` : ''}`);
      }
      if (args.syncEnabled !== undefined || args.syncPreset !== undefined) {
        parts.push(args.syncEnabled === false ? 'turn off scheduled syncing' : `sync friends ${preset(args.syncPreset)}`);
      }
      if (!parts.length) return 'Change your publishing schedule.';
      const sentence = parts.join(', and ');
      return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
    }
    case 'webring_add_photo': {
      const source = str('urlOrLocalPath');
      return `Add photo ${source} to album ${quoted(albumTitle(str('albumId')))}.`;
    }
    case 'webring_set_profile_image': {
      const kind = args.kind === 'banner' ? 'banner' : 'profile photo';
      if (str('localPath')) return `Set your ${kind} from the file ${str('localPath')}.`;
      return `Change your ${kind}.`;
    }
    case 'webring_update_profile': {
      if (str('siteUrl')) return `Change your profile site URL to ${str('siteUrl')} (this changes your identity, did:web).`;
      const fields = Object.keys(args).filter((k) => k !== 'personaId');
      return fields.length ? `Change your profile (${fields.join(', ')}).` : 'Change your profile.';
    }
    case 'webring_configure_analytics_addon':
      return args.enabled === false || args.clear === true
        ? 'Turn off Google Analytics on your published site.'
        : `Add Google Analytics${str('measurementId') ? ` (${str('measurementId')})` : ''} to your published site.`;
    case 'webring_configure_ads_addon':
      return args.enabled === false || args.clear === true
        ? 'Turn off Google AdSense on your published site.'
        : `Add Google AdSense ads${str('publisherId') ? ` (${str('publisherId')})` : ''} to your published site.`;
    case 'webring_github_login_start':
      return 'Start signing in to GitHub, so Studio can publish to your GitHub account.';
    case 'webring_github_login_poll':
      return 'Finish signing in to GitHub and save the sign-in for publishing.';
    case 'webring_setup_github_site':
      return `Create or reuse the GitHub repository ${str('repoName') ? quoted(str('repoName')) : 'for your site'} and point your site at it${
        args.allowAddressChange === true ? ', changing your site address if needed' : ''
      }.`;
    case 'webring_create_persona':
      return `Create a new persona ${quoted(str('displayName') || str('label') || 'New Persona')}${str('siteUrl') ? ` for ${str('siteUrl')}` : ''}.`;
    case 'webring_switch_persona':
      return `Switch Studio to the persona ${str('personaId')}.`;
    case 'webring_hubs':
      return str('action') === 'remove'
        ? `Remove the Webring Hub ${str('url')}.`
        : `Add the Webring Hub ${str('url')} (Studio contacts it).`;
    case 'webring_set_hub_listing':
      return args.listed === true
        ? `List your site in the Webring Hub ${str('url')}.`
        : `Remove your site's listing from the Webring Hub ${str('url')}.`;
    case 'webring_join_ring':
      return `Ask to join the webring at ${str('hubUrl')}.`;
    case 'webring_leave_ring':
      return `Leave the webring ${str('ringId')}.`;
    case 'webring_create_hosted_ring':
      return `Create a new webring ${quoted(str('name') || 'Untitled')} that you host.`;
    case 'webring_review_ring_request':
      return `${str('decision') === 'approve' ? 'Approve' : 'Decline'} a request to join one of your webrings.`;
    case 'webring_review_friend_notice':
      return args.accept === false ? 'Ignore a friend notice someone sent you.' : 'Accept a friend notice someone sent you.';
    case 'webring_set_ring_member':
      return `${str('action') ? `${str('action').charAt(0).toUpperCase()}${str('action').slice(1)}` : 'Change'} ${str('siteUrl')} in your webring.`;
    default:
      return `Run ${name}`;
  }
}
