import { describe, expect, it, vi } from "vitest";
import { TaskStreamPump } from "../../src/delivery/task-stream-pump.js";

describe("TaskStreamPump", () => {
  it("coalesces rapid updates and flushes the latest full content", async () => {
    vi.useFakeTimers();
    try {
      const published: string[] = [];
      const pump = new TaskStreamPump(async (content) => {
        published.push(content);
      }, 400);
      pump.push("a");
      pump.push("ab");
      pump.push("abc");

      await vi.advanceTimersByTimeAsync(400);
      await pump.flush();
      expect(published).toEqual(["abc"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes final content before closing", async () => {
    const publish = vi.fn(async () => undefined);
    const pump = new TaskStreamPump(publish, 10_000);
    pump.push("partial");
    await pump.close("complete");
    expect(publish).toHaveBeenLastCalledWith("complete");
    pump.push("ignored");
    await pump.flush();
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
