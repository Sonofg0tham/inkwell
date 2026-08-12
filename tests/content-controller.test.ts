// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldController } from '../lib/content/fieldController';
import { destroyOverlayHost, getOverlayHost } from '../lib/content/overlay/host';
import type { IssueDto } from '../lib/messaging/protocol';
import type { DocIssue } from '../lib/content/types';
import { DEFAULT_SETTINGS, type Settings } from '../lib/settings/schema';

class TestResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

class TestIntersectionObserver {
  constructor(private callback: IntersectionObserverCallback) {}
  observe(target: Element): void {
    this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  disconnect(): void {}
}

describe('FieldController lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver);
  });

  afterEach(() => {
    destroyOverlayHost();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function setup(text = 'This sentance needs a correction.') {
    const field = document.createElement('textarea');
    field.value = text;
    document.body.appendChild(field);

    let inputListener: EventListener | null = null;
    let compositionEndListener: EventListener | null = null;
    const nativeAdd = field.addEventListener.bind(field);
    vi.spyOn(field, 'addEventListener').mockImplementation((type, listener, options) => {
      if (type === 'input') inputListener = listener as EventListener;
      if (type === 'compositionend') compositionEndListener = listener as EventListener;
      nativeAdd(type, listener, options);
    });

    let settings: Settings = structuredClone(DEFAULT_SETTINGS);
    const port = {
      check: vi.fn(),
      cancel: vi.fn(),
    };
    const reportCount = vi.fn();
    const reportStatus = vi.fn();
    const addToDictionary = vi.fn();
    const controller = new FieldController(
      { kind: 'textarea', el: field },
      {
        getSettings: () => settings,
        port: port as never,
        reportCount,
        reportStatus,
        addToDictionary,
      },
    );

    return {
      controller,
      field,
      port,
      reportCount,
      reportStatus,
      addToDictionary,
      input: (isTrusted: boolean) => inputListener?.({ isTrusted } as Event),
      compositionEnd: (isTrusted: boolean) => compositionEndListener?.({ isTrusted } as Event),
      updateSettings: (next: Settings) => { settings = next; },
    };
  }

  function seedIssues(runtime: ReturnType<typeof setup>, issues: IssueDto[]) {
    runtime.controller.activate();
    const internal = runtime.controller as unknown as {
      chunks: Array<{ hash: string }>;
      issuesByHash: Map<string, IssueDto[]>;
      currentIssues: DocIssue[];
      render(): void;
      showCard(issueId: string, anchor: { left: number; top: number; width: number; height: number }): void;
    };
    internal.issuesByHash.set(internal.chunks[0]!.hash, issues);
    internal.render();
    return internal;
  }

  function repeatedSpellingIssues(): IssueDto[] {
    return [
      {
        id: 'recieve-id', type: 'spelling', start: 0, end: 7,
        original: 'recieve', replacement: 'receive', explanation: 'Misspelling.',
      },
      {
        id: 'recieve-id', type: 'spelling', start: 12, end: 19,
        original: 'Recieve', replacement: 'Receive', explanation: 'Misspelling.',
      },
      {
        id: 'sentance-id', type: 'spelling', start: 24, end: 32,
        original: 'sentance', replacement: 'sentence', explanation: 'Misspelling.',
      },
    ];
  }

  it('requires a trusted edit before checking and uses an unguessable request ID', async () => {
    const runtime = setup();
    runtime.controller.activate();

    await vi.advanceTimersByTimeAsync(801);
    expect(runtime.port.check).not.toHaveBeenCalled();

    runtime.input(false);
    await vi.advanceTimersByTimeAsync(801);
    expect(runtime.port.check).not.toHaveBeenCalled();

    runtime.compositionEnd(false);
    await vi.advanceTimersByTimeAsync(801);
    expect(runtime.port.check).not.toHaveBeenCalled();

    runtime.input(true);
    await vi.advanceTimersByTimeAsync(801);
    expect(runtime.port.check).toHaveBeenCalledTimes(1);
    expect(runtime.port.check.mock.calls[0]![0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('sends no text if the field becomes sensitive after its input event', async () => {
    const runtime = setup('Private text that must not leave this field.');
    runtime.controller.activate();
    runtime.input(true);
    runtime.field.setAttribute('autocomplete', 'username');

    await vi.advanceTimersByTimeAsync(801);

    expect(runtime.port.check).not.toHaveBeenCalled();
  });

  it('sends no text if an ancestor opts out after the field input event', async () => {
    const runtime = setup('Private text that must not leave this editor.');
    runtime.controller.activate();
    runtime.input(true);
    const wrapper = document.createElement('div');
    runtime.field.replaceWith(wrapper);
    wrapper.append(runtime.field);
    wrapper.setAttribute('data-inkwell-disable', '');

    await vi.advanceTimersByTimeAsync(801);

    expect(runtime.port.check).not.toHaveBeenCalled();
  });

  it('cancels old work and rechecks immediately when checking settings change', async () => {
    const runtime = setup();
    runtime.controller.activate();
    runtime.input(true);
    await vi.advanceTimersByTimeAsync(801);
    const firstRequestId = runtime.port.check.mock.calls[0]![0] as string;

    runtime.updateSettings({ ...DEFAULT_SETTINGS, strictness: 'picky' });
    (runtime.controller as unknown as { settingsChanged?: () => void }).settingsChanged?.();

    expect(runtime.port.cancel).toHaveBeenCalledWith([firstRequestId]);
    await vi.advanceTimersByTimeAsync(801);
    expect(runtime.port.check).toHaveBeenCalledTimes(2);
    expect(runtime.port.check.mock.calls[1]![0]).not.toBe(firstRequestId);
  });

  it('reports zero and clears visible status when the active field is deactivated', async () => {
    const runtime = setup();
    runtime.controller.activate();
    runtime.input(true);
    await vi.advanceTimersByTimeAsync(801);
    expect(getOverlayHost().statusLayer.hidden).toBe(false);

    runtime.controller.deactivate();

    expect(runtime.reportCount).toHaveBeenLastCalledWith(0);
    expect(getOverlayHost().statusLayer.hidden).toBe(true);
    expect(getOverlayHost().statusLayer.textContent).toBe('');
  });

  it('shows checking and provider failure states beside the active field', async () => {
    const runtime = setup();
    runtime.field.getBoundingClientRect = () => ({
      left: 20, top: 30, width: 260, height: 80, right: 280, bottom: 110,
      x: 20, y: 30, toJSON: () => ({}),
    });
    runtime.controller.activate();
    runtime.input(true);
    await vi.advanceTimersByTimeAsync(801);

    const host = getOverlayHost();
    expect(host.statusLayer.dataset.state).toBe('checking');
    expect(host.statusLayer.hidden).toBe(false);

    const handler = runtime.port.check.mock.calls[0]![3] as (response: unknown) => void;
    handler({
      t: 'error',
      requestId: runtime.port.check.mock.calls[0]![0],
      code: 'network',
      hint: 'Could not reach the local model.',
    });

    expect(host.statusLayer.dataset.state).toBe('error');
    expect(host.statusLayer.textContent).toContain('Could not reach the local model.');
    expect(host.statusLayer.getAttribute('role')).toBe('alert');
  });

  it('marks a deterministic-only result as partial when the contextual model failed', async () => {
    const runtime = setup('teh message');
    runtime.field.getBoundingClientRect = () => ({
      left: 20, top: 30, width: 260, height: 80, right: 280, bottom: 110,
      x: 20, y: 30, toJSON: () => ({}),
    });
    runtime.controller.activate();
    runtime.input(true);
    await vi.advanceTimersByTimeAsync(801);

    const handler = runtime.port.check.mock.calls[0]![3] as (response: unknown) => void;
    handler({
      t: 'result',
      requestId: runtime.port.check.mock.calls[0]![0],
      chunkHash: runtime.port.check.mock.calls[0]![1],
      issues: [],
      incomplete: { code: 'network', hint: 'Local model unavailable.' },
    });
    await vi.runAllTimersAsync();

    expect(getOverlayHost().statusLayer.dataset.state).toBe('partial');
    expect(getOverlayHost().statusLayer.textContent).toContain('contextual');
    expect(runtime.reportStatus).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: 'partial',
      hint: 'Local model unavailable.',
    }));
  });

  it('forwards Add to dictionary with the exact original word', () => {
    const runtime = setup('recieve and Recieve and sentance');
    const internal = seedIssues(runtime, repeatedSpellingIssues());
    internal.showCard(internal.currentIssues[1]!.id, { left: 20, top: 30, width: 60, height: 18 });

    const add = Array.from(
      getOverlayHost().cardLayer.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Add to dictionary');
    expect(add).toBeTruthy();
    add?.click();

    expect(runtime.addToDictionary).toHaveBeenCalledWith('Recieve');
  });

  it('Ignore all suppresses every casing of a spelling in that field', () => {
    const runtime = setup('recieve and Recieve and sentance');
    const internal = seedIssues(runtime, repeatedSpellingIssues());
    internal.showCard(internal.currentIssues[0]!.id, { left: 20, top: 30, width: 60, height: 18 });

    const ignoreAll = Array.from(
      getOverlayHost().cardLayer.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Ignore all');
    expect(ignoreAll).toBeTruthy();
    ignoreAll?.click();
    internal.render();

    expect(internal.currentIssues.map((issue) => issue.original)).toEqual(['sentance']);
  });

  it('Dismiss suppresses only the selected occurrence', () => {
    const runtime = setup('recieve and Recieve and sentance');
    const internal = seedIssues(runtime, repeatedSpellingIssues());
    internal.showCard(internal.currentIssues[0]!.id, { left: 20, top: 30, width: 60, height: 18 });

    getOverlayHost().cardLayer
      .querySelector<HTMLButtonElement>('.ink-card-btn-dismiss')
      ?.click();
    internal.render();

    expect(internal.currentIssues.map((issue) => issue.original)).toEqual([
      'Recieve',
      'sentance',
    ]);
  });

  it('removes the raw cached issue when a qualified stale suggestion cannot be applied', () => {
    const runtime = setup('The text changed before the click.');
    runtime.controller.activate();
    const sourceIssue = {
      id: 'raw-hash',
      type: 'spelling' as const,
      start: 4,
      end: 12,
      original: 'sentance',
      replacement: 'sentence',
      explanation: 'Correct the spelling.',
    };
    const internal = runtime.controller as unknown as {
      issuesByHash: Map<string, typeof sourceIssue[]>;
      apply(issue: DocIssue): void;
    };
    internal.issuesByHash.set('chunk-hash', [sourceIssue]);

    internal.apply({
      ...sourceIssue,
      id: 'raw-hash@4',
      docStart: 4,
      docEnd: 12,
      chunkHash: 'chunk-hash',
    });

    expect(internal.issuesByHash.get('chunk-hash')).toEqual([]);
  });
});
