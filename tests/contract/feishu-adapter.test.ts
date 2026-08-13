import pino from "pino";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const larkMocks = vi.hoisted(() => ({
  createMessage: vi.fn(),
  replyMessage: vi.fn(),
  getMessageResource: vi.fn(),
  createChat: vi.fn(),
  getChat: vi.fn(),
  getChatMembers: vi.fn(),
  createChatMembers: vi.fn(),
  createCard: vi.fn(),
  updateCardContent: vi.fn(),
  updateCardSettings: vi.fn(),
  wsStart: vi.fn(),
  wsClose: vi.fn(),
  handlers: {} as Record<string, (payload: unknown) => unknown>,
  clientOptions: {} as Record<string, unknown>,
  wsOptions: {} as Record<string, unknown>,
}));

vi.mock("@larksuiteoapi/node-sdk", () => ({
  AppType: { SelfBuild: "self_build" },
  LoggerLevel: { info: "info", warn: "warn" },
  Client: class {
    constructor(options: Record<string, unknown>) {
      larkMocks.clientOptions = options;
    }
    readonly im = {
      message: { create: larkMocks.createMessage, reply: larkMocks.replyMessage },
      messageResource: { get: larkMocks.getMessageResource },
      chat: { create: larkMocks.createChat, get: larkMocks.getChat },
      chatMembers: { get: larkMocks.getChatMembers, create: larkMocks.createChatMembers },
    };
    readonly cardkit = {
      v1: {
        card: { create: larkMocks.createCard, settings: larkMocks.updateCardSettings },
        cardElement: { content: larkMocks.updateCardContent },
      },
    };
  },
  WSClient: class {
    constructor(options: Record<string, unknown>) {
      larkMocks.wsOptions = options;
    }
    readonly start = larkMocks.wsStart;
    readonly close = larkMocks.wsClose;
  },
  EventDispatcher: class {
    register(handlers: Record<string, (payload: unknown) => unknown>): this {
      larkMocks.handlers = handlers;
      return this;
    }
  },
}));

import { FeishuAdapter } from "../../src/channels/feishu-adapter.js";

const cardPayload = {
  event_id: "evt-card-sdk-1",
  create_time: "1700000000000",
  operator: { open_id: "ou-owner" },
  context: {
    open_message_id: "om-card-1",
    open_chat_id: "oc-card-1",
  },
  action: {
    tag: "button",
    value: { protocol: "clawbridge.card.v1", action: "refresh" },
  },
};

