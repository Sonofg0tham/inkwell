// PDF text extraction via pdf.js. Loaded on demand — it is by far the largest
// thing Inkwell ships, and most users never import a PDF.
//
// MV3 notes: the worker is bundled as an extension-origin asset (Vite ?url),
// and isEvalSupported is off because the extension CSP forbids eval.

import { PdfError } from './pdfError';
export { PdfError } from './pdfError';

const MAX_PAGES = 200;

let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

async function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import('pdfjs-dist');
      const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

/**
 * Joins pdf.js text items into readable lines. Items carry no line breaks, so
 * breaks are inferred from vertical position changes in the text matrix.
 */
function itemsToText(items: Array<{ str?: string; transform?: number[]; hasEOL?: boolean }>): string {
  let out = '';
  let lastY: number | null = null;
  for (const item of items) {
    const str = item.str ?? '';
    const y = item.transform?.[5];
    if (lastY !== null && typeof y === 'number' && Math.abs(y - lastY) > 1) {
      out += '\n';
    } else if (out && !out.endsWith(' ') && !out.endsWith('\n') && str && !str.startsWith(' ')) {
      out += ' ';
    }
    out += str;
    if (item.hasEOL) out += '\n';
    if (typeof y === 'number') lastY = y;
  }
  return out;
}

export async function extractPdfText(
  buffer: ArrayBuffer,
  onProgress?: (page: number, total: number) => void,
): Promise<string> {
  const pdfjs = await loadPdfjs().catch(() => {
    throw new PdfError('Inkwell couldn’t load its PDF reader.');
  });

  // pdf.js 6 no longer uses eval, so the extension CSP is satisfied by
  // default. WASM and image decoding are switched off because text extraction
  // never rasterises anything, and wasm-unsafe-eval is not granted to MV3.
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    useWasm: false,
    disableFontFace: true,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
  });

  let doc;
  try {
    doc = await loadingTask.promise;
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (/password/i.test(message)) {
      throw new PdfError('That PDF is password protected, so Inkwell can’t read it.');
    }
    throw new PdfError('That file couldn’t be opened as a PDF.');
  }

  try {
    const pageCount = Math.min(doc.numPages, MAX_PAGES);
    const pages: string[] = [];
    for (let n = 1; n <= pageCount; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pages.push(itemsToText(content.items as Array<{ str?: string }>));
      page.cleanup();
      onProgress?.(n, pageCount);
    }

    const text = pages
      .join('\n\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    if (!text) {
      throw new PdfError(
        'No text found in that PDF. Scanned or image-only PDFs need optical character recognition first.',
      );
    }
    if (doc.numPages > MAX_PAGES) {
      return `${text}\n\n[Inkwell imported the first ${MAX_PAGES} of ${doc.numPages} pages.]`;
    }
    return text;
  } finally {
    await loadingTask.destroy().catch(() => {});
  }
}
