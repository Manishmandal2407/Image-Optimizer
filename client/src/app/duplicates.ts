import { Component, HostListener, inject, input, output, signal } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { DupFile, DupGroup, DupKind, DupPage, DupRemovedPage, DupSensitivity, fileName, folderName, formatSize } from './models';
import { Pager } from './pager';

// The Duplicates screen: identical files and pictures that look the same.
// It only shows what the server found. Every button talks to the server through the parent (App).
@Component({
  imports: [Pager],
  selector: 'app-duplicates',
  templateUrl: './duplicates.html',
})
export class Duplicates {
  data = input.required<DupPage>();         // one page of groups, plus the totals
  removed = input.required<DupRemovedPage>(); // one page of files moved to the vault
  kind = input.required<DupKind>();         // which groups are showing
  busy = input(false);
  pageSize = input.required<number>();
  removedPageSize = input.required<number>();

  find = output<DupSensitivity>();
  remove = output<{ groupId: string; keep: string }>();
  removeExact = output<void>();
  restore = output<string>();
  kindChange = output<DupKind>();
  pageChange = output<number>();
  removedPageChange = output<number>();

  sensitivity = signal<DupSensitivity>('normal');
  confirmOpen = signal(false); // the "Move identical copies?" dialog
  // The big preview (modal): which group, and which file of it is showing.
  preview = signal<{ group: DupGroup; index: number } | null>(null);
  private sanitizer = inject(DomSanitizer);
  private frames = new Map<string, SafeResourceUrl>(); // a PDF viewer needs a "trusted" address, kept so it does not reload
  // The file chosen to keep in each group (until you choose, our suggestion is used).
  private choice = signal<Record<string, string>>({});

  formatSize = formatSize;
  fileName = fileName;
  folderName = folderName;

  readonly levels: { key: DupSensitivity; label: string; note: string }[] = [
    { key: 'strict', label: 'Strict', note: 'Only pictures that are almost exactly the same.' },
    { key: 'normal', label: 'Normal', note: 'Copies that were resized or saved again.' },
    { key: 'loose', label: 'Loose', note: 'Also finds more distant matches. Check these carefully.' },
  ];

  chosen(g: DupGroup): string {
    const c = this.choice()[g.id];
    return c && g.files.some((f) => f.relativePath === c) ? c : g.keep;
  }
  choose(g: DupGroup, path: string) {
    this.choice.update((all) => ({ ...all, [g.id]: path }));
  }
  // How much space this group frees with the file you chose to keep.
  reclaim(g: DupGroup): number {
    const keep = this.chosen(g);
    return g.files.reduce((n, f) => n + (f.relativePath === keep ? 0 : f.sizeBytes), 0);
  }

  // ---- big preview ----
  openPreview(g: DupGroup, index: number) {
    this.preview.set({ group: g, index });
  }
  closePreview() {
    this.preview.set(null);
  }
  step(delta: number) {
    const p = this.preview();
    if (!p) return;
    const n = p.group.files.length;
    this.preview.set({ group: p.group, index: (p.index + delta + n) % n });
  }
  current(): DupFile | null {
    const p = this.preview();
    return p ? p.group.files[p.index] ?? null : null;
  }
  frame(path: string): SafeResourceUrl {
    let f = this.frames.get(path);
    if (!f) {
      f = this.sanitizer.bypassSecurityTrustResourceUrl(this.open(path));
      this.frames.set(path, f);
    }
    return f;
  }
  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent) {
    if (!this.preview()) return;
    if (e.key === 'Escape') this.closePreview();
    else if (e.key === 'ArrowRight') this.step(1);
    else if (e.key === 'ArrowLeft') this.step(-1);
  }

  thumb(path: string): string {
    return '/api/dup-thumb?path=' + encodeURIComponent(path);
  }
  open(path: string): string {
    return '/api/dup-file?path=' + encodeURIComponent(path);
  }
  // "24 KB, 1200 x 800" (PDFs have no picture size)
  meta(f: { sizeBytes: number; width?: number; height?: number }): string {
    const size = formatSize(f.sizeBytes);
    return f.width && f.height ? `${size}, ${f.width} \u00d7 ${f.height}` : size;
  }
  copyLetter(n: number): string {
    return String.fromCharCode(64 + n); // 1 -> A, 2 -> B
  }
  date(ms: number): string {
    return new Date(ms).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  when(iso: string): string {
    return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
}
