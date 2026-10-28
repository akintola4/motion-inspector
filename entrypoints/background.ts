import { AGENT_GLOBAL } from '../lib/agent-protocol';

/**
 * Opens the side panel from the toolbar icon, and puts pages back the way
 * they were (resumed, 1×, no highlight) when the panel closes.
 */
export default defineBackground(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'panel') return;
    const attached = new Set<number>();
    port.onMessage.addListener((msg: { type: string; tabId?: number }) => {
      if (msg.type === 'attach' && typeof msg.tabId === 'number') attached.add(msg.tabId);
    });
    port.onDisconnect.addListener(() => {
      for (const tabId of attached) {
        chrome.scripting
          .executeScript({
            target: { tabId },
            world: 'MAIN',
            func: (key: string) => {
              const agent = (window as unknown as Record<string, { reset?: () => void } | undefined>)[key];
              agent?.reset?.();
            },
            args: [AGENT_GLOBAL],
          })
          .catch(() => {});
      }
    });
  });
});
