import pino from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";

const larkMocks = vi.hoisted(() => ({
  createMessage: vi.fn(),
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
    readonly im = { message: { create: larkMocks.createMessage } };
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
});
