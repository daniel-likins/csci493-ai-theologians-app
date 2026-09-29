import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export interface PdfPageText {
  page: number;
  text: string;
}

export interface PdfExtraction {
  status: 'ok' | 'partial' | 'no_text' | 'error';
  pages: PdfPageText[];
  pageCount: number;
  detail: string | null;
}

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsPromise: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((pdfjs) => {
    const require = createRequire(import.meta.url);
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
    return pdfjs;
  });
  return pdfjsPromise;
}

const MIN_PAGE_CHARS = 20;

/**
 * Extract text page by page, keeping page numbers. Scanned PDFs (no text layer) are reported as such —
 * there is no OCR, and nothing is invented.
 */
export async function extractPdfText(data: Uint8Array, maxPages = 2000): Promise<PdfExtraction> {
  const pdfjs = await loadPdfJs();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  let doc: Awaited<(typeof loadingTask)['promise']>;
  try {
    doc = await loadingTask.promise;
  } catch (err) {
    await loadingTask.destroy().catch(() => undefined);
    const name = (err as { name?: string } | null)?.name;
    if (name === 'PasswordException') {
      return { status: 'error', pages: [], pageCount: 0, detail: "This PDF is password-protected, so its text can't be read." };
    }
    return {
      status: 'error',
      pages: [],
      pageCount: 0,
      detail: `This file couldn't be read as a PDF (${err instanceof Error ? err.message : 'unknown error'}).`,
    };
  }

  const pageCount = doc.numPages;
  const limit = Math.min(pageCount, maxPages);
  const pages: PdfPageText[] = [];
  let emptyPages = 0;
  try {
    for (let i = 1; i <= limit; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if ('str' in item) {
          text += item.str;
          text += item.hasEOL ? '\n' : ' ';
        }
      }
      text = text
        .replace(/[ \t]+\n/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (text.length < MIN_PAGE_CHARS) emptyPages++;
      pages.push({ page: i, text });
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }

  const notes: string[] = [];
  let status: PdfExtraction['status'] = 'ok';
  if (emptyPages === limit) {
    status = 'no_text';
    notes.push(
      "No extractable text — this PDF looks like scanned images. Theologians doesn't run OCR; a model that reads PDFs directly may still be able to see it.",
    );
  } else if (emptyPages > 0) {
    status = 'partial';
    notes.push(`${emptyPages} of ${limit} pages had no extractable text (possibly scanned pages or images).`);
  }
  if (pageCount > limit) notes.push(`Only the first ${limit} of ${pageCount} pages were indexed.`);
  return { status, pages, pageCount, detail: notes.length ? notes.join(' ') : null };
}
