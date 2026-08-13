import { describe, expect, it } from "vitest";
import { normalizeCodexEvent } from "../../src/codex/event-normalizer.js";

describe("normalizeCodexEvent", () => {
  it("normalizes plan updates", () => {
    expect(
      normalizeCodexEvent({
        method: "turn/plan/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          plan: [{ step: "Run tests", status: "inProgress" }],
        },
      }),
    ).toEqual({
      type: "plan",
      threadId: "thread-1",
      turnId: "turn-1",
      steps: [{ step: "Run tests", status: "inProgress" }],
    });
  });

  it("normalizes completed command and file-change items", () => {
    expect(
      normalizeCodexEvent({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            command: ["npm", "test"],
            status: "completed",
            exitCode: 0,
          },
        },
      }),
    ).toMatchObject({ type: "command", command: "npm test", status: "completed", exitCode: 0 });

    expect(
      normalizeCodexEvent({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "fileChange",
            status: "completed",
            changes: [
              { path: "src/app.ts", kind: "update" },
              { path: "src/new.ts", kind: "add" },
            ],
          },
        },
      }),
    ).toMatchObject({ type: "fileChange", paths: ["src/app.ts", "src/new.ts"] });
  });

  it("normalizes server errors", () => {
    expect(
      normalizeCodexEvent({
        method: "error",
        params: { threadId: "thread-1", turnId: "turn-1", error: { message: "network" } },
      }),
    ).toEqual({ type: "error", threadId: "thread-1", turnId: "turn-1", message: "network" });
  });
});
