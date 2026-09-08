import * as lark from "@larksuiteoapi/node-sdk";
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import type { InboundMessage } from "../core/types.js";
import type { BridgeDatabase } from "../persistence/database.js";

export interface ComposerContext {
  chatId: string;
  chatType: "p2p" | "group";
  senderOpenId: string;
  topicRootId?: string;
}

export interface TurnComposer {
  getDirectSubmissionUrl(): string | undefined;
  createSubmissionUrl(context: ComposerContext): string;
}

type BitableClient = Pick<lark.Client, "bitable" | "drive">;

interface BitableAttachment {
  file_token?: string;
  name?: string;
  type?: string;
  size?: number;
}

export class BitableCloudComposer implements TurnComposer {
  private timer: NodeJS.Timeout | undefined;
  private polling: Promise<void> | undefined;
  private submit: ((message: InboundMessage) => Promise<void>) | undefined;

  constructor(
    private readonly options: {
      client: BitableClient;
      database: BridgeDatabase;
      logger: Logger;
      ownerOpenId: string;
      formUrl: string;
      routingMode: "sessionParam" | "singleActive";
      appToken: string;
      tableId: string;
      pollIntervalMs: number;
      tokenTtlMinutes: number;
      attachmentDirectory: string;
      attachmentMaxBytes: number;
      maxFiles: number;
      fields: {
        session: string;
        text: string;
        attachments: string;
        status: string;
        error: string;
      };
      statuses: {
        pending: string;
        processing: string;
        accepted: string;
        failed: string;
      };
    },
  ) {}

  getDirectSubmissionUrl(): string | undefined {
    return this.options.routingMode === "singleActive" ? this.options.formUrl : undefined;
  }

  static createClient(credentials: { appId: string; appSecret: string }): BitableClient {
    return new lark.Client(credentials);
  }

  setSubmitHandler(handler: (message: InboundMessage) => Promise<void>): void {
    this.submit = handler;
  }

  createSubmissionUrl(context: ComposerContext): string {
    this.options.database.pruneComposerSessions();
    if (this.options.routingMode === "singleActive") {
      this.options.database.invalidateComposerSessions(context.senderOpenId);
    }
    const token = randomUUID();
    this.options.database.createComposerSession({
      token,
      ...context,
      expiresAt: new Date(Date.now() + this.options.tokenTtlMinutes * 60_000).toISOString(),
    });
    if (this.options.routingMode === "singleActive") return this.options.formUrl;
    const url = new URL(this.options.formUrl);
    url.searchParams.set("clawbridge_session", token);
    return url.toString();
  }

