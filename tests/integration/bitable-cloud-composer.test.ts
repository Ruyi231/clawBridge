import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { BitableCloudComposer } from "../../src/composer/bitable-cloud-composer.js";
import type { InboundMessage } from "../../src/core/types.js";
import { BridgeDatabase } from "../../src/persistence/database.js";

describe("BitableCloudComposer", () => {
  let database: BridgeDatabase | undefined;
  let directory: string | undefined;

  afterEach(() => {
    database?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("polls one cloud record and combines its text and attachments", async () => {
    database = new BridgeDatabase(":memory:");
    directory = mkdtempSync(path.join(tmpdir(), "clawbridge-cloud-composer-"));
    const list = vi.fn();
    const update = vi.fn(async () => ({ code: 0 }));
    const download = vi.fn(async () => ({
      writeFile: async (target: string) => writeFile(target, "attachment"),
    }));
    const composer = new BitableCloudComposer({
      client: {
        bitable: { appTableRecord: { list, update } },
        drive: { media: { download } },
      } as never,
      database,
      logger: pino({ level: "silent" }),
      ownerOpenId: "owner",
      routingMode: "sessionParam",
      formUrl: "https://example.feishu.cn/base/form",
      appToken: "base-token",
      tableId: "table-id",
      pollIntervalMs: 5_000,
      tokenTtlMinutes: 30,
      attachmentDirectory: directory,
      attachmentMaxBytes: 1024 * 1024,
      maxFiles: 5,
      fields: {
        session: "ClawBridge会话",
        text: "消息内容",
        attachments: "附件",
        status: "处理状态",
        error: "错误信息",
      },
      statuses: { pending: "待处理", processing: "处理中", accepted: "已接收", failed: "失败" },
    });
    const url = composer.createSubmissionUrl({
      chatId: "chat-project",
      chatType: "group",
      senderOpenId: "owner",
      topicRootId: "topic-1",
    });
    const token = new URL(url).searchParams.get("clawbridge_session");
    list.mockResolvedValue({
      code: 0,
      data: {
        items: [
          {
            record_id: "record-1",
            fields: {
              ClawBridge会话: token,
              消息内容: "一起分析这些材料",
              附件: [
                { file_token: "image-token", name: "photo.png", type: "image/png", size: 5 },
                { file_token: "file-token", name: "notes.md", type: "text/markdown", size: 5 },
              ],
              处理状态: "待处理",
            },
          },
        ],
      },
    });
    let received: InboundMessage | undefined;
    composer.setSubmitHandler(async (message) => {
      received = message;
    });

    await composer.pollNow();

    expect(received).toMatchObject({
      eventId: "bitable:record-1",
      chatId: "chat-project",
      topicRootId: "topic-1",
      text: "一起分析这些材料",
      attachments: [
        { key: "image-token", name: "photo.png", type: "image", source: "local" },
        { key: "file-token", name: "notes.md", type: "file", source: "local" },
      ],
    });
    expect(
      received?.attachments?.every((item) => item.localPath && existsSync(item.localPath)),
    ).toBe(true);
    expect(download).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ data: { fields: { 处理状态: "处理中", 错误信息: "" } } }),
    );
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { fields: { 处理状态: "已接收", 错误信息: "" } } }),
    );
    expect(database.getComposerSession(token!)?.consumedAt).toBeTruthy();
  });

  it("marks a record failed when its routing token is unknown", async () => {
    database = new BridgeDatabase(":memory:");
    directory = mkdtempSync(path.join(tmpdir(), "clawbridge-cloud-composer-"));
    const update = vi.fn(async () => ({ code: 0 }));
    const composer = new BitableCloudComposer({
      client: {
        bitable: {
          appTableRecord: {
            list: vi.fn(async () => ({
              code: 0,
              data: {
                items: [
                  {
                    record_id: "record-invalid",
                    fields: { ClawBridge会话: "unknown", 处理状态: "待处理" },
                  },
                ],
              },
            })),
            update,
          },
        },
        drive: { media: { download: vi.fn() } },
      } as never,
      database,
      logger: pino({ level: "silent" }),
      ownerOpenId: "owner",
      routingMode: "sessionParam",
      formUrl: "https://example.feishu.cn/base/form",
      appToken: "base-token",
      tableId: "table-id",
      pollIntervalMs: 5_000,
      tokenTtlMinutes: 30,
      attachmentDirectory: directory,
      attachmentMaxBytes: 1024 * 1024,
      maxFiles: 5,
      fields: {
        session: "ClawBridge会话",
        text: "消息内容",
        attachments: "附件",
        status: "处理状态",
        error: "错误信息",
      },
      statuses: { pending: "待处理", processing: "处理中", accepted: "已接收", failed: "失败" },
    });
    composer.setSubmitHandler(async () => undefined);

    await composer.pollNow();

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          fields: { 处理状态: "失败", 错误信息: "组合发送链接无效或已过期" },
        },
      }),
    );
  });

  it("routes a native form record to the most recently activated topic", async () => {
    database = new BridgeDatabase(":memory:");
    directory = mkdtempSync(path.join(tmpdir(), "clawbridge-cloud-composer-"));
    const update = vi.fn(async () => ({ code: 0 }));
    const submitted: InboundMessage[] = [];
    const composer = new BitableCloudComposer({
      client: {
        bitable: {
          appTableRecord: {
            list: vi.fn(async () => ({
              code: 0,
              data: {
                items: [
                  {
                    record_id: "record-native",
                    created_time: Date.now(),
                    fields: { 消息内容: "原生表单提交", 附件: [], 处理状态: "" },
                  },
                ],
              },
            })),
            update,
          },
        },
        drive: { media: { download: vi.fn() } },
      } as never,
      database,
      logger: pino({ level: "silent" }),
      ownerOpenId: "owner",
      routingMode: "singleActive",
      formUrl: "https://example.feishu.cn/share/base/native-form",
      appToken: "base-token",
      tableId: "table-id",
      pollIntervalMs: 5_000,
      tokenTtlMinutes: 30,
      attachmentDirectory: directory,
      attachmentMaxBytes: 1024 * 1024,
      maxFiles: 5,
      fields: {
        session: "ClawBridge会话",
        text: "消息内容",
        attachments: "附件",
        status: "处理状态",
        error: "错误信息",
      },
      statuses: { pending: "待处理", processing: "处理中", accepted: "已接收", failed: "失败" },
    });
    composer.setSubmitHandler(async (message) => {
      submitted.push(message);
    });

    expect(
      composer.createSubmissionUrl({
        chatId: "chat-project",
        chatType: "group",
        senderOpenId: "owner",
        topicRootId: "topic-old",
      }),
    ).toBe("https://example.feishu.cn/share/base/native-form");
    expect(
      composer.createSubmissionUrl({
        chatId: "chat-project",
        chatType: "group",
        senderOpenId: "owner",
        topicRootId: "topic-new",
      }),
    ).toBe("https://example.feishu.cn/share/base/native-form");

    await composer.pollNow();

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      eventId: "bitable:record-native",
      chatId: "chat-project",
      topicRootId: "topic-new",
      text: "原生表单提交",
    });
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { fields: { 处理状态: "已接收", 错误信息: "" } } }),
    );
  });
});