describe("Feishu adapter card contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    larkMocks.handlers = {};
    larkMocks.clientOptions = {};
    larkMocks.wsOptions = {};
    larkMocks.createMessage.mockResolvedValue({
      code: 0,
      data: { message_id: "om-sent-1" },
    });
    larkMocks.replyMessage.mockResolvedValue({
      code: 0,
      data: { message_id: "om-reply-1" },
    });
    larkMocks.getMessageResource.mockResolvedValue({
      headers: { "content-length": "4" },
      writeFile: async (targetPath: string) => writeFile(targetPath, "test"),
    });
    larkMocks.createChat.mockResolvedValue({
      code: 0,
      data: { chat_id: "oc-project-1" },
    });
    larkMocks.getChat.mockResolvedValue({
      code: 0,
      data: { name: "[Codex] Demo Project", chat_status: "normal" },
    });
    larkMocks.getChatMembers.mockResolvedValue({
      code: 0,
      data: { items: [{ member_id: "ou-owner" }], has_more: false },
    });
    larkMocks.createChatMembers.mockResolvedValue({ code: 0, data: {} });
    larkMocks.createCard.mockResolvedValue({ code: 0, data: { card_id: "card-stream-1" } });
    larkMocks.updateCardContent.mockResolvedValue({ code: 0 });
    larkMocks.updateCardSettings.mockResolvedValue({ code: 0 });
    larkMocks.wsStart.mockImplementation(() => {
      (larkMocks.wsOptions.onReady as (() => void) | undefined)?.();
    });
  });

  it("uses a bounded SDK logger that does not expose credentials", () => {
    const output: string[] = [];
    const logger = pino({ level: "trace" }, { write: (line: string) => output.push(line) });
    new FeishuAdapter({ appId: "cli-sensitive", appSecret: "secret-sensitive" }, logger);

    expect(larkMocks.clientOptions.logger).toBe(larkMocks.wsOptions.logger);
    const sdkLogger = larkMocks.wsOptions.logger as { error: (...messages: unknown[]) => void };
    sdkLogger.error('request failed app_id=cli-sensitive app_secret="secret-sensitive"', {
      config: { data: { app_secret: "secret-sensitive" } },
    });

    expect(output.join("\n")).not.toContain("cli-sensitive");
    expect(output.join("\n")).not.toContain("secret-sensitive");
    expect(output.join("\n")).toContain("***");
  });

  it("registers card.action.trigger and acknowledges before Bridge finishes", async () => {
    const adapter = new FeishuAdapter(
      { appId: "cli-test", appSecret: "secret" },
      pino({ enabled: false }),
    );
    let finishHandling!: () => void;
    const handling = new Promise<void>((resolve) => {
      finishHandling = resolve;
    });
    const onEvent = vi.fn(() => handling);

    await adapter.start(onEvent);
    expect(larkMocks.handlers).toHaveProperty("im.message.receive_v1");
    expect(larkMocks.handlers).toHaveProperty("card.action.trigger");

    const response = larkMocks.handlers["card.action.trigger"]!(cardPayload);

    expect(response).toEqual({ toast: { type: "info", content: "正在处理…" } });
    expect(onEvent).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(onEvent).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "card_action",
        eventId: "evt-card-sdk-1",
        chatId: "oc-card-1",
        senderOpenId: "ou-owner",
        value: { protocol: "clawbridge.card.v1", action: "refresh" },
      }),
    );
    finishHandling();
    await handling;
  });

  it("replies with an interactive card inside a project topic", async () => {
    const adapter = new FeishuAdapter(
      { appId: "cli-test", appSecret: "secret" },
      pino({ enabled: false }),
    );
    await expect(
      adapter.send({
        kind: "card",
        audience: "group",
        chatId: "oc-project-1",
        replyToMessageId: "om-topic-root",
        text: "approval",
        card: { header: { title: "Approve" }, elements: [] },
      }),
    ).resolves.toBe("om-reply-1");
    expect(larkMocks.replyMessage).toHaveBeenCalledWith({
      path: { message_id: "om-topic-root" },
      data: {
        msg_type: "interactive",
        content: JSON.stringify({ header: { title: "Approve" }, elements: [] }),
        reply_in_thread: true,
      },
    });
  });

  it("rejects malformed card actions without dispatching them", async () => {
    const adapter = new FeishuAdapter(
      { appId: "cli-test", appSecret: "secret" },
      pino({ enabled: false }),
    );
    const onEvent = vi.fn(async () => {});
    await adapter.start(onEvent);

    const response = larkMocks.handlers["card.action.trigger"]!({
      ...cardPayload,
      operator: {},
    });

    expect(response).toEqual({
      toast: { type: "error", content: "操作无效，请刷新菜单后重试" },
    });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("cancels a pending first connection promptly when stopped", async () => {
    larkMocks.wsStart.mockImplementationOnce(() => new Promise<void>(() => {}));
    const adapter = new FeishuAdapter(
      { appId: "cli-test", appSecret: "secret" },
      pino({ enabled: false }),
    );

    const starting = adapter.start(vi.fn(async () => {}));
    await adapter.stop();

    await expect(starting).rejects.toThrow("startup was stopped");
    expect(larkMocks.wsClose).toHaveBeenCalled();
  });

  it("reports a terminal connection failure after the first successful connection", async () => {
    const adapter = new FeishuAdapter(
      { appId: "cli-test", appSecret: "secret" },
      pino({ enabled: false }),
    );
    const onFatalError = vi.fn();
    adapter.onFatalError(onFatalError);

    await adapter.start(vi.fn(async () => {}));
    (larkMocks.wsOptions.onError as ((error: Error) => void) | undefined)?.(
      new Error("reconnect exhausted"),
    );

    expect(onFatalError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("check the saved App ID") }),
    );
  });

  it("sends text messages with the existing msg_type", async () => {
    const adapter = new FeishuAdapter(
      { appId: "cli-test", appSecret: "secret" },
      pino({ enabled: false }),
    );

    await expect(adapter.send({ chatId: "oc-1", text: "hello" })).resolves.toBe("om-sent-1");
    expect(larkMocks.createMessage).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc-1",
        msg_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    });
  });

  it("sends cards as interactive messages", async () => {
    const adapter = new FeishuAdapter(
      { appId: "cli-test", appSecret: "secret" },
      pino({ enabled: false }),
    );
    const card = {
      schema: "2.0",
      body: { elements: [{ tag: "markdown", content: "menu" }] },
    };

    await expect(
      adapter.send({ kind: "card", audience: "p2p", chatId: "oc-1", text: "menu", card }),
    ).resolves.toBe("om-sent-1");
    expect(larkMocks.createMessage).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc-1",
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });
  });

  it("replies inside the originating project topic", async () => {
    const adapter = new FeishuAdapter(
      { appId: "cli-test", appSecret: "secret" },
      pino({ enabled: false }),
    );

    await expect(
      adapter.send({
        chatId: "oc-project",
        text: "任务完成",
        replyToMessageId: "om-topic-root",
      }),
    ).resolves.toBe("om-reply-1");
    expect(larkMocks.replyMessage).toHaveBeenCalledWith({
      path: { message_id: "om-topic-root" },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text: "任务完成" }),
        reply_in_thread: true,
      },
    });
    expect(larkMocks.createMessage).not.toHaveBeenCalled();
  });

  it("downloads a Feishu message resource within the configured size limit", async () => {
    const adapter = new FeishuAdapter(
      { appId: "cli-test", appSecret: "secret" },
      pino({ enabled: false }),
    );
    const directory = await mkdtemp(path.join(tmpdir(), "clawbridge-attachment-"));
    const targetPath = path.join(directory, "photo.jpg");
    try {
      await adapter.downloadAttachment({
        messageId: "om-image",
        fileKey: "img-key",
        type: "image",
        targetPath,
        maxBytes: 8,
      });

      expect(larkMocks.getMessageResource).toHaveBeenCalledWith({
        params: { type: "image" },
        path: { message_id: "om-image", file_key: "img-key" },
      });
      await expect(readFile(targetPath, "utf8")).resolves.toBe("test");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an attachment whose declared size exceeds the configured limit", async () => {
    const writeResource = vi.fn();
    larkMocks.getMessageResource.mockResolvedValueOnce({
      headers: { "content-length": "1024" },
      writeFile: writeResource,
    });
    const adapter = new FeishuAdapter(
      { appId: "cli-test", appSecret: "secret" },
      pino({ enabled: false }),
    );

    await expect(
      adapter.downloadAttachment({
        messageId: "om-file",
        fileKey: "file-key",
        type: "file",
        targetPath: path.join(tmpdir(), "must-not-be-written.txt"),
        maxBytes: 32,
      }),
    ).rejects.toThrow("Attachment exceeds configured size limit");
    expect(writeResource).not.toHaveBeenCalled();
  });

  it("rejects a successful API response without a message id", async () => {
    larkMocks.createMessage.mockResolvedValueOnce({ code: 0, data: {} });
    const adapter = new FeishuAdapter(
      { appId: "cli-test", appSecret: "secret" },
      pino({ enabled: false }),
    );

    await expect(adapter.send({ chatId: "oc-1", text: "hello" })).rejects.toThrow(
      "Feishu send failed: response is missing message_id",
    );
  });

  it("creates a private thread-style project workspace with the owner", async () => {
    const adapter = new FeishuAdapter(
      { appId: "cli-test", appSecret: "secret" },
      pino({ enabled: false }),
    );

    await expect(
      adapter.createProjectSpace({
        projectId: "demo",
        projectName: "Demo Project",
        ownerOpenId: "ou-owner",
        idempotencyKey: "project-demo-123",
      }),
    ).resolves.toEqual({ chatId: "oc-project-1", displayName: "[Codex] Demo Project" });
    expect(larkMocks.createChat).toHaveBeenCalledWith({
      params: {
        user_id_type: "open_id",
        set_bot_manager: true,
        uuid: "project-demo-123",
      },
      data: {
        name: "[Codex] Demo Project",
        description: "ClawBridge project workspace: demo",
        owner_id: "ou-owner",
        user_id_list: ["ou-owner"],
        group_message_type: "thread",
        chat_mode: "group",
        chat_type: "private",
        join_message_visibility: "not_anyone",
        leave_message_visibility: "not_anyone",
        membership_approval: "approval_required",
      },
    });
  });

  it("rejects a successful project workspace response without a chat id", async () => {
    larkMocks.createChat.mockResolvedValueOnce({ code: 0, data: {} });
    const adapter = new FeishuAdapter(
      { appId: "cli-test", appSecret: "secret" },
      pino({ enabled: false }),
    );

    await expect(
      adapter.createProjectSpace({
        projectId: "demo",
        projectName: "Demo",
        ownerOpenId: "ou-owner",
        idempotencyKey: "project-demo-123",
      }),
    ).rejects.toThrow("response is missing chat_id");
  });

  it("detects whether the project owner is still in an existing project group", async () => {
    const adapter = new FeishuAdapter(
      { appId: "cli-test", appSecret: "secret" },
      pino({ enabled: false }),
    );

    await expect(
      adapter.inspectProjectSpace({ chatId: "oc-project-1", ownerOpenId: "ou-owner" }),
    ).resolves.toEqual({ status: "ready", displayName: "[Codex] Demo Project" });
    expect(larkMocks.getChatMembers).toHaveBeenCalledWith({
      params: { member_id_type: "open_id", page_size: 100 },
      path: { chat_id: "oc-project-1" },
    });

    larkMocks.getChatMembers.mockResolvedValueOnce({
      code: 0,
      data: { items: [{ member_id: "ou-someone-else" }], has_more: false },
    });
    await expect(
      adapter.inspectProjectSpace({ chatId: "oc-project-1", ownerOpenId: "ou-owner" }),
    ).resolves.toEqual({ status: "owner_absent", displayName: "[Codex] Demo Project" });
  });

  it("recognizes a dissolved project group without trying to list members", async () => {
    larkMocks.getChat.mockResolvedValueOnce({ code: 232009, msg: "dissolved" });
    const adapter = new FeishuAdapter(
      { appId: "cli-test", appSecret: "secret" },
      pino({ enabled: false }),
    );

    await expect(
      adapter.inspectProjectSpace({ chatId: "oc-old", ownerOpenId: "ou-owner" }),
    ).resolves.toEqual({ status: "dissolved" });
    expect(larkMocks.getChatMembers).not.toHaveBeenCalled();
  });

  it("reinvites the owner to an existing private project group", async () => {
    const adapter = new FeishuAdapter(
      { appId: "cli-test", appSecret: "secret" },
      pino({ enabled: false }),
    );

    await expect(
      adapter.addProjectSpaceMember({ chatId: "oc-project-1", ownerOpenId: "ou-owner" }),
    ).resolves.toBeUndefined();
    expect(larkMocks.createChatMembers).toHaveBeenCalledWith({
      params: { member_id_type: "open_id", succeed_type: 2 },
      path: { chat_id: "oc-project-1" },
      data: { id_list: ["ou-owner"] },
    });
  });

  it("creates a project topic root message with an idempotency key", async () => {
    const adapter = new FeishuAdapter(
      { appId: "cli-test", appSecret: "secret" },
      pino({ enabled: false }),
    );

    await expect(
      adapter.createProjectTopic({
        chatId: "oc-project-1",
        title: "修复移动端布局",
        idempotencyKey: "thread-019f",
      }),
    ).resolves.toEqual({ topicRootId: "om-sent-1" });
    expect(larkMocks.createMessage).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc-project-1",
        msg_type: "text",
        content: JSON.stringify({ text: "🧵 修复移动端布局" }),
        uuid: "thread-019f",
      },
    });
  });

  it("creates, updates, and finalizes a CardKit task stream inside a topic", async () => {
    const adapter = new FeishuAdapter(
      { appId: "cli-test", appSecret: "secret" },
      pino({ enabled: false }),
    );

    await expect(
      adapter.startTaskStream({
        chatId: "oc-project",
        replyToMessageId: "om-topic-root",
        title: "Demo · 任务运行中",
        initialText: "正在连接 Codex…",
      }),
    ).resolves.toEqual({ streamId: "card-stream-1", messageId: "om-reply-1" });
    expect(larkMocks.replyMessage).toHaveBeenCalledWith({
      path: { message_id: "om-topic-root" },
      data: {
        msg_type: "interactive",
        content: JSON.stringify({ type: "card", data: { card_id: "card-stream-1" } }),
        reply_in_thread: true,
      },
    });

    await adapter.updateTaskStream("card-stream-1", "正在修改文件");
    expect(larkMocks.updateCardContent).toHaveBeenCalledWith({
      path: { card_id: "card-stream-1", element_id: "task_stream_content" },
      data: {
        content: "正在修改文件",
        sequence: 1,
        uuid: "task-card-stream-1-1",
      },
    });
    await adapter.finishTaskStream("card-stream-1", "Demo · 已完成");
    expect(larkMocks.updateCardSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { card_id: "card-stream-1" },
        data: expect.objectContaining({ sequence: 2 }),
      }),
    );
  });
});