  async start(): Promise<void> {
    if (this.timer) return;
    await this.pollNow();
    this.timer = setInterval(() => {
      void this.pollNow().catch((error: unknown) => {
        this.options.logger.warn({ err: error }, "Cloud composer poll failed");
      });
    }, this.options.pollIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.polling;
  }

  pollNow(): Promise<void> {
    if (this.polling) return this.polling;
    const polling = this.pollOnce().finally(() => {
      if (this.polling === polling) this.polling = undefined;
    });
    this.polling = polling;
    return polling;
  }

  private async pollOnce(): Promise<void> {
    if (!this.submit) return;
    this.options.database.pruneComposerSessions();
    let pageToken: string | undefined;
    do {
      const response = await this.options.client.bitable.appTableRecord.list({
        path: { app_token: this.options.appToken, table_id: this.options.tableId },
        params: {
          page_size: 100,
          ...(pageToken ? { page_token: pageToken } : {}),
          field_names: JSON.stringify(Object.values(this.options.fields)),
          automatic_fields: true,
        },
      });
      if (response.code !== 0) {
        throw new Error(`读取飞书组合提交表失败：${response.msg ?? response.code}`);
      }
      for (const record of response.data?.items ?? []) {
        if (!record.record_id) continue;
        const status = fieldText(record.fields[this.options.fields.status]);
        if (
          status !== this.options.statuses.pending &&
          !(this.options.routingMode === "singleActive" && !status)
        ) {
          continue;
        }
        await this.processRecord(record.record_id, record.fields, record.created_time);
      }
      pageToken = response.data?.has_more ? response.data.page_token : undefined;
    } while (pageToken);
  }

  private async processRecord(
    recordId: string,
    fields: Record<string, unknown>,
    createdTime?: number,
  ): Promise<void> {
    const explicitToken = fieldText(fields[this.options.fields.session]);
    const session = explicitToken
      ? this.options.database.getComposerSession(explicitToken)
      : this.options.routingMode === "singleActive"
        ? this.options.database.getLatestActiveComposerSession(this.options.ownerOpenId)
        : undefined;
    if (!explicitToken && !session) return;
    if (!session || session.consumedAt || new Date(session.expiresAt).getTime() <= Date.now()) {
      await this.updateRecord(recordId, this.options.statuses.failed, "组合发送链接无效或已过期");
      return;
    }
    if (
      !explicitToken &&
      createdTime !== undefined &&
      createdTime + 2_000 < new Date(session.createdAt).getTime()
    ) {
      return;
    }
    const token = session.token;
    await this.updateRecord(recordId, this.options.statuses.processing, "");
    const directory = path.resolve(this.options.attachmentDirectory, "composer", recordId);
    try {
      const cloudAttachments = fieldAttachments(fields[this.options.fields.attachments]);
      if (cloudAttachments.length > this.options.maxFiles) {
        throw new Error(`附件数量超过 ${this.options.maxFiles} 个`);
      }
      await mkdir(directory, { recursive: true });
      const attachments: NonNullable<InboundMessage["attachments"]> = [];
      for (const [index, attachment] of cloudAttachments.entries()) {
        if (!attachment.file_token) throw new Error("附件缺少 file_token");
        if ((attachment.size ?? 0) > this.options.attachmentMaxBytes) {
          throw new Error(`附件 ${attachment.name ?? index + 1} 超过单文件大小限制`);
        }
        const originalName = (attachment.name || `附件-${index + 1}`).slice(0, 255);
        const extension = path.extname(originalName).slice(0, 16);
        const localPath = path.join(directory, `${index + 1}-${randomUUID()}${extension}`);
        const download = await this.options.client.drive.media.download({
          path: { file_token: attachment.file_token },
        });
        await download.writeFile(localPath);
        const downloaded = await stat(localPath);
        if (downloaded.size > this.options.attachmentMaxBytes) {
          throw new Error(`附件 ${originalName} 超过单文件大小限制`);
        }
        const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]);
        attachments.push({
          key: attachment.file_token,
          name: originalName,
          type:
            attachment.type?.startsWith("image/") || imageExtensions.has(extension.toLowerCase())
              ? "image"
              : "file",
          source: "local",
          localPath,
        });
      }
      const text = fieldText(fields[this.options.fields.text]);
      if (!text && attachments.length === 0) throw new Error("提交内容为空");
      await this.submit!({
        eventId: `bitable:${recordId}`,
        messageId: `bitable:${recordId}`,
        chatId: session.chatId,
        chatType: session.chatType,
        ...(session.topicRootId ? { topicRootId: session.topicRootId } : {}),
        senderOpenId: session.senderOpenId,
        text: text || "请阅读并处理这些附件。",
        ...(attachments.length ? { attachments } : {}),
        receivedAt: new Date().toISOString(),
      });
      if (!this.options.database.consumeComposerSession(token)) {
        throw new Error("组合发送链接已被使用或已过期");
      }
      await this.updateRecord(recordId, this.options.statuses.accepted, "");
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      const detail = error instanceof Error ? error.message : String(error);
      await this.updateRecord(recordId, this.options.statuses.failed, detail.slice(0, 500));
      this.options.logger.warn({ err: error, recordId }, "Cloud composer record failed");
    }
  }

  private async updateRecord(recordId: string, status: string, error: string): Promise<void> {
    const response = await this.options.client.bitable.appTableRecord.update({
      path: {
        app_token: this.options.appToken,
        table_id: this.options.tableId,
        record_id: recordId,
      },
      data: {
        fields: {
          [this.options.fields.status]: status,
          [this.options.fields.error]: error,
        },
      },
    });
    if (response.code !== 0) {
      throw new Error(`更新飞书组合提交状态失败：${response.msg ?? response.code}`);
    }
  }
}

function fieldText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && "text" in item) {
        return typeof item.text === "string" ? item.text : "";
      }
      return "";
    })
    .join("")
    .trim();
}

function fieldAttachments(value: unknown): BitableAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is BitableAttachment =>
    Boolean(item && typeof item === "object"),
  );
}
