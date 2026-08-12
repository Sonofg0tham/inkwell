import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('release hygiene', () => {
  it('ignores common private-key, credential and local browser artefacts', () => {
    const ignore = fs.readFileSync(path.resolve(__dirname, '../.gitignore'), 'utf8');
    for (const pattern of ['*.pem', '*.key', 'credentials*.json', '.agents/', '.playwright-mcp/']) {
      expect(ignore.split(/\r?\n/)).toContain(pattern);
    }
  });

  it('keeps the heavy PDF reader behind the dynamic import boundary', () => {
    const importer = fs.readFileSync(path.resolve(__dirname, '../lib/import/index.ts'), 'utf8');
    expect(importer).not.toMatch(/from ['"]\.\/pdf['"]/);
    expect(importer).toContain("await import('./pdf')");
  });

  it('uses the PDF.js legacy bundle required by the advertised browser floor', () => {
    const pdfImporter = fs.readFileSync(path.resolve(__dirname, '../lib/import/pdf.ts'), 'utf8');
    expect(pdfImporter).toContain("import('pdfjs-dist/legacy/build/pdf.mjs')");
    expect(pdfImporter).toContain("import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')");
    expect(pdfImporter).not.toContain("import('pdfjs-dist/build/pdf.worker.min.mjs?url')");
  });
});
