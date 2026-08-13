export class TaskStreamPump {
  private latest = "";
  private published = "";
  private timer: NodeJS.Timeout | undefined;
  private tail = Promise.resolve();
  private lastPublishedAt = 0;
  private closed = false;

  constructor(
    private readonly publish: (content: string) => Promise<void>,
    private readonly intervalMs = 400,
  ) {}

  push(content: string): void {
    if (this.closed) return;
    this.latest = content;
    if (this.timer) return;
    const delay = Math.max(0, this.intervalMs - (Date.now() - this.lastPublishedAt));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.enqueueLatest();
    }, delay);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.enqueueLatest();
    await this.tail;
  }

  async close(finalContent?: string): Promise<void> {
    if (finalContent !== undefined) this.latest = finalContent;
    await this.flush();
    this.closed = true;
  }

  private enqueueLatest(): void {
    const snapshot = this.latest;
    if (!snapshot || snapshot === this.published) return;
    this.published = snapshot;
    this.tail = this.tail.then(async () => {
      await this.publish(snapshot);
      this.lastPublishedAt = Date.now();
      if (!this.closed && this.latest !== snapshot && !this.timer) this.push(this.latest);
    });
    // A later flush/close still observes the original rejection. This immediate
    // handler only prevents a throttled background publication from becoming an
    // unhandled rejection before the caller reaches that synchronization point.
    void this.tail.catch(() => undefined);
  }
}
