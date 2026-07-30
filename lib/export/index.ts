// Exports a document to disk. Everything happens locally in the page.
import { buildDocx } from './docx';

export type ExportFormat = 'txt' | 'md' | 'docx' | 'pdf';

export const EXPORT_LABELS: Record<ExportFormat, string> = {
  pdf: 'PDF',
  docx: 'Word (.docx)',
  md: 'Markdown (.md)',
  txt: 'Plain text (.txt)',
};

/** Filesystem-safe filename derived from the document title. */
export function safeFilename(title: string, extension: string): string {
  const base = title
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${base || 'Untitled document'}.${extension}`;
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke on the next turn — revoking synchronously can cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * PDF is produced by Chrome's own print engine rather than a bundled PDF
 * writer: correct text shaping, real pagination, full Unicode, selectable
 * text, and nothing to ship. The user picks "Save as PDF" in the print dialog.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The printable document. Exported separately from the window handling so the
 * output can be asserted directly — driving Chrome's print dialog in a test
 * blocks the renderer, so the markup is verified here instead.
 */
export function buildPrintHtml(title: string, text: string): string {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block)}</p>`)
    .join('\n');

  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  @page { size: A4; margin: 20mm; }
  html { -webkit-print-color-adjust: exact; }
  body {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 12pt;
    line-height: 1.65;
    color: #1a1d2b;
    max-width: 42em;
    margin: 0 auto;
    padding: 24px;
  }
  h1 {
    font-size: 20pt;
    line-height: 1.25;
    margin: 0 0 1.2em;
    padding-bottom: 0.4em;
    border-bottom: 1px solid #d8d2c4;
  }
  p { margin: 0 0 0.9em; orphans: 3; widows: 3; white-space: pre-wrap; }
  @media print { .no-print { display: none; } }
  .no-print {
    position: fixed; top: 12px; right: 12px;
    font-family: system-ui, sans-serif; font-size: 13px;
  }
  .no-print button {
    font: inherit; font-weight: 600; padding: 8px 16px; border-radius: 8px;
    border: none; background: #c2410c; color: #fff; cursor: pointer;
  }
</style></head>
<body>
<div class="no-print"><button id="ink-print">Save as PDF</button></div>
<h1 id="ink-title">${escapeHtml(title)}</h1>
<div id="ink-body">
${paragraphs}
</div>
</body></html>`;
}

export function openPrintView(title: string, text: string): boolean {
  // A Blob URL rather than writing into an about:blank window: Chrome replaces
  // that initial document asynchronously, which silently wiped the content.
  const url = URL.createObjectURL(new Blob([buildPrintHtml(title, text)], { type: 'text/html' }));
  const win = window.open(url, '_blank', 'width=820,height=900');
  if (!win) {
    URL.revokeObjectURL(url);
    return false;
  }
  win.focus();

  // Inline handlers are blocked by the extension CSP, so the button is wired
  // from here once the document exists, and the dialog is offered a beat later.
  const ready = () => {
    try {
      win.document.getElementById('ink-print')?.addEventListener('click', () => win.print());
    } catch {
      // cross-document timing — the print dialog below still works
    }
  };
  setTimeout(ready, 150);
  setTimeout(() => {
    try {
      win.print();
    } catch {
      // The user can still press the button.
    }
  }, 600);
  // Revoked late: pulling the URL out from under a slow load would blank the
  // window, which is exactly the failure this Blob approach replaced.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

export function exportDocument(format: ExportFormat, title: string, text: string): boolean {
  switch (format) {
    case 'pdf':
      return openPrintView(title, text);
    case 'docx':
      download(
        new Blob([buildDocx(text, title) as BlobPart], {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
        safeFilename(title, 'docx'),
      );
      return true;
    case 'md':
      download(
        new Blob([`# ${title}\n\n${text}\n`], { type: 'text/markdown;charset=utf-8' }),
        safeFilename(title, 'md'),
      );
      return true;
    case 'txt':
    default:
      download(new Blob([text], { type: 'text/plain;charset=utf-8' }), safeFilename(title, 'txt'));
      return true;
  }
}
