import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "../../src/codex/app-server-client.js";

let client: CodexAppServerClient | undefined;
afterEach(async () => client?.stop());

describe("Codex App Server JSONL contract", () => {
  it("identifies the released ClawBridge 2.0 client during initialization", async () => {
    client = new CodexAppServerClient({
      command: process.execPath,
      args: [path.resolve("tests/fixtures/fake-app-server.mjs"), "--require-client-version=2.0.5"],
      requestTimeoutMs: 2_000,
      turnTimeoutMs: 2_000,
    });

    await expect(client.listModels()).resolves.toHaveLength(1);
  });

  it("lists models and sends model plus reasoning effort to turn/start", async () => {
    client = new CodexAppServerClient({
      command: process.execPath,
      args: [path.resolve("tests/fixtures/fake-app-server.mjs")],
      requestTimeoutMs: 2_000,
      turnTimeoutMs: 2_000,
    });
    await expect(client.listModels()).resolves.toEqual([
      expect.objectContaining({
        model: "gpt-test",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Fast" },
          { reasoningEffort: "medium", description: "Balanced" },
        ],
      }),
    ]);
    await expect(
      client.runTurn({
        cwd: process.cwd(),
        prompt: "hello",
        approvalPolicy: "onRequest",
        sandbox: "workspaceWrite",
        model: "gpt-test",
        reasoningEffort: "medium",
      }),
    ).resolves.toEqual(expect.objectContaining({ finalText: "fake result" }));
  });
  it("classifies the implicit thread created by runTurn as a user thread", async () => {
    client = new CodexAppServerClient({
      command: process.execPath,
      args: [path.resolve("tests/fixtures/fake-app-server.mjs")],
      requestTimeoutMs: 2_000,
      turnTimeoutMs: 2_000,
    });
    const progress: string[] = [];
    const result = await client.runTurn({
      cwd: process.cwd(),
      prompt: "hello",
      approvalPolicy: "onRequest",
      sandbox: "workspaceWrite",
      onProgress: (event) => {
        if (event.type === "assistantDelta") progress.push(event.delta);
      },
    });
    expect(result).toEqual({
      threadId: "thread-test",
      turnId: "turn-test",
      finalText: "fake result",
    });
    expect(progress).toEqual(["fake ", "result"]);

    await expect(client.listThreads({ cwd: process.cwd(), limit: 10 })).resolves.toEqual([
      expect.objectContaining({ id: "thread-test", status: "notLoaded", cwd: process.cwd() }),
    ]);
    await expect(client.readThread("thread-test")).resolves.toEqual(
      expect.objectContaining({ id: "thread-test", status: "notLoaded" }),
    );
    await expect(client.interrupt("thread-test", "turn-test")).resolves.toBeUndefined();
  });

  it("classifies an explicitly-created thread as a user thread", async () => {
    client = new CodexAppServerClient({
      command: process.execPath,
      args: [path.resolve("tests/fixtures/fake-app-server.mjs")],
      requestTimeoutMs: 2_000,
      turnTimeoutMs: 2_000,
    });

    await expect(
      client.startThread({
        cwd: process.cwd(),
        approvalPolicy: "never",
        sandbox: "workspaceWrite",
      }),
    ).resolves.toEqual(expect.objectContaining({ id: "thread-test" }));
  });

  it("starts the first turn of an explicitly-created empty thread without thread/resume", async () => {
    client = new CodexAppServerClient({
      command: process.execPath,
      args: [path.resolve("tests/fixtures/fake-app-server.mjs")],
      requestTimeoutMs: 2_000,
      turnTimeoutMs: 2_000,
    });
    let resumes = 0;
    client.on("message", (message) => {
      if ("method" in message && message.method === "test/resumeObserved") resumes += 1;
    });
    const thread = await client.startThread({
      cwd: process.cwd(),
      approvalPolicy: "never",
      sandbox: "workspaceWrite",
    });

    await expect(
      client.runTurn({
        cwd: process.cwd(),
        prompt: "first task",
        threadId: thread.id,
        approvalPolicy: "never",
        sandbox: "workspaceWrite",
      }),
    ).resolves.toEqual(expect.objectContaining({ threadId: thread.id, finalText: "fake result" }));
    expect(resumes).toBe(0);

    await expect(
      client.runTurn({
        cwd: process.cwd(),
        prompt: "second task",
        threadId: thread.id,
        approvalPolicy: "never",
        sandbox: "workspaceWrite",
      }),
    ).resolves.toEqual(expect.objectContaining({ threadId: thread.id }));
    expect(resumes).toBe(1);
  });

  it.each(["unsubscribed", "notSubscribed", "notLoaded"] as const)(
    "unsubscribes a thread without stopping the App Server (%s)",
    async (status) => {
      client = new CodexAppServerClient({
        command: process.execPath,
        args: [
          path.resolve("tests/fixtures/fake-app-server.mjs"),
          `--unsubscribe-status=${status}`,
        ],
        requestTimeoutMs: 2_000,
        turnTimeoutMs: 2_000,
      });

      await expect(client.unsubscribeThread("thread-test")).resolves.toBe(status);
      await expect(client.readThread("thread-test")).resolves.toEqual(
        expect.objectContaining({ id: "thread-test" }),
      );
    },
  );

  it("rejects an invalid thread unsubscribe status", async () => {
    client = new CodexAppServerClient({
      command: process.execPath,
      args: [path.resolve("tests/fixtures/fake-app-server.mjs"), "--unsubscribe-status=unexpected"],
      requestTimeoutMs: 2_000,
      turnTimeoutMs: 2_000,
    });

    await expect(client.unsubscribeThread("thread-test")).rejects.toMatchObject({
      code: "CODEX_PROTOCOL_ERROR",
      message: "Invalid thread/unsubscribe response",
    });
  });

  it("holds concurrent business calls until the shared initialize handshake completes", async () => {
    client = new CodexAppServerClient({
      command: process.execPath,
      args: [
        path.resolve("tests/fixtures/fake-app-server.mjs"),
        "--initialize-delay=75",
        "--require-initialized",
      ],
      requestTimeoutMs: 2_000,
      turnTimeoutMs: 2_000,
    });

    const [started, listed, read] = await Promise.all([
      client.startThread({
        cwd: process.cwd(),
        approvalPolicy: "never",
        sandbox: "workspaceWrite",
      }),
      client.listThreads({ cwd: process.cwd(), limit: 10 }),
      client.readThread("thread-test"),
    ]);

    expect(started).toEqual(expect.objectContaining({ id: "thread-test" }));
    expect(listed).toEqual([expect.objectContaining({ id: "thread-test" })]);
    expect(read).toEqual(expect.objectContaining({ id: "thread-test" }));
  });

  it("interrupts the started turn and removes its waiter when onStarted throws", async () => {
    client = new CodexAppServerClient({
      command: process.execPath,
      args: [path.resolve("tests/fixtures/fake-app-server.mjs")],
      requestTimeoutMs: 2_000,
      turnTimeoutMs: 2_000,
    });
    const interruptObserved = new Promise<void>((resolve) => {
      const onMessage = (message: unknown): void => {
        if (
          typeof message === "object" &&
          message !== null &&
          "method" in message &&
          message.method === "test/interruptObserved"
        ) {
          client?.off("message", onMessage);
          resolve();
        }
      };
      client?.on("message", onMessage);
    });

    await expect(
      client.runTurn({
        cwd: process.cwd(),
        prompt: "hang",
        approvalPolicy: "never",
        sandbox: "workspaceWrite",
        onStarted: () => {
          throw new Error("onStarted failed");
        },
      }),
    ).rejects.toThrow("onStarted failed");
    await expect(interruptObserved).resolves.toBeUndefined();
    expect(client.listenerCount("message")).toBe(0);
    expect(client.listenerCount("terminated")).toBe(0);
  });

  it("terminates the App Server when onStarted fails and the turn cannot be interrupted", async () => {
    client = new CodexAppServerClient({
      command: process.execPath,
      args: [
        path.resolve("tests/fixtures/fake-app-server.mjs"),
        "--fail-interrupt",
        "--report-pid",
      ],
      requestTimeoutMs: 2_000,
      turnTimeoutMs: 2_000,
    });
    const serverPids: number[] = [];
    const onMessage = (message: unknown): void => {
      if (
        typeof message === "object" &&
        message !== null &&
        "method" in message &&
        message.method === "test/serverPid" &&
        "params" in message &&
        typeof message.params === "object" &&
        message.params !== null &&
        "pid" in message.params &&
        typeof message.params.pid === "number"
      ) {
        serverPids.push(message.params.pid);
      }
    };
    client.on("message", onMessage);

    await expect(
      client.runTurn({
        cwd: process.cwd(),
        prompt: "hang",
        approvalPolicy: "never",
        sandbox: "workspaceWrite",
        onStarted: () => {
          throw new Error("callback persistence failed");
        },
      }),
    ).rejects.toThrow("callback persistence failed");

    await expect(
      client.startThread({
        cwd: process.cwd(),
        approvalPolicy: "never",
        sandbox: "workspaceWrite",
      }),
    ).resolves.toEqual(expect.objectContaining({ id: "thread-test" }));
    client.off("message", onMessage);
    expect(serverPids).toHaveLength(2);
    expect(serverPids[1]).not.toBe(serverPids[0]);
  });

  it.each([
    ["turn/start rejects", "--fail-turn-start", "turn start failed"],
    ["turn/start has no turn id", "--invalid-turn-start", "did not return a turn id"],
  ])("unsubscribes an implicitly-created thread when %s", async (_name, mode, message) => {
    client = new CodexAppServerClient({
      command: process.execPath,
      args: [path.resolve("tests/fixtures/fake-app-server.mjs"), mode],
      requestTimeoutMs: 2_000,
      turnTimeoutMs: 2_000,
    });
    const unsubscribeObserved = new Promise<string>((resolve) => {
      const onMessage = (rpcMessage: unknown): void => {
        if (
          typeof rpcMessage === "object" &&
          rpcMessage !== null &&
          "method" in rpcMessage &&
          rpcMessage.method === "test/unsubscribeObserved" &&
          "params" in rpcMessage &&
          typeof rpcMessage.params === "object" &&
          rpcMessage.params !== null &&
          "threadId" in rpcMessage.params &&
          typeof rpcMessage.params.threadId === "string"
        ) {
          client?.off("message", onMessage);
          resolve(rpcMessage.params.threadId);
        }
      };
      client?.on("message", onMessage);
    });

    await expect(
      client.runTurn({
        cwd: process.cwd(),
        prompt: "never starts",
        approvalPolicy: "never",
        sandbox: "workspaceWrite",
      }),
    ).rejects.toThrow(message);
    await expect(unsubscribeObserved).resolves.toBe("thread-test");
  });

  it("restarts the App Server when cleanup unsubscribe fails, while preserving the turn error", async () => {
    client = new CodexAppServerClient({
      command: process.execPath,
      args: [
        path.resolve("tests/fixtures/fake-app-server.mjs"),
        "--fail-turn-start",
        "--unsubscribe-status=unexpected",
        "--report-pid",
      ],
      requestTimeoutMs: 2_000,
      turnTimeoutMs: 2_000,
    });
    const serverPids: number[] = [];
    client.on("message", (rpcMessage: unknown) => {
      if (
        typeof rpcMessage === "object" &&
        rpcMessage !== null &&
        "method" in rpcMessage &&
        rpcMessage.method === "test/serverPid" &&
        "params" in rpcMessage &&
        typeof rpcMessage.params === "object" &&
        rpcMessage.params !== null &&
        "pid" in rpcMessage.params &&
        typeof rpcMessage.params.pid === "number"
      ) {
        serverPids.push(rpcMessage.params.pid);
      }
    });

    await expect(
      client.runTurn({
        cwd: process.cwd(),
        prompt: "never starts",
        approvalPolicy: "never",
        sandbox: "workspaceWrite",
      }),
    ).rejects.toThrow("turn start failed");

    await expect(
      client.startThread({
        cwd: process.cwd(),
        approvalPolicy: "never",
        sandbox: "workspaceWrite",
      }),
    ).resolves.toEqual(expect.objectContaining({ id: "thread-test" }));
    expect(serverPids).toHaveLength(2);
    expect(serverPids[1]).not.toBe(serverPids[0]);
  });

  it("does not unsubscribe an existing resumed thread when turn/start fails", async () => {
    client = new CodexAppServerClient({
      command: process.execPath,
      args: [
        path.resolve("tests/fixtures/fake-app-server.mjs"),
        "--fail-turn-start",
        "--unsubscribe-status=unexpected",
        "--report-pid",
      ],
      requestTimeoutMs: 2_000,
      turnTimeoutMs: 2_000,
    });
    const serverPids: number[] = [];
    client.on("message", (rpcMessage: unknown) => {
      if (
        typeof rpcMessage === "object" &&
        rpcMessage !== null &&
        "method" in rpcMessage &&
        rpcMessage.method === "test/serverPid" &&
        "params" in rpcMessage &&
        typeof rpcMessage.params === "object" &&
        rpcMessage.params !== null &&
        "pid" in rpcMessage.params &&
        typeof rpcMessage.params.pid === "number"
      ) {
        serverPids.push(rpcMessage.params.pid);
      }
    });

    await expect(
      client.runTurn({
        cwd: process.cwd(),
        prompt: "never starts",
        threadId: "thread-existing",
        approvalPolicy: "never",
        sandbox: "workspaceWrite",
      }),
    ).rejects.toThrow("turn start failed");

    await expect(
      client.startThread({
        cwd: process.cwd(),
        approvalPolicy: "never",
        sandbox: "workspaceWrite",
      }),
    ).resolves.toEqual(expect.objectContaining({ id: "thread-test" }));
    expect(serverPids).toHaveLength(1);
  });

  it("rejects an active turn promptly when App Server exits", async () => {
    client = new CodexAppServerClient({
      command: process.execPath,
      args: [path.resolve("tests/fixtures/fake-app-server-crash.mjs")],
      requestTimeoutMs: 2_000,
      turnTimeoutMs: 2_000,
    });
    await expect(
      client.runTurn({
        cwd: process.cwd(),
        prompt: "crash",
        approvalPolicy: "onRequest",
        sandbox: "workspaceWrite",
      }),
    ).rejects.toMatchObject({ code: "CODEX_START_FAILED" });
  });

  it("maps the local read-only policy to current App Server wire values", async () => {
    client = new CodexAppServerClient({
      command: process.execPath,
      args: [path.resolve("tests/fixtures/fake-app-server.mjs")],
      requestTimeoutMs: 2_000,
      turnTimeoutMs: 2_000,
    });
    await expect(
      client.runTurn({
        cwd: process.cwd(),
        prompt: "read only",
        approvalPolicy: "never",
        sandbox: "readOnly",
      }),
    ).resolves.toMatchObject({ finalText: "fake result" });
  });

  it("manages stable stored-thread history without experimental APIs", async () => {
    client = new CodexAppServerClient({
      command: process.execPath,
      args: [path.resolve("tests/fixtures/fake-app-server.mjs")],
      requestTimeoutMs: 2_000,
      turnTimeoutMs: 2_000,
    });

    await expect(
      client.startThread({
        cwd: process.cwd(),
        approvalPolicy: "unlessTrusted",
        sandbox: "readOnly",
      }),
    ).resolves.toEqual(
      expect.objectContaining({ id: "thread-test", cwd: process.cwd(), status: "notLoaded" }),
    );

    await expect(client.nameThread("thread-test", "Named history")).resolves.toBeUndefined();
    await expect(client.readThread("thread-test")).resolves.toEqual(
      expect.objectContaining({ id: "thread-test", name: "Named history" }),
    );

    await expect(client.readThreadDetails("thread-test")).resolves.toEqual(
      expect.objectContaining({
        id: "thread-test",
        turns: [
          {
            id: "turn-history",
            status: "completed",
            startedAt: 10,
            completedAt: 11,
            messages: [
              { role: "user", text: "history question", phase: null },
              { role: "assistant", text: "history progress", phase: "commentary" },
              { role: "assistant", text: "history answer", phase: "final_answer" },
            ],
          },
        ],
      }),
    );

    await expect(client.archiveThread("thread-test")).resolves.toBeUndefined();
    await expect(
      client.listThreads({
        cwd: process.cwd(),
        archived: true,
        cursor: "cursor-test",
        limit: 5,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "thread-test",
        name: "Named history",
        preview: "cursor-test:archived",
      }),
    ]);

    await expect(client.unarchiveThread("thread-test")).resolves.toEqual(
      expect.objectContaining({ id: "thread-test", name: "Named history" }),
    );
  });

  it("interrupts a Codex turn when the turn deadline expires", async () => {
    client = new CodexAppServerClient({
      command: process.execPath,
      args: [path.resolve("tests/fixtures/fake-app-server.mjs")],
      requestTimeoutMs: 1_000,
      turnTimeoutMs: 50,
    });
    const interruptObserved = new Promise<void>((resolve) => {
      client?.on("message", (message) => {
        if ("method" in message && message.method === "test/interruptObserved") resolve();
      });
    });

    await expect(
      client.runTurn({
        cwd: process.cwd(),
        prompt: "hang",
        approvalPolicy: "never",
        sandbox: "workspaceWrite",
      }),
    ).rejects.toMatchObject({
      code: "CODEX_TIMEOUT",
      message: "Codex turn timed out after 1s; interrupt requested",
    });
    await expect(interruptObserved).resolves.toBeUndefined();
  });

  it("stops and restarts the App Server when a timed-out turn cannot be interrupted", async () => {
    client = new CodexAppServerClient({
      command: process.execPath,
      args: [
        path.resolve("tests/fixtures/fake-app-server.mjs"),
        "--fail-interrupt",
        "--report-pid",
      ],
      requestTimeoutMs: 1_000,
      turnTimeoutMs: 50,
    });
    const serverPids: number[] = [];
    client.on("message", (message) => {
      if (
        "method" in message &&
        message.method === "test/serverPid" &&
        typeof message.params === "object" &&
        message.params !== null &&
        "pid" in message.params &&
        typeof message.params.pid === "number"
      ) {
        serverPids.push(message.params.pid);
      }
    });

    await expect(
      client.runTurn({
        cwd: process.cwd(),
        prompt: "hang",
        approvalPolicy: "never",
        sandbox: "workspaceWrite",
      }),
    ).rejects.toMatchObject({ code: "CODEX_TIMEOUT" });

    await expect(client.readThread("thread-test")).resolves.toMatchObject({ id: "thread-test" });
    await vi.waitFor(() => expect(new Set(serverPids).size).toBeGreaterThanOrEqual(2));
  });
});
