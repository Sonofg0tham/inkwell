import type { OneShotRequest, OneShotResponseMap } from './protocol';

/** Type-safe one-shot request. Response type is derived from the request tag. */
export function sendTyped<T extends OneShotRequest['t']>(
  req: Extract<OneShotRequest, { t: T }>,
): Promise<OneShotResponseMap[T]> {
  return chrome.runtime.sendMessage(req);
}

type Handlers = {
  [K in OneShotRequest['t']]: (
    req: Extract<OneShotRequest, { t: K }>,
    sender: chrome.runtime.MessageSender,
  ) => Promise<OneShotResponseMap[K]>;
};

/** Registers a single onMessage listener that routes by the `t` tag. */
export function createRouter(handlers: Handlers): void {
  chrome.runtime.onMessage.addListener((msg: OneShotRequest, sender, sendResponse) => {
    const handler = handlers[msg?.t] as
      | ((r: OneShotRequest, s: chrome.runtime.MessageSender) => Promise<unknown>)
      | undefined;
    if (!handler) return;
    handler(msg, sender).then(sendResponse, (err: unknown) => {
      sendResponse({
        ok: false,
        code: 'network',
        hint: err instanceof Error ? err.message : String(err),
      });
    });
    return true; // keep the channel open for the async response
  });
}
