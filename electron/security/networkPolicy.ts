import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * "No network" scopes. An agent call in read-only MCP mode runs inside one, and every outbound
 * request path (the peer fetcher, GitHub API calls, GitHub sign-in) checks it first, so a
 * read-only agent can't make Studio contact anyone, even through a tool that would normally fetch.
 */
const noNetwork = new AsyncLocalStorage<true>();

export class NetworkDisabledError extends Error {
  constructor() {
    super('Network access is disabled in read-only MCP mode');
    this.name = 'NetworkDisabledError';
  }
}

/** Runs `fn` (and everything it awaits) with outbound network access refused. */
export function runWithoutNetwork<T>(fn: () => T): T {
  return noNetwork.run(true, fn);
}

/** True inside runWithoutNetwork. Tools use it to answer from stored data instead of fetching. */
export function isNetworkDisabled(): boolean {
  return noNetwork.getStore() === true;
}

/** Throws NetworkDisabledError inside runWithoutNetwork. Called before any outbound request. */
export function assertNetworkAllowed(): void {
  if (isNetworkDisabled()) throw new NetworkDisabledError();
}
