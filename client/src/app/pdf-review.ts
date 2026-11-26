import { Component, inject, input, output } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { PdfDoc, fileName, folderName, formatSize, pdfOriginalSize, pdfPill, pdfSuggestion, ssimBand, ssimMeaning, ssimPosition } from './models';
import { Pager } from './pager';

// The PDF part of the Review screen: original and smaller PDF side by side, with the decision buttons.
@Component({
  imports: [Pager],
  selector: 'app-pdf-review',
  templateUrl: './pdf-review.html',
})
export class PdfReview {
  // Data that comes IN from the parent (App).
  items = input.required<PdfDoc[]>(); // the cards on this page
  total = input.required<number>();   // how many PDFs can be reviewed in all
  page = input.required<number>();
  pageSize = input.required<number>();
  busy = input(false);

  // Events that go OUT to the parent. The parent talks to the server.
  useSmaller = output<string>();
  keepOriginal = output<string>();
  restore = output<string>();
  pageChange = output<number>();

  private sanitizer = inject(DomSanitizer);
  private frames = new Map<string, SafeResourceUrl>();

  formatSize = formatSize;
  fileName = fileName;
  folderName = folderName;
  originalSize = pdfOriginalSize;
  pill = pdfPill;
  suggestion = pdfSuggestion;
  ssimBand = ssimBand;
  ssimMeaning = ssimMeaning;
  ssimPosition = ssimPosition;

  // Address the browser uses to fetch a PDF from our server (the "v" reloads it after a change).
  url(which: 'original' | 'smaller', d: PdfDoc): string {
    return `/api/pdf-file/${which}?path=${encodeURIComponent(d.relativePath)}&v=${d.sizeBytes}`;
  }

  // The same address, marked as safe for an <iframe> (it points only to our own server).
  frame(which: 'original' | 'smaller', d: PdfDoc): SafeResourceUrl {
    const u = this.url(which, d);
    let safe = this.frames.get(u);
    if (!safe) {
      safe = this.sanitizer.bypassSecurityTrustResourceUrl(u);
      this.frames.set(u, safe);
    }
    return safe;
  }

  label(d: PdfDoc): string {
    const s = pdfSuggestion(d);
    if (s === 'green') return 'Looks the same';
    if (s === 'amber') return 'Check this one';
    if (s === 'red') return 'Keep original';
    return '';
  }

  reason(d: PdfDoc): string {
    const s = pdfSuggestion(d);
    if (s === 'green') return 'The pictures inside are very similar to the originals (SSIM 0.99 or higher).';
    if (s === 'amber') return 'Some pictures inside look a little different. Compare the two PDFs.';
    if (s === 'red') return 'Saves less than 5%, so it is not worth changing.';
    return '';
  }

  statusText(d: PdfDoc): string {
    const o = d.outcome;
    if (!o) return '';
    const when = new Date(o.at).toLocaleString();
    if (o.action === 'replaced') {
      return `Replaced on ${when}. Saved ${formatSize(o.beforeBytes - o.afterBytes)}. The original is in the vault.`;
    }
    if (o.action === 'kept') return `You chose to keep the original (${when}).`;
    if (o.action === 'restored') return `Original restored on ${when}. You can decide again.`;
    return `Last try failed: ${o.message}`;
  }
}
