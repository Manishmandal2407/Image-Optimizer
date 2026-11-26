import { Component, computed, effect, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { EMPTY_PAGE, EMPTY_SUMMARY, ImageRecord, ListPage, PdfDoc, PdfPrepareResult, PdfReport, Summary, fileName, folderName, formatSize, originalSize, pageSlice, pdfBiggestSavingFirst, statusPill, summarizeDocs, thumbUrl } from './models';
import { Review } from './review';
import { Results } from './results';
import { Documents } from './documents';
import { PdfReview } from './pdf-review';
import { Pager } from './pager';

// How many rows the Images list shows on one page.
const LIST_PAGE_SIZE = 50;
const REVIEW_PAGE_SIZE = 10; // each review card loads two full pictures
const RESULTS_PAGE_SIZE = 50;
const DOC_LIST_PAGE_SIZE = 50;
const DOC_REVIEW_PAGE_SIZE = 3; // each PDF card loads two PDF viewers

// The shape of the data the server sends us.
interface Folders { imagesFolder: string; vaultFolder: string; workFolder: string }
interface HealthResponse { folders: Folders }
interface ScanResponse { count: number; totalBytes: number; pdfCount: number; pdfBytes: number; warnings: string[]; totals: Summary }
interface ActionResponse { message: string; totals: Summary }
interface Progress { active: boolean; label: string; done: number; total: number; stopping: boolean }
interface PrepareResponse {
  stopped: boolean; made: number; alreadyDone: number; tooSmall: number; failed: number;
  pdfMade: number; pdfAlreadyDone: number; pdfTooSmall: number; pdfNoCopy: number; pdfFailed: number;
  totals: Summary; documents: PdfDoc[];
}

@Component({
  imports: [Review, PdfReview, Results, Pager, Documents],
  selector: 'app-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App {
  // "http" is Angular's tool for talking to our server.
  private http = inject(HttpClient);

  // A "signal" is a box holding a value. When we change it, the page updates by itself.
  // The server keeps the whole list. We only hold the totals and the page we are looking at.
  summary = signal<Summary>(EMPTY_SUMMARY);
  listData = signal<ListPage>(EMPTY_PAGE);
  reviewData = signal<ListPage>(EMPTY_PAGE);
  resultsData = signal<ListPage>(EMPTY_PAGE);
  rangeCount = signal(0); // how many images "Replace by saving" would replace now
  folders = signal<Folders | null>(null);
  view = signal<'list' | 'review' | 'documents' | 'results'>('list'); // which tab is showing
  pdfReport = signal<PdfReport | null>(null); // the answer of the PDF check
  pdfResults = signal<Record<string, PdfPrepareResult>>({}); // smaller PDF copies made so far, by file
  pdfDocs = signal<Record<string, PdfDoc>>({}); // what the server remembers about each PDF, by file
  busy = signal(false);
  progress = signal<Progress | null>(null); // how far a long job is (null for quick jobs)
  busyText = signal('');
  infoMessage = signal('');
  errorMessage = signal('');
  pdfConfirmOpen = signal(false); // the "Replace N PDFs?" dialog
  confirmOpen = signal(false); // the "Replace N images?" dialog
  rangeRequest = signal<{ from: number; to: number; n: number } | null>(null); // the same, for "Replace by saving"

  // What the Review tab shows: the images or the PDFs.
  reviewKind = signal<'images' | 'pdfs'>('images');
  reviewMode = signal<'side' | 'slider'>('side'); // how Review shows the two pictures
  // "Replace by saving": the range you type (starts at 15 to 20 %).
  fromPct = signal(15);
  toPct = signal(20);
  readonly minSsim = 0.95; // must match the server
  rangeValid = computed(() => {
    const from = this.fromPct();
    const to = this.toPct();
    return Number.isFinite(from) && Number.isFinite(to) && from >= 0 && to <= 100 && from <= to;
  });
  docListPage = signal(1);
  docReviewPage = signal(1);

  // The PDFs (the server keeps them all in one small list, so the browser cuts it into pages).
  pdfList = computed(() => Object.values(this.pdfDocs()));
  docSummary = computed(() => summarizeDocs(this.pdfList()));
  docListData = computed(() =>
    pageSlice([...this.pdfList()].sort(pdfBiggestSavingFirst), this.docListPage(), DOC_LIST_PAGE_SIZE));
  docReviewData = computed(() =>
    pageSlice(this.pdfList().filter((d) => d.smaller).sort(pdfBiggestSavingFirst), this.docReviewPage(), DOC_REVIEW_PAGE_SIZE));
  docListPageSize = DOC_LIST_PAGE_SIZE;
  docReviewPageSize = DOC_REVIEW_PAGE_SIZE;

  // Totals for the left side of the page. Images come from the server; the PDFs are added here.
  totalBytes = computed(() => this.summary().totalBytes);
  readyCount = computed(() => this.summary().readyCount + this.docSummary().readyCount);
  replacedCount = computed(() => this.summary().replacedCount + this.docSummary().replacedCount);
  decidedCount = computed(() => this.summary().decidedCount + this.docSummary().decidedCount);
  greenWaiting = computed(() => this.summary().greenWaiting);
  savedBytes = computed(() => this.summary().savedBytes + this.docSummary().savedBytes);
  couldSave = computed(() => this.summary().couldSave + this.docSummary().couldSave);
  baseBytes = computed(() => this.summary().baseBytes + this.docSummary().baseBytes);
  savedPct = computed(() => (this.baseBytes() > 0 ? (this.savedBytes() / this.baseBytes()) * 100 : 0));
  couldPct = computed(() => (this.baseBytes() > 0 ? (this.couldSave() / this.baseBytes()) * 100 : 0));

  // Rows per page. The server cuts the list into pages, so only one page travels to the browser.
  listPageSize = LIST_PAGE_SIZE;
  reviewPageSize = REVIEW_PAGE_SIZE;
  resultsPageSize = RESULTS_PAGE_SIZE;
  private pageWanted = { list: 1, review: 1, results: 1 };
  private range = { from: 15, to: 20 };

  // Switch tab and fetch what that tab shows.
  show(view: 'list' | 'review' | 'documents' | 'results') {
    this.view.set(view);
    if (view === 'review' && this.summary().readyCount === 0 && this.docSummary().readyCount > 0) {
      this.reviewKind.set('pdfs');
    }
    void this.reload();
  }

  goListPage(n: number) {
    this.pageWanted.list = n;
    window.scrollTo({ top: 0 });
    void this.reload();
  }
  goReviewPage(n: number) {
    this.pageWanted.review = n;
    window.scrollTo({ top: 0 });
    void this.reload();
  }
  goDocListPage(n: number) {
    this.docListPage.set(n);
    window.scrollTo({ top: 0 });
  }
  goDocReviewPage(n: number) {
    this.docReviewPage.set(n);
    window.scrollTo({ top: 0 });
  }
  goResultsPage(n: number) {
    this.pageWanted.results = n;
    window.scrollTo({ top: 0 });
    void this.reload();
  }

  setFrom(event: Event) {
    this.fromPct.set(Number((event.target as HTMLInputElement).value));
  }
  setTo(event: Event) {
    this.toPct.set(Number((event.target as HTMLInputElement).value));
  }
  askRange() {
    this.askReplaceRange({ from: this.fromPct(), to: this.toPct(), n: this.rangeCount() });
  }

  // Whenever the range changes, ask the server how many images it covers.
  setRange(r: { from: number; to: number }) {
    this.range = r;
    void this.loadRangeCount();
  }

  private async loadRangeCount() {
    try {
      const r = await firstValueFrom(this.http.get<{ n: number }>(`/api/range-count?from=${this.range.from}&to=${this.range.to}`));
      this.rangeCount.set(r.n);
    } catch {
      // the next click will explain a server problem
    }
  }

  // Fetch the totals and the page of the tab we are on. Called after every click that changes something.
  async reload() {
    try {
      const t = await firstValueFrom(this.http.get<{ totals: Summary }>('/api/summary'));
      this.summary.set(t.totals);
      const docs = await firstValueFrom(this.http.get<{ documents: PdfDoc[] }>('/api/pdf-records'));
      this.setPdfDocs(docs.documents);
      const v = this.view();
      if (v === 'list' || v === 'review' || v === 'results') {
        const size = v === 'list' ? LIST_PAGE_SIZE : v === 'review' ? REVIEW_PAGE_SIZE : RESULTS_PAGE_SIZE;
        const p = await firstValueFrom(this.http.get<ListPage>(`/api/images?view=${v}&page=${this.pageWanted[v]}&size=${size}`));
        this.pageWanted[v] = p.page; // the server never goes past the last page
        if (v === 'list') this.listData.set(p);
        else if (v === 'review') this.reviewData.set(p);
        else this.resultsData.set(p);
      }
      if (v === 'review') await this.loadRangeCount();
    } catch {
      // If the server is down, the next button click will explain it.
    }
  }

  // Helpers the page can call (see models.ts).
  formatSize = formatSize;
  fileName = fileName;
  folderName = folderName;
  thumbUrl = thumbUrl;
  originalSize = originalSize;
  pill = statusPill;

  constructor() {
    void this.loadFolders();
    effect(() => {
      if (this.rangeValid()) this.setRange({ from: this.fromPct(), to: this.toPct() });
    });
    // While a job is running, ask the server once a second how far it is.
    effect((onCleanup) => {
      if (!this.busy()) {
        this.progress.set(null);
        return;
      }
      const timer = setInterval(async () => {
        try {
          const p = await firstValueFrom(this.http.get<Progress>('/api/progress'));
          this.progress.set(p.active && p.total > 0 ? p : null);
        } catch {
          // ignore: the job's own answer will explain a server problem
        }
      }, 1000);
      onCleanup(() => clearInterval(timer));
    });
  }

  // "Stop": the job finishes the file it is on, then stops before the next one.
  async stop() {
    this.progress.update((p) => (p ? { ...p, stopping: true } : p));
    try {
      await firstValueFrom(this.http.post('/api/stop', {}));
    } catch {
      // ignore
    }
  }

  progressPct(): number {
    const p = this.progress();
    return p && p.total > 0 ? Math.min(100, (p.done / p.total) * 100) : 0;
  }

  // Show which folders are in use (reads config only, changes nothing).
  private async loadFolders() {
    try {
      const h = await firstValueFrom(this.http.get<HealthResponse>('/api/health'));
      this.folders.set(h.folders);
      const p = await firstValueFrom(this.http.get<{ documents: PdfDoc[] }>('/api/pdf-records'));
      this.setPdfDocs(p.documents);
      await this.reload();
    } catch {
      // If the server is down, the first button click will explain it.
    }
  }

  // Runs when you click "Scan folder". Finds the images AND the PDFs (read-only).
  async scan() {
    this.start('Scanning your images and PDFs...');
    try {
      const result = await firstValueFrom(this.http.get<ScanResponse>('/api/scan'));
      this.summary.set(result.totals);
      await this.reload();
      let text = `Scan finished: ${result.count} images and ${result.pdfCount} PDFs found.`;
      if (result.warnings.length > 0) {
        text += ` ${result.warnings.length} warning(s): see data/app.log.`;
      }
      this.infoMessage.set(text);
    } catch (err) {
      this.errorMessage.set(this.explain(err));
    }
    this.busy.set(false);
  }

  // Runs when you click "Make smaller copies".
  async makeSmallerCopies() {
    this.start('Making smaller copies. This can take a few minutes, please wait.');
    try {
      const r = await firstValueFrom(this.http.post<PrepareResponse>('/api/prepare', {}));
      this.summary.set(r.totals);
      this.setPdfDocs(r.documents);
      this.infoMessage.set(
        `Smaller copies made: ${r.made} images and ${r.pdfMade} PDFs. Already done before: ${r.alreadyDone + r.pdfAlreadyDone}. ` +
        `Under 500 KB (skipped): ${r.tooSmall + r.pdfTooSmall}. PDFs with nothing to shrink: ${r.pdfNoCopy}. ` +
        `Failed: ${r.failed + r.pdfFailed}. ` +
        (r.stopped ? `Stopped by you. Click Make smaller copies again to carry on. ` : ``) +
        `Open Review to compare them.`
      );
      if (r.made > 0) {
        this.reviewKind.set('images');
        this.show('review');
      } else if (r.pdfMade > 0) {
        this.reviewKind.set('pdfs');
        this.show('review');
      } else {
        await this.reload();
      }
    } catch (err) {
      this.errorMessage.set(this.explain(err));
    }
    this.busy.set(false);
  }

  // PDFs that are ready and safe: saving 5% or more, SSIM 0.99 or higher, no decision yet.
  pdfReadyCount = computed(
    () => Object.values(this.pdfDocs()).filter((d) => d && !d.outcome && d.smaller && d.smaller.savingPercent >= 5 && d.smaller.ssim >= 0.99).length
  );

  askReplaceReadyPdfs() {
    if (this.pdfReadyCount() > 0) this.pdfConfirmOpen.set(true);
  }

  async confirmReplaceReadyPdfs() {
    const n = this.pdfReadyCount();
    this.pdfConfirmOpen.set(false);
    this.start(`Replacing ${n} PDF(s), one at a time. Please wait.`);
    try {
      const r = await firstValueFrom(this.http.post<{ message: string; documents: PdfDoc[] }>('/api/pdf-replace-ready', {}));
      this.setPdfDocs(r.documents);
      this.infoMessage.set(r.message);
    } catch (err) {
      const body = err instanceof HttpErrorResponse ? (err.error as { documents?: PdfDoc[] } | null) : null;
      if (body?.documents) this.setPdfDocs(body.documents);
      this.errorMessage.set(this.explain(err));
    }
    this.busy.set(false);
  }

  // Keep the PDF records the server sends back (by file name).
  private setPdfDocs(list: PdfDoc[]) {
    this.pdfDocs.set(Object.fromEntries(list.map((d) => [d.relativePath, d])));
  }

  // Runs when you click "Estimate savings" on the Documents tab. Read-only.
  async checkPdfs() {
    this.start('Checking your PDFs. This can take a few minutes, please wait.');
    try {
      const r = await firstValueFrom(this.http.post<PdfReport>('/api/pdf-report', {}));
      this.pdfReport.set(r);
      this.infoMessage.set(`PDF check finished: ${r.pdfCount} PDFs found, ${r.checkedCount} checked.`);
    } catch (err) {
      this.errorMessage.set(this.explain(err));
    }
    this.busy.set(false);
  }

  // Runs when you click "Make smaller copy" for one PDF. Only a test copy is made.
  async makePdfSmaller(relativePath: string) {
    this.start(`Making a smaller copy of ${fileName(relativePath)}. Please wait.`);
    try {
      const r = await firstValueFrom(this.http.post<PdfPrepareResult>('/api/pdf-prepare', { relativePath }));
      this.pdfResults.update((all) => ({ ...all, [relativePath]: r }));
      if (r.documents) this.setPdfDocs(r.documents);
      this.infoMessage.set(r.made ? `Smaller copy made for ${fileName(relativePath)}.` : `No copy made for ${fileName(relativePath)}.`);
    } catch (err) {
      this.errorMessage.set(this.explain(err));
    }
    this.busy.set(false);
  }

  // ---- the PDF buttons on the Documents screen ----

  // Same safe steps as for images: vault first, then swap, then check.
  async pdfAction(kind: 'replace' | 'keep' | 'restore', relativePath: string) {
    const text = {
      replace: `Replacing ${fileName(relativePath)}. The original goes to the vault first.`,
      keep: 'Saving your choice...',
      restore: `Restoring ${fileName(relativePath)} from the vault...`,
    }[kind];
    this.start(text);
    try {
      const r = await firstValueFrom(this.http.post<{ message: string; documents: PdfDoc[] }>(`/api/pdf-${kind}`, { relativePath }));
      this.setPdfDocs(r.documents);
      this.infoMessage.set(r.message);
    } catch (err) {
      const body = err instanceof HttpErrorResponse ? (err.error as { documents?: PdfDoc[] } | null) : null;
      if (body?.documents) this.setPdfDocs(body.documents);
      this.errorMessage.set(this.explain(err));
    }
    this.busy.set(false);
  }

  // ---- the buttons on the Review screen ----

  async useSmaller(img: ImageRecord) {
    await this.action('/api/replace', { relativePath: img.relativePath }, `Replacing ${fileName(img.relativePath)}. The original goes to the vault first.`);
  }

  async keepOriginal(img: ImageRecord) {
    await this.action('/api/keep', { relativePath: img.relativePath }, 'Saving your choice...');
  }

  async restore(img: ImageRecord) {
    await this.action('/api/restore', { relativePath: img.relativePath }, `Restoring ${fileName(img.relativePath)} from the vault...`);
  }

  // "Replace all green ones" first asks you to confirm.
  askReplaceGreen() {
    if (this.greenWaiting() > 0) this.confirmOpen.set(true);
  }

  async confirmReplaceGreen() {
    const n = this.greenWaiting();
    this.confirmOpen.set(false);
    await this.action('/api/replace-green', {}, `Replacing ${n} image(s), one at a time. Please wait.`);
  }

  // "Replace by saving": confirm first, then replace every image in the range.
  askReplaceRange(request: { from: number; to: number; n: number }) {
    if (request.n > 0) this.rangeRequest.set(request);
  }

  async confirmReplaceRange() {
    const r = this.rangeRequest();
    this.rangeRequest.set(null);
    if (!r) return;
    await this.action(
      '/api/replace-range',
      { fromPercent: r.from, toPercent: r.to },
      `Replacing ${r.n} image(s) that save ${r.from}% to ${r.to}%, one at a time. Please wait.`
    );
  }

  // Send a button click to the server and show the answer.
  private async action(url: string, body: object, busyText: string) {
    this.start(busyText);
    try {
      const r = await firstValueFrom(this.http.post<ActionResponse>(url, body));
      this.summary.set(r.totals);
      await this.reload();
      this.infoMessage.set(r.message);
    } catch (err) {
      // Even when something fails, some files may have changed, so reload.
      await this.reload();
      this.errorMessage.set(this.explain(err));
    }
    this.busy.set(false);
  }

  dismiss() {
    this.infoMessage.set('');
    this.errorMessage.set('');
  }

  // Bar width (in %) for the saving of one image in the list.
  meterWidth(img: ImageRecord): number {
    return Math.min(100, Math.max(2, img.smaller?.savingPercent ?? 0));
  }

  private start(text: string) {
    this.busy.set(true);
    this.busyText.set(text);
    this.infoMessage.set('');
    this.errorMessage.set('');
  }

  // Turn an error into a plain sentence.
  private explain(err: unknown): string {
    if (err instanceof HttpErrorResponse) {
      if (err.status === 0) return 'Cannot reach the server. Is "npm start" still running?';
      if (err.error && typeof err.error.error === 'string') return err.error.error;
      return `The server had a problem (code ${err.status}). See data/app.log.`;
    }
    return 'Something went wrong.';
  }
}
