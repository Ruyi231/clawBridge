import * as lark from "@larksuiteoapi/node-sdk";
import type { Logger } from "pino";
import type { ChannelAdapter } from "./channel-adapter.js";
import { parseFeishuCardAction, parseFeishuMessage } from "./feishu-event.js";
import type { InboundEvent, OutboundMessage } from "../core/types.js";

export class FeishuAdapter implements ChannelAdapter {
  private readonly client: lark.Client;
  private readonly wsClient: lark.WSClient;
  private readonly ready: Promise<void>;
  private readonly sdkCredentialValues: string[];
  private settleStopped: (() => void) | undefined;
  private hasConnected = false;
  private stopped = false;
  private fatalErrorHandler: ((error: Error) => void) | undefined;

  constructor(
    credentials: { appId: string; appSecret: string },
    private readonly logger: Logger,
  ) {
    this.sdkCredentialValues = [credentials.appId, credentials.appSecret].filter(Boolean);
    const sdkLogger = {
      error: (...messages: unknown[]) => this.logSdkMessage("error", messages),
      warn: (...messages: unknown[]) => this.logSdkMessage("warn", messages),
      info: (...messages: unknown[]) => this.logSdkMessage("info", messages),
      debug: (...messages: unknown[]) => this.logSdkMessage("debug", messages),
      trace: (...messages: unknown[]) => this.logSdkMessage("trace", messages),
    };
    let markReady!: () => void;
    let markFailed!: (error: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      markFailed = reject;
    });
    this.client = new lark.Client({
      ...credentials,
      appType: lark.AppType.SelfBuild,
      logger: sdkLogger,
      loggerLevel: lark.LoggerLevel.warn,
    });
    this.wsClient = new lark.WSClient({
      ...credentials,
      logger: sdkLogger,
      loggerLevel: lark.LoggerLevel.warn,
      handshakeTimeoutMs: 15_000,
      onReady: () => {
        this.hasConnected = true;
        markReady();
      },
      onError: () => {
        this.logger.warn({ source: "feishu-sdk" }, "Feishu connection could not be established");
        const failure = new Error(
          "Feishu connection failed; check the saved App ID and App Secret",
        );
        if (!this.hasConnected) {
          markFailed(failure);
        } else if (!this.stopped) {
          // onError is terminal in the SDK (retry exhausted or a non-retryable
          // credential/configuration error). A supervised launch should exit so
          // Task Scheduler can restart it instead of keeping a stale ready file.
          this.logger.fatal({ source: "feishu-sdk" }, "Feishu connection was lost permanently");
          this.fatalErrorHandler?.(failure);
        }
      },
    });
  }

  private logSdkMessage(
    level: "error" | "warn" | "info" | "debug" | "trace",
    messages: unknown[],
  ): void {
    const summary = messages
      .filter((message): message is string => typeof message === "string")
      .map((message) => {
        let safe = message.replace(/\s+/g, " ").slice(0, 500);
        for (const credential of this.sdkCredentialValues)
          safe = safe.replaceAll(credential, "***");
        return safe
          .replace(
            /(["']?(?:app_id|app_secret|access_token|tenant_access_token|authorization)["']?\s*[:=]\s*)["']?[^"'\s,}]+["']?/gi,
            "$1***",
          )
          .replace(/\bcli_[A-Za-z0-9_-]+\b/g, "***");
      })
      .join(" ");
    this.logger[level]({ source: "feishu-sdk" }, summary || "Feishu SDK event");
  }

  async start(onEvent: (event: InboundEvent) => Promise<void>): Promise<void> {
    const dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (payload: unknown) => {
        this.logger.info("Feishu message event received");
        try {
          const message = parseFeishuMessage(payload);
          if (message) await onEvent(message);
        } catch (error) {
          this.logger.warn({ err: error }, "Invalid Feishu event");
        }
      },
      "card.action.trigger": (payload: unknown) => {
        this.logger.info("Feishu card action received");
        try {
          const action = parseFeishuCardAction(payload);
          // Card callbacks have a short response deadline. Acknowledge the callback
          // immediately and let Bridge serialize, authorize, and execute it in the
          // background just like a regular inbound event.
          setImmediate(() => {
            try {
              void onEvent(action).catch((error: unknown) => {
                this.logger.error({ err: error }, "Feishu card action handling failed");
              });
            } catch (error) {
              this.logger.error({ err: error }, "Feishu card action handling failed");
            }
          });
          return { toast: { type: "info", content: "正在处理…" } };
        } catch (error) {
          this.logger.warn({ err: error }, "Invalid Feishu card action");
          return { toast: { type: "error", content: "操作无效，请刷新菜单后重试" } };
        }
      },
    });
    const startFailure = Promise.resolve(this.wsClient.start({ eventDispatcher: dispatcher })).then(
      () => new Promise<never>(() => {}),
      () => {
        throw new Error("Feishu connection startup failed; check the saved credentials");
      },
    );
    let timeout: NodeJS.Timeout | undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      this.settleStopped = () => reject(new Error("Feishu connection startup was stopped"));
    });
    try {
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Feishu connection timed out during startup")),
          30_000,
        );
      });
      await Promise.race([this.ready, startFailure, timedOut, stopped]);
    } catch (error) {
      this.wsClient.close();
      throw error;
    } finally {
      this.settleStopped = undefined;
      if (timeout) clearTimeout(timeout);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.settleStopped?.();
    this.wsClient.close();
  }

  onFatalError(handler: (error: Error) => void): void {
    this.fatalErrorHandler = handler;
  }

  async send(message: OutboundMessage): Promise<string> {
    const isCard = message.kind === "card";
    const content = JSON.stringify(isCard ? message.card : { text: message.text });
    const response =
      !isCard && message.replyToMessageId
        ? await this.client.im.message.reply({
            path: { message_id: message.replyToMessageId },
            data: { msg_type: "text", content, reply_in_thread: true },
          })
        : await this.client.im.message.create({
            params: { receive_id_type: "chat_id" },
            data: {
              receive_id: message.chatId,
              msg_type: isCard ? "interactive" : "text",
              content,
            },
          });
    if (response.code !== 0)
      throw new Error(`Feishu send failed: ${response.msg ?? response.code}`);
    const messageId = response.data?.message_id;
    if (!messageId) throw new Error("Feishu send failed: response is missing message_id");
    return messageId;
  }

  async createProjectSpace(input: {
    projectId: string;
    projectName: string;
    ownerOpenId: string;
    idempotencyKey: string;
  }): Promise<{ chatId: string; displayName: string }> {
    const safeName = input.projectName
      .replace(/[\r\n\t]/g, " ")
      .trim()
      .slice(0, 48);
    if (!safeName) throw new Error("Feishu project space name cannot be empty");
    const displayName = `[Codex] ${safeName}`.slice(0, 60);
    const response = await this.client.im.chat.create({
      params: {
        user_id_type: "open_id",
        set_bot_manager: true,
        uuid: input.idempotencyKey.slice(0, 50),
      },
      data: {
        name: displayName,
        description: `ClawBridge project workspace: ${input.projectId}`.slice(0, 100),
        owner_id: input.ownerOpenId,
        user_id_list: [input.ownerOpenId],
        group_message_type: "thread",
        chat_mode: "group",
        chat_type: "private",
        join_message_visibility: "not_anyone",
        leave_message_visibility: "not_anyone",
        membership_approval: "approval_required",
      },
    });
    if (response.code !== 0) {
      throw new Error(`Feishu create project space failed: ${response.msg ?? response.code}`);
    }
    const chatId = response.data?.chat_id;
    if (!chatId) {
      throw new Error("Feishu create project space failed: response is missing chat_id");
    }
    return { chatId, displayName };
  }

  async createProjectTopic(input: {
    chatId: string;
    title: string;
    idempotencyKey: string;
  }): Promise<{ topicRootId: string }> {
    const title = input.title
      .replace(/[\r\n\t]/g, " ")
      .trim()
      .slice(0, 120);
    if (!title) throw new Error("Feishu project topic title cannot be empty");
    const response = await this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: input.chatId,
        msg_type: "text",
        content: JSON.stringify({ text: `🧵 ${title}` }),
        uuid: input.idempotencyKey.slice(0, 50),
      },
    });
    if (response.code !== 0) {
      throw new Error(`Feishu create project topic failed: ${response.msg ?? response.code}`);
    }
    const topicRootId = response.data?.message_id;
    if (!topicRootId) {
      throw new Error("Feishu create project topic failed: response is missing message_id");
    }
    return { topicRootId };
  }
}
