// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { destroyOverlayHost, getOverlayHost } from '../lib/content/overlay/host';
import { OverlayStatus } from '../lib/content/overlay/status';

describe('overlay check status announcements', () => {
  beforeEach(() => {
    destroyOverlayHost();
    document.body.replaceChildren();
  });

  afterEach(() => {
    destroyOverlayHost();
  });

  it('provides one polite atomic live region inside the closed overlay', () => {
    const host = getOverlayHost();

    expect(host.statusLayer.getAttribute('role')).toBe('status');
    expect(host.statusLayer.getAttribute('aria-live')).toBe('polite');
    expect(host.statusLayer.getAttribute('aria-atomic')).toBe('true');
  });

  it('announces checking and completed suggestion counts', () => {
    const host = getOverlayHost();
    const status = new OverlayStatus(host);

    status.announce({ state: 'checking' });
    expect(host.statusLayer.dataset.state).toBe('checking');
    expect(host.statusLayer.textContent).toBe('Inkwell is checking this text.');

    status.announce({ state: 'checked', issueCount: 0 });
    expect(host.statusLayer.textContent).toBe('Check complete. No suggestions.');

    status.announce({ state: 'checked', issueCount: 2 });
    expect(host.statusLayer.textContent).toBe('Check complete. 2 suggestions.');
  });

  it('announces partial checks without claiming the text is clear', () => {
    const host = getOverlayHost();
    const status = new OverlayStatus(host);

    status.announce({ state: 'partial', issueCount: 2, droppedCount: 1 });

    expect(host.statusLayer.dataset.state).toBe('partial');
    expect(host.statusLayer.textContent).toBe(
      'Check incomplete. 2 suggestions available. 1 suggestion could not be placed.',
    );
  });

  it('explains when contextual checking was unavailable', () => {
    const host = getOverlayHost();
    const status = new OverlayStatus(host);

    status.announce({
      state: 'partial',
      issueCount: 1,
      droppedCount: 0,
      message: 'Local model unavailable.',
    });

    expect(host.statusLayer.textContent).toBe(
      'Check incomplete. 1 suggestion available. The contextual check was unavailable. Local model unavailable.',
    );
  });

  it('announces provider errors as text rather than markup', () => {
    const host = getOverlayHost();
    const status = new OverlayStatus(host);

    status.announce({ state: 'error', message: '<img src=x onerror=alert(1)>' });

    expect(host.statusLayer.dataset.state).toBe('error');
    expect(host.statusLayer.textContent).toBe('Check failed. <img src=x onerror=alert(1)>');
    expect(host.statusLayer.querySelector('img')).toBeNull();
  });

  it('shows checker failures beside the active field instead of hiding them visually', () => {
    const host = getOverlayHost();
    const status = new OverlayStatus(host);

    (status as unknown as { announce(update: unknown, anchor: unknown): void }).announce(
      { state: 'error', message: 'Could not reach the local model.' },
      { left: 40, top: 60, width: 240, height: 80 },
    );

    expect(host.statusLayer.hidden).toBe(false);
    expect(host.statusLayer.getAttribute('role')).toBe('alert');
    expect(host.statusLayer.style.left).not.toBe('');
    expect(host.statusLayer.style.top).not.toBe('');
    expect(getComputedStyle(host.statusLayer).width).not.toBe('1px');
  });
});
