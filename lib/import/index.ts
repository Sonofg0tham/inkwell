// Turns a picked or dropped file into plain text for a new Inkwell document.
// Everything runs locally in the page — no upload, no server.
import { DocxError, extractDocxText } from './docx';
import { PdfError } from './pdfError';

export class ImportError extends Error {}

/** Beyond this the editor and storage quota both start to struggle. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_TEXT_CHARS = 400_000;

export const ACCEPTED_EXTENSIONS = ['.txt', '.md', '.markdown', '.text', '.docx', '.pdf'] as const;

export interface ImportResult {
  title: string;
  text: string;
  /** Non-fatal notes to show the user, e.g. truncation. */
  notices: string[];
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

function titleFromFilename(name: string): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  return base.replace(/[_-]+/g, ' ').trim() || 'Imported document';
}

export function isSupportedFile(name: string): boolean {
  return (ACCEPTED_EXTENSIONS as readonly string[]).includes(extensionOf(name));
}

export async function importFile(
  file: File,
  onProgress?: (message: string) => void,
): Promise<ImportResult> {
  const ext = extensionOf(file.name);
  if (!isSupportedFile(file.name)) {
    throw new ImportError(
      `Inkwell can’t read ${ext || 'that kind of file'}. Try a .txt, .md, .docx or .pdf file.`,
    );
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new ImportError('That file is bigger than 20 MB, which is too large to import.');
  }
  if (file.size === 0) {
    throw new ImportError('That file is empty.');
  }

  const notices: string[] = [];
  let text: string;

  try {
    if (ext === '.pdf') {
      onProgress?.('Reading PDF…');
      // Dynamic import keeps pdf.js out of the main bundle.
      const { extractPdfText } = await import('./pdf');
      text = await extractPdfText(await file.arrayBuffer(), (page, total) =>
        onProgress?.(`Reading PDF… page ${page} of ${total}`),
      );
    } else if (ext === '.docx') {
      onProgress?.('Reading document…');
      text = await extractDocxText(await file.arrayBuffer());
    } else {
      onProgress?.('Reading file…');
      text = await file.text();
    }
  } catch (err) {
    if (err instanceof DocxError || err instanceof PdfError || err instanceof ImportError) {
      throw new ImportError(err.message);
    }
    throw new ImportError('Inkwell couldn’t read that file.');
  }

  // Strip BOM and normalise line endings so the checker sees clean offsets.
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');

  if (!text.trim()) {
    throw new ImportError('That file has no readable text in it.');
  }
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS);
    notices.push(`Only the first ${MAX_TEXT_CHARS.toLocaleString('en-GB')} characters were imported.`);
  }

  return { title: titleFromFilename(file.name), text, notices };
}
