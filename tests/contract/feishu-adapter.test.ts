import pino from "pino";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const larkMocks = vi.hoisted(() => ({
  createMessage: vi.fn(),
  replyMessage: vi.fn(),
  patchMessage: vi.fn(),
  deleteMessage: vi.fn(),
  getMessageResource: vi.fn(),
  createChat: vi.fn(),
  getChat: vi.fn(),
  updateChat: vi.fn(),
  deleteChat: vi.fn(),
  getChatMembers: vi.fn(),
  createChatMembers: vi.fn(),
  deleteChatMembers: vi.fn(),
  createCard: vi.fn(),
  updateCard: vi.fn(),
  updateCardContent: vi.fn(),
  updateCardSettings: vi.fn(),
  uploadImage: vi.fn(),
  uploadFile: vi.fn(),
  downloadDriveMedia: vi.fn(),
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
      message: {
        create: larkMocks.createMessage,
        reply: larkMocks.replyMessage,
        delete: larkMocks.deleteMessage,
      },
      v1: { message: { patch: larkMocks.patchMessage } },
      messageResource: { get: larkMocks.getMessageResource },
      image: { create: larkMocks.uploadImage },
      file: { create: larkMocks.uploadFile },
      chat: {
        create: larkMocks.createChat,
        get: larkMocks.getChat,
        update: larkMocks.updateChat,
        delete: larkMocks.deleteChat,
      },
      chatMembers: {
        get: larkMocks.getChatMembers,
        create: larkMocks.createChatMembers,
        delete: larkMocks.deleteChatMembers,
      },
    };
    readonly cardkit = {
      v1: {
        card: {
          create: larkMocks.createCard,
          update: larkMocks.updateCard,
          settings: larkMocks.updateCardSettings,
        },
        cardElement: { content: larkMocks.updateCardContent },
      },
    };
    readonly drive = { media: { download: larkMocks.downloadDriveMedia } };
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
    larkMocks.patchMessage.mockResolvedValue({ code: 0, data: {} });
    larkMocks.deleteMessage.mockResolvedValue({ code: 0, data: {} });
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
    larkMocks.deleteChatMembers.mockResolvedValue({ code: 0, data: {} });
    larkMocks.updateChat.mockResolvedValue({ code: 0, data: {} });
    larkMocks.deleteChat.mockResolvedValue({ code: 0, data: {} });
    larkMocks.createCard.mockResolvedValue({ code: 0, data: { card_id: "card-stream-1" } });
    larkMocks.updateCard.mockResolvedValue({ code: 0 });
    larkMocks.updateCardContent.mockResolvedValue({ code: 0 });
    larkMocks.updateCardSettings.mockResolvedValue({ code: 0 });
    larkMocks.uploadImage.mockResolvedValue({ image_key: "img-uploaded-1" });
    larkMocks.uploadFile.mockResolvedValue({ file_key: "file-uploaded-1" });
    larkMocks.downloadDriveMedia.mockResolvedValue({
      writeFile: async (targetPath: string) => writeFile(targetPath, "image"),
    });
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
        card: {
          header: { title: { tag: "plain_text", content: "Approve" } },
          elements: [],
        },
      }),
    ).resolves.toBe("om-reply-1");
    const sentCard = JSON.parse(larkMocks.replyMessage.mock.calls[0]![0].data.content) as {
      schema: string;
      body: { elements: unknown[] };
    };
    expect(larkMocks.replyMessage).toHaveBeenCalledWith({
      path: { message_id: "om-topic-root" },
      data: {
        msg_type: "interactive",
        content: expect.any(String),
        reply_in_thread: true,
      },
    });
    expect(sentCard.schema).toBe("2.0");
    expect(sentCard.body.elements).toEqual([]);
  });

  it("sends the home card as CardKit 2.0 with callback and desktop AppLink behaviors", async () => {
    const adapter = new FeishuAdapter(
      { appId: "cli-test", appSecret: "secret" },
      pino({ enabled: false }),
    );
    const projectSpaceUrl = "https://applink.feishu.cn/client/chat/open?openChatId=oc-project-1";

    await adapter.send({
      kind: "card",
      audience: "p2p",
      chatId: "oc-control",
      text: "home",
      card: {
        config: { wide_screen_mode: true, enable_forward: false, update_multi: false },
        header: {
          template: "blue",
          title: { tag: "plain_text", content: "ClawBridge 控制台" },
        },
        elements: [
          {
            tag: "action",
            layout: "bisected",
            actions: [
              {
                tag: "button",
                text: { tag: "plain_text", content: "刷新" },
                value: { version: 1, action: "menu.refresh" },
              },
              {
                tag: "button",
                text: { tag: "plain_text", content: "项目群" },
                value: { version: 1, action: "project.space", projectId: "demo" },
                url: projectSpaceUrl,
                multi_url: {
                  url: projectSpaceUrl,
                  pc_url: projectSpaceUrl,
                  ios_url: projectSpaceUrl,
                  android_url: projectSpaceUrl,
                },
              },
            ],
          },
        ],
      },
    });

    const request = larkMocks.createMessage.mock.calls[0]?.[0] as {
      data: { content: string };
    };
    const card = JSON.parse(request.data.content) as {
      schema: string;
      body: { elements: Array<Record<string, unknown>> };
    };
    const serialized = JSON.stringify(card);

    expect(card.schema).toBe("2.0");
    expect(serialized).toContain('"type":"callback"');
    expect(serialized).toContain('"action":"menu.refresh"');
    expect(serialized).toContain('"type":"open_url"');
    expect(serialized).toContain('"action":"project.space"');
    expect(serialized).toContain(`"default_url":"${projectSpaceUrl}"`);
    expect(serialized).toContain(`"pc_url":"${projectSpaceUrl}"`);
    expect(serialized).not.toContain('"tag":"action"');
  });

  it("updates an existing interactive card without sending a new message", async () => {
    const adapter = new FeishuAdapter(
      { appId: "cli-test", appSecret: "secret" },
      pino({ enabled: false }),
    );
    const card = {
      header: { title: { tag: "plain_text", content: "Thread details" } },
      elements: [
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "Back" },
              value: { version: 1, action: "menu.refresh" },
            },
          ],
        },
      ],
    };

    await adapter.updateCardMessage("om-card-1", card);

    const patchedCard = JSON.parse(larkMocks.patchMessage.mock.calls[0]![0].data.content) as {
      schema: string;
      body: { elements: unknown[] };
    };
    expect(larkMocks.patchMessage).toHaveBeenCalledWith({
      path: { message_id: "om-card-1" },
      data: { content: expect.any(String) },
    });
    expect(patchedCard.schema).toBe("2.0");
    expect(JSON.stringify(patchedCard)).toContain('"action":"menu.refresh"');
    expect(larkMocks.createMessage).not.toHaveBeenCalled();
    expect(larkMocks.replyMessage).not.toHaveBeenCalled();
  });

  it("withdraws a bot-authored toolbar message", async () => {
    const adapter = new FeishuAdapter(
      { appId: "cli-test", appSecret: "secret" },
      pino({ enabled: false }),
    );

    await adapter.deleteMessage("om-toolbar-old");

    expect(larkMocks.deleteMessage).toHaveBeenCalledWith({
      path: { message_id: "om-toolbar-old" },
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

  it("creates a private project workspace with a chat control surface", async () => {
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
        group_message_type: "chat",
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
    ).resolves.toEqual({
      status: "ready",
      displayName: "[Codex] Demo Project",
      canConfigure: false,
    });
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
    ).resolves.toEqual({
      status: "owner_absent",
      displayName: "[Codex] Demo Project",
      canConfigure: false,
    });
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

  it("removes the owner when leaving a project group", async () => {
    const adapter = new FeishuAdapter(
      { appId: "cli-test", appSecret: "secret" },
      pino({ enabled: false }),
    );

    await expect(
      adapter.removeProjectSpaceMember({ chatId: "oc-project-1", ownerOpenId: "ou-owner" }),
    ).resolves.toBeUndefined();
    expect(larkMocks.deleteChatMembers).toHaveBeenCalledWith({
      params: { member_id_type: "open_id" },
      path: { chat_id: "oc-project-1" },
      data: { id_list: ["ou-owner"] },
    });
  });

  it("dissolves an application-created project group", async () => {
    const adapter = new FeishuAdapter(
      { appId: "cli-test", appSecret: "secret" },
      pino({ enabled: false }),
    );

    await expect(adapter.deleteProjectSpace({ chatId: "oc-project-1" })).resolves.toBeUndefined();
    expect(larkMocks.deleteChat).toHaveBeenCalledWith({ path: { chat_id: "oc-project-1" } });
  });

  it("switches an existing project group to chat control plus threaded replies", async () => {
    const adapter = new FeishuAdapter(
      { appId: "cli-test", appSecret: "secret" },
      pino({ enabled: false }),
    );

    await expect(
      adapter.configureProjectSpace({ chatId: "oc-project-1" }),
    ).resolves.toBeUndefined();
    expect(larkMocks.updateChat).toHaveBeenCalledWith({
      params: { user_id_type: "open_id" },
      path: { chat_id: "oc-project-1" },
      data: { group_message_type: "chat" },
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
        historyTurns: [{ title: "第 1 轮", userText: "你好", assistantText: "你好！" }],
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
    expect(larkMocks.replyMessage).toHaveBeenCalledTimes(3);
    expect(larkMocks.replyMessage).toHaveBeenNthCalledWith(1, {
      path: { message_id: "om-sent-1" },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text: "—— 已恢复的历史对话 ——" }),
        reply_in_thread: true,
        uuid: expect.stringMatching(/^clawbridge-msg-[0-9a-f]{32}$/),
      },
    });
    expect(larkMocks.replyMessage).toHaveBeenNthCalledWith(2, {
      path: { message_id: "om-sent-1" },
      data: {
        msg_type: "interactive",
        content: JSON.stringify({
          type: "card",
          data: { card_id: "card-stream-1" },
        }),
        reply_in_thread: true,
        uuid: expect.stringMatching(/^clawbridge-msg-[0-9a-f]{32}$/),
      },
    });
    expect(larkMocks.replyMessage).toHaveBeenNthCalledWith(3, {
      path: { message_id: "om-sent-1" },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text: "—— 以下为新的对话 ——\n可直接发送新的 Codex 任务。" }),
        reply_in_thread: true,
        uuid: expect.stringMatching(/^clawbridge-msg-[0-9a-f]{32}$/),
      },
    });
    const replyUuids = larkMocks.replyMessage.mock.calls.map(([request]) => request.data.uuid);
    expect(new Set(replyUuids).size).toBe(3);
    expect(larkMocks.createCard).toHaveBeenCalledWith({
      data: {
        type: "card_json",
        data: JSON.stringify({
          schema: "2.0",
          config: { summary: { content: "第 1 轮" } },
          header: {
            template: "blue",
            title: { tag: "plain_text", content: "第 1 轮" },
          },
          body: {
            elements: [
              {
                tag: "markdown",
                content: "**👤 用户**\n你好",
              },
              { tag: "hr" },
              { tag: "markdown", content: "**🤖 Codex**\n你好！" },
            ],
          },
        }),
      },
    });
  });

  it("replaces local Markdown images before creating a history card", async () => {
    const adapter = new FeishuAdapter(
      { appId: "cli-test", appSecret: "secret" },
      pino({ enabled: false }),
    );

    await adapter.createProjectTopic({
      chatId: "oc-project-1",
      title: "含本机图片的历史",
      idempotencyKey: "thread-local-image",
      historyTurns: [
        {
          title: "第 1 轮",
          userText: "图片如下：![运行截图](/C:/Users/Ruyi/Documents/Codex/result.png)",
          assistantText: "已查看图片。",
        },
      ],
    });

    const request = larkMocks.createCard.mock.calls.at(-1)?.[0] as {
      data: { data: string };
    };
    const card = JSON.parse(request.data.data) as {
      body: { elements: Array<{ content: string }> };
    };
    const content = card.body.elements[0]?.content ?? "";
    expect(content).toContain("🖼️ 运行截图（图片未同步）");
    expect(content).not.toContain("/C:/Users/Ruyi");
    expect(content).not.toContain("![运行截图]");
  });

  it("restores historical Codex images and files into the rebuilt topic", async () => {
    const adapter = new FeishuAdapter(
      { appId: "cli-test", appSecret: "secret" },
      pino({ enabled: false }),
    );
    const directory = await mkdtemp(path.join(tmpdir(), "clawbridge-history-output-"));
    const imagePath = path.join(directory, "history.png");
    const filePath = path.join(directory, "history.pdf");
    await writeFile(imagePath, "image");
    await writeFile(filePath, "report");

    try {
      await adapter.createProjectTopic({
        chatId: "oc-project-1",
        title: "恢复产物",
        idempotencyKey: "thread-history-output",
        historyTurns: [
          {
            title: "第 1 轮",
            userText: "生成产物",
            assistantText: "已生成历史产物。",
            attachments: [
              {
                name: "question.png",
                type: "image",
                driveFileToken: "bitable-image-token",
              },
            ],
            localArtifacts: [
              { path: imagePath, name: "history.png", type: "image", size: 5 },
              { path: filePath, name: "history.pdf", type: "file", size: 6 },
            ],
          },
        ],
      });

      const request = larkMocks.createCard.mock.calls.at(-1)?.[0] as {
        data: { data: string };
      };
      const card = JSON.parse(request.data.data);
      expect(JSON.stringify(card)).toContain('"img_key":"img-uploaded-1"');
      expect(JSON.stringify(card)).toContain("本轮图片预览（1）");
      expect(JSON.stringify(card)).toContain("history.pdf · 已发送为下方附件");
      expect(larkMocks.downloadDriveMedia).toHaveBeenCalledWith({
        path: { file_token: "bitable-image-token" },
      });
      expect(larkMocks.replyMessage).toHaveBeenCalledWith({
        path: { message_id: "om-sent-1" },
        data: {
          msg_type: "file",
          content: JSON.stringify({ file_key: "file-uploaded-1" }),
          reply_in_thread: true,
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
        userText: "分析这些材料",
        assistantText: "正在连接 Codex…",
        attachments: [{ name: "截图.png", type: "image", imageKey: "img-input-1" }],
      }),
    ).resolves.toEqual({ streamId: "card-stream-1", messageId: "om-reply-1" });
    const streamCardRequest = larkMocks.createCard.mock.calls.at(-1)?.[0] as {
      data: { data: string };
    };
    const streamCard = JSON.parse(streamCardRequest.data.data) as {
      body: { elements: Array<{ tag: string; expanded?: boolean }> };
    };
    expect(JSON.stringify(streamCard)).toContain("**👤 用户**\\n分析这些材料");
    expect(JSON.stringify(streamCard)).toContain('"img_key":"img-input-1"');
    expect(streamCard.body.elements).toContainEqual(
      expect.objectContaining({ tag: "collapsible_panel", expanded: false }),
    );
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
        content: "**🤖 Codex**\n正在修改文件",
        sequence: 1,
        uuid: "task-card-stream-1-1",
      },
    });
    const directory = await mkdtemp(path.join(tmpdir(), "clawbridge-output-"));
    const imagePath = path.join(directory, "result.png");
    const filePath = path.join(directory, "report.pdf");
    await writeFile(imagePath, "image");
    await writeFile(filePath, "report");
    await adapter.finishTaskStream("card-stream-1", {
      summary: "Demo · 已完成",
      finalText: "已生成结果。",
      artifacts: [
        { path: imagePath, name: "result.png", type: "image", size: 5 },
        { path: filePath, name: "report.pdf", type: "file", size: 6 },
      ],
    });
    await rm(directory, { recursive: true, force: true });
    expect(larkMocks.uploadImage).toHaveBeenCalled();
    expect(larkMocks.uploadFile).toHaveBeenCalled();
    expect(larkMocks.replyMessage).toHaveBeenLastCalledWith({
      path: { message_id: "om-topic-root" },
      data: {
        msg_type: "file",
        content: JSON.stringify({ file_key: "file-uploaded-1" }),
        reply_in_thread: true,
      },
    });
    expect(larkMocks.updateCard).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { card_id: "card-stream-1" },
        data: expect.objectContaining({ sequence: 2 }),
      }),
    );
    const finalCardRequest = larkMocks.updateCard.mock.calls.at(-1)?.[0] as {
      data: { card: { data: string } };
    };
    const finalCard = JSON.parse(finalCardRequest.data.card.data);
    expect(JSON.stringify(finalCard)).toContain('"img_key":"img-uploaded-1"');
    expect(JSON.stringify(finalCard)).toContain("report.pdf · 已发送为下方附件");
  });
});
