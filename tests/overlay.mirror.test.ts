// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { destroyOverlayHost, getOverlayHost } from '../lib/content/overlay/host';
import { measureTextControl } from '../lib/content/overlay/mirror';

function setControlGeometry(
  element: HTMLInputElement | HTMLTextAreaElement,
  clientWidth: number,
  rectWidth: number,
): void {
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: clientWidth });
  element.getBoundingClientRect = () =>
    ({
      x: 20,
      y: 30,
      left: 20,
      top: 30,
      right: 20 + rectWidth,
      bottom: 70,
      width: rectWidth,
      height: 40,
      toJSON: () => ({}),
    }) as DOMRect;
}

function currentMirror(): HTMLDivElement {
  return getOverlayHost().measureLayer.querySelector<HTMLDivElement>('.ink-mirror')!;
}

describe('text-control mirror geometry', () => {
  beforeEach(() => {
    destroyOverlayHost();
    document.body.replaceChildren();
  });

  afterEach(() => {
    destroyOverlayHost();
  });

  it('gives a right-aligned border-box input the same usable width as the control', () => {
    const input = document.createElement('input');
    input.value = 'Short text';
    input.style.cssText =
      'box-sizing:border-box;width:240px;padding:4px 12px;border:2px solid black;text-align:right';
    setControlGeometry(input, 236, 240);
    document.body.append(input);

    measureTextControl(input, [{ start: 0, end: 5 }]);

    expect(currentMirror().style.width).toBe('240px');
    expect(currentMirror().style.textAlign).toBe('right');
    expect(currentMirror().style.whiteSpace).toBe('pre');
  });

  it('uses a textarea client width rather than laying text beneath its scrollbar', () => {
    const textarea = document.createElement('textarea');
    textarea.value = 'Text that wraps onto another line in a narrow textarea.';
    textarea.style.cssText =
      'box-sizing:border-box;width:240px;padding:8px;border:2px solid black;overflow-wrap:break-word';
    setControlGeometry(textarea, 220, 240);
    document.body.append(textarea);

    measureTextControl(textarea, [{ start: 0, end: 4 }]);

    expect(currentMirror().style.width).toBe('224px');
    expect(currentMirror().style.whiteSpace).toBe('pre-wrap');
  });

  it('preserves the content width of a centre-aligned content-box input', () => {
    const input = document.createElement('input');
    input.value = 'Centred text';
    input.style.cssText =
      'box-sizing:content-box;width:220px;padding:4px 10px;border:2px solid black;text-align:center';
    setControlGeometry(input, 240, 244);
    document.body.append(input);

    measureTextControl(input, [{ start: 0, end: 7 }]);

    expect(currentMirror().style.width).toBe('220px');
    expect(currentMirror().style.textAlign).toBe('center');
  });
});
