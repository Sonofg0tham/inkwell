// Focus-driven discovery of editable surfaces. The content script stays inert
// until the user actually focuses something checkable.
import { FieldController, type FieldEnv } from './fieldController';
import { isInkwellOverlayTarget, resolveEditable } from './editablePolicy';
import { destroyOverlayHost } from './overlay/host';

export interface WatcherHandle {
  stop(): void;
  settingsChanged(): void;
}

/** The genuinely focused element, following open shadow roots down. */
function deepActiveElement(): Element | null {
  let el: Element | null = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

export function startWatcher(env: FieldEnv): WatcherHandle {
  const controllers = new WeakMap<Element, FieldController>();
  let activeController: FieldController | null = null;
  let activeElement: Element | null = null;

  const deactivateActive = (): void => {
    activeController?.deactivate();
    activeController = null;
    activeElement = null;
  };

  const attach = (rawTarget: EventTarget | null): void => {
    const target = resolveEditable(rawTarget);
    if (!target || activeElement === target.el) return;
    deactivateActive();
    let controller = controllers.get(target.el);
    if (!controller) {
      controller = new FieldController(target, env);
      controllers.set(target.el, controller);
    }
    activeController = controller;
    activeElement = target.el;
    controller.activate();
  };

  // Events crossing a shadow boundary are retargeted to the host, so
  // composedPath()[0] identifies the field that was actually focused.
  const onFocusIn = (event: FocusEvent): void => {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    attach(path[0] ?? event.target);
  };

  const onFocusOut = (event: FocusEvent): void => {
    if (!activeController || !activeElement) return;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const origin = path[0] ?? event.target;
    const originField = resolveEditable(origin);
    const leftActiveField =
      origin === activeElement ||
      (origin instanceof Node && activeElement.contains(origin)) ||
      originField?.el === activeElement;
    const leftOverlay =
      isInkwellOverlayTarget(origin) || isInkwellOverlayTarget(event.target);
    if (!leftActiveField && !leftOverlay) return;

    // The card and its buttons live in Inkwell's shadow tree. Moving focus
    // there must not tear down the controller before keyboard actions run.
    if (isInkwellOverlayTarget(event.relatedTarget)) return;
    const nextField = resolveEditable(event.relatedTarget);
    if (nextField?.el === activeElement) return;
    deactivateActive();
  };

  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusout', onFocusOut, true);
  // A field may already be focused when the watcher starts. document.activeElement
  // is retargeted too, so descend through any open shadow roots to the real one.
  if (document.activeElement) attach(deepActiveElement());

  return {
    settingsChanged: () => activeController?.settingsChanged(),
    stop: () => {
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      deactivateActive();
      destroyOverlayHost();
    },
  };
}
