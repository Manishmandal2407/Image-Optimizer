import { Component, input, output } from '@angular/core';
import { DocSummary, PdfDoc, PdfReport, fileName, folderName, formatSize, pdfOriginalSize, pdfPill } from './models';
import { Pager } from './pager';

// The Documents screen: every PDF found by Scan, listed like the images.
@Component({
  imports: [Pager],
  selector: 'app-documents',
  templateUrl: './documents.html',
})
export class Documents {
  // Data that comes IN from the parent (App).
  items = input.required<PdfDoc[]>(); // the rows on this page
  total = input.required<number>();   // PDFs in all
  page = input.required<number>();
  pageSize = input.required<number>();
  summary = input.required<DocSummary>();
  report = input<PdfReport | null>(null); // the optional estimate ("Estimate savings")
  busy = input(false);

  // Events that go OUT: the parent talks to the server.
  check = output<void>();
  prepare = output<string>(); // make a smaller copy of one PDF (its path inside the images folder)
  pageChange = output<number>();

  // The groups of the estimate, in the order we show them.
  readonly groups = [
    { key: 'worth', label: 'Pictures worth shrinking', note: 'JPEG pictures that can be made smaller.', pill: 'green' },
    { key: 'small-pictures', label: 'Small pictures or other formats', note: 'Too small to matter, or a picture format we cannot shrink.', pill: 'grey' },
    { key: 'no-pictures', label: 'No pictures', note: 'Nothing to shrink.', pill: 'grey' },
    { key: 'skipped', label: 'Skipped for safety', note: 'Signed, password-protected, or with form fields.', pill: 'amber' },
    { key: 'unreadable', label: 'Could not be read', note: 'Damaged, or not a real PDF.', pill: 'red' },
  ] as const;

  formatSize = formatSize;
  fileName = fileName;
  folderName = folderName;
  originalSize = pdfOriginalSize;
  pill = pdfPill;

  // Bar width (in %) for the saving of one PDF in the list.
  meterWidth(d: PdfDoc): number {
    return Math.min(100, Math.max(2, d.smaller?.savingPercent ?? 0));
  }
}
