const MINUTE_MS = 60_000;

export interface LibraryRescanOptions {
  /** Zero disables scheduled rescans. The library is still scanned once at startup. */
  readonly minutes: number;
  readonly refresh: () => Promise<void>;
  readonly onError: (error: unknown) => void;
}

/**
 * Rescans the music directory on a fixed interval, so files added to the server appear without a
 * restart. The timer does not keep the process alive. The returned function cancels the schedule.
 */
export function scheduleLibraryRescan(options: LibraryRescanOptions): () => void {
  if (options.minutes <= 0) {
    return () => undefined;
  }
  const timer = setInterval(() => {
    options.refresh().catch(options.onError);
  }, options.minutes * MINUTE_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
