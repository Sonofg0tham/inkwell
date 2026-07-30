// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { documentXmlToText, extractDocxText } from '../lib/import/docx';
import { readZipEntry } from '../lib/import/zip';
import { importFile, isSupportedFile, MAX_TEXT_CHARS } from '../lib/import/index';

// ── Minimal ZIP writer, so the tests exercise a real archive ─────────
function crc32(buf: Uint8Array): number {
  let table = (crc32 as any)._t as number[] | undefined;
  if (!table) {
    table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    (crc32 as any)._t = table;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = (crc >>> 8) ^ table[(crc ^ b) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries: Array<{ name: string; content: string; store?: boolean }>): ArrayBuffer {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const raw = enc.encode(entry.content);
    const data = entry.store ? raw : new Uint8Array(deflateRawSync(Buffer.from(raw)));
    const method = entry.store ? 0 : 8;
    const crc = crc32(raw);

    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((a, c) => a + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const l of locals) { out.set(l, at); at += l.length; }
  for (const c of centrals) { out.set(c, at); at += c.length; }
  out.set(eocd, at);
  return out.buffer;
}

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Their was a problem</w:t></w:r><w:r><w:t xml:space="preserve"> with the code.</w:t></w:r></w:p>
    <w:p><w:r><w:t>Second</w:t></w:r><w:r><w:tab/><w:t>paragraph</w:t></w:r><w:r><w:br/><w:t>after a break.</w:t></w:r></w:p>
    <w:p><w:r><w:instrText>PAGE \\* MERGEFORMAT</w:instrText></w:r><w:r><w:delText>deleted words</w:delText></w:r><w:r><w:t>Kept.</w:t></w:r></w:p>
  </w:body>
</w:document>`;

function fileFrom(name: string, data: ArrayBuffer | string, type = ''): File {
  return new File([data as BlobPart], name, { type });
}

describe('zip reader', () => {
  it('reads a deflated entry', async () => {
    const zip = makeZip([{ name: 'word/document.xml', content: DOCUMENT_XML }]);
    const out = await readZipEntry(zip, 'word/document.xml');
    expect(out).toContain('Their was a problem');
  });

  it('reads a stored (uncompressed) entry', async () => {
    const zip = makeZip([{ name: 'word/document.xml', content: 'plain', store: true }]);
    expect(await readZipEntry(zip, 'word/document.xml')).toBe('plain');
  });

  it('finds the right entry among several', async () => {
    const zip = makeZip([
      { name: '[Content_Types].xml', content: '<types/>' },
      { name: 'word/document.xml', content: DOCUMENT_XML },
      { name: 'docProps/core.xml', content: '<core/>' },
    ]);
    const out = await readZipEntry(zip, 'word/document.xml');
    expect(out).toContain('Second');
  });

  it('returns null for a missing entry', async () => {
    const zip = makeZip([{ name: 'a.txt', content: 'x' }]);
    expect(await readZipEntry(zip, 'word/document.xml')).toBeNull();
  });

  it('rejects data that is not a zip', async () => {
    const bytes = new TextEncoder().encode('this is not a zip file at all');
    await expect(readZipEntry(bytes.buffer as ArrayBuffer, 'word/document.xml')).rejects.toThrow(/valid ZIP/i);
  });
});

describe('docx text extraction', () => {
  it('keeps paragraphs on separate lines', () => {
    const text = documentXmlToText(DOCUMENT_XML);
    const lines = text.split('\n');
    expect(lines[0]).toBe('Their was a problem with the code.');
    expect(text).toContain('Second\tparagraph');
  });

  it('honours tabs and line breaks inside a paragraph', () => {
    expect(documentXmlToText(DOCUMENT_XML)).toContain('paragraph\nafter a break.');
  });

  it('skips field codes and tracked deletions', () => {
    const text = documentXmlToText(DOCUMENT_XML);
    expect(text).not.toContain('MERGEFORMAT');
    expect(text).not.toContain('deleted words');
    expect(text).toContain('Kept.');
  });

  it('extracts from a whole docx archive', async () => {
    const zip = makeZip([
      { name: '[Content_Types].xml', content: '<types/>' },
      { name: 'word/document.xml', content: DOCUMENT_XML },
    ]);
    expect(await extractDocxText(zip)).toContain('Their was a problem');
  });

  it('explains itself when the zip is not a Word file', async () => {
    const zip = makeZip([{ name: 'hello.txt', content: 'hi' }]);
    await expect(extractDocxText(zip)).rejects.toThrow(/Word document/i);
  });
});

describe('importFile', () => {
  it('accepts the documented extensions only', () => {
    expect(isSupportedFile('notes.txt')).toBe(true);
    expect(isSupportedFile('NOTES.MD')).toBe(true);
    expect(isSupportedFile('report.docx')).toBe(true);
    expect(isSupportedFile('report.pdf')).toBe(true);
    expect(isSupportedFile('legacy.doc')).toBe(false);
    expect(isSupportedFile('image.png')).toBe(false);
    expect(isSupportedFile('noextension')).toBe(false);
  });

  it('imports plain text and titles the doc from the filename', async () => {
    const result = await importFile(fileFrom('my_first-draft.txt', 'Their was a problem.'));
    expect(result.text).toBe('Their was a problem.');
    expect(result.title).toBe('my first draft');
  });

  it('normalises CRLF line endings and strips a BOM', async () => {
    const result = await importFile(fileFrom('a.txt', '﻿line one\r\nline two\r\n'));
    expect(result.text).toBe('line one\nline two\n');
  });

  it('imports a docx end to end', async () => {
    const zip = makeZip([{ name: 'word/document.xml', content: DOCUMENT_XML }]);
    const result = await importFile(fileFrom('Quarterly Report.docx', zip));
    expect(result.title).toBe('Quarterly Report');
    expect(result.text).toContain('Their was a problem with the code.');
  });

  it('rejects unsupported types with a helpful message', async () => {
    await expect(importFile(fileFrom('photo.png', 'x'))).rejects.toThrow(/\.txt, \.md, \.docx or \.pdf/);
  });

  it('rejects empty and whitespace-only files', async () => {
    await expect(importFile(fileFrom('empty.txt', ''))).rejects.toThrow(/empty/i);
    await expect(importFile(fileFrom('blank.txt', '   \n\n  '))).rejects.toThrow(/no readable text/i);
  });

  it('truncates very long documents and says so', async () => {
    const huge = 'word '.repeat(MAX_TEXT_CHARS); // far beyond the cap
    const result = await importFile(fileFrom('big.txt', huge));
    expect(result.text.length).toBe(MAX_TEXT_CHARS);
    expect(result.notices[0]).toMatch(/first/i);
  });

  it('reports progress as it works', async () => {
    const seen: string[] = [];
    await importFile(fileFrom('a.txt', 'hello'), (m) => seen.push(m));
    expect(seen.length).toBeGreaterThan(0);
  });
});
