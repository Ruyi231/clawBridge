import * as lark from "@larksuiteoapi/node-sdk";
import { createHash } from "node:crypto";
import type { Logger } from "pino";
import type { ChannelAdapter } from "./channel-adapter.js";
import { parseFeishuCardAction, parseFeishuMessage } from "./feishu-event.js";
import type { InboundEvent, OutboundMessage } from "../core/types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeHistoryCardMarkdown(markdown: string): string {
  let insideFence = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        insideFence = !insideFence;
        return line;
      }
      if (insideFence) return line;
      return line
        .replace(
          /!\[([^\]]*)\]\([^\r\n)]*\)/g,
          (_match, alt: string) => `🖼️ ${alt.trim() || "图片"}（图片未同步）`,
        )
        .replace(/<img\b[^>]*>/gi, "🖼️ 图片（图片未同步）");
    })
    .join("\n");
}

function convertCardButton(
  input: Record<string, unknown>,
  elementId: string,
): Record<string, unknown> {
  const text = isRecord(input.text) ? input.text : { tag: "plain_text", content: "操作" };
  const classicType = typeof input.type === "string" ? input.type : "default";
  const type =
    classicType === "primary"
      ? "primary_filled"
      : classicType === "danger"
        ? "danger_filled"
        : "default";
  const multiUrl = isRecord(input.multi_url) ? input.multi_url : undefined;
  const defaultUrl =
    typeof input.url === "string"
      ? input.url
      : typeof multiUrl?.url === "string"
        ? multiUrl.url
        : undefined;
  const behaviors: Array<Record<string, unknown>> = [];
  if (isRecord(input.value)) {
    behaviors.push({ type: "callback", value: input.value });
  }
  if (defaultUrl) {
    behaviors.push({
      type: "open_url",
      default_url: defaultUrl,
      pc_url: typeof multiUrl?.pc_url === "string" ? multiUrl.pc_url : defaultUrl,
      ios_url: typeof multiUrl?.ios_url === "string" ? multiUrl.ios_url : defaultUrl,
      android_url: typeof multiUrl?.android_url === "string" ? multiUrl.android_url : defaultUrl,
    });
  }

  return {
    tag: "button",
    element_id: elementId,
    text,
    type,
    width: "fill",
    size: "medium",
    behaviors,
    ...(typeof input.name === "string" ? { name: input.name } : {}),
    ...(input.action_type === "form_submit" ? { form_action_type: "submit" } : {}),
    ...(isRecord(input.confirm) ? { confirm: input.confirm } : {}),
  };
}

interface CardConversionState {
  rowIndex: number;
  buttonIndex: number;
  inputIndex: number;
}

function convertCardElements(
  elements: unknown[],
  state: CardConversionState,
): Array<Record<string, unknown>> {
  const converted: Array<Record<string, unknown>> = [];
  for (const rawElement of elements) {
    if (!isRecord(rawElement)) continue;
    if (rawElement.tag === "hr") {
      converted.push({ tag: "hr" });
      continue;
    }
    if (rawElement.tag === "div" && isRecord(rawElement.text)) {
      converted.push({
        tag: "markdown",
        content: typeof rawElement.text.content === "string" ? rawElement.text.content : "",
      });
      if (isRecord(rawElement.extra)) {
        converted.push(convertCardButton(rawElement.extra, `card_btn_${++state.buttonIndex}`));
      }
      continue;
    }
    if (rawElement.tag === "button") {
      converted.push(convertCardButton(rawElement, `card_btn_${++state.buttonIndex}`));
      continue;
    }
    if (rawElement.tag === "input") {
      converted.push({
        ...rawElement,
        element_id: `card_input_${++state.inputIndex}`,
      });
      continue;
    }
    if (rawElement.tag === "form" && Array.isArray(rawElement.elements)) {
      converted.push({
        tag: "form",
        ...(typeof rawElement.name === "string" ? { name: rawElement.name } : {}),
        elements: convertCardElements(rawElement.elements, state),
      });
      continue;
    }
    if (rawElement.tag !== "action" || !Array.isArray(rawElement.actions)) continue;

    const buttons = rawElement.actions
      .filter(isRecord)
      .map((action) => convertCardButton(action, `card_btn_${++state.buttonIndex}`));
    if (buttons.length === 0) continue;
    if (buttons.length === 1) {
      converted.push(buttons[0]!);
      continue;
    }
    converted.push({
      tag: "column_set",
      element_id: `card_row_${++state.rowIndex}`,
      flex_mode: buttons.length === 2 ? "bisect" : buttons.length === 3 ? "trisection" : "flow",
      horizontal_spacing: "8px",
      columns: buttons.map((button) => ({
        tag: "column",
        width: "weighted",
        weight: 1,
        vertical_align: "top",
        elements: [button],
      })),
    });
  }
  return converted;
}

