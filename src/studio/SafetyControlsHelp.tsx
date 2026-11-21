import React from 'react';

/** One Help entry: what a safeguard is, what it protects against, and what to do when it appears. */
function Entry(props: { title: string; tone: string; protects: React.ReactNode; todo: React.ReactNode }) {
  return (
    <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-1.5">
      <h4 className={`font-bold text-sm ${props.tone}`}>{props.title}</h4>
      <p className="text-xs text-slate-300 leading-relaxed">
        <span className="font-semibold text-slate-200">Protects against: </span>
        {props.protects}
      </p>
      <p className="text-xs text-slate-300 leading-relaxed">
        <span className="font-semibold text-slate-200">What to do: </span>
        {props.todo}
      </p>
    </div>
  );
}

/** Help → "10. Safety Notices & Controls": every notice, dialog and setting that guards your data. */
export function SafetyControlsHelp() {
  return (
    <div className="space-y-6">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
        <div>
          <h3 className="text-xl font-bold">Safety Notices &amp; Controls</h3>
          <p className="text-xs text-slate-400 mt-1">
            What each warning, dialog and safety setting in Studio is for, and what to do when you see it.
          </p>
        </div>

        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 pt-1">Notices</h4>
        <Entry
          title="Security banners (yellow and red, at the top)"
          tone="text-amber-300"
          protects={
            <>
              Saving secrets unencrypted without knowing it (<strong>Secure storage unavailable</strong>), and revealing
              your IP address when a saved proxy can&apos;t be used (<strong>Network activity paused</strong>).
            </>
          }
          todo={
            <>
              Read the banner: it names the problem and the fix. For secure storage, set up your system keychain, or accept
              the prompt only if this computer is yours alone. For a paused network, re-enter the proxy for that persona.
              See <strong>9. Secure Storage &amp; Proxy</strong>.
            </>
          }
        />
        <Entry
          title="A friend's key changed (Review New Key…) and your own fingerprint"
          tone="text-rose-300"
          protects={<>Someone taking over a friend&apos;s site, or their address, and posting as them.</>}
          todo={
            <>
              Click <strong>Review New Key…</strong> on their card. Ask your friend, by phone or a channel you already use,
              to read the first and last 8 characters of their key (they find it under{' '}
              <strong>Profile &amp; Identity → Your key fingerprint</strong>). Trust the new key only if they match. If
              Studio says their site showed more than one new key, be extra careful: that can mean impersonation.
            </>
          }
        />
        <Entry
          title={'"⚠ Sync problem" and "Older copies refused"'}
          tone="text-amber-300"
          protects={
            <>
              A friend&apos;s site (or someone between you and it) serving tampered files, or an old copy to bring back
              posts they deleted or a key they replaced (a rollback).
            </>
          }
          todo={
            <>
              Nothing was changed or removed. The notice says which file and why. If it keeps happening, tell your friend:
              their host may be serving a stale cache, or their files may have been altered. It clears on the next good
              sync.
            </>
          }
        />

        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 pt-2">AI agents (MCP)</h4>
        <Entry
          title="Read-only mode and “Allow agents to read private data”"
          tone="text-indigo-300"
          protects={
            <>
              An agent changing things you didn&apos;t ask for, contacting the network on its own, or reading private
              friends, saved posts and your publishing settings. Friends&apos; posts can contain instructions aimed at
              your agent.
            </>
          }
          todo={
            <>
              Agents start read-only. Turn on <strong>Allow Local Writes</strong> in the AI Agent (MCP) tab only while you
              want an agent to make changes. Leave private data off unless you trust the agent. No agent can change either
              setting.
            </>
          }
        />
        <Entry
          title="Approval requests and the decisions list"
          tone="text-indigo-300"
          protects={<>An agent publishing, deleting, changing keys or your site&apos;s address, or signing in, without you.</>}
          todo={
            <>
              Read what the agent wants, for which persona, and any file shown in full. <strong>Deny</strong> is the
              default and Enter never approves. Unanswered requests expire after 30 minutes. Recent decisions are listed in
              the MCP tab.
            </>
          }
        />
        <Entry
          title="Held agent changes"
          tone="text-indigo-300"
          protects={<>Something an agent added or edited going live on your site before you&apos;ve looked at it.</>}
          todo={
            <>
              Automatic and scheduled publishes skip held changes (&quot;Held — agent changes need review&quot;). Check
              them in <strong>Agent changes waiting for your review</strong>, then click{' '}
              <strong>Release for publishing</strong>, or publish manually and confirm.
            </>
          }
        />

        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 pt-2">Exporting and publishing</h4>
        <Entry
          title="Export folder rules"
          tone="text-emerald-300"
          protects={<>An export overwriting or deleting files in a folder that isn&apos;t Studio&apos;s.</>}
          todo={
            <>
              Only <strong>Change folder…</strong> sets the folder, and Studio writes only into an empty folder or one it
              exported to before (marked with a <code>.webring-studio-export</code> file). If it refuses, choose an empty
              folder.
            </>
          }
        />
        <Entry
          title="SFTP sign-in and the pinned server key"
          tone="text-emerald-300"
          protects={
            <>
              Uploading your site (and your password) to an impostor server. Studio remembers your host&apos;s key on the
              first publish and checks it every time after.
            </>
          }
          todo={
            <>
              Choose <strong>Password</strong>, <strong>Private key file</strong> (picked with <strong>Choose key
              file…</strong>, with an optional passphrase) or <strong>SSH agent</strong> (Pageant or the Windows OpenSSH
              agent). If <strong>The server&apos;s identity has changed</strong> appears, nothing was uploaded: check with
              your host before trusting the new key. <strong>Forget pinned key</strong> is only for a host that told you its
              key changed.
            </>
          }
        />
        <Entry
          title="Unencrypted FTP"
          tone="text-amber-300"
          protects={<>Your password and site files crossing the network in clear text.</>}
          todo={
            <>
              FTP uses encryption (FTPS) by default. If the connection fails, ask your host whether FTPS or SFTP is
              available. Tick <strong>Allow unencrypted FTP</strong> only as a last resort.
            </>
          }
        />
        <Entry
          title="GitHub fine-grained token"
          tone="text-emerald-300"
          protects={<>A leaked token giving access to all your repositories.</>}
          todo={
            <>
              Use <strong>Create token on GitHub</strong> and make a fine-grained token for only this repository, with
              Contents: Read and write and Pages: Read and write. If someone else commits to the branch while you publish,
              Studio rebuilds on top of their commit (it never force-pushes); if the branch keeps changing, try again in a
              minute.
            </>
          }
        />
        <Entry
          title="Image limits and image addresses"
          tone="text-emerald-300"
          protects={
            <>
              A crafted image address writing or deleting files outside your export folder, and an oversized image using up
              all your computer&apos;s memory.
            </>
          }
          todo={
            <>
              If Studio says <strong>This image address isn&apos;t valid</strong>, choose the image again from the Media
              Library or use an https:// address. If it says an image is <strong>too large</strong> or is a 16-bit PNG, export
              a copy of 64 megapixels or less, at 8 bits per channel.
            </>
          }
        />
        <Entry
          title="Your published page and the preview"
          tone="text-cyan-300"
          protects={<>Injected scripts running on your site, and a local preview server left open.</>}
          todo={
            <>
              Nothing; it&apos;s automatic. Your page runs only its own scripts (plus the add-ons you turn on). The preview
              server stops when you leave the Preview tab, when Studio quits, and after 10 idle minutes: click{' '}
              <strong>Preview stopped — click to restart</strong> to bring it back.
            </>
          }
        />
      </div>
    </div>
  );
}
