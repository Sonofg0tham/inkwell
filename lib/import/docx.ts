// Extracts readable text from a .docx. A docx is a ZIP whose main body lives
// in word/document.xml as WordprocessingML, so this walks paragraphs rather
// than stripping tags with a regex (which would glue words together).
import { readZipEntry, ZipError } from './zip';

export class DocxError extends Error {}

const UNSUPPORTED_XML_DECLARATION = /<!\s*(?:DOCTYPE|ENTITY)\b/iu;

const SKIP_ELEMENTS = new Set([
  'instrText', // field codes, e.g. page numbers
  'delText', // tracked deletions — not part of the current text
  'proofErr',
]);

/** Depth-first walk collecting the visible run text of one paragraph. */
function paragraphText(paragraph: Element): string {
  let out = '';
  const walk = (node: Node) => {
    if (node.nodeType === 3) return; // handled via the w:t branch below
    const el = node as Element;
    if (el.nodeType !== 1) return;
    const name = el.localName;
    if (SKIP_ELEMENTS.has(name)) return;
    if (name === 't') {
      out += el.textContent ?? '';
      return;
    }
    if (name === 'tab') {
      out += '\t';
      return;
    }
    if (name === 'br' || name === 'cr') {
      out += '\n';
      return;
    }
    for (const child of Array.from(el.childNodes)) walk(child);
  };
  for (const child of Array.from(paragraph.childNodes)) walk(child);
  return out;
}

/** Converts WordprocessingML to plain text, one line per paragraph. */
export function documentXmlToText(xml: string): string {
  if (UNSUPPORTED_XML_DECLARATION.test(xml)) {
    throw new DocxError('The document contains unsupported XML declarations.');
  }

  // This creates a detached XML document. Parsed nodes are never attached to
  // an HTML document, and this module only reads textContent from w:t nodes.
  // codeql[js/xss-through-dom]
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new DocxError('The document’s contents could not be read.');
  }

  const paragraphs: string[] = [];
  const all = doc.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i]!;
    if (el.localName === 'p') paragraphs.push(paragraphText(el));
  }

  return paragraphs
    .join('\n')
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function extractDocxText(buffer: ArrayBuffer): Promise<string> {
  let xml: string | null;
  try {
    xml = await readZipEntry(buffer, 'word/document.xml');
  } catch (err) {
    if (err instanceof ZipError) throw new DocxError(err.message);
    throw err;
  }
  if (xml === null) {
    throw new DocxError(
      'That doesn’t look like a Word document. If it’s an older .doc file, open it in Word and save as .docx first.',
    );
  }
  return documentXmlToText(xml);
}
