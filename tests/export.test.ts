// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { buildDocx } from '../lib/export/docx';
import { createZip } from '../lib/export/zipWriter';
import { buildPrintHtml, safeFilename } from '../lib/export/index';
import { extractDocxText } from '../lib/import/docx';
import { readZipEntry } from '../lib/import/zip';

describe('zip writer', () => {
  it('produces an archive our own reader can open', async () => {
    const zip = createZip([
      { name: 'a.txt', content: 'hello' },
      { name: 'nested/b.txt', content: 'world' },
    ]);
    expect(await readZipEntry(zip.buffer as ArrayBuffer, 'a.txt')).toBe('hello');
    expect(await readZipEntry(zip.buffer as ArrayBuffer, 'nested/b.txt')).toBe('world');
  });

  it('writes a correct CRC32 and sizes for each entry', async () => {
    const payload = 'The quick brown fox';
    const zip = createZip([{ name: 'x.txt', content: payload }]);
    const view = new DataView(zip.buffer as ArrayBuffer);
    // Local header: signature, stored method, matching compressed/uncompressed size.
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(8, true)).toBe(0); // stored
    expect(view.getUint32(18, true)).toBe(view.getUint32(22, true));
    expect(view.getUint32(18, true)).toBe(new TextEncoder().encode(payload).length);
    // CRC checked against an independent implementation, not our own.
    expect(view.getUint32(14, true)).toBe(zlibCrc32(Buffer.from(payload, 'utf8')) >>> 0);
  });

  it('handles unicode content and filenames', async () => {
    const zip = createZip([{ name: 'ünï.txt', content: 'héllo — wörld … 😀' }]);
    expect(await readZipEntry(zip.buffer as ArrayBuffer, 'ünï.txt')).toBe('héllo — wörld … 😀');
  });
});

describe('docx export', () => {
  async function roundTrip(text: string, title?: string): Promise<string> {
    const bytes = buildDocx(text, title);
    return extractDocxText(bytes.buffer as ArrayBuffer);
  }

  it('round-trips plain text through our own docx reader', async () => {
    const text = 'Their was a problem.\nWe fixed it.';
    const out = await roundTrip(text);
    expect(out).toContain('Their was a problem.');
    expect(out).toContain('We fixed it.');
  });

  it('keeps paragraphs on separate lines', async () => {
    const out = await roundTrip('First para.\nSecond para.\nThird para.');
    const lines = out.split('\n').filter((l) => l.trim() !== '');
    expect(lines).toEqual(['First para.', 'Second para.', 'Third para.']);
  });

  it('includes the title as the first line when given', async () => {
    const out = await roundTrip('Body text here.', 'My Report');
    expect(out.split('\n')[0]).toBe('My Report');
  });

  it('escapes XML metacharacters instead of corrupting the file', async () => {
    const text = 'Tom & Jerry <script>alert("x")</script> "quoted" it\'s';
    const out = await roundTrip(text);
    expect(out).toContain('Tom & Jerry');
    expect(out).toContain('<script>alert("x")</script>');
    expect(out).toContain("it's");
  });

  it('preserves tabs inside a line', async () => {
    const out = await roundTrip('Column A\tColumn B');
    expect(out).toContain('Column A\tColumn B');
  });

  it('survives unicode and emoji', async () => {
    const out = await roundTrip('Café — naïve résumé … 😀 日本語');
    expect(out).toContain('Café — naïve résumé … 😀 日本語');
  });

  it('strips control characters that would make Word reject the file', async () => {
    const out = await roundTrip(`Before${String.fromCharCode(7)}After`);
    expect(out).toContain('BeforeAfter');
  });

  it('contains the four parts Word requires', async () => {
    const buf = buildDocx('hi').buffer as ArrayBuffer;
    for (const part of [
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
      'word/_rels/document.xml.rels',
    ]) {
      expect(await readZipEntry(buf, part)).not.toBeNull();
    }
  });

  it('handles an empty document without producing a broken file', async () => {
    const buf = buildDocx('').buffer as ArrayBuffer;
    const xml = await readZipEntry(buf, 'word/document.xml');
    expect(xml).toContain('<w:body>');
    expect(xml).toContain('</w:document>');
  });
});

describe('print view (PDF source)', () => {
  it('renders the title as a heading and in the tab title', () => {
    const html = buildPrintHtml('Release notes', 'Body.');
    expect(html).toContain('<title>Release notes</title>');
    expect(html).toContain('<h1 id="ink-title">Release notes</h1>');
  });

  it('splits blank-line-separated blocks into paragraphs', () => {
    const html = buildPrintHtml('T', 'First para.\n\nSecond para.\n\nThird.');
    const paras = html.match(/<p>[\s\S]*?<\/p>/g) ?? [];
    expect(paras).toHaveLength(3);
    expect(paras[1]).toContain('Second para.');
  });

  it('keeps single newlines inside a paragraph (pre-wrap handles them)', () => {
    const html = buildPrintHtml('T', 'Line one\nLine two');
    const paras = html.match(/<p>[\s\S]*?<\/p>/g) ?? [];
    expect(paras).toHaveLength(1);
    expect(paras[0]).toContain('Line one\nLine two');
    expect(html).toContain('white-space: pre-wrap');
  });

  it('escapes HTML so document text can never become markup', () => {
    const html = buildPrintHtml('<img src=x onerror=alert(1)>', '<script>alert("xss")</script>');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img src=x');
  });

  it('sets A4 page setup for printing', () => {
    const html = buildPrintHtml('T', 'x');
    expect(html).toContain('@page');
    expect(html).toContain('size: A4');
  });
});

describe('safeFilename', () => {
  it('strips characters Windows forbids', () => {
    expect(safeFilename('a/b\\c:d*e?f"g<h>i|j', 'txt')).toBe('abcdefghij.txt');
  });

  it('falls back when the title is empty', () => {
    expect(safeFilename('   ', 'pdf')).toBe('Untitled document.pdf');
  });

  it('caps very long titles', () => {
    expect(safeFilename('x'.repeat(200), 'md').length).toBeLessThanOrEqual(84);
  });
});
