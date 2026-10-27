import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

/** Writes an A4 PDF. The HTML must already be self-contained. */
export async function renderReportPdf(html: string, outPath: string): Promise<void> {
  await mkdir(path.dirname(outPath), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({
      path: outPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '14mm', right: '14mm', bottom: '14mm', left: '14mm' },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: '<div style="width:100%;font-size:9px;text-align:center;color:#52525b;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    });
  } finally {
    await browser.close();
  }
}
