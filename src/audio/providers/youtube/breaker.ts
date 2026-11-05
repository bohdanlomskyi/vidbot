export interface FailureBreakerOptions {
  /** Consecutive systemic failures that open the breaker. */
  readonly threshold: number;
  readonly cooldownMs: number;
}

/**
 * Circuit breaker for the YouTube provider. After enough consecutive systemic failures
 * the provider refuses requests for a cooldown period, so a broken yt-dlp or a rate
 * limit cannot tie up the bot. A success clears the failure count.
 */
export class FailureBreaker {
  private consecutive = 0;
  private openUntil = 0;

  constructor(private readonly options: FailureBreakerOptions) {}

  isOpen(now: number = Date.now()): boolean {
    return now < this.openUntil;
  }

  recordSystemFailure(now: number = Date.now()): void {
    this.consecutive += 1;
    if (this.consecutive >= this.options.threshold) {
      this.openUntil = now + this.options.cooldownMs;
      this.consecutive = 0;
    }
  }

  recordSuccess(): void {
    this.consecutive = 0;
  }
}
