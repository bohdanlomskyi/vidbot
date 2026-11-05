export type TimerKind = 'idle' | 'empty' | 'reconnect';

/**
 * One timer per kind per session. Scheduling a kind that is already pending does nothing,
 * so repeated state checks cannot stack countdowns. Timers are cleared when the session ends.
 */
export class SessionTimers {
  private readonly timers = new Map<TimerKind, ReturnType<typeof setTimeout>>();

  has(kind: TimerKind): boolean {
    return this.timers.has(kind);
  }

  ensure(kind: TimerKind, delayMs: number, action: () => void): void {
    if (this.timers.has(kind)) {
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(kind);
      action();
    }, delayMs);
    this.timers.set(kind, timer);
  }

  cancel(kind: TimerKind): void {
    const timer = this.timers.get(kind);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(kind);
    }
  }

  cancelAll(): void {
    for (const kind of [...this.timers.keys()]) {
      this.cancel(kind);
    }
  }
}
