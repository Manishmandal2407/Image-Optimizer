import { Component, computed, input, output } from '@angular/core';

// A small page bar with page numbers: 1 2 3 4 5 ... 18, and 1 ... 14 15 16 17 18 on the last pages.
// It only shows the buttons. The parent decides which rows to show.
@Component({
  selector: 'app-pager',
  templateUrl: './pager.html',
})
export class Pager {
  total = input.required<number>(); // how many rows in all
  page = input.required<number>(); // the page showing now (1 is the first)
  pageSize = input.required<number>(); // rows per page
  pageChange = output<number>(); // tells the parent which page you chose

  pages = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize())));
  first = computed(() => (this.total() === 0 ? 0 : (this.page() - 1) * this.pageSize() + 1));
  last = computed(() => Math.min(this.total(), this.page() * this.pageSize()));

  // The buttons to draw: a page number, or null for the "..." gap.
  //   up to 7 pages:  1 2 3 4 5 6 7
  //   near the start: 1 2 3 4 5 ... 18
  //   in the middle:  1 ... 8 9 10 ... 18
  //   near the end:   1 ... 14 15 16 17 18
  items = computed<(number | null)[]>(() => {
    const n = this.pages();
    const p = Math.min(this.page(), n);
    if (n <= 7) return Array.from({ length: n }, (_, i) => i + 1);
    if (p <= 4) return [1, 2, 3, 4, 5, null, n];
    if (p >= n - 3) return [1, null, n - 4, n - 3, n - 2, n - 1, n];
    return [1, null, p - 1, p, p + 1, null, n];
  });

  // 150000 -> "1,50,000"
  fmt(n: number): string {
    return n.toLocaleString('en-IN');
  }

  go(n: number) {
    if (n !== this.page()) this.pageChange.emit(n);
  }
}
