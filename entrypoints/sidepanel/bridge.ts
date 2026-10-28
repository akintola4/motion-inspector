import { AGENT_GLOBAL, AGENT_VERSION, type AgentMethod } from '../../lib/agent-protocol';

export class RestrictedPageError extends Error {}

const RESTRICTED = /^(chrome|chrome-extension|edge|about|devtools|view-source|chrome-search):/i;
const STORE = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i;

export function isRestrictedUrl(url: string | undefined): boolean {
  return !!url && (RESTRICTED.test(url) || STORE.test(url));
}

/**
 * Talks to the page agent in one tab. Each call is a MAIN-world
 * executeScript whose return value is the agent's (JSON) result.
 */
export class TabBridge {
  constructor(readonly tabId: number) {}

  private async exec<T>(method: AgentMethod, args: unknown[]): Promise<{ missing: true } | { missing: false; value: T }> {
    let results: chrome.scripting.InjectionResult<unknown>[];
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        world: 'MAIN',
        func: (key: string, version: number, m: string, a: unknown[]) => {
          const agent = (window as unknown as Record<string, Record<string, unknown> | undefined>)[key];
          if (!agent || agent.version !== version) return { missing: true };
          const fn = agent[m] as (...x: unknown[]) => unknown;
          return { missing: false, value: fn(...a) };
        },
        args: [AGENT_GLOBAL, AGENT_VERSION, method, args],
      });
    } catch (err) {
      throw classify(err);
    }
    return (results[0]?.result ?? { missing: true }) as { missing: true } | { missing: false; value: T };
  }

  async inject() {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        world: 'MAIN',
        files: ['/agent.js'],
      });
    } catch (err) {
      throw classify(err);
    }
  }

  async call<T>(method: AgentMethod, ...args: unknown[]): Promise<T> {
    let res = await this.exec<T>(method, args);
    if (res.missing) {
      await this.inject();
      res = await this.exec<T>(method, args);
    }
    if (res.missing) throw new Error('Could not start the page agent.');
    return res.value;
  }
}

function classify(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/cannot access|cannot be scripted|extensions gallery|chrome:\/\/|permission/i.test(msg)) {
    return new RestrictedPageError(msg);
  }
  return err instanceof Error ? err : new Error(msg);
}
