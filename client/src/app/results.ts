import { Component, computed, input, output, signal } from '@angular/core';
import { ImageRecord, PdfDoc, Summary, fileName, folderName, formatSize, originalSize, pdfPill, statusPill, thumbUrl } from './models';

import { Pager } from './pager';

// How many PDF rows the Results table shows on one page.
const PDF_PAGE_SIZE = 50;

// The Results screen: every file, what happened, sizes, and total space saved.
@Component({
  imports: [Pager],
  selector: 'app-results',
  templateUrl: './results.html',
  styleUrl: './results.css',
})
export class Results {
  // The server sends only the page of images we show, plus the totals for the whole list.
  items = input.required<ImageRecord[]>();
  total = input.required<number>();
  page = input.required<number>();
  pageSize = input.required<number>();
  summary = input.required<Summary>();
  docs = input<Record<string, PdfDoc | undefined>>({}); // every PDF found by Scan
  pageChange = output<number>();

  // Which list is showing. Until you choose, it is the images (or the PDFs, when there are no images).
  private kindWanted = signal<'images' | 'pdfs' | null>(null);
  kind = computed(() => this.kindWanted() ?? (this.total() === 0 && this.pdfList().length > 0 ? 'pdfs' : 'images'));
  setKind(k: 'images' | 'pdfs') {
    this.kindWanted.set(k);
  }

  goImgPage(n: number) {
    this.pageChange.emit(n);
  }

  // PDFs: their own page counter (the list of PDFs we worked on is small, so it is paged here).
  pdfPageSize = PDF_PAGE_SIZE;
  private pdfPageWanted = signal(1);
  pdfPage = computed(() => Math.min(this.pdfPageWanted(), Math.max(1, Math.ceil(this.pdfList().length / PDF_PAGE_SIZE))));
  pdfItems = computed(() => {
    const start = (this.pdfPage() - 1) * PDF_PAGE_SIZE;
    return this.pdfList().slice(start, start + PDF_PAGE_SIZE);
  });
  goPdfPage(n: number) {
    this.pdfPageWanted.set(n);
  }

  formatSize = formatSize;
  fileName = fileName;
  folderName = folderName;
  thumbUrl = thumbUrl;
  pill = statusPill;
  pdfPill = pdfPill;

  // Every PDF found by Scan: replaced ones first (biggest saving first), then the rest, biggest file first.
  pdfList = computed(() =>
    Object.values(this.docs())
      .filter((d): d is PdfDoc => !!d)
      .sort((a, b) => this.pdfSavedBytes(b) - this.pdfSavedBytes(a) || this.pdfBefore(b) - this.pdfBefore(a))
  );
  private pdfSavedBytes(d: PdfDoc): number {
    return d.outcome?.action === 'replaced' ? d.outcome.beforeBytes - d.outcome.afterBytes : -1;
  }
  private pdfReplaced = computed(() => this.pdfList().filter((d) => d.outcome?.action === 'replaced'));

  // Totals for ALL images come from the server; PDFs are added here.
  replacedCount = computed(() => this.summary().replacedCount + this.pdfReplaced().length);
  keptCount = computed(
    () => this.summary().keptCount + this.pdfList().filter((d) => d.outcome?.action === 'kept').length
  );

  // Space saved = (size before - size after) of every replaced file (images and PDFs).
  totalSaved = computed(
    () =>
      this.summary().savedBytes +
      this.pdfReplaced().reduce((sum, d) => sum + (d.outcome!.beforeBytes - d.outcome!.afterBytes), 0)
  );

  // The same four columns for a PDF.
  pdfBefore(d: PdfDoc): number {
    return d.outcome?.action === 'replaced' ? d.outcome.beforeBytes : d.sizeBytes;
  }
  pdfAfter(d: PdfDoc): string {
    return d.outcome?.action === 'replaced' ? formatSize(d.outcome.afterBytes) : '-';
  }
  pdfSaved(d: PdfDoc): string {
    const o = d.outcome;
    return o?.action === 'replaced' ? formatSize(o.beforeBytes - o.afterBytes) : '-';
  }
  pdfHappened(d: PdfDoc): string {
    const o = d.outcome;
    if (o?.action === 'replaced') return 'Replaced with the smaller version';
    if (o?.action === 'kept') return 'You kept the original';
    if (o?.action === 'restored') return 'Original restored from the vault';
    if (o?.action === 'failed') return o.message;
    if (d.error) return d.error;
    if (d.smaller) return 'Smaller copy ready, waiting for your decision';
    if (d.noCopyReason) return d.noCopyReason;
    if (d.sizeBytes < 500 * 1024) return 'Under 500 KB, skipped';
    return 'Not compressed yet';
  }

  // Size before: the original size (after a replace it is remembered in the outcome).
  before(img: ImageRecord): number {
    return originalSize(img);
  }

  // Size after: only files that were replaced have a new size.
  after(img: ImageRecord): string {
    return img.outcome?.action === 'replaced' ? formatSize(img.outcome.afterBytes) : '-';
  }

  saved(img: ImageRecord): string {
    const o = img.outcome;
    return o?.action === 'replaced' ? formatSize(o.beforeBytes - o.afterBytes) : '-';
  }

  // What happened to this file, in plain words.
  happened(img: ImageRecord): string {
    const o = img.outcome;
    if (o?.action === 'replaced') return 'Replaced with the smaller version';
    if (o?.action === 'kept') return 'You kept the original';
    if (o?.action === 'restored') return 'Original restored from the vault';
    if (o?.action === 'failed') return o.message;
    if (img.error) return img.error;
    if (img.smaller) return 'Smaller copy ready, waiting for your decision';
    if (img.sizeBytes < 500 * 1024) return 'Under 500 KB, skipped';
    return 'Not compressed yet';
  }

  isBad(img: ImageRecord): boolean {
    return img.outcome?.action === 'failed' || !!img.error;
  }
}
