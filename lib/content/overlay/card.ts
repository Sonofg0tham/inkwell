import type { DocIssue, Rect } from '../types';
import type { OverlayHost } from './host';
import { TYPE_COLORS, TYPE_LABELS } from './underlines';

export interface CardCallbacks {
  onApply(issue: DocIssue): void;
  onDismiss(issue: DocIssue): void;
  onAddToDictionary?(word: string): void;
  onIgnoreAll?(word: string): void;
}

const GAP = 6;
const VIEWPORT_MARGIN = 8;
let cardCounter = 0;

/**
 * The floating suggestion card. All model-derived strings are inserted via
 * textContent — model output must never become markup.
 */
export class SuggestionCard {
  private card: HTMLDivElement | null = null;
  private currentIssueId: string | null = null;
  private pointerInside = false;
  private returnFocus: HTMLElement | null = null;
  private onWindowPointerDown = (e: PointerEvent) => {
    if (!this.card) return;
    const path = e.composedPath();
    if (!path.includes(this.card)) this.hide();
  };
  private onWindowKeyDown = (e: KeyboardEvent) => {
    if (!this.card) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.hide(true);
      return;
    }
    if (e.key !== 'Tab' || !this.returnFocus) return;

    const controls = Array.from(
      this.card.querySelectorAll<HTMLButtonElement>('button:not([disabled])'),
    );
    if (controls.length === 0) return;
    const first = controls[0]!;
    const last = controls[controls.length - 1]!;
    const active = this.host.root.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
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

    const active = this.host.root.activeElement;
    this.returnFocus =
      active instanceof HTMLElement && active.classList.contains('ink-seg') ? active : null;

    const card = document.createElement('div');
    card.className = 'ink-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'false');

    const cardId = ++cardCounter;
    const titleId = `inkwell-suggestion-title-${cardId}`;
    const explanationId = `inkwell-suggestion-explanation-${cardId}`;
    card.setAttribute('aria-labelledby', titleId);

    const typeRow = document.createElement('div');
    typeRow.className = 'ink-card-type';
    typeRow.id = titleId;
    const dot = document.createElement('span');
    dot.className = 'ink-card-dot';
    dot.style.background = TYPE_COLORS[issue.type];
    dot.setAttribute('aria-hidden', 'true');
    const typeLabel = document.createElement('span');
    typeLabel.textContent = `${TYPE_LABELS[issue.type]} suggestion`;
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
    explanation.id = explanationId;
    explanation.textContent = issue.explanation;

    const buttons = document.createElement('div');
    buttons.className = 'ink-card-buttons';
    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'ink-card-btn ink-card-btn-apply';
    applyBtn.textContent = 'Apply';
    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'ink-card-btn ink-card-btn-dismiss';
    dismissBtn.textContent = 'Dismiss';
    // Pointer users keep the editable's selection. The actual action stays on
    // native `click`, so Enter and Space work without custom key handlers.
    buttons.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    applyBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.hide();
      this.callbacks.onApply(issue);
    });
    dismissBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.hide();
      this.callbacks.onDismiss(issue);
    });
    buttons.append(applyBtn, dismissBtn);
    if (issue.type === 'spelling') {
      if (this.callbacks.onAddToDictionary) {
        const addToDictionaryBtn = document.createElement('button');
        addToDictionaryBtn.type = 'button';
        addToDictionaryBtn.className =
          'ink-card-btn ink-card-btn-dismiss ink-card-btn-add-dictionary';
        addToDictionaryBtn.textContent = 'Add to dictionary';
        addToDictionaryBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.hide(true);
          this.callbacks.onAddToDictionary?.(issue.original);
        });
        buttons.append(addToDictionaryBtn);
      }
      if (this.callbacks.onIgnoreAll) {
        const ignoreAllBtn = document.createElement('button');
        ignoreAllBtn.type = 'button';
        ignoreAllBtn.className = 'ink-card-btn ink-card-btn-dismiss ink-card-btn-ignore-all';
        ignoreAllBtn.textContent = 'Ignore all';
        ignoreAllBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.hide(true);
          this.callbacks.onIgnoreAll?.(issue.original);
        });
        buttons.append(ignoreAllBtn);
      }
      buttons.style.flexWrap = 'wrap';
    }

    card.append(typeRow, change);
    if (issue.explanation) {
      card.setAttribute('aria-describedby', explanationId);
      card.append(explanation);
    }
    card.append(buttons);

    card.addEventListener('pointerenter', () => {
      this.pointerInside = true;
    });
    card.addEventListener('pointerleave', () => {
      this.pointerInside = false;
    });
    // Closed shadow roots retarget events at the host boundary. Stop internal
    // presses here and keep the page-level outside listener in bubble phase.
    card.addEventListener('pointerdown', (e) => e.stopPropagation());
    card.addEventListener('click', (e) => e.stopPropagation());

    this.host.cardLayer.appendChild(card);
    this.card = card;
    this.currentIssueId = issue.id;

    if (this.returnFocus) applyBtn.focus();

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

    window.addEventListener('pointerdown', this.onWindowPointerDown);
    window.addEventListener('keydown', this.onWindowKeyDown, true);
  }

  hide(restoreFocus = false): void {
    const card = this.card;
    if (!card) return;
    const target = this.returnFocus;
    // Clear the observable state before touching the focused DOM. Removing a
    // focused card can synchronously trigger field deactivation, which calls
    // hide again. The re-entrant call must see an already-closed card.
    this.card = null;
    this.currentIssueId = null;
    this.pointerInside = false;
    this.returnFocus = null;
    window.removeEventListener('pointerdown', this.onWindowPointerDown);
    window.removeEventListener('keydown', this.onWindowKeyDown, true);
    card.remove();
    if (restoreFocus && target?.isConnected) target.focus();
  }
}
