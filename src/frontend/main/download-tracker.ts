export type DownloadOutcome = { success: boolean; error?: string } & Record<string, unknown>;

/**
 * Tracks model downloads for one IPC surface: deduplicates concurrent requests
 * per modelId, keeps a percent map for `get-*-download-status`, and notifies
 * progress (including a final 100) through the callback.
 */
export class DownloadTracker {
  private active = new Map<string, Promise<DownloadOutcome>>();
  private progress = new Map<string, number>();

  constructor(private notify: (modelId: string, percent: number) => void) {}

  status(): Array<{ modelId: string; percent: number }> {
    return Array.from(this.progress, ([modelId, percent]) => ({ modelId, percent }));
  }

  /** `job` performs the download and returns extra fields for the success payload. */
  download(
    modelId: string,
    job: (onProgress: (percent: number) => void) => Promise<Record<string, unknown>>,
  ): Promise<DownloadOutcome> {
    const existing = this.active.get(modelId);
    if (existing) return existing;

    // Seed 0% before the job starts: status queries must see the download
    // during the pre-progress window (connect/redirect, VAD pre-download),
    // or a remounted settings page shows the download button instead of the bar.
    this.progress.set(modelId, 0);
    this.notify(modelId, 0);

    const task = (async (): Promise<DownloadOutcome> => {
      try {
        const extra = await job((percent) => {
          this.progress.set(modelId, percent);
          this.notify(modelId, percent);
        });
        this.notify(modelId, 100);
        return { success: true, ...extra };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      } finally {
        this.active.delete(modelId);
        this.progress.delete(modelId);
      }
    })();

    this.active.set(modelId, task);
    return task;
  }
}
