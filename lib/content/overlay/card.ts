import type { DocIssue, Rect } from '../types';
import type { OverlayHost } from './host';
import { TYPE_COLORS, TYPE_LABELS } from './underlines';

export interface CardCallbacks {
  onApply(issue: DocIssue): void;
  onDismiss(issue: DocIssue): void;
}

const GAP = 6;
const VIEWPORT_MARGIN = 8;

/**
 * The floating suggestion card. All model-derived strings are inserted via
 * textContent — model output must never become markup.
 */
export class SuggestionCard {
  private card: HTMLDivElement | null = null;
  private currentIssueId: string | null = null;
  private pointerInside = false;
  private onWindowPointerDown = (e: PointerEvent) => {
    if (!this.card) return;
    const path = e.composedPath();
    if (!path.includes(this.card)) this.hide();
  };
  private onWindowKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this.hide();
  };

  constructor(
    private host: OverlayHost,
    private callbacks: CardCallbacks,
  ) {}

  get visibleIssueId(): string | null {
    return this.currentIssueId;
  }

  get isPointerInside(): boolean {
    return this.pointerInside;
  }

  show(issue: DocIssue, anchor: Rect): void {
    this.hide();

    const card = document.createElement('div');
    card.className = 'ink-card';

    const typeRow = document.createElement('div');
    typeRow.className = 'ink-card-type';
    const dot = document.createElement('span');
    dot.className = 'ink-card-dot';
    dot.style.background = TYPE_COLORS[issue.type];
    const typeLabel = document.createElement('span');
    typeLabel.textContent = TYPE_LABELS[issue.type];
    typeRow.append(dot, typeLabel);

    const change = document.createElement('div');
    change.className = 'ink-card-change';
    const original = document.createElement('span');
    original.className = 'ink-card-original';
    original.textContent = issue.original;
    const arrow = document.createElement('span');
    arrow.className = 'ink-card-arrow';
    arrow.textContent = '→';
    const replacement = document.createElement('span');
    replacement.className = 'ink-card-replacement';
    replacement.textContent = issue.replacement === '' ? '(remove)' : issue.replacement;
    change.append(original, arrow, replacement);

    const explanation = document.createElement('div');
    explanation.className = 'ink-card-explanation';
    explanation.textContent = issue.explanation;

    const buttons = document.createElement('div');
    buttons.className = 'ink-card-buttons';
    const applyBtn = document.createElement('button');
    applyBtn.className = 'ink-card-btn ink-card-btn-apply';
    applyBtn.textContent = 'Apply';
    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'ink-card-btn ink-card-btn-dismiss';
    dismissBtn.textContent = 'Dismiss';
    // pointerdown + preventDefault so the editable never loses focus/selection
    // before the action runs.
    applyBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.hide();
      this.callbacks.onApply(issue);
    });
    dismissBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.hide();
      this.callbacks.onDismiss(issue);
    });
    buttons.append(applyBtn, dismissBtn);

    card.append(typeRow, change);
    if (issue.explanation) card.append(explanation);
    card.append(buttons);

    card.addEventListener('pointerenter', () => {
      this.pointerInside = true;
    });
    card.addEventListener('pointerleave', () => {
      this.pointerInside = false;
    });

    this.host.cardLayer.appendChild(card);
    this.card = card;
    this.currentIssueId = issue.id;

    // Position after insertion so we can measure. Prefer below the underline;
    // flip above when there isn't room.
    const rect = card.getBoundingClientRect();
    let top = anchor.top + anchor.height + GAP;
    if (top + rect.height > window.innerHeight - VIEWPORT_MARGIN) {
      top = anchor.top - rect.height - GAP;
    }
    const left = Math.min(
      Math.max(anchor.left, VIEWPORT_MARGIN),
      window.innerWidth - rect.width - VIEWPORT_MARGIN,
    );
    card.style.top = `${Math.max(top, VIEWPORT_MARGIN)}px`;
    card.style.left = `${left}px`;

    window.addEventListener('pointerdown', this.onWindowPointerDown, true);
    window.addEventListener('keydown', this.onWindowKeyDown, true);
  }

  hide(): void {
    if (!this.card) return;
    this.card.remove();
    this.card = null;
    this.currentIssueId = null;
    this.pointerInside = false;
    window.removeEventListener('pointerdown', this.onWindowPointerDown, true);
    window.removeEventListener('keydown', this.onWindowKeyDown, true);
  }
}
