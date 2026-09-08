import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChannelAdapter } from "../../src/channels/channel-adapter.js";
import type { InboundEvent, OutboundMessage } from "../../src/core/types.js";
import type { CodexRunner } from "../../src/codex/protocol-types.js";
import type { BridgeConfig } from "../../src/config/schema.js";
import { BridgeDatabase } from "../../src/persistence/database.js";
import { Bridge } from "../../src/core/bridge.js";
import { BridgeError } from "../../src/core/errors.js";
import type { DesktopProjectSource } from "../../src/projects/codex-desktop-project-discovery.js";
import { areSameResolvedPath } from "../../src/security/path-policy.js";

class FakeChannel implements ChannelAdapter {
  callback?: (event: InboundEvent) => Promise<void>;
  readonly sent: OutboundMessage[] = [];
  readonly updatedCards: Array<{ messageId: string; card: Record<string, unknown> }> = [];
  readonly deletedMessages: string[] = [];
  updateCardMessage?: NonNullable<ChannelAdapter["updateCardMessage"]>;
  readonly deleteMessage = vi.fn(async (messageId: string) => {
    this.deletedMessages.push(messageId);
  });
  sendAttempts = 0;
  private remainingFailures: number;
  private releaseBlockedSend?: () => void;
  readonly createProjectSpace = vi.fn(async (input: { projectName: string }) => ({
    chatId: "chat-created-project",
    displayName: `[Codex] ${input.projectName}`,
  }));
  readonly inspectProjectSpace = vi.fn<NonNullable<ChannelAdapter["inspectProjectSpace"]>>(
    async () => ({ status: "ready", displayName: "[Codex] Demo" }),
  );
  readonly addProjectSpaceMember = vi.fn(async () => undefined);
  readonly removeProjectSpaceMember = vi.fn(async () => undefined);
  readonly deleteProjectSpace = vi.fn(async () => undefined);
  readonly configureProjectSpace = vi.fn(async () => undefined);
  readonly createProjectTopic = vi.fn<NonNullable<ChannelAdapter["createProjectTopic"]>>(
    async () => ({ topicRootId: "topic-created-thread" }),
  );
  startTaskStream?: NonNullable<ChannelAdapter["startTaskStream"]>;
  updateTaskStream?: NonNullable<ChannelAdapter["updateTaskStream"]>;
  finishTaskStream?: NonNullable<ChannelAdapter["finishTaskStream"]>;
  readonly downloadAttachment = vi.fn(async (input: { targetPath: string }) => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(input.targetPath, "attachment content");
  });

  constructor(
    options: {
      failures?: number;
      blockFirstSend?: boolean;
      updateCards?: boolean;
      streaming?: boolean;
    } = {},
  ) {
    this.remainingFailures = options.failures ?? 0;
    if (options.updateCards) {
      this.updateCardMessage = vi.fn(async (messageId, card) => {
        this.updatedCards.push({ messageId, card });
      });
    }
    if (options.streaming) {
      this.startTaskStream = vi.fn(async () => ({
        streamId: "stream-task-1",
        messageId: "message-stream-1",
      }));
      this.updateTaskStream = vi.fn(async () => undefined);
      this.finishTaskStream = vi.fn(async () => undefined);
    }
    if (options.blockFirstSend) {
      this.firstSendGate = new Promise<void>((resolve) => {
        this.releaseBlockedSend = resolve;
      });
    }
  }

  private readonly firstSendGate?: Promise<void>;

  async start(callback: (event: InboundEvent) => Promise<void>): Promise<void> {
    this.callback = callback;
  }

  async stop(): Promise<void> {}

  async send(message: OutboundMessage): Promise<string> {
    this.sendAttempts += 1;
    if (this.sendAttempts === 1 && this.firstSendGate) await this.firstSendGate;
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw new Error("temporary Feishu failure");
    }
    this.sent.push(message);
    const id = `sent-${this.sent.length}`;
    return id;
  }

  releaseFirstSend(): void {
    this.releaseBlockedSend?.();
  }

  async receive(text: string, eventId = "event-bridge-1"): Promise<void> {
    if (!this.callback) throw new Error("channel has not started");
    await this.callback({
      eventId,
      messageId: "message-bridge-1",
      chatId: "chat-owner",
      chatType: "p2p",
      senderOpenId: "owner",
      text,
      receivedAt: new Date().toISOString(),
    });
  }

  async receiveAttachment(
    attachment: { key: string; name: string; type: "image" | "file" },
    eventId: string,
  ): Promise<void> {
    if (!this.callback) throw new Error("channel has not started");
    await this.callback({
      eventId,
      messageId: `message-${eventId}`,
      chatId: "chat-owner",
      chatType: "p2p",
      senderOpenId: "owner",
      text: `process ${attachment.name}`,
      attachments: [attachment],
      receivedAt: new Date().toISOString(),
    });
  }

  async receiveGroup(
    text: string,
    eventId = "group-event-bridge-1",
    options: { chatId?: string; topicRootId?: string; senderOpenId?: string } = {},
  ): Promise<void> {
    if (!this.callback) throw new Error("channel has not started");
    await this.callback({
      eventId,
      messageId: "group-message-bridge-1",
      chatId: options.chatId ?? "chat-group",
      chatType: "group",
      senderOpenId: options.senderOpenId ?? "owner",
      text,
      ...(options.topicRootId ? { topicRootId: options.topicRootId } : {}),
      receivedAt: new Date().toISOString(),
    });
  }

  async receiveCard(
    value: Record<string, unknown>,
    eventId = "card-event-bridge-1",
    senderOpenId = "owner",
    messageId = this.latestCardMessageId(),
    formValue?: Record<string, unknown>,
    chatId = "chat-owner",
  ): Promise<void> {
    if (!this.callback) throw new Error("channel has not started");
    await this.callback({
      kind: "card_action",
      eventId,
      messageId,
      chatId,
      chatType: "unknown",
      senderOpenId,
      value,
      ...(formValue ? { formValue } : {}),
      receivedAt: new Date().toISOString(),
    });
  }

  latestCardMessageIdForChat(chatId: string): string {
    for (let index = this.sent.length - 1; index >= 0; index -= 1) {
      const message = this.sent[index];
      if (message?.kind === "card" && message.chatId === chatId) return `sent-${index + 1}`;
    }
    return "missing-card-message";
  }

  private latestCardMessageId(): string {
    for (let index = this.sent.length - 1; index >= 0; index -= 1) {
      if (this.sent[index]?.kind === "card") return `sent-${index + 1}`;
    }
    return "missing-card-message";
  }
}

const config: BridgeConfig = {
  bridge: {
    databasePath: ":memory:",
    logLevel: "info",
    maxConcurrency: 1,
    deliveryMaxAttempts: 5,
    deliveryRetryBaseMs: 10,
    attachmentDirectory: "./data/attachments-test",
    attachmentMaxBytes: 1024 * 1024,
    outputArtifacts: { enabled: true, maxFiles: 10 },
  },
  feishu: {
    appIdEnv: "APP_ID",
    appSecretEnv: "APP_SECRET",
    allowedOpenIdEnv: "OWNER_ID",
    directMessagesOnly: true,
  },
  composer: {
    enabled: false,
    routingMode: "sessionParam",
    pollIntervalMs: 5_000,
    maxFiles: 20,
    tokenTtlMinutes: 30,
    fields: {
      session: "ClawBridge会话",
      text: "消息内容",
      attachments: "附件",
      status: "处理状态",
      error: "错误信息",
    },
    statuses: { pending: "待处理", processing: "处理中", accepted: "已接收", failed: "失败" },
  },
  codex: {
    command: "fake",
    args: [],
    approvalPolicy: "onRequest",
    sandbox: "workspaceWrite",
    requestTimeoutMs: 2_000,
    turnTimeoutMs: 10_000,
  },
  projectManagement: {
    allowedRoots: [],
    allowCreateDirectory: false,
    allowRegisterExisting: false,
    codexDesktopProjects: { enabled: false, registerCreatedProjects: false },
  },
  projectsFile: "projects.yaml",
};

let bridge: Bridge | undefined;
afterEach(async () => bridge?.stop());

function fakeCodex(): CodexRunner {
  let createdThread = 0;
  let serverRequestHandler: Parameters<CodexRunner["setServerRequestHandler"]>[0] | undefined;
  return {
    setServerRequestHandler: vi.fn((handler) => {
      serverRequestHandler = handler;
      void serverRequestHandler;
    }),
    listModels: vi.fn(async () => [
      {
        id: "gpt-test",
        model: "gpt-test",
        displayName: "GPT Test",
        description: "Test model",
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
      },
    ]),
    readRateLimits: vi.fn(async () => ({
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        planType: "plus",
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 1_800_100_000 },
        rateLimitReachedType: null,
        spendControlReached: false,
        individualLimit: null,
      },
      rateLimitsByLimitId: null,
      availableResetCredits: 2,
    })),
    runTurn: vi.fn(async (input: Parameters<CodexRunner["runTurn"]>[0]) => {
      input.onStarted?.({ threadId: "thread-bridge", turnId: "turn-bridge" });
      if (input.prompt === "needs approval") {
        await new Promise<void>((resolve, reject) => {
          serverRequestHandler?.({
            request: {
              id: "approval-1",
              method: "item/commandExecution/requestApproval",
              params: {
                threadId: "thread-bridge",
                turnId: "turn-bridge",
                itemId: "item-1",
                startedAtMs: Date.now(),
                command: "npm test",
                reason: "Run tests",
              },
            },
            respond: async (result) => {
              if ((result as { decision?: string }).decision !== "accept") {
                reject(new Error("approval declined"));
                return;
              }
              resolve();
            },
            reject: async (error) => reject(new Error(error.message)),
          });
        });
      }
      if (input.prompt === "needs answer") {
        await new Promise<void>((resolve, reject) => {
          serverRequestHandler?.({
            request: {
              id: "question-1",
              method: "item/tool/requestUserInput",
              params: {
                threadId: "thread-bridge",
                turnId: "turn-bridge",
                itemId: "item-2",
                isBlocking: true,
                questions: [
                  {
                    id: "choice",
                    header: "选择模式",
                    question: "使用哪个模式？",
                    options: [{ label: "安全", description: "只读运行" }],
                  },
                ],
              },
            },
            respond: async (result) => {
              const answer = (result as { answers?: Record<string, { answers: string[] }> }).answers
                ?.choice?.answers[0];
              if (answer !== "安全") reject(new Error("unexpected answer"));
              else resolve();
            },
            reject: async (error) => reject(new Error(error.message)),
          });
        });
      }
      return {
        threadId: "thread-bridge",
        turnId: "turn-bridge",
        finalText: "done",
      };
    }),
    startThread: vi.fn(async (input: Parameters<CodexRunner["startThread"]>[0]) => ({
      id: `thread-created-${++createdThread}`,
      name: null,
      preview: "",
      cwd: input.cwd,
      updatedAt: Date.now(),
      status: "notLoaded",
    })),
    listThreads: vi.fn(async () => []),
    readThread: vi.fn(async (threadId: string) => ({
      id: threadId,
      name: "Test thread",
      preview: "",
      cwd: process.cwd(),
      updatedAt: null,
      status: "notLoaded",
    })),
    readThreadDetails: vi.fn(async (threadId: string) => ({
      id: threadId,
      name: "Test thread",
      preview: "",
      cwd: process.cwd(),
      updatedAt: Date.now(),
      status: "notLoaded",
      turns: [],
    })),
    nameThread: vi.fn(async () => undefined),
    archiveThread: vi.fn(async () => undefined),
    unarchiveThread: vi.fn(async (threadId: string) => ({
      id: threadId,
      name: "Test thread",
      preview: "",
      cwd: process.cwd(),
      updatedAt: Date.now(),
      status: "notLoaded",
    })),
    unsubscribeThread: vi.fn(async () => "unsubscribed" as const),
    interrupt: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
}

