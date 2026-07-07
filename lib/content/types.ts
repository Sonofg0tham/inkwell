import type { IssueDto } from '../messaging/protocol';

export type FieldTarget =
  | { kind: 'textarea'; el: HTMLTextAreaElement }
  | { kind: 'input'; el: HTMLInputElement }
  | { kind: 'contenteditable'; el: HTMLElement };

/** An issue anchored to document-level offsets within a field. */
export interface DocIssue extends IssueDto {
  docStart: number;
  docEnd: number;
  chunkHash: string;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function intersectRect(a: Rect, b: Rect): Rect | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  if (right - left < 1 || bottom - top < 1) return null;
  return { left, top, width: right - left, height: bottom - top };
}
