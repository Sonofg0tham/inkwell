// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { applyFix } from '../lib/content/applyFix';
import { buildTextIndex, rangeFromOffsets } from '../lib/content/textIndex';
import type { DocIssue } from '../lib/content/types';

describe('contenteditable atomic nodes', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('keeps model ranges from crossing a non-editable mention', () => {
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    editor.append(document.createTextNode('Hello '));
    const mention = document.createElement('span');
    mention.contentEditable = 'false';
    mention.textContent = '@Craig';
    editor.append(mention, document.createTextNode('teh'));
    document.body.append(editor);

    const index = buildTextIndex(editor);
    expect(index.text).toBe('Hello \nteh');

    const issue: DocIssue = {
      id: 'crosses-mention',
      type: 'grammar',
      start: 0,
      end: index.text.length,
      docStart: 0,
      docEnd: index.text.length,
      original: index.text,
      replacement: 'Hi',
      explanation: 'Shorten the greeting.',
      chunkHash: 'chunk',
    };

    expect(applyFix({ kind: 'contenteditable', el: editor }, issue)).toBe(false);
    expect(mention.isConnected).toBe(true);
    expect(editor.textContent).toBe('Hello @Craigteh');
  });

  it('keeps an inline replacement inside the following formatted text node', () => {
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    editor.innerHTML = '<strong id="format-token">Keep this:</strong> <span id="nested-input">She walk home.</span>';
    document.body.append(editor);
    const nestedInput = editor.querySelector<HTMLElement>('#nested-input')!;
    const index = buildTextIndex(editor);
    const start = index.text.indexOf('She walk');
    const range = rangeFromOffsets(index, start, start + 'She walk'.length);

    expect(range?.startContainer).toBe(nestedInput.firstChild);
    expect(range?.startOffset).toBe(0);

    const issue: DocIssue = {
      id: 'nested-inline-replacement',
      type: 'grammar',
      start,
      end: start + 'She walk'.length,
      docStart: start,
      docEnd: start + 'She walk'.length,
      original: 'She walk',
      replacement: 'She walks',
      explanation: 'Make the subject and verb agree.',
      chunkHash: 'chunk',
    };

    expect(applyFix({ kind: 'contenteditable', el: editor }, issue)).toBe(true);
    expect(nestedInput.textContent).toBe('She walks home.');
    expect(editor.querySelector('#format-token')?.textContent).toBe('Keep this:');
  });

  it('uses a collapsed native insertion for a suffix added inside formatted text', () => {
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    editor.innerHTML = '<strong>Keep this:</strong> <span id="nested-input">She walk home.</span>';
    document.body.append(editor);
    const nestedInput = editor.querySelector<HTMLElement>('#nested-input')!;
    const index = buildTextIndex(editor);
    const start = index.text.indexOf('She walk');
    const inserted: string[] = [];

    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: (_command: string, _showUi: boolean, value: string) => {
        inserted.push(value);
        const selection = document.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        if (!range || !range.collapsed || range.startContainer.nodeType !== Node.TEXT_NODE) {
          return false;
        }
        (range.startContainer as Text).insertData(range.startOffset, value);
        return true;
      },
    });

    const issue: DocIssue = {
      id: 'nested-inline-native-insertion',
      type: 'grammar',
      start,
      end: start + 'She walk'.length,
      docStart: start,
      docEnd: start + 'She walk'.length,
      original: 'She walk',
      replacement: 'She walks',
      explanation: 'Make the subject and verb agree.',
      chunkHash: 'chunk',
    };

    const applied = applyFix({ kind: 'contenteditable', el: editor }, issue);
    Reflect.deleteProperty(document, 'execCommand');

    expect(applied).toBe(true);
    expect(inserted).toEqual(['s']);
    expect(nestedInput.textContent).toBe('She walks home.');
  });

  it('applies a suffix insertion at the end of the final formatted text node', () => {
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    editor.innerHTML = '<span id="terminal-input">She walk</span>';
    document.body.append(editor);
    const terminalInput = editor.querySelector<HTMLElement>('#terminal-input')!;

    const issue: DocIssue = {
      id: 'terminal-suffix-insertion',
      type: 'grammar',
      start: 0,
      end: 'She walk'.length,
      docStart: 0,
      docEnd: 'She walk'.length,
      original: 'She walk',
      replacement: 'She walks',
      explanation: 'Make the subject and verb agree.',
      chunkHash: 'chunk',
    };

    expect(applyFix({ kind: 'contenteditable', el: editor }, issue)).toBe(true);
    expect(terminalInput.textContent).toBe('She walks');
  });

  it('keeps a suffix insertion in the preceding inline element', () => {
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    editor.innerHTML = '<span id="first-inline">She walk</span><em id="second-inline"> home.</em>';
    document.body.append(editor);
    const firstInline = editor.querySelector<HTMLElement>('#first-inline')!;
    const secondInline = editor.querySelector<HTMLElement>('#second-inline')!;

    const issue: DocIssue = {
      id: 'inline-boundary-suffix',
      type: 'grammar',
      start: 0,
      end: 'She walk'.length,
      docStart: 0,
      docEnd: 'She walk'.length,
      original: 'She walk',
      replacement: 'She walks',
      explanation: 'Make the subject and verb agree.',
      chunkHash: 'chunk',
    };

    expect(applyFix({ kind: 'contenteditable', el: editor }, issue)).toBe(true);
    expect(firstInline.textContent).toBe('She walks');
    expect(secondInline.textContent).toBe(' home.');
  });

  it('keeps a prefix insertion in the following inline element', () => {
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    editor.innerHTML = '<strong id="label-inline">Label: </strong><span id="word-inline">walk</span>';
    document.body.append(editor);
    const labelInline = editor.querySelector<HTMLElement>('#label-inline')!;
    const wordInline = editor.querySelector<HTMLElement>('#word-inline')!;
    const docStart = 'Label: '.length;

    const issue: DocIssue = {
      id: 'inline-boundary-prefix',
      type: 'spelling',
      start: docStart,
      end: docStart + 'walk'.length,
      docStart,
      docEnd: docStart + 'walk'.length,
      original: 'walk',
      replacement: 'swalk',
      explanation: 'Add the missing first letter.',
      chunkHash: 'chunk',
    };

    expect(applyFix({ kind: 'contenteditable', el: editor }, issue)).toBe(true);
    expect(labelInline.textContent).toBe('Label: ');
    expect(wordInline.textContent).toBe('swalk');
  });

  it.each([
    'img',
    'hr',
    'svg',
    'canvas',
    'iframe',
    'object',
    'embed',
    'video',
    'audio',
    'input',
    'textarea',
    'select',
    'button',
  ])('keeps a correction from crossing and deleting an atomic <%s> node', (tagName) => {
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    const atomic =
      tagName === 'svg'
        ? document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        : document.createElement(tagName);
    editor.append(document.createTextNode('Before'), atomic, document.createTextNode('after'));
    document.body.append(editor);

    const index = buildTextIndex(editor);

    const issue: DocIssue = {
      id: `crosses-${tagName}`,
      type: 'grammar',
      start: 0,
      end: index.text.length,
      docStart: 0,
      docEnd: index.text.length,
      original: index.text,
      replacement: 'Changed',
      explanation: 'Replace text around the atomic node.',
      chunkHash: 'chunk',
    };

    expect(applyFix({ kind: 'contenteditable', el: editor }, issue)).toBe(false);
    expect(atomic.isConnected).toBe(true);
    expect(editor.textContent).toBe('Beforeafter');
    expect(index.text).toBe('Before\nafter');
  });
});
