// PDF bytes stay local. PDF.js asks for bounded slices instead of a base64 copy.
import * as pdfjs from '/vendor/pdfjs/build/pdf.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.mjs';
export const MAX_PDF_BYTES = 200 * 1024 * 1024;

export async function openPdf(blob) {
  if (!blob || blob.size > MAX_PDF_BYTES) throw new Error('PDF 不能超过 200 MB');
  const header = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
  if (!new TextDecoder().decode(header.slice(0, 1024)).includes('%PDF-')) throw new Error('文件不是有效的 PDF');
  const range = new pdfjs.PDFDataRangeTransport(blob.size, header);
  let task;
  range.requestDataRange = (begin, end) => {
    blob.slice(begin, end).arrayBuffer().then(bytes => range.onDataRange(begin, new Uint8Array(bytes))).catch(() => task?.destroy());
  };
  task = pdfjs.getDocument({range, length:blob.size, disableAutoFetch:true, disableStream:true,
    rangeChunkSize:65536, isEvalSupported:false,
    cMapUrl:'/vendor/pdfjs/cmaps/', cMapPacked:true,
    standardFontDataUrl:'/vendor/pdfjs/standard_fonts/', wasmUrl:'/vendor/pdfjs/wasm/'});
  try {
    const pdf = await task.promise;
    // PDF.js 6 exposes disposal on loadingTask. Keep the shared workspace's
    // existing document.destroy() contract for all import and preview callers.
    if (typeof pdf.destroy !== 'function') pdf.destroy = () => task.destroy();
    return pdf;
  }
  catch (error) {
    await task.destroy();
    if (error.name === 'PasswordException') throw new Error('这份 PDF 有密码保护，请先解锁再导入');
    throw new Error(`无法打开 PDF：${error.message}`);
  }
}

export async function renderPdfPage(pdf, number, rotation = 0, maxSide = 2400) {
  const page = await pdf.getPage(number);
  const angle = (page.rotate + rotation) % 360;
  const base = page.getViewport({scale:1, rotation:angle});
  const viewport = page.getViewport({scale:Math.min(maxSide / Math.max(base.width, base.height), 3), rotation:angle});
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
  try {
    await page.render({canvasContext:canvas.getContext('2d'), viewport, background:'white'}).promise;
    return canvas.toDataURL('image/jpeg', .9);
  } finally { canvas.width=canvas.height=0; page.cleanup(); }
}

// Reads the PDF's existing text layer. This deliberately does not run OCR.
export async function extractPdfTextPages(pdf) {
  const pages = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number);
    try {
      const content = await page.getTextContent({ includeMarkedContent: false });
      const rows = [];
      for (const item of content.items) {
        if (typeof item.str !== 'string' || !item.str.trim()) continue;
        const x = item.transform?.[4] ?? 0;
        const y = item.transform?.[5] ?? 0;
        const tolerance = Math.max(2, (item.height || 10) * 0.35);
        let row = rows.find(candidate => Math.abs(candidate.y - y) <= tolerance);
        if (!row) rows.push(row = { y, items: [] });
        row.items.push({ x, width: item.width || 0, text: item.str, hasEOL: Boolean(item.hasEOL) });
      }
      const text = rows.sort((a, b) => b.y - a.y).map(row => {
        const items = row.items.sort((a, b) => a.x - b.x);
        let line = '';
        let previous;
        for (const item of items) {
          if (previous && line && !/\s$/.test(line) && !/^\s/.test(item.text)) {
            const gap = item.x - (previous.x + previous.width);
            if (gap > 2 && /[\p{L}\p{N}]$/u.test(line) && /^[\p{L}\p{N}]/u.test(item.text)) line += ' ';
          }
          line += item.text;
          previous = item;
        }
        return line.trim();
      }).filter(Boolean).join('\n').trim();
      pages.push(text);
    } finally {
      page.cleanup();
    }
  }
  return pages;
}
