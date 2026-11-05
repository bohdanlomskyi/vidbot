/**
 * Serialises asynchronous tasks per key (for example per Discord guild). Tasks
 * with the same key run one at a time in submission order. Tasks with different
 * keys run independently. A failing task releases the key for the next one.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    // `tail` settles only after this task releases, so the next task waits for it.
    const tail = previous.then(() => current);
    this.tails.set(key, tail);

    try {
      await previous;
      return await task();
    } finally {
      release();
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}
