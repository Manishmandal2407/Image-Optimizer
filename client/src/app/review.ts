import { Component, input, output } from '@angular/core';
import { ImageRecord, fileName, folderName, formatSize, originalSize, ssimBand, ssimMeaning, ssimPosition, statusPill } from './models';
import { Compare } from './compare';
import { Pager } from './pager';

// The Review screen: original and smaller copy, with the decision buttons.
@Component({
  imports: [Compare, Pager],
  selector: 'app-review',
  templateUrl: './review.html',
  styleUrl: './review.css',
})
export class Review {
  // Data that comes IN from the parent (App). The server sends only the page we show.
  items = input.required<ImageRecord[]>(); // the cards on this page
  total = input.required<number>();        // how many images can be reviewed in all
  page = input.required<number>();         // the page showing now
  pageSize = input.required<number>();
  busy = input(false);
  mode = input<'side' | 'slider'>('side'); // how to show the two pictures (chosen in the panel above)

  // Events that go OUT to the parent. The parent talks to the server.
  useSmaller = output<ImageRecord>();
  keepOriginal = output<ImageRecord>();
  restore = output<ImageRecord>();
  pageChange = output<number>();

  goPage(n: number) {
    this.pageChange.emit(n);
  }

  formatSize = formatSize;
  fileName = fileName;
  folderName = folderName;
  originalSize = originalSize;
  pill = statusPill;
  ssimBand = ssimBand;
  ssimMeaning = ssimMeaning;
  ssimPosition = ssimPosition;

  // Address the browser uses to fetch a picture from our server.
  url(which: 'original' | 'smaller', img: ImageRecord): string {
    return `/api/image/${which}?path=${encodeURIComponent(img.relativePath)}`;
  }

  label(img: ImageRecord): string {
    if (img.suggestion === 'green') return 'Looks the same';
    if (img.suggestion === 'amber') return 'Check this one';
    if (img.suggestion === 'red') return 'Keep original';
    return '';
  }

  reason(img: ImageRecord): string {
    if (img.suggestion === 'green') return 'Very similar to the original (SSIM 0.99 or higher).';
    if (img.suggestion === 'amber') return 'A little different from the original. Compare the two pictures.';
    if (img.suggestion === 'red') return 'Saves less than 5%, so it is not worth changing.';
    return '';
  }

  statusText(img: ImageRecord): string {
    const o = img.outcome;
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