function convertCardToCardKit(card: Record<string, unknown>): Record<string, unknown> {
  if (card.schema === "2.0" || !Array.isArray(card.elements)) return card;

  const header = isRecord(card.header) ? card.header : undefined;
  const headerTitle = header && isRecord(header.title) ? header.title : undefined;
  const summary = typeof headerTitle?.content === "string" ? headerTitle.content : "ClawBridge";
  const state: CardConversionState = { rowIndex: 0, buttonIndex: 0, inputIndex: 0 };
  const bodyElements = convertCardElements(card.elements, state);

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: summary },
    },
    ...(header ? { header } : {}),
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements: bodyElements,
    },
  };
}

export class FeishuAdapter implements ChannelAdapter {
  private readonly client: lark.Client;
  private readonly wsClient: lark.WSClient;
  private readonly ready: Promise<void>;
  private readonly sdkCredentialValues: string[];
  private settleStopped: (() => void) | undefined;
  private hasConnected = false;
  private stopped = false;
  private fatalErrorHandler: ((error: Error) => void) | undefined;
  private readonly streamSequences = new Map<string, { elementId: string; sequence: number }>();

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

  private async callApi<T>(operation: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      const responseData =
        typeof error === "object" && error !== null && "response" in error
          ? (error as { response?: { data?: unknown } }).response?.data
          : undefined;
      const apiCode =
        typeof responseData === "object" && responseData !== null && "code" in responseData
          ? String((responseData as { code?: unknown }).code)
          : undefined;
      const apiMessage =
        typeof responseData === "object" && responseData !== null && "msg" in responseData
          ? String((responseData as { msg?: unknown }).msg)
          : undefined;
      const detail = [
        apiCode ? `飞书错误码 ${apiCode}` : undefined,
        apiMessage,
        !apiCode && !apiMessage
          ? error instanceof Error
            ? error.message
            : String(error)
          : undefined,
      ]
        .filter(Boolean)
        .join("：");
      throw new Error(`${operation}失败：${detail}`);
    }
  }

  private async wait(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
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
    const content = JSON.stringify(
      isCard ? convertCardToCardKit(message.card) : { text: message.text },
    );
    const response = message.replyToMessageId
      ? await this.client.im.message.reply({
          path: { message_id: message.replyToMessageId },
          data: { msg_type: isCard ? "interactive" : "text", content, reply_in_thread: true },
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

  async updateCardMessage(messageId: string, card: Record<string, unknown>): Promise<void> {
    const preparedCard = convertCardToCardKit(card);
    const response = await this.callApi("更新飞书卡片", () =>
      this.client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(preparedCard) },
      }),
    );
    if (response.code !== 0) {
      throw new Error(`Feishu card update failed: ${response.msg ?? response.code}`);
    }
  }

  async downloadAttachment(input: {
    messageId: string;
    fileKey: string;
    type: "image" | "file";
    targetPath: string;
    maxBytes: number;
  }): Promise<void> {
    const resource = await this.client.im.messageResource.get({
      params: { type: input.type === "image" ? "image" : "file" },
      path: { message_id: input.messageId, file_key: input.fileKey },
    });
    const declaredLength = Number(resource.headers?.["content-length"] ?? 0);
    if (declaredLength > input.maxBytes)
      throw new Error("Attachment exceeds configured size limit");
    await resource.writeFile(input.targetPath);
    const { size } = await import("node:fs/promises").then((fs) => fs.stat(input.targetPath));
    if (size > input.maxBytes) {
      await import("node:fs/promises").then((fs) =>
        fs.unlink(input.targetPath).catch(() => undefined),
      );
      throw new Error("Attachment exceeds configured size limit");
    }
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
    const response = await this.callApi("创建飞书项目群", () =>
      this.client.im.chat.create({
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
          group_message_type: "chat",
          chat_mode: "group",
          chat_type: "private",
          join_message_visibility: "not_anyone",
          leave_message_visibility: "not_anyone",
          membership_approval: "approval_required",
        },
      }),
    );
    if (response.code !== 0) {
      throw new Error(`Feishu create project space failed: ${response.msg ?? response.code}`);
    }
    const chatId = response.data?.chat_id;
    if (!chatId) {
      throw new Error("Feishu create project space failed: response is missing chat_id");
    }
    return { chatId, displayName };
  }

  async inspectProjectSpace(input: { chatId: string; ownerOpenId: string }): Promise<{
    status: "ready" | "owner_absent" | "dissolved" | "missing";
    displayName?: string;
    messageMode?: "chat" | "thread";
    canConfigure?: boolean;
  }> {
    const chat = await this.callApi("读取飞书项目群信息", () =>
      this.client.im.chat.get({
        params: { user_id_type: "open_id" },
        path: { chat_id: input.chatId },
      }),
    );
    if (chat.code === 232006) return { status: "missing" };
    if (chat.code === 232009 || chat.data?.chat_status?.startsWith("dissolved")) {
      return { status: "dissolved" };
    }
    if (chat.code !== 0) {
      throw new Error(`Feishu inspect project group failed: ${chat.msg ?? chat.code}`);
    }

    let pageToken: string | undefined;
    do {
      const members = await this.callApi("读取飞书项目群成员", () =>
        this.client.im.chatMembers.get({
          params: {
            member_id_type: "open_id",
            page_size: 100,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
          path: { chat_id: input.chatId },
        }),
      );
      if (members.code === 232006) return { status: "missing" };
      if (members.code === 232009) return { status: "dissolved" };
      if (members.code !== 0) {
        throw new Error(
          `Feishu inspect project group members failed: ${members.msg ?? members.code}`,
        );
      }
      if (members.data?.items?.some((member) => member.member_id === input.ownerOpenId)) {
        return {
          status: "ready",
          ...(chat.data?.name ? { displayName: chat.data.name } : {}),
          ...(chat.data?.group_message_type === "chat" || chat.data?.group_message_type === "thread"
            ? { messageMode: chat.data.group_message_type }
            : {}),
          canConfigure: Boolean(chat.data?.bot_manager_id_list?.length),
        };
      }
      pageToken = members.data?.has_more ? members.data.page_token : undefined;
    } while (pageToken);

    return {
      status: "owner_absent",
      ...(chat.data?.name ? { displayName: chat.data.name } : {}),
      ...(chat.data?.group_message_type === "chat" || chat.data?.group_message_type === "thread"
        ? { messageMode: chat.data.group_message_type }
        : {}),
      canConfigure: Boolean(chat.data?.bot_manager_id_list?.length),
    };
  }

  async addProjectSpaceMember(input: { chatId: string; ownerOpenId: string }): Promise<void> {
    const response = await this.callApi("重新加入飞书项目群", () =>
      this.client.im.chatMembers.create({
        params: { member_id_type: "open_id", succeed_type: 2 },
        path: { chat_id: input.chatId },
        data: { id_list: [input.ownerOpenId] },
      }),
    );
    if (response.code !== 0) {
      throw new Error(`Feishu rejoin project group failed: ${response.msg ?? response.code}`);
    }
    const rejected = [
      ...(response.data?.invalid_id_list ?? []),
      ...(response.data?.not_existed_id_list ?? []),
      ...(response.data?.pending_approval_id_list ?? []),
    ];
    if (rejected.includes(input.ownerOpenId)) {
      throw new Error("Feishu rejoin project group failed: the owner was not added");
    }
  }

  async removeProjectSpaceMember(input: { chatId: string; ownerOpenId: string }): Promise<void> {
    const response = await this.callApi("退出飞书项目群", () =>
      this.client.im.chatMembers.delete({
        params: { member_id_type: "open_id" },
        path: { chat_id: input.chatId },
        data: { id_list: [input.ownerOpenId] },
      }),
    );
    if (response.code !== 0) {
      throw new Error(`Feishu leave project group failed: ${response.msg ?? response.code}`);
    }
    if (response.data?.invalid_id_list?.includes(input.ownerOpenId)) {
      throw new Error("Feishu leave project group failed: the owner was not removed");
    }
  }

  async deleteProjectSpace(input: { chatId: string }): Promise<void> {
    const response = await this.callApi("解散飞书项目群", () =>
      this.client.im.chat.delete({ path: { chat_id: input.chatId } }),
    );
    if (response.code !== 0) {
      throw new Error(`Feishu dissolve project group failed: ${response.msg ?? response.code}`);
    }
  }

  async configureProjectSpace(input: { chatId: string }): Promise<void> {
    const response = await this.callApi("配置飞书项目群", () =>
      this.client.im.chat.update({
        params: { user_id_type: "open_id" },
        path: { chat_id: input.chatId },
        data: { group_message_type: "chat" },
      }),
    );
    if (response.code !== 0) {
      throw new Error(`Feishu configure project group failed: ${response.msg ?? response.code}`);
    }
  }

  async createProjectTopic(input: {
    chatId: string;
    title: string;
    idempotencyKey: string;
    historyMessages?: string[];
  }): Promise<{ topicRootId: string }> {
    const title = input.title
      .replace(/[\r\n\t]/g, " ")
      .trim()
      .slice(0, 120);
    if (!title) throw new Error("Feishu project topic title cannot be empty");
    const root = await this.callApi("创建项目话题根消息", () =>
      this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: input.chatId,
          msg_type: "text",
          content: JSON.stringify({ text: `🧵 ${title}` }),
          uuid: input.idempotencyKey.slice(0, 50),
        },
      }),
    );
    if (root.code !== 0) {
      throw new Error(`Feishu create project topic failed: ${root.msg ?? root.code}`);
    }
    const rootMessageId = root.data?.message_id;
    if (!rootMessageId) {
      throw new Error("Feishu create project topic failed: response is missing message_id");
    }
    const historyMessages = (input.historyMessages ?? []).filter((message) => message.trim());
    const replies: Array<{ kind: "text" | "history"; text: string }> = historyMessages.length
      ? [
          { kind: "text", text: "—— 已恢复的历史对话 ——" },
          ...historyMessages.map((text) => ({ kind: "history" as const, text })),
          {
            kind: "text",
            text: "—— 以下为新的对话 ——\n可直接发送新的 Codex 任务。",
          },
        ]
      : [{ kind: "text", text: "—— 新的对话 ——\n可直接发送 Codex 任务。" }];
    let topicRootId = rootMessageId;
    for (const [index, reply] of replies.entries()) {
      const historyCardId =
        reply.kind === "history" ? await this.createHistoryCard(reply.text) : undefined;
      let response: Awaited<ReturnType<typeof this.client.im.message.reply>> | undefined;
      let lastError: unknown;
      for (const delayMilliseconds of [0, 400, 1_000]) {
        if (delayMilliseconds > 0) await this.wait(delayMilliseconds);
        try {
          response = await this.callApi("创建项目话题回复", () =>
            this.client.im.message.reply({
              path: { message_id: rootMessageId },
              data:
                reply.kind === "history"
                  ? {
                      msg_type: "interactive" as const,
                      content: JSON.stringify({
                        type: "card",
                        data: { card_id: historyCardId },
                      }),
                      reply_in_thread: true,
                      uuid: `clawbridge-msg-${createHash("sha256")
                        .update(`${input.idempotencyKey}\0${index}`)
                        .digest("hex")
                        .slice(0, 32)}`,
                    }
                  : {
                      msg_type: "text" as const,
                      content: JSON.stringify({ text: reply.text }),
                      reply_in_thread: true,
                      uuid: `clawbridge-msg-${createHash("sha256")
                        .update(`${input.idempotencyKey}\0${index}`)
                        .digest("hex")
                        .slice(0, 32)}`,
                    },
            }),
          );
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!response) throw lastError;
      if (response.code !== 0) {
        throw new Error(`Feishu create project topic failed: ${response.msg ?? response.code}`);
      }
      topicRootId = response.data?.root_id ?? topicRootId;
      if (index + 1 < replies.length) await this.wait(25);
    }
    return { topicRootId };
  }

  private async createHistoryCard(message: string): Promise<string> {
    const [firstLine = "历史对话", ...remainingLines] = message.split("\n");
    const title = firstLine.trim().slice(0, 80) || "历史对话";
    const content = sanitizeHistoryCardMarkdown(remainingLines.join("\n").trim() || message.trim());
    const card = {
      schema: "2.0",
      config: { summary: { content: title } },
      header: {
        template: "blue",
        title: { tag: "plain_text", content: title },
      },
      body: { elements: [{ tag: "markdown", content }] },
    };
    const created = await this.client.cardkit.v1.card.create({
      data: { type: "card_json", data: JSON.stringify(card) },
    });
    const cardId = created.data?.card_id;
    if (created.code !== 0 || !cardId) {
      throw new Error(`Feishu history card create failed: ${created.msg ?? created.code}`);
    }
    return cardId;
  }

  async startTaskStream(input: {
    chatId: string;
    replyToMessageId?: string | null;
    title: string;
    initialText: string;
  }): Promise<{ streamId: string; messageId: string }> {
    const elementId = "task_stream_content";
    const card = {
      schema: "2.0",
      config: {
        streaming_mode: true,
        summary: { content: input.title.slice(0, 100) },
        streaming_config: {
          print_frequency_ms: { default: 60 },
          print_step: { default: 1 },
          print_strategy: "fast",
        },
      },
      body: {
        elements: [{ tag: "markdown", element_id: elementId, content: input.initialText }],
      },
    };
    const created = await this.client.cardkit.v1.card.create({
      data: { type: "card_json", data: JSON.stringify(card) },
    });
    const cardId = created.data?.card_id;
    if (created.code !== 0 || !cardId) {
      throw new Error(`Feishu stream card create failed: ${created.msg ?? created.code}`);
    }
    const content = JSON.stringify({ type: "card", data: { card_id: cardId } });
    const sent = input.replyToMessageId
      ? await this.client.im.message.reply({
          path: { message_id: input.replyToMessageId },
          data: { msg_type: "interactive", content, reply_in_thread: true },
        })
      : await this.client.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: { receive_id: input.chatId, msg_type: "interactive", content },
        });
    const messageId = sent.data?.message_id;
    if (sent.code !== 0 || !messageId) {
      throw new Error(`Feishu stream card send failed: ${sent.msg ?? sent.code}`);
    }
    this.streamSequences.set(cardId, { elementId, sequence: 0 });
    return { streamId: cardId, messageId };
  }

  async updateTaskStream(streamId: string, content: string): Promise<void> {
    const stream = this.streamSequences.get(streamId);
    if (!stream) throw new Error("Unknown Feishu task stream");
    const sequence = ++stream.sequence;
    const response = await this.client.cardkit.v1.cardElement.content({
      path: { card_id: streamId, element_id: stream.elementId },
      data: { content: content.slice(-30_000), sequence, uuid: `task-${streamId}-${sequence}` },
    });
    if (response.code !== 0) {
      throw new Error(`Feishu task stream update failed: ${response.msg ?? response.code}`);
    }
  }

  async finishTaskStream(streamId: string, summary: string): Promise<void> {
    const stream = this.streamSequences.get(streamId);
    if (!stream) return;
    const sequence = ++stream.sequence;
    try {
      const response = await this.client.cardkit.v1.card.settings({
        path: { card_id: streamId },
        data: {
          settings: JSON.stringify({
            config: { streaming_mode: false, summary: { content: summary.slice(0, 100) } },
          }),
          sequence,
          uuid: `finish-${streamId}-${sequence}`,
        },
      });
      if (response.code !== 0) {
        throw new Error(`Feishu task stream finish failed: ${response.msg ?? response.code}`);
      }
    } finally {
      this.streamSequences.delete(streamId);
    }
  }
}