describe("Bridge vertical slice", () => {
  function cardActionValue(
    message: OutboundMessage | undefined,
    actionName: string,
  ): Record<string, unknown> | undefined {
    if (message?.kind !== "card") return undefined;
    const visit = (value: unknown): Record<string, unknown> | undefined => {
      if (Array.isArray(value)) {
        for (const item of value) {
          const found = visit(item);
          if (found) return found;
        }
      } else if (typeof value === "object" && value !== null) {
        const record = value as Record<string, unknown>;
        if (
          typeof record.value === "object" &&
          record.value !== null &&
          (record.value as Record<string, unknown>).action === actionName
        )
          return record.value as Record<string, unknown>;
        for (const child of Object.values(record)) {
          const found = visit(child);
          if (found) return found;
        }
      }
      return undefined;
    };
    return visit(message.card);
  }

  it("returns a pairing candidate without authorizing Codex execution", async () => {
    const channel = new FakeChannel();
    const codex = fakeCodex();
    const logger = pino({ level: "silent" });
    const warn = vi.spyOn(logger, "warn");
    const database = new BridgeDatabase(":memory:");
    bridge = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "ou_pending_pairing",
      logger,
    });

    await bridge.start();
    await channel.receive("pair me", "pair-event");

    expect(warn).toHaveBeenCalledWith(
      { pairingCandidateOpenId: "owner" },
      expect.stringContaining("CLAWBRIDGE_FEISHU_ALLOWED_OPEN_ID"),
    );
    expect(codex.runTurn).not.toHaveBeenCalled();
    expect(channel.sent).toEqual([
      expect.objectContaining({
        chatId: "chat-owner",
        text: expect.stringContaining("owner"),
      }),
    ]);
  });

  it("routes command approval to a one-time card and resumes the task", async () => {
    const channel = new FakeChannel();
    const database = new BridgeDatabase(":memory:");
    bridge = new Bridge({
      channel,
      codex: fakeCodex(),
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();
    await channel.receive("needs approval", "approval-task");
    await vi.waitFor(() =>
      expect(database.listTasks({ limit: 1 })[0]?.state).toBe("waiting_approval"),
    );
    const card = channel.sent.find(
      (message) => message.kind === "card" && message.text === "Codex 等待远程审批",
    );
    const value = cardActionValue(card, "approval.resolve");
    expect(value).toMatchObject({ decision: "accept" });
    await channel.receiveCard(value!, "approval-answer");
    await vi.waitFor(() => expect(database.listTasks({ limit: 1 })[0]?.state).toBe("completed"));
    await channel.receiveCard(value!, "approval-replay");
    await vi.waitFor(() =>
      expect(
        channel.sent.some(
          (message) => message.kind !== "card" && message.text.includes("已处理或已过期"),
        ),
      ).toBe(true),
    );
  });

  it("routes Codex user input options through a question card", async () => {
    const channel = new FakeChannel();
    const database = new BridgeDatabase(":memory:");
    bridge = new Bridge({
      channel,
      codex: fakeCodex(),
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();
    await channel.receive("needs answer", "question-task");
    await vi.waitFor(() =>
      expect(database.listTasks({ limit: 1 })[0]?.state).toBe("waiting_approval"),
    );
    const card = channel.sent.find(
      (message) => message.kind === "card" && message.text === "Codex 等待你的回答",
    );
    const value = cardActionValue(card, "question.answer");
    expect(value).toMatchObject({ answer: "安全", questionId: "choice" });
    await channel.receiveCard(value!, "question-answer");
    await vi.waitFor(() => expect(database.listTasks({ limit: 1 })[0]?.state).toBe("completed"));
  });

  it("downloads an image attachment into a task directory and cleans it after completion", async () => {
    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "clawbridge-attachments-"));
    try {
      const channel = new FakeChannel();
      const codex = fakeCodex();
      const database = new BridgeDatabase(":memory:");
      bridge = new Bridge({
        channel,
        codex,
        database,
        config: {
          ...config,
          bridge: { ...config.bridge, attachmentDirectory: temporaryDirectory },
        },
        projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
        allowedOpenId: "owner",
        logger: pino({ level: "silent" }),
      });
      await bridge.start();
      await channel.receiveAttachment(
        { key: "image-key", name: "photo.jpg", type: "image" },
        "image-task",
      );
      await vi.waitFor(() => expect(database.listTasks({ limit: 1 })[0]?.state).toBe("completed"));
      expect(channel.downloadAttachment).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: "message-image-task",
          fileKey: "image-key",
          type: "image",
        }),
      );
      expect(vi.mocked(codex.runTurn).mock.calls[0]?.[0].inputs).toEqual([
        expect.objectContaining({ type: "text" }),
        expect.objectContaining({ type: "localImage", path: expect.stringContaining("image.jpg") }),
      ]);
      expect(
        existsSync(path.join(temporaryDirectory, database.listTasks({ limit: 1 })[0]!.id)),
      ).toBe(false);
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("accepts one composed turn with text and multiple local attachments", async () => {
    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "clawbridge-composed-"));
    const sourceDirectory = path.join(temporaryDirectory, "composer", "submission-1");
    mkdirSync(sourceDirectory, { recursive: true });
    const imagePath = path.join(sourceDirectory, "photo.png");
    const filePath = path.join(sourceDirectory, "notes.md");
    writeFileSync(imagePath, "image");
    writeFileSync(filePath, "notes");
    try {
      const channel = new FakeChannel({ streaming: true });
      const codex = fakeCodex();
      const database = new BridgeDatabase(":memory:");
      bridge = new Bridge({
        channel,
        codex,
        database,
        config: {
          ...config,
          bridge: { ...config.bridge, attachmentDirectory: temporaryDirectory },
        },
        projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
        allowedOpenId: "owner",
        logger: pino({ level: "silent" }),
      });
      await bridge.start();
      database.bindFeishuProjectSpace({
        projectId: "demo",
        chatId: "chat-project",
        ownerOpenId: "owner",
        displayName: "[Codex] Demo",
      });
      database.bindFeishuPendingTopic({
        projectId: "demo",
        chatId: "chat-project",
        topicRootId: "topic-composed",
        ownerOpenId: "owner",
      });

      await bridge.submitComposedTurn({
        eventId: "composer:submission-1",
        messageId: "composer:submission-1",
        chatId: "chat-project",
        chatType: "group",
        topicRootId: "topic-composed",
        senderOpenId: "owner",
        text: "一起分析",
        attachments: [
          {
            key: "local-image",
            name: "photo.png",
            type: "image",
            source: "local",
            localPath: imagePath,
          },
          {
            key: "local-file",
            name: "notes.md",
            type: "file",
            source: "local",
            localPath: filePath,
          },
        ],
        receivedAt: new Date().toISOString(),
      });
      await vi.waitFor(() => expect(database.listTasks({ limit: 1 })[0]?.state).toBe("completed"));

      expect(channel.downloadAttachment).not.toHaveBeenCalled();
      const turn = vi.mocked(codex.runTurn).mock.calls[0]?.[0];
      expect(turn?.inputs).toEqual([
        expect.objectContaining({ type: "text", text: expect.stringContaining("2-file.md") }),
        expect.objectContaining({ type: "localImage" }),
      ]);
      expect(existsSync(sourceDirectory)).toBe(false);
      expect(channel.startTaskStream).toHaveBeenCalledWith(
        expect.objectContaining({
          userText: "一起分析",
          attachments: [
            { name: "photo.png", type: "image", localPath: imagePath },
            { name: "notes.md", type: "file" },
          ],
        }),
      );
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("persists an inbound message, runs Codex, and sends the final result", async () => {
    const channel = new FakeChannel();
    const codex = fakeCodex();
    bridge = new Bridge({
      channel,
      codex,
      database: new BridgeDatabase(":memory:"),
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });

    await bridge.start();
    await channel.receive("inspect this project");
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.text.includes("✅ completed"))).toBe(true),
    );
    expect(codex.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "inspect this project", cwd: process.cwd() }),
    );
    expect(codex.unsubscribeThread).toHaveBeenCalledWith("thread-bridge");
    expect(channel.sent.at(-1)?.text).toContain("thread-bridge");
  });

  it("shows current Codex remaining quota from the single-chat console", async () => {
    const channel = new FakeChannel({ updateCards: true });
    const codex = fakeCodex();
    bridge = new Bridge({
      channel,
      codex,
      database: new BridgeDatabase(":memory:"),
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });

    await bridge.start();
    await channel.receive("/menu", "quota-menu");
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.kind === "card")).toBe(true),
    );
    const cardMessageId = channel.latestCardMessageIdForChat("chat-owner");
    await channel.receiveCard(
      { version: 1, action: "quota.show" },
      "quota-show",
      "owner",
      cardMessageId,
    );

    await vi.waitFor(() => expect(codex.readRateLimits).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(JSON.stringify(channel.updatedCards.at(-1)?.card)).toContain("剩余 75%"),
    );
  });

  it("keeps only the finalized stream card when streaming succeeds", async () => {
    const channel = new FakeChannel({ streaming: true });
    const database = new BridgeDatabase(":memory:");
    bridge = new Bridge({
      channel,
      codex: fakeCodex(),
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });

    await bridge.start();
    await channel.receive("stream this result", "stream-success");
    await vi.waitFor(() => expect(database.listTasks({ limit: 1 })[0]?.state).toBe("completed"));

    expect(channel.updateTaskStream).toHaveBeenLastCalledWith("stream-task-1", "done");
    expect(channel.finishTaskStream).toHaveBeenCalledWith("stream-task-1", {
      summary: "Demo · 已完成",
      finalText: "done",
    });
    expect(channel.sent.some((message) => message.text.includes("✅ completed"))).toBe(false);
  });

  it("passes only explicitly linked project-local outputs to the Feishu stream finalizer", async () => {
    const channel = new FakeChannel({ streaming: true });
    const codex = fakeCodex();
    const projectRoot = mkdtempSync(path.join(tmpdir(), "clawbridge-project-output-"));
    const outputPath = path.join(projectRoot, "result.png");
    writeFileSync(outputPath, "image");
    vi.mocked(codex.runTurn).mockImplementationOnce(async (input) => {
      input.onStarted?.({ threadId: "thread-bridge", turnId: "turn-bridge" });
      return {
        threadId: "thread-bridge",
        turnId: "turn-bridge",
        finalText: `已生成。![结果](<${outputPath}>)`,
      };
    });
    const database = new BridgeDatabase(":memory:");
    bridge = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: projectRoot, enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });

    try {
      await bridge.start();
      await channel.receive("生成图片", "stream-output");
      await vi.waitFor(() => expect(database.listTasks({ limit: 1 })[0]?.state).toBe("completed"));

      expect(channel.finishTaskStream).toHaveBeenCalledWith(
        "stream-task-1",
        expect.objectContaining({
          finalText: expect.stringContaining("result.png"),
          artifacts: [
            expect.objectContaining({ path: outputPath, name: "result.png", type: "image" }),
          ],
        }),
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("falls back to a normal final reply when finalizing the stream fails", async () => {
    const channel = new FakeChannel({ streaming: true });
    channel.updateTaskStream = vi.fn(async () => {
      throw new Error("CardKit update failed");
    });
    const database = new BridgeDatabase(":memory:");
    bridge = new Bridge({
      channel,
      codex: fakeCodex(),
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });

    await bridge.start();
    await channel.receive("stream fallback", "stream-fallback");
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.text.includes("✅ completed"))).toBe(true),
    );
    expect(database.listTasks({ limit: 1 })[0]?.state).toBe("completed");
  });

  it("routes a registered project topic to its bound Codex thread", async () => {
    const channel = new FakeChannel({ updateCards: true });
    const codex = fakeCodex();
    vi.mocked(codex.runTurn).mockImplementation(async (input) => {
      input.onStarted?.({ threadId: "thread-topic", turnId: "turn-topic" });
      return { threadId: "thread-topic", turnId: "turn-topic", finalText: "done" };
    });
    const database = new BridgeDatabase(":memory:");
    database.syncProjects([{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }]);
    database.upsertThread({ threadId: "thread-topic", projectId: "demo", status: "idle" });
    database.bindFeishuProjectSpace({
      projectId: "demo",
      chatId: "chat-group",
      ownerOpenId: "owner",
      displayName: "[Codex] Demo",
    });
    database.bindFeishuThreadRoute({
      threadId: "thread-topic",
      projectId: "demo",
      chatId: "chat-group",
      topicRootId: "topic-root-1",
      ownerOpenId: "owner",
    });
    bridge = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });

    await bridge.start();
    await channel.receiveGroup("检查这个项目", "topic-task", {
      topicRootId: "topic-root-1",
    });

    await vi.waitFor(() => expect(codex.runTurn).toHaveBeenCalledTimes(1));
    expect(codex.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "检查这个项目",
        cwd: process.cwd(),
        threadId: "thread-topic",
      }),
    );
    await vi.waitFor(() =>
      expect(
        channel.sent.some(
          (message) =>
            message.kind === "card" &&
            message.replyToMessageId === "topic-root-1" &&
            JSON.stringify(message.card).includes("model.list"),
        ),
      ).toBe(true),
    );
    const firstToolbarMessageId = database.getFeishuThreadRoute("thread-topic")?.toolbarMessageId;
    expect(firstToolbarMessageId).toMatch(/^sent-/);

    await channel.receiveGroup("再检查一次", "topic-task-2", {
      topicRootId: "topic-root-1",
    });
    await vi.waitFor(() => expect(codex.runTurn).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(channel.deletedMessages).toContain(firstToolbarMessageId));
    await vi.waitFor(() =>
      expect(
        channel.sent.filter(
          (message) => message.kind === "card" && message.text.includes("模型设置"),
        ),
      ).toHaveLength(2),
    );
    expect(database.getFeishuThreadRoute("thread-topic")?.toolbarMessageId).not.toBe(
      firstToolbarMessageId,
    );
  });

  it("opens a native composer directly while activating its bound topic", async () => {
    const channel = new FakeChannel({ updateCards: true });
    const codex = fakeCodex();
    vi.mocked(codex.runTurn).mockImplementation(async (input) => {
      input.onStarted?.({ threadId: "thread-topic", turnId: "turn-topic" });
      return { threadId: "thread-topic", turnId: "turn-topic", finalText: "done" };
    });
    const database = new BridgeDatabase(":memory:");
    database.syncProjects([{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }]);
    database.upsertThread({ threadId: "thread-topic", projectId: "demo", status: "idle" });
    database.bindFeishuProjectSpace({
      projectId: "demo",
      chatId: "chat-group",
      ownerOpenId: "owner",
      displayName: "[Codex] Demo",
    });
    database.bindFeishuThreadRoute({
      threadId: "thread-topic",
      projectId: "demo",
      chatId: "chat-group",
      topicRootId: "topic-root-1",
      ownerOpenId: "owner",
    });
    const formUrl = "https://example.feishu.cn/share/base/native-form";
    const composer = {
      getDirectSubmissionUrl: vi.fn(() => formUrl),
      createSubmissionUrl: vi.fn(() => formUrl),
    };
    bridge = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      composer,
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });

    await bridge.start();
    await channel.receiveGroup("生成工具栏", "composer-toolbar", {
      topicRootId: "topic-root-1",
    });
    await vi.waitFor(() =>
      expect(
        channel.sent.some(
          (message) =>
            message.kind === "card" &&
            JSON.stringify(message.card).includes("composer.open.thread"),
        ),
      ).toBe(true),
    );
    const toolbar = channel.sent.findLast(
      (message) =>
        message.kind === "card" && JSON.stringify(message.card).includes("composer.open.thread"),
    );
    const value = cardActionValue(toolbar, "composer.open.thread");
    expect(value).toBeDefined();
    expect(JSON.stringify(toolbar)).toContain(formUrl);
    const sentBeforeClick = channel.sent.length;
    await channel.receiveCard(
      value!,
      "composer-open",
      "owner",
      channel.latestCardMessageIdForChat("chat-group"),
      undefined,
      "chat-group",
    );

    expect(composer.createSubmissionUrl).toHaveBeenCalledWith({
      chatId: "chat-group",
      chatType: "group",
      senderOpenId: "owner",
      topicRootId: "topic-root-1",
    });
    expect(channel.sent).toHaveLength(sentBeforeClick);
  });

  it("opens model settings at the bottom when a project topic receives the exact model keyword", async () => {
    const channel = new FakeChannel({ updateCards: true });
    const codex = fakeCodex();
    const database = new BridgeDatabase(":memory:");
    database.syncProjects([{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }]);
    database.upsertThread({ threadId: "thread-topic", projectId: "demo", status: "idle" });
    database.bindFeishuProjectSpace({
      projectId: "demo",
      chatId: "chat-group",
      ownerOpenId: "owner",
      displayName: "[Codex] Demo",
    });
    database.bindFeishuThreadRoute({
      threadId: "thread-topic",
      projectId: "demo",
      chatId: "chat-group",
      topicRootId: "topic-root-1",
      ownerOpenId: "owner",
    });
    bridge = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });

    await bridge.start();
    await channel.receiveGroup("模型", "topic-model", { topicRootId: "topic-root-1" });

    await vi.waitFor(() => expect(codex.listModels).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(
        channel.sent.some(
          (message) =>
            message.kind === "card" &&
            message.replyToMessageId === "topic-root-1" &&
            message.text === "模型与推理强度",
        ),
      ).toBe(true),
    );
    expect(codex.runTurn).not.toHaveBeenCalled();

    const modelCardMessageId = channel.latestCardMessageIdForChat("chat-group");
    await channel.receiveCard(
      {
        version: 1,
        action: "model.use",
        projectId: "demo",
        threadId: "thread-topic",
        model: "gpt-test",
      },
      "topic-model-use",
      "owner",
      modelCardMessageId,
      undefined,
      "chat-group",
    );
    await vi.waitFor(() => expect(channel.updatedCards).toHaveLength(1));
    const compactCard = channel.updatedCards[0]?.card;
    expect(compactCard).not.toHaveProperty("header");
    expect(JSON.stringify(compactCard)).toContain("model.list");
    expect(JSON.stringify(compactCard)).not.toContain("项目控制台");
    expect(JSON.stringify(compactCard)).not.toContain("Test model");
  });

  it("keeps model settings out of the project group's main chat", async () => {
    const channel = new FakeChannel();
    const codex = fakeCodex();
    const database = new BridgeDatabase(":memory:");
    database.syncProjects([{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }]);
    database.bindFeishuProjectSpace({
      projectId: "demo",
      chatId: "chat-group",
      ownerOpenId: "owner",
      displayName: "[Codex] Demo",
    });
    bridge = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });

    await bridge.start();
    await channel.receiveGroup("模型", "project-model");

    expect(channel.sent).toHaveLength(0);
    expect(codex.listModels).not.toHaveBeenCalled();
    expect(codex.runTurn).not.toHaveBeenCalled();
  });

  it("invalidates an empty topic thread when Codex reports that no rollout exists", async () => {
    const channel = new FakeChannel();
    const codex = fakeCodex();
    vi.mocked(codex.runTurn).mockRejectedValue(
      new Error("no rollout found for thread id thread-empty"),
    );
    const database = new BridgeDatabase(":memory:");
    database.syncProjects([{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }]);
    database.upsertThread({ threadId: "thread-empty", projectId: "demo", status: "idle" });
    database.bindFeishuProjectSpace({
      projectId: "demo",
      chatId: "chat-group",
      ownerOpenId: "owner",
      displayName: "[Codex] Demo",
    });
    database.bindFeishuThreadRoute({
      threadId: "thread-empty",
      projectId: "demo",
      chatId: "chat-group",
      topicRootId: "topic-empty",
      ownerOpenId: "owner",
    });
    database.selectProject("chat-group", "demo");
    database.setThread("chat-group", "demo", "thread-empty");
    bridge = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });

    await bridge.start();
    await channel.receiveGroup("run this", "missing-rollout", { topicRootId: "topic-empty" });

    await vi.waitFor(() =>
      expect(database.getProjectThread("demo", "thread-empty")?.status).toBe("unavailable"),
    );
    expect(database.getConversation("chat-group")?.threadId).toBeNull();
    expect(database.getFeishuThreadRoute("thread-empty")).toBeUndefined();
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.text.includes("没有可恢复的 Codex 历史"))).toBe(
        true,
      ),
    );
  });

  it("rejects group messages outside a registered project topic", async () => {
    const channel = new FakeChannel();
    const codex = fakeCodex();
    const database = new BridgeDatabase(":memory:");
    database.syncProjects([{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }]);
    database.bindFeishuProjectSpace({
      projectId: "demo",
      chatId: "chat-group",
      ownerOpenId: "owner",
      displayName: "[Codex] Demo",
    });
    bridge = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });

    await bridge.start();
    await channel.receiveGroup("不要执行", "group-without-topic");
    await channel.receiveGroup("也不要执行", "unknown-topic", {
      topicRootId: "unknown-topic-root",
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(codex.runTurn).not.toHaveBeenCalled();
    expect(database.nextQueued()).toBeUndefined();
  });

  it("returns the interactive control card for /menu", async () => {
    const channel = new FakeChannel();
    bridge = new Bridge({
      channel,
      codex: fakeCodex(),
      database: new BridgeDatabase(":memory:"),
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });

    await bridge.start();
    await channel.receive("/menu", "menu-command");
    await vi.waitFor(() =>
      expect(
        channel.sent.some(
          (message) => message.kind === "card" && message.text === "ClawBridge 控制台",
        ),
      ).toBe(true),
    );

    const menu = channel.sent.find(
      (message) => message.kind === "card" && message.text === "ClawBridge 控制台",
    );
    expect(menu).toMatchObject({
      kind: "card",
      audience: "p2p",
      card: {
        config: { update_multi: false },
        header: { title: { content: "ClawBridge 控制台" } },
      },
    });
  });

  it("opens global and project task centers from the control card", async () => {
    const channel = new FakeChannel();
    const database = new BridgeDatabase(":memory:");
    database.syncProjects([{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }]);
    database.enqueue(
      {
        eventId: "task-center-event",
        messageId: "task-center-message",
        chatId: "chat-owner",
        chatType: "p2p",
        senderOpenId: "owner",
        text: "实现任务中心",
        receivedAt: new Date().toISOString(),
      },
      "demo",
    );
    bridge = new Bridge({
      channel,
      codex: fakeCodex(),
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();
    await channel.receive("/menu", "task-center-menu");
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.kind === "card")).toBe(true),
    );

    await channel.receiveCard({ version: 1, action: "task.list" }, "task-center-global");
    await vi.waitFor(() =>
      expect(
        channel.sent.some((message) => message.kind === "card" && message.text === "全局任务中心"),
      ).toBe(true),
    );
    await channel.receiveCard(
      { version: 1, action: "task.list", projectId: "demo" },
      "task-center-project",
    );
    await vi.waitFor(() =>
      expect(
        channel.sent.some((message) => message.kind === "card" && message.text === "项目任务中心"),
      ).toBe(true),
    );
  });

  it("does not issue an interactive card into a group chat", async () => {
    const channel = new FakeChannel();
    const database = new BridgeDatabase(":memory:");
    database.syncProjects([{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }]);
    database.upsertThread({ threadId: "thread-topic", projectId: "demo", status: "idle" });
    database.bindFeishuProjectSpace({
      projectId: "demo",
      chatId: "chat-group",
      ownerOpenId: "owner",
      displayName: "[Codex] Demo",
    });
    database.bindFeishuThreadRoute({
      threadId: "thread-topic",
      projectId: "demo",
      chatId: "chat-group",
      topicRootId: "topic-root-menu",
      ownerOpenId: "owner",
    });
    bridge = new Bridge({
      channel,
      codex: fakeCodex(),
      database,
      config: {
        ...config,
        feishu: { ...config.feishu, directMessagesOnly: false },
      },
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });

    await bridge.start();
    await channel.receiveGroup("菜单", "group-menu", { topicRootId: "topic-root-menu" });
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.text.includes("仅支持机器人单聊"))).toBe(true),
    );
    expect(channel.sent.some((message) => message.kind === "card")).toBe(false);
  });

  it("paginates all available projects through card actions", async () => {
    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "clawbridge-card-pages-"));
    try {
      const channel = new FakeChannel();
      const database = new BridgeDatabase(":memory:");
      const projects = Array.from({ length: 17 }, (_, index) => {
        const rootPath = path.join(temporaryDirectory, `project-${index + 1}`);
        mkdirSync(rootPath);
        return { id: `p${index + 1}`, name: `Project ${index + 1}`, rootPath, enabled: true };
      });
      bridge = new Bridge({
        channel,
        codex: fakeCodex(),
        database,
        config,
        projects,
        allowedOpenId: "owner",
        logger: pino({ level: "silent" }),
      });
      await bridge.start();
      await channel.receive("/menu", "project-page-menu");
      await vi.waitFor(() =>
        expect(channel.sent.some((message) => message.kind === "card")).toBe(true),
      );

      await channel.receiveCard(
        { version: 1, action: "project.list", page: 1 },
        "project-page-two",
      );
      await vi.waitFor(() =>
        expect(
          channel.sent.some(
            (message) =>
              message.kind === "card" &&
              JSON.stringify(message.card).includes("Project 9") &&
              JSON.stringify(message.card).includes("第 2 / 2 页"),
          ),
        ).toBe(true),
      );
    } finally {
      await bridge?.stop();
      bridge = undefined;
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("creates a fresh project topic and materializes its Codex thread on the first task", async () => {
    const channel = new FakeChannel();
    const codex = fakeCodex();
    const database = new BridgeDatabase(":memory:");
    bridge = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();

    await channel.receive("/menu", "card-project-menu");
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.kind === "card")).toBe(true),
    );
    await channel.receiveCard({ version: 1, action: "project.list" }, "card-project-list");
    await vi.waitFor(() =>
      expect(
        channel.sent.some((message) => message.kind === "card" && message.text === "选择项目"),
      ).toBe(true),
    );

    await channel.receiveCard(
      { version: 1, action: "project.use", projectId: "demo" },
      "card-project-use",
    );
    await vi.waitFor(() => expect(database.getConversation("chat-owner")?.projectId).toBe("demo"));
    database.upsertThread({
      threadId: "thread-old",
      projectId: "demo",
      title: "Old work",
      archived: false,
    });
    database.setThread("chat-owner", "demo", "thread-old");

    await channel.receiveCard(
      { version: 1, action: "thread.new", projectId: "demo" },
      "card-thread-new",
    );
    await vi.waitFor(() =>
      expect(
        database.resolveFeishuPendingTopic("chat-created-project", "topic-created-thread"),
      ).toMatchObject({ projectId: "demo" }),
    );
    expect(channel.createProjectSpace).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "demo", projectName: "Demo", ownerOpenId: "owner" }),
    );
    expect(channel.createProjectTopic).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "chat-created-project" }),
    );
    expect(database.getFeishuThreadRoute("thread-created-1")).toBeUndefined();
    expect(codex.runTurn).not.toHaveBeenCalled();

    await channel.receiveGroup("从新对话开始执行", "card-fresh-thread-task", {
      chatId: "chat-created-project",
      topicRootId: "topic-created-thread",
    });
    await vi.waitFor(() => expect(codex.runTurn).toHaveBeenCalledTimes(1));
    expect(vi.mocked(codex.runTurn).mock.calls[0]?.[0]).toMatchObject({
      prompt: "从新对话开始执行",
      threadId: null,
    });
    await vi.waitFor(() =>
      expect(database.getFeishuThreadRoute("thread-bridge")).toMatchObject({
        projectId: "demo",
        chatId: "chat-created-project",
        topicRootId: "topic-created-thread",
      }),
    );
    expect(
      database.resolveFeishuPendingTopic("chat-created-project", "topic-created-thread"),
    ).toBeUndefined();
  });

  it("registers mobile projects only while Desktop is closed and honors Desktop removal", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "clawbridge-mobile-project-"));
    const channel = new FakeChannel();
    const database = new BridgeDatabase(":memory:");
    let registeredProject: { name: string; rootPath: string } | undefined;
    let desktopRunning = true;
    const registerProject = vi.fn(async (input: { name: string; rootPath: string }) => {
      const created = !registeredProject;
      registeredProject = input;
      return { sourceId: "desktop-test", created };
    });
    const desktopProjects: DesktopProjectSource = {
      isDesktopRunning: vi.fn(async () => desktopRunning),
      listProjects: vi.fn(async () => ({
        projects: registeredProject
          ? [
              {
                sourceId: "desktop-test",
                name: registeredProject.name,
                rootPaths: [registeredProject.rootPath],
                order: 0,
                assignedThreadIds: [],
              },
            ]
          : [],
        sourcePath: path.join(root, ".codex-global-state.json"),
        usedBackup: false,
      })),
      registerProject,
    };
    bridge = new Bridge({
      channel,
      codex: fakeCodex(),
      database,
      config: {
        ...config,
        projectManagement: {
          allowedRoots: [root],
          allowCreateDirectory: true,
          allowRegisterExisting: false,
          codexDesktopProjects: { enabled: true, registerCreatedProjects: true },
        },
      },
      projects: [],
      desktopProjects,
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    try {
      await bridge.start();
      await channel.receive("/menu", "mobile-project-menu");
      await vi.waitFor(() =>
        expect(channel.sent.some((message) => message.kind === "card")).toBe(true),
      );
      await channel.receiveCard(
        { version: 1, action: "project.create" },
        "mobile-project-create",
        "owner",
        channel.latestCardMessageIdForChat("chat-owner"),
        { projectName: "test_codex" },
      );

      await vi.waitFor(() =>
        expect(database.listProjects().some((project) => project.name === "test_codex")).toBe(true),
      );
      const project = database.listProjects().find((candidate) => candidate.name === "test_codex");
      expect(project?.id).toMatch(/^mobile-[0-9a-f]{16}$/);
      expect(project?.name).toBe("test_codex");
      expect(path.basename(project?.rootPath ?? "")).toBe("test_codex");
      expect(existsSync(path.join(root, "test_codex"))).toBe(true);
      expect(registerProject).not.toHaveBeenCalled();
      expect(database.getDesktopProjectSync(project!.id)).toMatchObject({ state: "pending" });

      desktopRunning = false;
      await channel.receive("/project list", "desktop-closed-register-project");
      await vi.waitFor(() => expect(registerProject).toHaveBeenCalledTimes(1));
      expect(registerProject).toHaveBeenCalledWith({
        name: "test_codex",
        rootPath: project?.rootPath,
      });
      expect(database.getDesktopProjectSync(project!.id)).toMatchObject({
        state: "pending",
        sourceId: "desktop-test",
      });

      desktopRunning = true;
      await channel.receive("/project list", "desktop-observed-project");
      await vi.waitFor(() =>
        expect(database.getDesktopProjectSync(project!.id)?.state).toBe("synced"),
      );

      registeredProject = undefined;
      await channel.receive("/project list", "desktop-removed-project");
      await vi.waitFor(() =>
        expect(database.getDesktopProjectSync(project!.id)?.state).toBe("removed"),
      );
      expect(database.getProject(project!.id)?.enabled).toBe(false);
      expect(registerProject).toHaveBeenCalledTimes(1);

      registeredProject = { name: "test_codex", rootPath: project!.rootPath };
      await channel.receive("/project list", "desktop-restored-project");
      await vi.waitFor(() => expect(database.getProject(project!.id)?.enabled).toBe(true));
      expect(database.getDesktopProjectSync(project!.id)?.state).toBe("synced");
    } finally {
      await bridge.stop();
      bridge = undefined;
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reinvites the owner when an existing project group was temporarily left", async () => {
    const channel = new FakeChannel();
    channel.inspectProjectSpace.mockResolvedValueOnce({
      status: "owner_absent",
      displayName: "[Codex] Demo",
    });
    const database = new BridgeDatabase(":memory:");
    database.syncProjects([{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }]);
    database.bindFeishuProjectSpace({
      projectId: "demo",
      chatId: "chat-existing-project",
      ownerOpenId: "owner",
      displayName: "[Codex] Demo",
    });
    bridge = new Bridge({
      channel,
      codex: fakeCodex(),
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();

    await channel.receive("/menu", "rejoin-menu");
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.kind === "card")).toBe(true),
    );
    await channel.receiveCard(
      { version: 1, action: "project.space", projectId: "demo" },
      "rejoin-project-space",
    );
    await vi.waitFor(() =>
      expect(channel.addProjectSpaceMember).toHaveBeenCalledWith({
        chatId: "chat-existing-project",
        ownerOpenId: "owner",
      }),
    );
    expect(channel.createProjectSpace).not.toHaveBeenCalled();
    expect(database.getFeishuProjectSpace("demo")?.chatId).toBe("chat-existing-project");
  });

  it("rebuilds the project group when Feishu rejects rejoining the previous group", async () => {
    const channel = new FakeChannel();
    channel.inspectProjectSpace.mockResolvedValueOnce({
      status: "owner_absent",
      displayName: "[Codex] Demo",
    });
    channel.addProjectSpaceMember.mockRejectedValueOnce(
      new Error("Request failed with status code 400"),
    );
    const database = new BridgeDatabase(":memory:");
    database.syncProjects([{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }]);
    database.bindFeishuProjectSpace({
      projectId: "demo",
      chatId: "chat-existing-project",
      ownerOpenId: "owner",
      displayName: "[Codex] Demo",
    });
    bridge = new Bridge({
      channel,
      codex: fakeCodex(),
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();
    await channel.receive("/menu", "rejoin-fallback-menu");
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.kind === "card")).toBe(true),
    );

    await channel.receiveCard(
      { version: 1, action: "project.space", projectId: "demo" },
      "rejoin-fallback-project-space",
    );
    await vi.waitFor(() =>
      expect(database.getFeishuProjectSpace("demo")?.chatId).toBe("chat-created-project"),
    );
    expect(channel.createProjectSpace).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "demo", ownerOpenId: "owner" }),
    );
    expect(
      channel.sent.some((message) => message.text.includes("Request failed with status code 400")),
    ).toBe(false);
  });

  it("rebuilds the project group when the previous group can no longer be inspected", async () => {
    const channel = new FakeChannel();
    channel.inspectProjectSpace.mockRejectedValueOnce(
      new Error("读取飞书项目群信息失败：Request failed with status code 400"),
    );
    const database = new BridgeDatabase(":memory:");
    database.syncProjects([{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }]);
    database.bindFeishuProjectSpace({
      projectId: "demo",
      chatId: "chat-inaccessible-project",
      ownerOpenId: "owner",
      displayName: "[Codex] Demo",
    });
    bridge = new Bridge({
      channel,
      codex: fakeCodex(),
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();
    await channel.receive("/menu", "inspect-fallback-menu");
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.kind === "card")).toBe(true),
    );

    await channel.receiveCard(
      { version: 1, action: "project.space", projectId: "demo" },
      "inspect-fallback-project-space",
    );
    await vi.waitFor(() =>
      expect(database.getFeishuProjectSpace("demo")?.chatId).toBe("chat-created-project"),
    );
    expect(channel.createProjectSpace).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "demo", ownerOpenId: "owner" }),
    );
    expect(
      channel.sent.some((message) => message.text.includes("Request failed with status code 400")),
    ).toBe(false);
  });

  it("opens the project group and reports a topic-specific notice when topic creation fails", async () => {
    const channel = new FakeChannel({ updateCards: true });
    channel.createProjectTopic.mockRejectedValueOnce(
      new Error("创建项目话题回复失败：飞书错误码 230071：reply in thread is not supported"),
    );
    const database = new BridgeDatabase(":memory:");
    database.syncProjects([{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }]);
    database.bindFeishuProjectSpace({
      projectId: "demo",
      chatId: "chat-existing-project",
      ownerOpenId: "owner",
      displayName: "[Codex] Demo",
    });
    database.selectProject("chat-owner", "demo");
    database.upsertThread({
      threadId: "thread-existing",
      projectId: "demo",
      title: "Existing work",
    });
    database.setThread("chat-owner", "demo", "thread-existing");
    bridge = new Bridge({
      channel,
      codex: fakeCodex(),
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();
    await channel.receive("/menu", "topic-failure-menu");
    await vi.waitFor(() => expect(channel.sent.length).toBeGreaterThan(0));
    const cardMessageId = channel.latestCardMessageIdForChat("chat-owner");

    await channel.receiveCard(
      { version: 1, action: "project.space", projectId: "demo" },
      "topic-failure-open",
      "owner",
      cardMessageId,
    );

    await vi.waitFor(() =>
      expect(
        channel.sent.some(
          (message) =>
            message.kind === "card" &&
            message.chatId === "chat-existing-project" &&
            JSON.stringify(message.card).includes("飞书错误码 230071"),
        ),
      ).toBe(true),
    );
    expect(channel.updatedCards.at(-1)?.messageId).toBe(cardMessageId);
    expect(JSON.stringify(channel.updatedCards.at(-1)?.card)).toContain("项目群已打开");
    expect(database.getFeishuThreadRoute("thread-existing")).toBeUndefined();
    expect(
      channel.sent.some((message) => message.text === "❌ Request failed with status code 400"),
    ).toBe(false);
  });

  it("rebuilds a dissolved project group while preserving Codex history", async () => {
    const channel = new FakeChannel();
    channel.inspectProjectSpace.mockResolvedValueOnce({ status: "dissolved" });
    const codex = fakeCodex();
    vi.mocked(codex.readThreadDetails).mockResolvedValue({
      id: "thread-existing",
      name: "Existing work",
      preview: "",
      cwd: process.cwd(),
      updatedAt: Date.now(),
      status: "notLoaded",
      turns: [
        {
          id: "turn-1",
          status: "completed",
          startedAt: null,
          completedAt: null,
          messages: [
            { role: "user", text: "历史问题", phase: null },
            { role: "assistant", text: "中间过程不应恢复", phase: "commentary" },
            {
              role: "assistant",
              text: `历史答案 [package](<${path.join(process.cwd(), "package.json")}>)`,
              phase: "final_answer",
            },
          ],
        },
        {
          id: "turn-2",
          status: "completed",
          startedAt: null,
          completedAt: null,
          messages: [
            { role: "user", text: "第二个问题", phase: null },
            { role: "assistant", text: "答案上半段", phase: "final_answer" },
            { role: "assistant", text: "答案下半段", phase: "final_answer" },
          ],
        },
      ],
    });
    const database = new BridgeDatabase(":memory:");
    database.syncProjects([{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }]);
    database.upsertThread({
      threadId: "thread-existing",
      projectId: "demo",
      title: "Existing work",
      archived: false,
    });
    const historicalTask = database.enqueue(
      {
        eventId: "history-attachment-event",
        messageId: "history-attachment-message",
        chatId: "chat-dissolved",
        chatType: "group",
        topicRootId: "topic-old",
        senderOpenId: "owner",
        text: "历史问题",
        attachments: [{ key: "history-image", name: "现场照片.jpg", type: "image" }],
        receivedAt: new Date().toISOString(),
      },
      "demo",
      "thread-existing",
    );
    database.updateTask(historicalTask!.id, "completed", {
      codexTurnId: "turn-1",
      finalText: "历史答案",
    });
    database.bindFeishuProjectSpace({
      projectId: "demo",
      chatId: "chat-dissolved",
      ownerOpenId: "owner",
      displayName: "[Codex] Demo",
    });
    database.bindFeishuThreadRoute({
      threadId: "thread-existing",
      projectId: "demo",
      chatId: "chat-dissolved",
      topicRootId: "topic-old",
      ownerOpenId: "owner",
    });
    database.selectProject("chat-owner", "demo");
    database.setThread("chat-owner", "demo", "thread-existing");
    bridge = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();

    await channel.receive("/menu", "rebuild-menu");
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.kind === "card")).toBe(true),
    );
    await channel.receiveCard(
      { version: 1, action: "project.space", projectId: "demo" },
      "rebuild-project-space",
    );
    await vi.waitFor(() =>
      expect(database.getFeishuProjectSpace("demo")?.chatId).toBe("chat-created-project"),
    );
    expect(database.getProjectThread("demo", "thread-existing")?.title).toBe("Existing work");
    expect(database.getFeishuThreadRoute("thread-existing")).toMatchObject({
      chatId: "chat-created-project",
      topicRootId: "topic-created-thread",
    });
    expect(channel.createProjectSpace).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "demo", ownerOpenId: "owner" }),
    );
    const historyTurns = channel.createProjectTopic.mock.calls.at(-1)?.[0].historyTurns ?? [];
    expect(historyTurns[0]).toMatchObject({
      title: "第 1 轮",
      userText: "历史问题",
      assistantText: expect.stringContaining("历史答案"),
      attachments: [{ name: "现场照片.jpg", type: "image" }],
      localArtifacts: [
        expect.objectContaining({ name: "package.json", type: "file", path: expect.any(String) }),
      ],
    });
    expect(JSON.stringify(historyTurns)).not.toContain("中间过程不应恢复");
    expect(historyTurns[1]?.assistantText).toBe("答案上半段\n\n答案下半段");
  });

  it("migrates a legacy topic group and keeps project controls inside the group", async () => {
    const channel = new FakeChannel({ updateCards: true });
    channel.inspectProjectSpace.mockResolvedValueOnce({
      status: "ready",
      displayName: "[Codex] Demo",
      messageMode: "thread",
      canConfigure: true,
    });
    const database = new BridgeDatabase(":memory:");
    database.syncProjects([{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }]);
    database.bindFeishuProjectSpace({
      projectId: "demo",
      chatId: "chat-existing-project",
      ownerOpenId: "owner",
      displayName: "[Codex] Demo",
    });
    bridge = new Bridge({
      channel,
      codex: fakeCodex(),
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();

    await channel.receive("/menu", "group-console-menu");
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.kind === "card")).toBe(true),
    );
    const privateControlCardId = channel.latestCardMessageIdForChat("chat-owner");
    await channel.receiveCard(
      { version: 1, action: "project.space", projectId: "demo" },
      "open-existing-group",
    );
    await vi.waitFor(() =>
      expect(
        channel.sent.some(
          (message) =>
            message.kind === "card" &&
            message.chatId === "chat-existing-project" &&
            message.text === "Demo 项目控制台",
        ),
      ).toBe(true),
    );
    expect(channel.configureProjectSpace).toHaveBeenCalledWith({
      chatId: "chat-existing-project",
    });

    const groupCardId = channel.latestCardMessageIdForChat("chat-existing-project");
    await channel.receiveCard(
      { version: 1, action: "thread.new", projectId: "demo" },
      "group-new-thread",
      "owner",
      groupCardId,
      undefined,
      "chat-existing-project",
    );
    await vi.waitFor(() =>
      expect(
        database.resolveFeishuPendingTopic("chat-existing-project", "topic-created-thread"),
      ).toMatchObject({ projectId: "demo" }),
    );
    expect(channel.createProjectTopic).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "chat-existing-project",
        idempotencyKey: expect.stringMatching(/^clawbridge-new-topic-/),
        title: "新对话",
        historyTurns: [],
      }),
    );
    const originalTopicKey = channel.createProjectTopic.mock.calls.at(-1)?.[0].idempotencyKey;
    expect(
      channel.sent.some(
        (message) =>
          message.kind === "card" &&
          message.chatId === "chat-existing-project" &&
          message.audience === "group",
      ),
    ).toBe(true);
    expect(database.getConversation("chat-existing-project")?.threadId).toBeNull();

    // Old cards can still contain project.leave. They must only refresh to the
    // new confirmed destructive action instead of deleting immediately.
    await channel.receiveCard(
      { version: 1, action: "project.leave", projectId: "demo" },
      "group-leave",
      "owner",
      groupCardId,
      undefined,
      "chat-existing-project",
    );
    await vi.waitFor(() =>
      expect(JSON.stringify(channel.updatedCards.at(-1)?.card)).toContain("退出并丢弃项目群"),
    );
    expect(JSON.stringify(channel.updatedCards.at(-1)?.card)).toContain("确认退出并丢弃项目群");
    expect(channel.removeProjectSpaceMember).not.toHaveBeenCalled();
    expect(channel.deleteProjectSpace).not.toHaveBeenCalled();
    expect(database.getFeishuProjectSpace("demo")).toBeDefined();

    await channel.receiveCard(
      { version: 1, action: "project.dissolve", projectId: "demo" },
      "group-dissolve",
      "owner",
      groupCardId,
      undefined,
      "chat-existing-project",
    );
    await vi.waitFor(() =>
      expect(channel.deleteProjectSpace).toHaveBeenCalledWith({ chatId: "chat-existing-project" }),
    );
    expect(database.getFeishuProjectSpace("demo")).toBeUndefined();
    database.selectProject("chat-owner", "demo");
    database.setThread("chat-owner", "demo", "thread-created-1");

    await channel.receiveCard(
      { version: 1, action: "project.space", projectId: "demo" },
      "open-fresh-group",
      "owner",
      privateControlCardId,
      undefined,
      "chat-owner",
    );
    await vi.waitFor(() => expect(channel.createProjectSpace).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(database.getFeishuProjectSpace("demo")?.chatId).toBe("chat-created-project"),
    );
    await vi.waitFor(() => expect(channel.createProjectTopic).toHaveBeenCalledTimes(2));
    const replacementTopicKey = channel.createProjectTopic.mock.calls.at(-1)?.[0].idempotencyKey;
    expect(replacementTopicKey).toMatch(/^clawbridge-topic-[0-9a-f]{32}$/);
    expect(replacementTopicKey).not.toBe(originalTopicKey);
  });

  it("does not persist a project group that dissolves immediately after creation", async () => {
    const channel = new FakeChannel({ updateCards: true });
    channel.inspectProjectSpace.mockResolvedValue({ status: "dissolved" });
    const database = new BridgeDatabase(":memory:");
    database.syncProjects([{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }]);
    database.selectProject("chat-owner", "demo");
    bridge = new Bridge({
      channel,
      codex: fakeCodex(),
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();

    await channel.receive("/menu", "dissolved-after-create-menu");
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.kind === "card")).toBe(true),
    );
    const cardMessageId = channel.latestCardMessageIdForChat("chat-owner");
    await channel.receiveCard(
      { version: 1, action: "project.space", projectId: "demo" },
      "dissolved-after-create-action",
      "owner",
      cardMessageId,
    );

    await vi.waitFor(() => expect(channel.createProjectSpace).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(
        channel.sent.some(
          (message) =>
            message.kind === "text" &&
            message.text.includes("飞书项目群创建后不可用（状态：dissolved）"),
        ),
      ).toBe(true),
    );
    expect(database.getFeishuProjectSpace("demo")).toBeUndefined();
  });

  it("repairs a newly created project group when the owner is initially absent", async () => {
    const channel = new FakeChannel({ updateCards: true });
    channel.inspectProjectSpace
      .mockResolvedValueOnce({ status: "owner_absent" })
      .mockResolvedValueOnce({ status: "ready", displayName: "[Codex] Demo" });
    const database = new BridgeDatabase(":memory:");
    database.syncProjects([{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }]);
    database.selectProject("chat-owner", "demo");
    bridge = new Bridge({
      channel,
      codex: fakeCodex(),
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();

    await channel.receive("/menu", "repair-owner-menu");
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.kind === "card")).toBe(true),
    );
    await channel.receiveCard(
      { version: 1, action: "project.space", projectId: "demo" },
      "repair-owner-action",
      "owner",
      channel.latestCardMessageIdForChat("chat-owner"),
    );

    await vi.waitFor(() =>
      expect(channel.addProjectSpaceMember).toHaveBeenCalledWith({
        chatId: "chat-created-project",
        ownerOpenId: "owner",
      }),
    );
    await vi.waitFor(() =>
      expect(database.getFeishuProjectSpace("demo")?.chatId).toBe("chat-created-project"),
    );
  });

  it("opens a legacy project group even when Feishu rejects the message-mode migration", async () => {
    const channel = new FakeChannel();
    channel.inspectProjectSpace.mockResolvedValueOnce({
      status: "ready",
      displayName: "[Codex] Demo",
      messageMode: "thread",
      canConfigure: true,
    });
    channel.configureProjectSpace.mockRejectedValueOnce(
      new Error("Request failed with status code 400"),
    );
    const database = new BridgeDatabase(":memory:");
    database.syncProjects([{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }]);
    database.bindFeishuProjectSpace({
      projectId: "demo",
      chatId: "chat-existing-project",
      ownerOpenId: "owner",
      displayName: "[Codex] Demo",
    });
    database.selectProject("chat-owner", "demo");
    bridge = new Bridge({
      channel,
      codex: fakeCodex(),
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();
    await channel.receive("/menu", "legacy-group-menu");
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.kind === "card")).toBe(true),
    );

    await channel.receiveCard(
      { version: 1, action: "project.space", projectId: "demo" },
      "legacy-group-open",
    );
    await vi.waitFor(() =>
      expect(
        channel.sent.some(
          (message) =>
            message.kind === "card" &&
            message.chatId === "chat-existing-project" &&
            JSON.stringify(message.card).includes("项目群模式暂未迁移"),
        ),
      ).toBe(true),
    );
    expect(
      channel.sent.some((message) => message.text.includes("Request failed with status code 400")),
    ).toBe(false);
  });

  it("lists and selects an existing thread through card actions", async () => {
    const channel = new FakeChannel();
    const codex = fakeCodex();
    vi.mocked(codex.listThreads).mockImplementation(async (input) =>
      input.archived
        ? []
        : [
            {
              id: "thread-existing",
              name: "Existing work",
              preview: "Continue here",
              cwd: process.cwd(),
              updatedAt: Date.now(),
              status: "notLoaded",
            },
          ],
    );
    const database = new BridgeDatabase(":memory:");
    bridge = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();

    await channel.receive("/menu", "card-thread-menu");
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.kind === "card")).toBe(true),
    );

    await channel.receiveCard(
      { version: 1, action: "thread.list", projectId: "demo" },
      "card-thread-list",
    );
    await vi.waitFor(() =>
      expect(
        channel.sent.some(
          (message) => message.kind === "card" && message.text === "选择 Demo 的对话",
        ),
      ).toBe(true),
    );
    expect(database.getProjectThread("demo", "thread-existing")).toMatchObject({
      title: "Existing work",
      archived: false,
    });

    await channel.receiveCard(
      {
        version: 1,
        action: "thread.use",
        projectId: "demo",
        threadId: "thread-existing",
      },
      "card-thread-use",
    );
    await vi.waitFor(() =>
      expect(database.getConversation("chat-owner")?.threadId).toBe("thread-existing"),
    );
    expect(codex.readThread).toHaveBeenCalledWith("thread-existing");
    await vi.waitFor(() =>
      expect(
        channel.sent.some(
          (message) =>
            message.kind === "card" &&
            message.chatId === "chat-created-project" &&
            message.replyToMessageId === "topic-created-thread" &&
            message.text.includes("模型设置"),
        ),
      ).toBe(true),
    );
  });

  it("treats a legacy thread.show card as continue-conversation without a detail page", async () => {
    const channel = new FakeChannel({ updateCards: true });
    const codex = fakeCodex();
    vi.mocked(codex.listThreads).mockImplementation(async (input) =>
      input.archived
        ? []
        : [
            {
              id: "thread-existing",
              name: "Existing work",
              preview: "Continue here",
              cwd: process.cwd(),
              updatedAt: Date.now(),
              status: "notLoaded",
            },
          ],
    );
    vi.mocked(codex.readThreadDetails).mockResolvedValue({
      id: "thread-existing",
      name: "Existing work",
      preview: "Continue here",
      cwd: process.cwd(),
      updatedAt: Date.now(),
      status: "notLoaded",
      turns: Array.from({ length: 4 }, (_, index) => ({
        id: `turn-history-${index + 1}`,
        status: "completed",
        startedAt: null,
        completedAt: null,
        messages: [
          { role: "user" as const, text: `history-${index * 2 + 1}`, phase: null },
          {
            role: "assistant" as const,
            text: `history-${index * 2 + 2}`,
            phase: "final_answer",
          },
        ],
      })),
    });
    const database = new BridgeDatabase(":memory:");
    bridge = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();
    database.selectProject("chat-owner", "demo");
    database.upsertThread({
      threadId: "thread-existing",
      projectId: "demo",
      title: "Existing work",
      status: "notLoaded",
    });

    await channel.receive("/menu", "thread-detail-menu");
    await vi.waitFor(() => expect(channel.sent.length).toBeGreaterThan(0));
    const cardMessageId = channel.latestCardMessageIdForChat("chat-owner");
    await channel.receiveCard(
      {
        version: 1,
        action: "thread.show",
        projectId: "demo",
        threadId: "thread-existing",
      },
      "thread-detail-show",
      "owner",
      cardMessageId,
    );

    await vi.waitFor(() => expect(channel.createProjectTopic).toHaveBeenCalledTimes(1));
    expect(database.getFeishuThreadRoute("thread-existing")).toMatchObject({
      projectId: "demo",
      topicRootId: "topic-created-thread",
    });
    expect(JSON.stringify(channel.updatedCards)).not.toContain("查看对话内容");
    expect(JSON.stringify(channel.updatedCards)).not.toContain("上一轮");
  });

  it("keeps control-card navigation on the original Feishu message", async () => {
    const channel = new FakeChannel({ updateCards: true });
    const codex = fakeCodex();
    const database = new BridgeDatabase(":memory:");
    database.syncProjects([{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }]);
    database.selectProject("chat-owner", "demo");
    bridge = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();
    await channel.receive("/menu", "single-card-menu");
    await vi.waitFor(() => expect(channel.sent.length).toBeGreaterThan(0));
    const cardMessageId = channel.latestCardMessageIdForChat("chat-owner");

    await channel.receiveCard(
      { version: 1, action: "project.list" },
      "single-card-projects",
      "owner",
      cardMessageId,
    );
    await vi.waitFor(() => expect(channel.updatedCards).toHaveLength(1));
    expect(JSON.stringify(channel.updatedCards.at(-1)?.card)).toContain("选择项目");
    expect(
      database.getLatestSentCardMessageId({
        chatId: "chat-owner",
        body: "选择项目",
        audience: "p2p",
      }),
    ).toBe(cardMessageId);

    await channel.receiveCard(
      { version: 1, action: "project.use", projectId: "demo" },
      "single-card-project-use",
      "owner",
      cardMessageId,
    );
    await vi.waitFor(() => expect(channel.updatedCards).toHaveLength(2));
    expect(JSON.stringify(channel.updatedCards.at(-1)?.card)).toContain("项目群已创建");
    expect(
      database.getLatestSentCardMessageId({
        chatId: "chat-owner",
        body: "ClawBridge 控制台",
        audience: "p2p",
      }),
    ).toBe(cardMessageId);
    expect(channel.createProjectSpace).toHaveBeenCalledTimes(1);
    expect(
      channel.sent.filter(
        (message) => message.kind === "card" && message.chatId === "chat-created-project",
      ),
    ).toHaveLength(1);
    const sentAfterProjectCreation = channel.sent.length;

    await channel.receiveCard(
      { version: 1, action: "project.space", projectId: "demo" },
      "single-card-project-space",
      "owner",
      cardMessageId,
    );
    await vi.waitFor(() => expect(channel.updatedCards).toHaveLength(4));
    expect(channel.sent).toHaveLength(sentAfterProjectCreation);
    expect(
      channel.updatedCards.some(
        (entry) =>
          entry.messageId !== cardMessageId && JSON.stringify(entry.card).includes("项目控制台"),
      ),
    ).toBe(true);

    database.upsertThread({ threadId: "thread-model", projectId: "demo", title: "Model thread" });
    database.setThread("chat-owner", "demo", "thread-model");
    await channel.receiveCard(
      { version: 1, action: "menu.refresh" },
      "single-card-home",
      "owner",
      cardMessageId,
    );
    await vi.waitFor(() => expect(channel.updatedCards).toHaveLength(5));
    expect(JSON.stringify(channel.updatedCards.at(-1)?.card)).toContain("ClawBridge 控制台");

    await channel.receiveCard(
      { version: 1, action: "task.list", projectId: "demo" },
      "single-card-tasks",
      "owner",
      cardMessageId,
    );
    await vi.waitFor(() => expect(channel.updatedCards).toHaveLength(6));
    expect(JSON.stringify(channel.updatedCards.at(-1)?.card)).toContain("任务中心");

    await channel.receiveCard(
      {
        version: 1,
        action: "model.list",
        projectId: "demo",
        threadId: "thread-model",
      },
      "single-card-models",
      "owner",
      cardMessageId,
    );
    await vi.waitFor(() => expect(channel.updatedCards).toHaveLength(7));
    expect(JSON.stringify(channel.updatedCards.at(-1)?.card)).toContain("切换模型");
    expect(channel.updatedCards.filter((entry) => entry.messageId === cardMessageId)).toHaveLength(
      6,
    );
    expect(channel.sent).toHaveLength(sentAfterProjectCreation);
  });

  it("discovers a Desktop thread whose historical cwd resolves to the current project", async () => {
    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "clawbridge-thread-alias-"));
    const projectRoot = path.join(temporaryDirectory, "current-project");
    const historicalRoot = path.join(temporaryDirectory, "historical-project");
    mkdirSync(projectRoot);
    symlinkSync(projectRoot, historicalRoot, process.platform === "win32" ? "junction" : "dir");
    try {
      const channel = new FakeChannel();
      const codex = fakeCodex();
      vi.mocked(codex.listThreads).mockImplementation(async (input) =>
        input.archived
          ? []
          : [
              {
                id: "thread-migrated",
                name: "Desktop migrated thread",
                preview: "Existing Desktop work",
                cwd: historicalRoot,
                updatedAt: Date.now(),
                status: "notLoaded",
              },
            ],
      );
      const database = new BridgeDatabase(":memory:");
      bridge = new Bridge({
        channel,
        codex,
        database,
        config,
        projects: [{ id: "demo", name: "Demo", rootPath: projectRoot, enabled: true }],
        allowedOpenId: "owner",
        logger: pino({ level: "silent" }),
      });
      await bridge.start();
      database.selectProject("chat-owner", "demo");
      await channel.receive("/menu", "migrated-thread-menu");
      await vi.waitFor(() =>
        expect(channel.sent.some((message) => message.kind === "card")).toBe(true),
      );

      await channel.receiveCard(
        { version: 1, action: "thread.list", projectId: "demo" },
        "migrated-thread-list",
      );

      await vi.waitFor(() =>
        expect(database.getProjectThread("demo", "thread-migrated")?.title).toBe(
          "Desktop migrated thread",
        ),
      );
      expect(
        channel.sent.some(
          (message) =>
            message.kind === "card" &&
            JSON.stringify(message.card).includes("Desktop migrated thread"),
        ),
      ).toBe(true);
    } finally {
      await bridge?.stop();
      bridge = undefined;
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("selects a model and reasoning effort for the current thread", async () => {
    const channel = new FakeChannel();
    const codex = fakeCodex();
    const database = new BridgeDatabase(":memory:");
    database.syncProjects([{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }]);
    database.upsertThread({ threadId: "thread-model", projectId: "demo", title: "Model thread" });
    database.selectProject("chat-owner", "demo");
    database.setThread("chat-owner", "demo", "thread-model");
    bridge = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();
    await channel.receive("/menu", "model-menu");
    await vi.waitFor(() => expect(channel.sent.some((item) => item.kind === "card")).toBe(true));
    await channel.receiveCard(
      {
        version: 1,
        action: "reasoning.use",
        projectId: "demo",
        threadId: "thread-model",
        model: "gpt-test",
        reasoningEffort: "medium",
      },
      "model-use",
    );
    await vi.waitFor(() =>
      expect(database.getThreadExecutionSettings("thread-model")).toMatchObject({
        model: "gpt-test",
        reasoningEffort: "medium",
      }),
    );
  });

  it("deduplicates repeated card callback events", async () => {
    const channel = new FakeChannel();
    const codex = fakeCodex();
    bridge = new Bridge({
      channel,
      codex,
      database: new BridgeDatabase(":memory:"),
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();

    await channel.receive("/menu", "card-dedupe-menu");
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.kind === "card")).toBe(true),
    );
    channel.sent.length = 0;

    const value = { version: 1, action: "project.list" };
    await channel.receiveCard(value, "same-card-event", "owner", "sent-1");
    await channel.receiveCard(value, "same-card-event", "owner", "sent-1");
    await vi.waitFor(() =>
      expect(channel.sent.filter((message) => message.kind === "card")).toHaveLength(1),
    );
    expect(codex.runTurn).not.toHaveBeenCalled();
  });

  it("does not execute a card action from an unauthorized sender", async () => {
    const channel = new FakeChannel();
    const codex = fakeCodex();
    const database = new BridgeDatabase(":memory:");
    bridge = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();

    await channel.receive("/menu", "unauthorized-card-menu");
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.kind === "card")).toBe(true),
    );
    const sentBeforeUnauthorizedClick = channel.sent.length;

    await channel.receiveCard(
      { version: 1, action: "project.use", projectId: "demo" },
      "unauthorized-card",
      "intruder",
    );

    expect(database.getConversation("chat-owner")).toBeUndefined();
    expect(channel.sent).toHaveLength(sentBeforeUnauthorizedClick);
    expect(codex.runTurn).not.toHaveBeenCalled();
    expect(codex.startThread).not.toHaveBeenCalled();
  });

  it("does not execute a card action from an unknown card message", async () => {
    const channel = new FakeChannel();
    const codex = fakeCodex();
    const database = new BridgeDatabase(":memory:");
    bridge = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();

    await channel.receiveCard(
      { version: 1, action: "project.use", projectId: "demo" },
      "unknown-card-event",
      "owner",
      "not-sent-by-bridge",
    );

    expect(database.getConversation("chat-owner")).toBeUndefined();
    expect(channel.sent).toHaveLength(0);
    expect(codex.runTurn).not.toHaveBeenCalled();
    expect(codex.startThread).not.toHaveBeenCalled();
  });

  it("closes a selected thread from a card without deleting its history", async () => {
    const channel = new FakeChannel();
    const codex = fakeCodex();
    const database = new BridgeDatabase(":memory:");
    bridge = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();
    database.selectProject("chat-owner", "demo");
    database.upsertThread({
      threadId: "thread-card-close",
      projectId: "demo",
      title: "Keep card history",
      archived: false,
    });
    database.setThread("chat-owner", "demo", "thread-card-close");

    await channel.receive("/menu", "card-close-menu");
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.kind === "card")).toBe(true),
    );

    await channel.receiveCard({ version: 1, action: "chat.close" }, "card-chat-close");
    await vi.waitFor(() => expect(codex.stop).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.text.includes("已关闭并释放"))).toBe(true),
    );

    expect(codex.unsubscribeThread).toHaveBeenCalledWith("thread-card-close");
    expect(database.getConversation("chat-owner")).toEqual({
      projectId: "demo",
      threadId: null,
    });
    expect(database.getProjectThread("demo", "thread-card-close")).toMatchObject({
      title: "Keep card history",
      archived: false,
    });
  });

  it("keeps a newly created empty chat subscribed until its first task creates a rollout", async () => {
    const channel = new FakeChannel();
    const codex = fakeCodex();
    const database = new BridgeDatabase(":memory:");
    bridge = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();
    await channel.receive("/project use demo", "new-release-project");
    await channel.receive('/chat new "Desktop handoff"', "new-release-chat");

    await vi.waitFor(() => expect(codex.startThread).toHaveBeenCalledTimes(1));
    expect(codex.unsubscribeThread).not.toHaveBeenCalled();
    expect(codex.stop).not.toHaveBeenCalled();
    expect(database.getConversation("chat-owner")).toEqual({
      projectId: "demo",
      threadId: "thread-created-1",
    });
    expect(database.getProjectThread("demo", "thread-created-1")).toMatchObject({
      archived: false,
      title: "Desktop handoff",
    });
  });

  it("keeps a newly created empty chat subscribed when naming it fails", async () => {
    const channel = new FakeChannel();
    const codex = fakeCodex();
    vi.mocked(codex.nameThread).mockRejectedValue(new Error("name unavailable"));
    const database = new BridgeDatabase(":memory:");
    bridge = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();
    await channel.receive("/project use demo", "new-name-failure-project");
    await channel.receive('/chat new "Naming failure"', "new-name-failure-chat");

    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.text.includes("命名失败"))).toBe(true),
    );
    expect(codex.unsubscribeThread).not.toHaveBeenCalled();
    expect(codex.stop).not.toHaveBeenCalled();
    expect(database.getConversation("chat-owner")).toEqual({
      projectId: "demo",
      threadId: "thread-created-1",
    });
    expect(database.getProjectThread("demo", "thread-created-1")).toMatchObject({
      archived: false,
    });
  });

  it("stops the idle App Server when task unsubscribe fails and can run the next task", async () => {
    const channel = new FakeChannel();
    const codex = fakeCodex();
    vi.mocked(codex.unsubscribeThread).mockRejectedValue(new Error("unsubscribe unavailable"));
    const database = new BridgeDatabase(":memory:");
    bridge = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();

    await channel.receive("first task", "unsubscribe-fallback-first");
    await vi.waitFor(() => expect(codex.stop).toHaveBeenCalledTimes(1));
    expect(database.getConversation("chat-owner")).toEqual({
      projectId: "demo",
      threadId: "thread-bridge",
    });
    expect(database.getProjectThread("demo", "thread-bridge")).toMatchObject({ archived: false });

    await channel.receive("second task", "unsubscribe-fallback-second");
    await vi.waitFor(() => expect(codex.runTurn).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(codex.stop).toHaveBeenCalledTimes(2));
    expect(vi.mocked(codex.runTurn).mock.calls[1]?.[0].threadId).toBe("thread-bridge");
    expect(database.getConversation("chat-owner")?.threadId).toBe("thread-bridge");
    expect(channel.sent.filter((message) => message.text.includes("✅ completed"))).toHaveLength(2);
  });

  it("closes the selected Feishu chat without deleting its history", async () => {
    const channel = new FakeChannel();
    const codex = fakeCodex();
    const database = new BridgeDatabase(":memory:");
    bridge = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();
    await channel.receive("/project use demo", "close-project");
    await channel.receive('/chat new "Desktop handoff"', "close-new");
    await vi.waitFor(() =>
      expect(database.getConversation("chat-owner")?.threadId).toBe("thread-created-1"),
    );

    await channel.receive("/chat close", "close-chat");
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.text.includes("已关闭并释放"))).toBe(true),
    );

    expect(codex.unsubscribeThread).toHaveBeenCalledWith("thread-created-1");
    expect(codex.stop).toHaveBeenCalledTimes(1);
    expect(database.getConversation("chat-owner")).toEqual({
      projectId: "demo",
      threadId: null,
    });
    expect(database.getProjectThread("demo", "thread-created-1")).toMatchObject({
      archived: false,
      title: "Desktop handoff",
    });
  });

  it("keeps the selected chat bound when stopping Codex during /chat close fails", async () => {
    const channel = new FakeChannel();
    const codex = fakeCodex();
    vi.mocked(codex.stop).mockRejectedValueOnce(new Error("stop unavailable"));
    const database = new BridgeDatabase(":memory:");
    bridge = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();
    database.selectProject("chat-owner", "demo");
    database.upsertThread({
      threadId: "thread-close-failure",
      projectId: "demo",
      title: "Keep this chat",
      archived: false,
    });
    database.setThread("chat-owner", "demo", "thread-close-failure");

    await channel.receive("/chat close", "close-stop-failure");
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.text.includes("stop unavailable"))).toBe(true),
    );

    expect(codex.unsubscribeThread).toHaveBeenCalledWith("thread-close-failure");
    expect(codex.stop).toHaveBeenCalledTimes(1);
    expect(database.getConversation("chat-owner")).toEqual({
      projectId: "demo",
      threadId: "thread-close-failure",
    });
    expect(database.getProjectThread("demo", "thread-close-failure")).toMatchObject({
      archived: false,
      title: "Keep this chat",
    });
  });

  it("rejects /chat close while any task is still open", async () => {
    const channel = new FakeChannel();
    let releaseTurn: (() => void) | undefined;
    const codex = fakeCodex();
    codex.runTurn = vi.fn(
      (input: Parameters<CodexRunner["runTurn"]>[0]) =>
        new Promise<Awaited<ReturnType<CodexRunner["runTurn"]>>>((resolve) => {
          input.onStarted?.({ threadId: "thread-active", turnId: "turn-active" });
          releaseTurn = () =>
            resolve({ threadId: "thread-active", turnId: "turn-active", finalText: "done" });
        }),
    );
    const database = new BridgeDatabase(":memory:");
    bridge = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();
    await channel.receive("long task", "close-open-task");
    await vi.waitFor(() => expect(codex.runTurn).toHaveBeenCalledTimes(1));

    await channel.receive("/chat close", "close-while-running");
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.text.includes("仍有任务正在排队或运行"))).toBe(
        true,
      ),
    );
    expect(codex.stop).not.toHaveBeenCalled();

    releaseTurn?.();
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.text.includes("✅ completed"))).toBe(true),
    );
  });

  it("returns from inbound handling while the outbound API is still blocked", async () => {
    const channel = new FakeChannel({ blockFirstSend: true });
    bridge = new Bridge({
      channel,
      codex: fakeCodex(),
      database: new BridgeDatabase(":memory:"),
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();

    await expect(
      Promise.race([
        channel.receive("inspect this project"),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("inbound handler blocked")), 100),
        ),
      ]),
    ).resolves.toBeUndefined();
    channel.releaseFirstSend();
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.text.includes("✅ completed"))).toBe(true),
    );
  });

  it("retries a transient delivery failure without rerunning the Codex task", async () => {
    const channel = new FakeChannel({ failures: 1 });
    const codex = fakeCodex();
    bridge = new Bridge({
      channel,
      codex,
      database: new BridgeDatabase(":memory:"),
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();
    await channel.receive("inspect this project");

    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.text.includes("✅ completed"))).toBe(true),
    );
    expect(channel.sendAttempts).toBeGreaterThanOrEqual(3);
    expect(codex.runTurn).toHaveBeenCalledTimes(1);
  });

  it("ignores a repeated event before routing it a second time", async () => {
    const channel = new FakeChannel();
    const codex = fakeCodex();
    bridge = new Bridge({
      channel,
      codex,
      database: new BridgeDatabase(":memory:"),
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();
    await channel.receive("inspect this project", "same-event");
    await channel.receive("inspect this project", "same-event");
    await vi.waitFor(() => expect(codex.runTurn).toHaveBeenCalledTimes(1));
  });

  it("drains a queued task after reopening the same database", async () => {
    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "clawbridge-test-"));
    const databasePath = path.join(temporaryDirectory, "bridge.db");
    try {
      const firstDatabase = new BridgeDatabase(databasePath);
      firstDatabase.syncProjects([
        { id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true },
      ]);
      firstDatabase.enqueue(
        {
          eventId: "queued-before-restart",
          messageId: "message-before-restart",
          chatId: "chat-owner",
          chatType: "p2p",
          senderOpenId: "owner",
          text: "resume queued work",
          receivedAt: new Date().toISOString(),
        },
        "demo",
      );
      firstDatabase.close();

      const channel = new FakeChannel();
      const codex = fakeCodex();
      bridge = new Bridge({
        channel,
        codex,
        database: new BridgeDatabase(databasePath),
        config: { ...config, bridge: { ...config.bridge, databasePath } },
        projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
        allowedOpenId: "owner",
        logger: pino({ level: "silent" }),
      });
      await bridge.start();
      await vi.waitFor(() => expect(codex.runTurn).toHaveBeenCalledTimes(1));
      await bridge.stop();
      bridge = undefined;
    } finally {
      if (bridge) {
        await bridge.stop();
        bridge = undefined;
      }
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("lists project threads and binds an idle thread", async () => {
    const channel = new FakeChannel();
    const codex = fakeCodex();
    vi.mocked(codex.listThreads).mockImplementation(async (input) =>
      input.archived
        ? []
        : [
            {
              id: "thread-existing",
              name: "Existing work",
              preview: "",
              cwd: process.cwd(),
              updatedAt: 1,
              status: "notLoaded",
            },
          ],
    );
    const database = new BridgeDatabase(":memory:");
    bridge = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();
    await channel.receive("/use demo", "use-event");
    await channel.receive("/threads", "threads-event");
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.text.includes("thread-existing"))).toBe(true),
    );

    await channel.receive("/resume thread-existing", "resume-event");
    await vi.waitFor(() =>
      expect(database.getConversation("chat-owner")?.threadId).toBe("thread-existing"),
    );
    expect(codex.readThread).toHaveBeenCalledWith("thread-existing");
  });

  it("interrupts an active turn and records a cancelled task", async () => {
    const channel = new FakeChannel();
    let rejectTurn: ((error: Error) => void) | undefined;
    const codex = fakeCodex();
    codex.runTurn = vi.fn(
      (input: Parameters<CodexRunner["runTurn"]>[0]) =>
        new Promise<never>((_, reject) => {
          rejectTurn = reject;
          input.onStarted?.({ threadId: "thread-active", turnId: "turn-active" });
        }),
    );
    codex.interrupt = vi.fn(async () => {
      rejectTurn?.(new BridgeError("CODEX_INTERRUPTED", "interrupted"));
    });
    const database = new BridgeDatabase(":memory:");
    bridge = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();
    await channel.receive("long task", "long-task-event");
    await vi.waitFor(() => expect(codex.runTurn).toHaveBeenCalledTimes(1));
    await channel.receive("/stop", "stop-event");

    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.text.includes("cancelled"))).toBe(true),
    );
    expect(codex.interrupt).toHaveBeenCalledWith("thread-active", "turn-active");
    expect(database.nextQueued()).toBeUndefined();
  });

  it("continues the bound thread and creates a fresh one after /new", async () => {
    const channel = new FakeChannel();
    const codex = fakeCodex();
    bridge = new Bridge({
      channel,
      codex,
      database: new BridgeDatabase(":memory:"),
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();

    await channel.receive("first task", "first-event");
    await vi.waitFor(() => expect(codex.runTurn).toHaveBeenCalledTimes(1));
    await channel.receive("second task", "second-event");
    await vi.waitFor(() => expect(codex.runTurn).toHaveBeenCalledTimes(2));
    expect(vi.mocked(codex.runTurn).mock.calls[1]?.[0].threadId).toBe("thread-bridge");
    await vi.waitFor(() =>
      expect(channel.sent.filter((message) => message.text.includes("✅ completed")).length).toBe(
        2,
      ),
    );

    await channel.receive("/new", "new-event");
    await channel.receive("third task", "third-event");
    await vi.waitFor(() => expect(codex.runTurn).toHaveBeenCalledTimes(3));
    expect(vi.mocked(codex.runTurn).mock.calls[2]?.[0].threadId).toBeNull();
  });

  it("restores the last selected thread independently for each project", async () => {
    const channel = new FakeChannel();
    const database = new BridgeDatabase(":memory:");
    const codex = fakeCodex();
    const otherRoot = path.dirname(process.cwd());
    vi.mocked(codex.readThread).mockImplementation(async (threadId: string) => ({
      id: threadId,
      name: "Test thread",
      preview: "",
      cwd: threadId === "thread-other" ? otherRoot : process.cwd(),
      updatedAt: null,
      status: "notLoaded",
    }));
    bridge = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [
        { id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true },
        { id: "other", name: "Other", rootPath: otherRoot, enabled: true },
      ],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();
    database.selectProject("chat-owner", "demo");
    database.setThread("chat-owner", "demo", "thread-demo");
    database.selectProject("chat-owner", "other");
    database.setThread("chat-owner", "other", "thread-other");

    await channel.receive("/project use demo", "restore-demo");
    await vi.waitFor(() =>
      expect(database.getConversation("chat-owner")).toEqual({
        projectId: "demo",
        threadId: "thread-demo",
      }),
    );
    await channel.receive("/project use other", "restore-other");
    await vi.waitFor(() =>
      expect(database.getConversation("chat-owner")).toEqual({
        projectId: "other",
        threadId: "thread-other",
      }),
    );
  });

  it("keeps a saved project chat when Codex is temporarily unavailable", async () => {
    const channel = new FakeChannel();
    const database = new BridgeDatabase(":memory:");
    const codex = fakeCodex();
    vi.mocked(codex.listThreads).mockRejectedValue(new Error("temporary app-server timeout"));
    bridge = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();
    database.selectProject("chat-owner", "demo");
    database.setThread("chat-owner", "demo", "thread-saved");

    await channel.receive("/project use demo", "restore-temporary-failure");
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.text.includes("绑定仍保留"))).toBe(true),
    );
    expect(database.getConversation("chat-owner")?.threadId).toBe("thread-saved");
  });

  it("clears a saved project chat only when Codex confirms it no longer exists", async () => {
    const channel = new FakeChannel();
    const database = new BridgeDatabase(":memory:");
    const codex = fakeCodex();
    vi.mocked(codex.readThread).mockRejectedValue(new Error("thread not found"));
    bridge = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();
    database.selectProject("chat-owner", "demo");
    database.setThread("chat-owner", "demo", "thread-missing");

    await channel.receive("/project use demo", "restore-missing-thread");
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.text.includes("绑定已清除"))).toBe(true),
    );
    expect(database.getConversation("chat-owner")?.threadId).toBeNull();
  });

  it("rejects duplicate enabled project roots during startup", async () => {
    const database = new BridgeDatabase(":memory:");
    bridge = new Bridge({
      channel: new FakeChannel(),
      codex: fakeCodex(),
      database,
      config,
      projects: [
        { id: "first", name: "First", rootPath: process.cwd(), enabled: true },
        { id: "second", name: "Second", rootPath: process.cwd(), enabled: true },
      ],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });

    await expect(bridge.start()).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("does not enable a project whose real root is already in use", async () => {
    const channel = new FakeChannel();
    const database = new BridgeDatabase(":memory:");
    bridge = new Bridge({
      channel,
      codex: fakeCodex(),
      database,
      config,
      projects: [
        { id: "first", name: "First", rootPath: process.cwd(), enabled: true },
        { id: "second", name: "Second", rootPath: process.cwd(), enabled: false },
      ],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();

    await channel.receive("/project enable second", "enable-duplicate-root");
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.text.includes("指向同一目录"))).toBe(true),
    );
    expect(database.getProject("second")?.enabled).toBe(false);
  });

  it("creates, lists, selects, reads, archives, and restores project chats", async () => {
    const channel = new FakeChannel();
    const codex = fakeCodex();
    const database = new BridgeDatabase(":memory:");
    bridge = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();
    await channel.receive("/project use demo", "chat-use-project");
    await channel.receive('/chat new "第一段工作"', "chat-new-first");
    await vi.waitFor(() =>
      expect(database.getConversation("chat-owner")?.threadId).toBe("thread-created-1"),
    );
    expect(codex.nameThread).toHaveBeenCalledWith("thread-created-1", "第一段工作");

    await channel.receive("/chat new 第二段工作", "chat-new-second");
    await vi.waitFor(() =>
      expect(database.getConversation("chat-owner")?.threadId).toBe("thread-created-2"),
    );
    expect(database.getProjectThreadByNumber("demo", 1)?.threadId).toBe("thread-created-1");
    expect(database.getProjectThreadByNumber("demo", 2)?.threadId).toBe("thread-created-2");

    await channel.receive("/chat list", "chat-list-new");
    await vi.waitFor(() =>
      expect(
        channel.sent.some((message) => message.text.includes("#1") && message.text.includes("#2")),
      ).toBe(true),
    );
    await channel.receive("/chat use 1", "chat-select-first");
    await vi.waitFor(() =>
      expect(database.getConversation("chat-owner")?.threadId).toBe("thread-created-1"),
    );

    vi.mocked(codex.readThreadDetails).mockResolvedValue({
      id: "thread-created-1",
      name: "第一段工作",
      preview: "已经完成读取",
      cwd: process.cwd(),
      updatedAt: Date.now(),
      status: "notLoaded",
      turns: [
        {
          id: "turn-history",
          status: "completed",
          startedAt: null,
          completedAt: null,
          messages: [
            { role: "user", text: "读取 README", phase: null },
            { role: "assistant", text: "README 已读取", phase: "final_answer" },
          ],
        },
      ],
    });
    await channel.receive("/chat show 1", "chat-show-first");
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.text.includes("README 已读取"))).toBe(true),
    );
    expect(codex.readThreadDetails).toHaveBeenCalledWith("thread-created-1", true);

    await channel.receive("/chat archive 1", "chat-archive-first");
    await vi.waitFor(() =>
      expect(database.getProjectThreadByNumber("demo", 1)?.archived).toBe(true),
    );
    expect(database.getConversation("chat-owner")?.threadId).toBeNull();
    expect(codex.archiveThread).toHaveBeenCalledWith("thread-created-1");

    await channel.receive("/chat unarchive 1", "chat-unarchive-first");
    await vi.waitFor(() =>
      expect(database.getProjectThreadByNumber("demo", 1)?.archived).toBe(false),
    );
    expect(codex.unarchiveThread).toHaveBeenCalledWith("thread-created-1");
    expect(database.getConversation("chat-owner")?.threadId).toBeNull();
  });

  it("rejects an overlong chat title before creating a Codex thread", async () => {
    const channel = new FakeChannel();
    const codex = fakeCodex();
    bridge = new Bridge({
      channel,
      codex,
      database: new BridgeDatabase(":memory:"),
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();
    await channel.receive("/project use demo", "long-title-project");
    await channel.receive(`/chat new ${"x".repeat(121)}`, "long-title-chat");

    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.text.includes("不能超过 120"))).toBe(true),
    );
    expect(codex.startThread).not.toHaveBeenCalled();
  });

  it("lists archived chats even when newer active chats fill the display window", async () => {
    const channel = new FakeChannel();
    const database = new BridgeDatabase(":memory:");
    const codex = fakeCodex();
    vi.mocked(codex.readThread).mockImplementation(async (threadId) => ({
      id: threadId,
      name: threadId === "thread-archived-old" ? "Archived target" : "Test thread",
      preview: "",
      cwd: process.cwd(),
      updatedAt: Date.now(),
      status: "notLoaded",
    }));
    bridge = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();
    database.selectProject("chat-owner", "demo");
    database.upsertThread({
      threadId: "thread-archived-old",
      projectId: "demo",
      title: "Archived target",
      archived: true,
      updatedAt: "2020-01-01T00:00:00.000Z",
    });
    for (let index = 0; index < 50; index += 1) {
      database.upsertThread({
        threadId: `thread-active-${index}`,
        projectId: "demo",
        title: `Active ${index}`,
        archived: false,
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      });
    }

    await channel.receive("/chat list archived", "archived-window");
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.text.includes("Archived target"))).toBe(true),
    );
  });

  it("creates a runtime project and can use it without restarting", async () => {
    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "clawbridge-project-root-"));
    try {
      const channel = new FakeChannel();
      const codex = fakeCodex();
      const database = new BridgeDatabase(":memory:");
      bridge = new Bridge({
        channel,
        codex,
        database,
        config: {
          ...config,
          projectManagement: {
            allowedRoots: [temporaryDirectory],
            allowCreateDirectory: true,
            allowRegisterExisting: true,
            codexDesktopProjects: { enabled: false, registerCreatedProjects: false },
          },
        },
        projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
        allowedOpenId: "owner",
        logger: pino({ level: "silent" }),
      });
      await bridge.start();

      await channel.receive('/project create mobile "手机创建的项目"', "runtime-create");
      await channel.receive("/project use mobile", "runtime-use");
      await channel.receive("检查当前目录", "runtime-task");

      await vi.waitFor(() => expect(codex.runTurn).toHaveBeenCalledOnce());
      const runInput = vi.mocked(codex.runTurn).mock.calls[0]?.[0];
      if (!runInput) throw new Error("Codex run input was not captured");
      expect(runInput.prompt).toBe("检查当前目录");
      await expect(
        areSameResolvedPath(runInput.cwd, path.join(temporaryDirectory, "mobile")),
      ).resolves.toBe(true);
      expect(database.getProject("mobile")).toMatchObject({
        name: "手机创建的项目",
        enabled: true,
      });
      await bridge.stop();
      bridge = undefined;
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("automatically synchronizes and selects visible Codex Desktop projects", async () => {
    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "clawbridge-desktop-projects-"));
    const clawRoot = path.join(temporaryDirectory, "claw");
    const spacedRoot = path.join(temporaryDirectory, "Project With Space");
    const chineseRoot = path.join(temporaryDirectory, "项目文档");
    mkdirSync(clawRoot);
    mkdirSync(spacedRoot);
    mkdirSync(chineseRoot);

    try {
      const channel = new FakeChannel();
      const database = new BridgeDatabase(":memory:");
      const codex = fakeCodex();
      vi.mocked(codex.readThread).mockImplementation(async (threadId) => {
        if (threadId === "thread-desktop-deleted") {
          throw new Error("thread not loaded: thread-desktop-deleted");
        }
        return {
          id: threadId,
          name:
            threadId === "thread-desktop-assigned"
              ? "Desktop assigned work"
              : threadId === "thread-desktop-archived"
                ? "Desktop archived work"
                : "Test thread",
          preview: "Existing Desktop conversation",
          cwd: "C:\\historical\\unrelated-path",
          updatedAt: Date.now(),
          status: "notLoaded",
        };
      });
      vi.mocked(codex.listThreads).mockImplementation(async (input) =>
        input.archived
          ? [
              {
                id: "thread-desktop-archived",
                name: "Desktop archived work",
                preview: "Archived Desktop conversation",
                cwd: spacedRoot,
                updatedAt: Date.now(),
                status: "notLoaded",
              },
            ]
          : [],
      );
      const desktopProjects: DesktopProjectSource = {
        listProjects: vi.fn(async () => ({
          sourcePath: path.join(temporaryDirectory, ".codex-global-state.json"),
          usedBackup: false,
          projects: [
            {
              sourceId: "desktop-claw",
              name: "claw",
              rootPaths: [clawRoot],
              order: 0,
              assignedThreadIds: [],
            },
            {
              sourceId: "desktop-spaced",
              name: "Project With Space",
              rootPaths: [spacedRoot],
              order: 1,
              assignedThreadIds: [
                "thread-desktop-assigned",
                "thread-desktop-archived",
                "thread-desktop-deleted",
              ],
            },
            {
              sourceId: "desktop-chinese",
              name: "项目文档",
              rootPaths: [chineseRoot],
              order: 2,
              assignedThreadIds: [],
            },
          ],
        })),
      };
      bridge = new Bridge({
        channel,
        codex,
        database,
        config: {
          ...config,
          projectManagement: {
            ...config.projectManagement,
            codexDesktopProjects: { enabled: true, registerCreatedProjects: false },
          },
        },
        projects: [
          { id: "bridge-dev", name: "ClawBridge development", rootPath: clawRoot, enabled: true },
        ],
        desktopProjects,
        allowedOpenId: "owner",
        logger: pino({ level: "silent" }),
      });
      await bridge.start();

      const clawProject = database.getProject("bridge-dev");
      const spacedProject = database.getProject("desktop@desktop-spaced");
      const chineseProject = database.getProject("desktop@desktop-chinese");
      if (!clawProject || !spacedProject || !chineseProject) {
        throw new Error("Expected synchronized Desktop projects were not registered");
      }
      expect(clawProject).toMatchObject({ name: "claw" });
      expect(spacedProject).toMatchObject({
        name: "Project With Space",
        enabled: true,
      });
      expect(chineseProject).toMatchObject({ name: "项目文档", enabled: true });
      database.upsertThread({
        threadId: "thread-desktop-deleted",
        projectId: "desktop@desktop-spaced",
        title: "Deleted Desktop work",
        preview: "This stale row must not remain visible",
        status: "idle",
        archived: false,
      });
      await expect(areSameResolvedPath(clawProject.rootPath, clawRoot)).resolves.toBe(true);
      await expect(areSameResolvedPath(spacedProject.rootPath, spacedRoot)).resolves.toBe(true);
      await expect(areSameResolvedPath(chineseProject.rootPath, chineseRoot)).resolves.toBe(true);

      await channel.receive("/projects", "desktop-project-list");
      await vi.waitFor(() => {
        const listing = channel.sent.find((message) => message.text.includes("#1 claw"))?.text;
        expect(listing).toContain(clawProject.rootPath);
        expect(listing).toContain("#2 Project With Space");
        expect(listing).toContain(spacedProject.rootPath);
        expect(listing).toContain("#3 项目文档");
        expect(listing).toContain(chineseProject.rootPath);
      });

      await channel.receive('/project use "Project With Space"', "desktop-project-name");
      await vi.waitFor(() =>
        expect(database.getConversation("chat-owner")?.projectId).toBe("desktop@desktop-spaced"),
      );

      await channel.receive("/project use #3", "desktop-project-number");
      await vi.waitFor(() =>
        expect(database.getConversation("chat-owner")?.projectId).toBe("desktop@desktop-chinese"),
      );

      await channel.receive('/project use "Project With Space"', "desktop-project-thread-owner");
      await vi.waitFor(() =>
        expect(database.getConversation("chat-owner")?.projectId).toBe("desktop@desktop-spaced"),
      );
      await channel.receive("/menu", "desktop-assigned-menu");
      await vi.waitFor(() =>
        expect(channel.sent.some((message) => message.kind === "card")).toBe(true),
      );
      await channel.receiveCard(
        { version: 1, action: "thread.list", projectId: "desktop@desktop-spaced" },
        "desktop-assigned-list",
      );
      await vi.waitFor(() =>
        expect(
          database.getProjectThread("desktop@desktop-spaced", "thread-desktop-assigned"),
        ).toMatchObject({ title: "Desktop assigned work" }),
      );
      expect(
        database.getProjectThread("desktop@desktop-spaced", "thread-desktop-archived"),
      ).toMatchObject({ title: "Desktop archived work", archived: true });
      expect(
        database.getProjectThread("desktop@desktop-spaced", "thread-desktop-deleted"),
      ).toMatchObject({ status: "unavailable" });
      const latestThreadCard = channel.sent.findLast(
        (message) => message.kind === "card" && message.text.includes("选择 Project With Space"),
      );
      expect(JSON.stringify(latestThreadCard)).not.toContain("thread-desktop-archived");
      expect(JSON.stringify(latestThreadCard)).not.toContain("thread-desktop-deleted");

      await bridge.stop();
      bridge = undefined;
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("revokes a removed Desktop project before accepting the next ordinary task", async () => {
    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "clawbridge-desktop-revoke-"));
    const projectRoot = path.join(temporaryDirectory, "desktop-only");
    mkdirSync(projectRoot);

    try {
      const channel = new FakeChannel();
      const codex = fakeCodex();
      const database = new BridgeDatabase(":memory:");
      let visible = true;
      const desktopProjects: DesktopProjectSource = {
        listProjects: vi.fn(async () => ({
          sourcePath: path.join(temporaryDirectory, ".codex-global-state.json"),
          usedBackup: false,
          projects: visible
            ? [
                {
                  sourceId: "desktop-only",
                  name: "Desktop only",
                  rootPaths: [projectRoot],
                  order: 0,
                  assignedThreadIds: [],
                },
              ]
            : [],
        })),
      };
      bridge = new Bridge({
        channel,
        codex,
        database,
        config: {
          ...config,
          projectManagement: {
            ...config.projectManagement,
            codexDesktopProjects: { enabled: true, registerCreatedProjects: false },
          },
        },
        projects: [],
        desktopProjects,
        allowedOpenId: "owner",
        logger: pino({ level: "silent" }),
      });
      await bridge.start();
      await channel.receive('/project use "Desktop only"', "desktop-project-select");
      await vi.waitFor(() =>
        expect(database.getConversation("chat-owner")?.projectId).toBe("desktop@desktop-only"),
      );

      visible = false;
      await channel.receive("do not run", "desktop-project-revoked-task");
      await vi.waitFor(() =>
        expect(channel.sent.some((message) => message.text.includes("已停用"))).toBe(true),
      );
      expect(codex.runTurn).not.toHaveBeenCalled();

      await bridge.stop();
      bridge = undefined;
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("rejects project switching while a task is running before onStarted", async () => {
    const channel = new FakeChannel();
    const codex = fakeCodex();
    let finishTurn:
      | ((value: { threadId: string; turnId: string; finalText: string }) => void)
      | undefined;
    codex.runTurn = vi.fn(
      () =>
        new Promise<{ threadId: string; turnId: string; finalText: string }>((resolve) => {
          finishTurn = resolve;
        }),
    );
    const database = new BridgeDatabase(":memory:");
    bridge = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [
        { id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true },
        { id: "other", name: "Other", rootPath: path.dirname(process.cwd()), enabled: true },
      ],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();
    await channel.receive("/project use demo", "running-use-demo");
    await channel.receive("长任务", "running-task");
    await vi.waitFor(() => expect(codex.runTurn).toHaveBeenCalledTimes(1));
    await channel.receive("/project use other", "running-switch-other");

    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.text.includes("不能切换项目"))).toBe(true),
    );
    expect(database.getConversation("chat-owner")?.projectId).toBe("demo");
    finishTurn?.({ threadId: "thread-late", turnId: "turn-late", finalText: "完成" });
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.text.includes("✅ completed"))).toBe(true),
    );
  });

  it("waits for the active task worker before closing the database", async () => {
    const channel = new FakeChannel();
    const codex = fakeCodex();
    let rejectTurn: ((error: Error) => void) | undefined;
    codex.runTurn = vi.fn(
      (input: Parameters<CodexRunner["runTurn"]>[0]) =>
        new Promise<never>((_, reject) => {
          rejectTurn = reject;
          input.onStarted?.({ threadId: "thread-shutdown", turnId: "turn-shutdown" });
        }),
    );
    codex.stop = vi.fn(async () => {
      setTimeout(() => rejectTurn?.(new Error("app-server stopped")), 10);
    });
    const database = new BridgeDatabase(":memory:");
    const order: string[] = [];
    const updateTask = database.updateTask.bind(database);
    vi.spyOn(database, "updateTask").mockImplementation((...args) => {
      if (args[1] === "failed") order.push("task-settled");
      return updateTask(...args);
    });
    const close = database.close.bind(database);
    vi.spyOn(database, "close").mockImplementation(() => {
      order.push("database-closed");
      close();
    });
    bridge = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();
    await channel.receive("long shutdown task", "shutdown-task");
    await vi.waitFor(() => expect(codex.runTurn).toHaveBeenCalledTimes(1));

    await bridge.stop();
    bridge = undefined;

    expect(order).toEqual(["task-settled", "database-closed"]);
  });

  it("waits for an in-flight delivery before closing the database", async () => {
    const channel = new FakeChannel({ blockFirstSend: true });
    vi.spyOn(channel, "stop").mockImplementation(async () => channel.releaseFirstSend());
    const database = new BridgeDatabase(":memory:");
    const order: string[] = [];
    const markDeliverySent = database.markDeliverySent.bind(database);
    vi.spyOn(database, "markDeliverySent").mockImplementation((...args) => {
      order.push("delivery-settled");
      return markDeliverySent(...args);
    });
    const close = database.close.bind(database);
    vi.spyOn(database, "close").mockImplementation(() => {
      order.push("database-closed");
      close();
    });
    bridge = new Bridge({
      channel,
      codex: fakeCodex(),
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    await bridge.start();
    await channel.receive("delivery shutdown task", "shutdown-delivery");
    await vi.waitFor(() => expect(channel.sendAttempts).toBe(1));

    await bridge.stop();
    bridge = undefined;

    expect(order.at(-1)).toBe("database-closed");
    expect(order).toContain("delivery-settled");
  });

  it("does not restart Codex when shutdown begins during a pre-Codex await", async () => {
    const channel = new FakeChannel();
    const codex = fakeCodex();
    const database = new BridgeDatabase(":memory:");
    const instance = new Bridge({
      channel,
      codex,
      database,
      config,
      projects: [{ id: "demo", name: "Demo", rootPath: process.cwd(), enabled: true }],
      allowedOpenId: "owner",
      logger: pino({ level: "silent" }),
    });
    bridge = instance;
    await instance.start();
    database.selectProject("chat-owner", "demo");

    let releasePath: (() => void) | undefined;
    let markPathAwaitStarted: (() => void) | undefined;
    const pathAwaitStarted = new Promise<void>((resolve) => {
      markPathAwaitStarted = resolve;
    });
    vi.spyOn(
      instance as unknown as {
        resolveRuntimeProjectPath(rootPath: string): Promise<string>;
      },
      "resolveRuntimeProjectPath",
    ).mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          releasePath = () => resolve(process.cwd());
          markPathAwaitStarted?.();
        }),
    );

    await channel.receive("/chat new shutdown-race", "shutdown-before-codex");
    await pathAwaitStarted;
    const stopping = instance.stop();
    await vi.waitFor(() => expect(codex.stop).toHaveBeenCalled());
    releasePath?.();
    await stopping;
    bridge = undefined;

    expect(codex.startThread).not.toHaveBeenCalled();
    expect(codex.stop).toHaveBeenCalledTimes(2);
  });
});
