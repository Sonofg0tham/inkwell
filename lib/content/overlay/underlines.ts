import type { IssueType } from '../../messaging/protocol';
import type { Rect } from '../types';
import type { OverlayHost } from './host';

export const TYPE_COLORS: Record<IssueType, string> = {
  spelling: '#e5484d',
  grammar: '#e5484d',
  punctuation: '#f5a623',
  style: '#4c7dd0',
};

export const TYPE_LABELS: Record<IssueType, string> = {
  spelling: 'Spelling',
  grammar: 'Grammar',
  punctuation: 'Punctuation',
  style: 'Style',
};

export interface SegmentSpec {
  issueId: string;
  type: IssueType;
  rects: Rect[];
}

export interface UnderlineCallbacks {
  onEnter(issueId: string, anchor: Rect): void;
  onLeave(issueId: string): void;
  onPress(issueId: string, anchor: Rect): void;
}

const UNDERLINE_HEIGHT = 2.5;

export class UnderlineLayer {
  constructor(
    private host: OverlayHost,
    private callbacks: UnderlineCallbacks,
  ) {}

  render(specs: SegmentSpec[]): void {
    const container = this.host.segLayer;
    container.replaceChildren();
    for (const spec of specs) {
      for (const rect of spec.rects) {
        if (rect.width < 2) continue;
        const seg = document.createElement('div');
        seg.className = 'ink-seg';
        seg.style.left = `${rect.left}px`;
        seg.style.top = `${rect.top + rect.height - UNDERLINE_HEIGHT}px`;
        seg.style.width = `${rect.width}px`;
        seg.style.height = `${UNDERLINE_HEIGHT}px`;
        seg.style.background = TYPE_COLORS[spec.type];
        const anchor: Rect = { ...rect };
        seg.addEventListener('pointerenter', () => this.callbacks.onEnter(spec.issueId, anchor));
        seg.addEventListener('pointerleave', () => this.callbacks.onLeave(spec.issueId));
        seg.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.callbacks.onPress(spec.issueId, anchor);
        });
        container.appendChild(seg);
      }
    }
  }

  clear(): void {
    this.host.segLayer.replaceChildren();
  }
}
