// Builds a genuine .docx from plain text. The four files below are the
// minimum Word and Google Docs will open: content types, the package
// relationships, the document body, and the document's own relationships.
import { createZip } from './zipWriter';

/**
 * Drops characters XML 1.0 forbids, which Word rejects the whole file over.
 * Tab, newline and carriage return are legal and deliberately kept. Done by
 * code point rather than a regex literal so the control characters never have
 * to survive a round trip through source encoding.
 */
function stripInvalidXmlChars(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0)!;
    if (code === 0x09 || code === 0x0a || code === 0x0d || code >= 0x20) out += ch;
  }
  return out;
}

function escapeXml(s: string): string {
  return stripInvalidXmlChars(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** One <w:p> per line, with tabs preserved as real tab runs. */
function paragraphXml(line: string): string {
  if (line === '') return '<w:p/>';
  const runs = line
    .split('\t')
    .map((part) => (part === '' ? '' : `<w:t xml:space="preserve">${escapeXml(part)}</w:t>`))
    .join('<w:tab/>');
  return `<w:p><w:r>${runs}</w:r></w:p>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

export function buildDocx(text: string, title?: string): Uint8Array {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const titlePara = title
    ? `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(title)}</w:t></w:r></w:p>`
    : '';
  const body = titlePara + lines.map(paragraphXml).join('');

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`;

  return createZip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    { name: '_rels/.rels', content: PACKAGE_RELS },
    { name: 'word/document.xml', content: documentXml },
    { name: 'word/_rels/document.xml.rels', content: DOCUMENT_RELS },
  ]);
}
