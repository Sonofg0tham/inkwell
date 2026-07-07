// One fixed-position shadow-DOM overlay per frame. Everything Inkwell draws
// lives inside this shadow root — the page's editable DOM is never mutated,
// and page CSS cannot reach in.

const OVERLAY_CSS = `
.ink-layer {
  all: initial;
}
.ink-seg {
  position: fixed;
  pointer-events: auto;
  cursor: pointer;
  border-radius: 2px;
}
.ink-seg::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: -16px;
  bottom: -4px;
}
.ink-card {
  position: fixed;
  pointer-events: auto;
  box-sizing: border-box;
  max-width: 320px;
  min-width: 220px;
  background: #fffdf8;
  color: #23273a;
  border: 1px solid #e6dfd0;
  border-radius: 12px;
  box-shadow: 0 3px 10px rgba(35, 39, 58, 0.10), 0 10px 28px rgba(35, 39, 58, 0.10);
  font-family: -apple-system, 'Segoe UI', system-ui, sans-serif;
  font-size: 13.5px;
  line-height: 1.45;
  padding: 12px 14px;
}
.ink-card-type {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #8a8272;
  margin-bottom: 6px;
}
.ink-card-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.ink-card-change {
  margin-bottom: 4px;
}
.ink-card-original {
  text-decoration: line-through;
  text-decoration-color: rgba(35, 39, 58, 0.4);
  color: #6f6a5c;
  overflow-wrap: anywhere;
}
.ink-card-arrow {
  margin: 0 6px;
  color: #8a8272;
}
.ink-card-replacement {
  font-weight: 700;
  overflow-wrap: anywhere;
}
.ink-card-explanation {
  color: #5c574a;
  margin-bottom: 10px;
}
.ink-card-buttons {
  display: flex;
  gap: 8px;
}
.ink-card-btn {
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  border-radius: 8px;
  padding: 5px 14px;
  cursor: pointer;
  border: 1px solid transparent;
}
.ink-card-btn-apply {
  background: #e86a3d;
  color: #fffdf8;
}
.ink-card-btn-apply:hover {
  background: #d55a2e;
}
.ink-card-btn-dismiss {
  background: transparent;
  color: #6f6a5c;
  border-color: #e6dfd0;
}
.ink-card-btn-dismiss:hover {
  background: #f3eee2;
}
.ink-mirror {
  position: fixed;
  top: 0;
  left: -10000px;
  visibility: hidden;
  pointer-events: none;
  border-style: solid;
  border-color: transparent;
}
`;

export interface OverlayHost {
  hostEl: HTMLElement;
  root: ShadowRoot;
  /** Container for underline segments. */
  segLayer: HTMLDivElement;
  /** Container for the suggestion card. */
  cardLayer: HTMLDivElement;
  /** Hidden measurement area (textarea mirror). */
  measureLayer: HTMLDivElement;
}

let singleton: OverlayHost | null = null;

export function getOverlayHost(): OverlayHost {
  if (singleton && singleton.hostEl.isConnected) return singleton;
  const hostEl = document.createElement('inkwell-overlay');
  hostEl.style.cssText =
    'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483646;pointer-events:none;';
  const root = hostEl.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = OVERLAY_CSS;
  const layer = document.createElement('div');
  layer.className = 'ink-layer';
  const segLayer = document.createElement('div');
  const cardLayer = document.createElement('div');
  const measureLayer = document.createElement('div');
  layer.append(segLayer, cardLayer, measureLayer);
  root.append(style, layer);
  document.documentElement.appendChild(hostEl);
  singleton = { hostEl, root, segLayer, cardLayer, measureLayer };
  return singleton;
}

export function destroyOverlayHost(): void {
  singleton?.hostEl.remove();
  singleton = null;
}
