import { vi } from 'vitest';

export interface StorageChange {
  oldValue?: any;
  newValue?: any;
}

export function setupChromeMock() {
  const store = new Map<string, any>();
  const changeListeners = new Set<(changes: Record<string, StorageChange>, areaName: string) => void>();

  const local = {
    get: vi.fn(async (keys?: string | string[] | Record<string, any> | null) => {
      if (keys === null || keys === undefined) {
        return Object.fromEntries(store.entries());
      }
      if (typeof keys === 'string') {
        return { [keys]: store.get(keys) };
      }
      if (Array.isArray(keys)) {
        const result: Record<string, any> = {};
        for (const k of keys) {
          if (store.has(k)) {
            result[k] = store.get(k);
          }
        }
        return result;
      }
      // keys is an object with default values
      const result: Record<string, any> = {};
      for (const [k, defaultVal] of Object.entries(keys)) {
        result[k] = store.has(k) ? store.get(k) : defaultVal;
      }
      return result;
    }),

    set: vi.fn(async (items: Record<string, any>) => {
      const changes: Record<string, StorageChange> = {};
      let hasChanges = false;
      for (const [key, newValue] of Object.entries(items)) {
        const oldValue = store.get(key);
        if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
          store.set(key, newValue);
          changes[key] = { oldValue, newValue };
          hasChanges = true;
        }
      }
      if (hasChanges && changeListeners.size > 0) {
        for (const listener of changeListeners) {
          listener(changes, 'local');
        }
      }
    }),

    remove: vi.fn(async (keys: string | string[]) => {
      const targetKeys = Array.isArray(keys) ? keys : [keys];
      const changes: Record<string, StorageChange> = {};
      let hasChanges = false;
      for (const key of targetKeys) {
        if (store.has(key)) {
          const oldValue = store.get(key);
          store.delete(key);
          changes[key] = { oldValue, newValue: undefined };
          hasChanges = true;
        }
      }
      if (hasChanges && changeListeners.size > 0) {
        for (const listener of changeListeners) {
          listener(changes, 'local');
        }
      }
    }),

    clear: vi.fn(async () => {
      const changes: Record<string, StorageChange> = {};
      let hasChanges = false;
      for (const [key, oldValue] of store.entries()) {
        changes[key] = { oldValue, newValue: undefined };
        hasChanges = true;
      }
      store.clear();
      if (hasChanges && changeListeners.size > 0) {
        for (const listener of changeListeners) {
          listener(changes, 'local');
        }
      }
    }),
  };

  const onChanged = {
    addListener: vi.fn((listener: (changes: Record<string, StorageChange>, areaName: string) => void) => {
      changeListeners.add(listener);
    }),
    removeListener: vi.fn((listener: (changes: Record<string, StorageChange>, areaName: string) => void) => {
      changeListeners.delete(listener);
    }),
    hasListener: vi.fn((listener: (changes: Record<string, StorageChange>, areaName: string) => void) => {
      return changeListeners.has(listener);
    }),
  };

  // Mock chrome.runtime.connect
  const connectListeners = new Set<(port: chrome.runtime.Port) => void>();

  globalThis.chrome = {
    storage: {
      local,
      onChanged,
    },
    runtime: {
      lastError: undefined,
      id: 'mock-extension-id',
      getURL: vi.fn((path: string) => `chrome-extension://mock-extension-id/${path}`),
      openOptionsPage: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => ({ host: null, siteDisabled: false, issueCount: 0 })),
      connect: vi.fn(({ name }: { name: string }) => {
        const messageListeners = new Set<(msg: any) => void>();
        const disconnectListeners = new Set<() => void>();
        let singleRateLimitSent = false;

        const mockPort = {
          name,
          onMessage: {
            addListener: (cb: any) => messageListeners.add(cb),
            removeListener: (cb: any) => messageListeners.delete(cb),
          },
          onDisconnect: {
            addListener: (cb: any) => disconnectListeners.add(cb),
            removeListener: (cb: any) => disconnectListeners.delete(cb),
          },
          postMessage: vi.fn((msg: any) => {
            if (msg.t === 'check') {
              // Model flagged problems but quoted text that isn't in the doc,
              // so every issue gets dropped during anchoring.
              if (msg.text.includes('TRIGGER_UNPLACEABLE')) {
                setTimeout(() => {
                  messageListeners.forEach((cb) =>
                    cb({
                      t: 'result',
                      requestId: msg.requestId,
                      chunkHash: msg.chunkHash,
                      issues: [],
                      dropped: 2,
                      model: 'mock-model',
                    })
                  );
                }, 5);
                return;
              }
              if (msg.text.includes('TRIGGER_SINGLE_RATE_LIMIT') && !singleRateLimitSent) {
                singleRateLimitSent = true;
                setTimeout(() => {
                  messageListeners.forEach((cb) =>
                    cb({
                      t: 'error',
                      requestId: msg.requestId,
                      code: 'rate_limit',
                      hint: 'Rate limited once for the continuation regression.',
                    })
                  );
                }, 5);
                return;
              }
              // Simulated free-tier quota exhaustion
              if (msg.text.includes('TRIGGER_RATE_LIMIT')) {
                setTimeout(() => {
                  messageListeners.forEach((cb) =>
                    cb({
                      t: 'error',
                      requestId: msg.requestId,
                      code: 'rate_limit',
                      hint: 'Rate limited (HTTP 429). Wait a moment and try again.',
                    })
                  );
                }, 5);
                return;
              }
              // Deterministic spelling succeeded while contextual checking failed.
              if (msg.text.includes('TRIGGER_CONTEXT_UNAVAILABLE')) {
                setTimeout(() => {
                  const start = msg.text.indexOf('teh');
                  messageListeners.forEach((cb) =>
                    cb({
                      t: 'result',
                      requestId: msg.requestId,
                      chunkHash: msg.chunkHash,
                      issues: [{
                        id: 'local-spelling-1',
                        type: 'spelling' as const,
                        start,
                        end: start + 3,
                        original: 'teh',
                        replacement: 'the',
                        explanation: 'Possible spelling mistake.',
                      }],
                      dropped: 0,
                      model: 'mock-model',
                      incomplete: { code: 'network', hint: 'Contextual model unavailable.' },
                    })
                  );
                }, 5);
                return;
              }
              // Simulated provider failure (e.g. Ollama 403 / bad API key)
              if (msg.text.includes('TRIGGER_CHECKER_ERROR')) {
                setTimeout(() => {
                  messageListeners.forEach((cb) =>
                    cb({
                      t: 'error',
                      requestId: msg.requestId,
                      code: 'auth',
                      hint: 'The server rejected the request (HTTP 403). Check your API key.',
                    })
                  );
                }, 5);
                return;
              }
              // Simulated checker latency
              setTimeout(() => {
                const issues: any[] = [];
                // Test checks spelling and grammar triggers
                if (msg.text.includes('Their was')) {
                  issues.push({
                    id: 'issue_1',
                    type: 'grammar' as const,
                    start: msg.text.indexOf('Their was'),
                    end: msg.text.indexOf('Their was') + 5,
                    original: 'Their',
                    replacement: 'There',
                    explanation: 'Did you mean "There"?',
                  });
                }
                for (const match of msg.text.matchAll(/beachh/g)) {
                  issues.push({
                    id: `issue_2_${match.index}`,
                    type: 'spelling' as const,
                    start: match.index,
                    end: match.index + 6,
                    original: 'beachh',
                    replacement: 'beach',
                    explanation: 'Spelling correction: beach',
                  });
                }
                for (const match of msg.text.matchAll(/[ \t]+[,.;:!?]/g)) {
                  issues.push({
                    id: `issue_punctuation_${match.index}`,
                    type: 'punctuation' as const,
                    start: match.index,
                    end: match.index + match[0].length,
                    original: match[0],
                    replacement: match[0].trimStart(),
                    explanation: 'Remove the space before the punctuation mark.',
                  });
                }
                messageListeners.forEach((cb) =>
                  cb({
                    t: 'result',
                    requestId: msg.requestId,
                    chunkHash: msg.chunkHash,
                    issues,
                    dropped: 0,
                    model: 'mock-model',
                  })
                );
              }, 5);
            }
          }),
          disconnect: vi.fn(() => {
            disconnectListeners.forEach((cb) => cb());
          }),
        };

        return mockPort;
      }),
    },
    tabs: {
      create: vi.fn(async () => ({ id: 1 })),
    },
  } as unknown as typeof chrome;

  return {
    store,
    changeListeners,
    local,
    onChanged,
  };
}
