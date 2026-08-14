import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDatabase } from "../../src/persistence/database.js";
import type { InboundMessage } from "../../src/core/types.js";

let database: BridgeDatabase;
const message: InboundMessage = {
  eventId: "event-1",
  messageId: "message-1",
  chatId: "chat-1",
  chatType: "p2p",
  senderOpenId: "owner",
  text: "hello",
  receivedAt: new Date(0).toISOString(),
};

beforeEach(() => {
  database = new BridgeDatabase(":memory:");
  database.syncProjects([{ id: "demo", name: "Demo", rootPath: "D:/demo", enabled: true }]);
});
afterEach(() => database.close());

describe("task persistence", () => {
  it("deduplicates every authorized inbound event before command routing", () => {
    expect(database.recordInboundEvent(message)).toBe(true);
    expect(database.recordInboundEvent(message)).toBe(false);
  });

  it("deduplicates inbound events", () => {
    expect(database.enqueue(message, "demo")).not.toBeNull();
    expect(database.enqueue(message, "demo")).toBeNull();
  });

  it("transitions stale running tasks to interrupted", () => {
    const task = database.enqueue(message, "demo");
    expect(task).not.toBeNull();
    database.updateTask(task!.id, "running");
    expect(database.interruptRunningTasks()).toBe(1);
    expect(database.getTask(task!.id)?.state).toBe("interrupted");
  });

  it("reports no open work when there are no tasks", () => {
    expect(database.hasAnyOpenTask()).toBe(false);
  });

  it.each(["completed", "failed", "cancelled", "interrupted"] as const)(
    "does not treat a %s task as open work",
    (state) => {
      const task = database.enqueue(message, "demo");
      expect(task).not.toBeNull();
      database.updateTask(task!.id, state);

      expect(database.hasAnyOpenTask()).toBe(false);
    },
  );

  it.each(["queued", "running", "waiting_approval"] as const)(
    "treats a %s task as open work",
    (state) => {
      const task = database.enqueue(message, "demo");
      expect(task).not.toBeNull();
      database.updateTask(task!.id, state);

      expect(database.hasAnyOpenTask()).toBe(true);
    },
  );

  it("prevents two holders from leasing the same thread", () => {
    expect(database.acquireLease("thread-1", "task-a", 60_000)).toBe(true);
    expect(database.isThreadLeased("thread-1")).toBe(true);
    expect(database.acquireLease("thread-1", "task-b", 60_000)).toBe(false);
    database.releaseLease("thread-1", "task-a");
    expect(database.isThreadLeased("thread-1")).toBe(false);
  });

  it("pins the selected thread at enqueue time and reports open work", () => {
    const queued = database.enqueue(message, "demo", "thread-at-enqueue");
    expect(queued).toMatchObject({ threadId: "thread-at-enqueue", state: "queued" });
    expect(database.hasOpenTask("chat-1")).toBe(true);
    expect(database.hasOpenTaskForProject("demo")).toBe(true);
    expect(database.hasOpenTaskForThread("thread-at-enqueue")).toBe(true);

    database.updateTask(queued!.id, "completed");
    expect(database.hasOpenTask("chat-1")).toBe(false);
    expect(database.hasOpenTaskForProject("demo")).toBe(false);
    expect(database.hasOpenTaskForThread("thread-at-enqueue")).toBe(false);
  });

  it("persists the source message and attachment metadata with the queued task", () => {
    const queued = database.enqueue(
      {
        ...message,
        eventId: "attachment-event",
        messageId: "attachment-message",
        attachments: [
          { key: "img-key", name: "photo.jpg", type: "image" },
          { key: "file-key", name: "notes.md", type: "file" },
        ],
      },
      "demo",
      "thread-with-attachments",
    );

    expect(queued).toMatchObject({
      messageId: "attachment-message",
      threadId: "thread-with-attachments",
      attachments: [
        { key: "img-key", name: "photo.jpg", type: "image" },
        { key: "file-key", name: "notes.md", type: "file" },
      ],
    });
    expect(database.getTask(queued!.id)).toMatchObject({
      messageId: "attachment-message",
      attachments: [
        { key: "img-key", name: "photo.jpg", type: "image" },
        { key: "file-key", name: "notes.md", type: "file" },
      ],
    });
  });

  it("claims, retries, and completes persisted deliveries", () => {
    const queued = database.queueDelivery({ chatId: "chat-1", body: "hello" });
    const firstAttempt = database.claimNextDelivery();
    expect(firstAttempt).toMatchObject({ id: queued.id, state: "sending", attempts: 1 });
    expect(firstAttempt?.message).toEqual({ chatId: "chat-1", kind: "text", text: "hello" });

    const retryAt = new Date(Date.now() + 1_000);
    expect(database.markDeliveryFailed(queued.id, "temporary", retryAt, 3)).toBe("retry");
    expect(database.claimNextDelivery(new Date(retryAt.getTime() - 1))).toBeUndefined();

    const secondAttempt = database.claimNextDelivery(new Date(retryAt.getTime() + 1));
    expect(secondAttempt).toMatchObject({ id: queued.id, state: "sending", attempts: 2 });
    database.markDeliverySent(queued.id, "feishu-message-1");
    expect(database.getDelivery(queued.id)).toMatchObject({
      state: "sent",
      attempts: 2,
      channelMessageId: "feishu-message-1",
    });
  });

  it("persists interactive cards as typed outbound messages", () => {
    const card = {
      schema: "2.0",
      body: { elements: [{ tag: "markdown", content: "Choose a project" }] },
    };
    const queued = database.queueOutbound(
      { chatId: "chat-1", kind: "card", audience: "p2p", text: "Choose a project", card },
      { taskId: null, sequence: 2 },
    );

    expect(queued).toMatchObject({
      chatId: "chat-1",
      kind: "card",
      audience: "p2p",
      payload: { text: "Choose a project", card },
      message: {
        chatId: "chat-1",
        kind: "card",
        audience: "p2p",
        text: "Choose a project",
        card,
      },
      body: "Choose a project",
      sequence: 2,
      state: "pending",
    });
    expect(database.claimNextDelivery()?.message).toEqual({
      chatId: "chat-1",
      kind: "card",
      audience: "p2p",
      text: "Choose a project",
      card,
    });
  });

  it("finds the latest sent project-group control card for in-place updates", () => {
    const card = { schema: "2.0", body: { elements: [] } };
    const first = database.queueOutbound({
      chatId: "chat-project",
      kind: "card",
      audience: "group",
      text: "Demo 项目控制台",
      card,
    });
    database.markDeliverySent(first.id, "message-project-card-1");
    const unrelated = database.queueOutbound({
      chatId: "chat-project",
      kind: "card",
      audience: "group",
      text: "Codex 等待你的回答",
      card,
    });
    database.markDeliverySent(unrelated.id, "message-question-card");
    const latest = database.queueOutbound({
      chatId: "chat-project",
      kind: "card",
      audience: "group",
      text: "Demo 项目控制台",
      card,
    });
    database.markDeliverySent(latest.id, "message-project-card-2");

    expect(
      database.getLatestSentCardMessageId({
        chatId: "chat-project",
        body: "Demo 项目控制台",
        audience: "group",
      }),
    ).toBe("message-project-card-2");
    expect(
      database.getLatestSentCardMessageId({
        chatId: "chat-other",
        body: "Demo 项目控制台",
        audience: "group",
      }),
    ).toBeUndefined();
  });

  it("tracks an in-place card rewrite under its new control-card identity", () => {
    const projectList = { schema: "2.0", body: { elements: [{ tag: "markdown" }] } };
    const home = { schema: "2.0", body: { elements: [{ tag: "action" }] } };
    const olderHome = database.queueOutbound({
      chatId: "chat-control",
      kind: "card",
      audience: "p2p",
      text: "ClawBridge 控制台",
      card: home,
    });
    database.markDeliverySent(olderHome.id, "message-older-control-card");
    const delivery = database.queueOutbound({
      chatId: "chat-control",
      kind: "card",
      audience: "p2p",
      text: "选择项目",
      card: projectList,
    });
    database.markDeliverySent(delivery.id, "message-control-card");

    expect(
      database.getLatestSentCardMessageId({
        chatId: "chat-control",
        audience: "p2p",
      }),
    ).toBe("message-control-card");

    expect(
      database.recordSentCardUpdate({
        chatId: "chat-control",
        channelMessageId: "message-control-card",
        body: "ClawBridge 控制台",
        card: home,
      }),
    ).toBe(true);

    expect(database.getDelivery(delivery.id)?.message).toEqual({
      chatId: "chat-control",
      kind: "card",
      audience: "p2p",
      text: "ClawBridge 控制台",
      card: home,
    });
    expect(
      database.getLatestSentCardMessageId({
        chatId: "chat-control",
        body: "ClawBridge 控制台",
        audience: "p2p",
      }),
    ).toBe("message-control-card");
    expect(
      database.getLatestSentCardMessageId({
        chatId: "chat-control",
        audience: "p2p",
      }),
    ).toBe("message-control-card");
  });

  it("persists a topic reply target in text deliveries", () => {
    const queued = database.queueOutbound({
      chatId: "chat-project",
      kind: "text",
      text: "任务完成",
      replyToMessageId: "topic-root-1",
    });

    expect(queued).toMatchObject({
      kind: "text",
      payload: { text: "任务完成", replyToMessageId: "topic-root-1" },
      message: {
        chatId: "chat-project",
        kind: "text",
        text: "任务完成",
        replyToMessageId: "topic-root-1",
      },
    });
  });

  it("stores incremental task progress and lists tasks by project", () => {
    database.syncProjects([
      { id: "demo", name: "Demo", rootPath: "D:/demo", enabled: true },
      { id: "other", name: "Other", rootPath: "D:/other", enabled: true },
    ]);
    const task = database.enqueue(
      {
        eventId: "progress-event",
        messageId: "progress-message",
        chatId: "chat-1",
        chatType: "p2p",
        senderOpenId: "owner",
        text: "执行任务",
        receivedAt: new Date().toISOString(),
      },
      "demo",
    );
    expect(task).not.toBeNull();
    database.updateTaskProgress(task!.id, "正在分析代码", "分析中");

    expect(database.getTask(task!.id)).toMatchObject({
      progressText: "正在分析代码",
      progressSummary: "分析中",
    });
    expect(database.listTasks({ projectId: "demo" }).map((item) => item.id)).toEqual([task!.id]);
    expect(database.listTasks({ projectId: "other" })).toEqual([]);
  });

  it("proves card callbacks came from a sent Bridge card in the same chat", () => {
    const card = { schema: "2.0", body: { elements: [] } };
    const sentCard = database.queueOutbound({
      chatId: "chat-1",
      kind: "card",
      audience: "p2p",
      text: "Control panel",
      card,
    });
    database.markDeliverySent(sentCard.id, "message-card-sent");

    const sentText = database.queueDelivery({ chatId: "chat-1", body: "plain text" });
    database.markDeliverySent(sentText.id, "message-text-sent");

    const noLongerSentCard = database.queueOutbound({
      chatId: "chat-1",
      kind: "card",
      audience: "p2p",
      text: "Stale control panel",
      card,
    });
    expect(database.claimNextDelivery()?.id).toBe(noLongerSentCard.id);
    database.markDeliverySent(noLongerSentCard.id, "message-card-retry");
    database.markDeliveryFailed(
      noLongerSentCard.id,
      "delivery state changed",
      new Date(Date.now() + 1_000),
      3,
    );

    expect(database.isSentCardMessage("chat-1", "message-card-sent")).toBe(true);
    expect(database.isSentCardMessage("chat-1", "message-card-sent", "p2p")).toBe(true);
    expect(database.isSentCardMessage("chat-1", "message-card-sent", "group")).toBe(false);
    expect(database.isSentCardMessage("chat-other", "message-card-sent")).toBe(false);
    expect(database.isSentCardMessage("chat-1", "message-text-sent")).toBe(false);
    expect(database.isSentCardMessage("chat-1", "message-card-retry")).toBe(false);
    expect(database.isSentCardMessage("chat-1", "message-missing")).toBe(false);
  });

  it("recovers a delivery claimed before a process restart", () => {
    const queued = database.queueDelivery({ chatId: "chat-1", body: "hello" });
    expect(database.claimNextDelivery()?.id).toBe(queued.id);
    expect(database.recoverSendingDeliveries()).toBe(1);
    expect(database.claimNextDelivery()?.id).toBe(queued.id);
  });

  it("migrates legacy body-only text deliveries to typed outbound messages", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "clawbridge-outbox-"));
    const databasePath = path.join(directory, "bridge.db");
    let migrated: BridgeDatabase | undefined;
    try {
      const legacy = new Database(databasePath);
      legacy.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
        INSERT INTO schema_migrations(version, applied_at)
        VALUES
          (1, '2026-08-11T00:00:00.000Z'),
          (2, '2026-08-11T00:00:00.000Z'),
          (3, '2026-08-11T00:00:00.000Z');

        CREATE TABLE deliveries (
          delivery_id TEXT PRIMARY KEY,
          task_id TEXT,
          chat_id TEXT,
          body TEXT,
          sequence INTEGER NOT NULL DEFAULT 0,
          channel_message_id TEXT,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT,
          last_error TEXT,
          updated_at TEXT NOT NULL
        );
        INSERT INTO deliveries(
          delivery_id, chat_id, body, status, next_attempt_at, updated_at
        ) VALUES(
          'legacy-text', 'chat-legacy', 'legacy body', 'pending',
          '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z'
        );
      `);
      legacy.close();

      migrated = new BridgeDatabase(databasePath);
      expect(migrated.getDelivery("legacy-text")).toMatchObject({
        kind: "text",
        body: "legacy body",
        payload: { text: "legacy body" },
        message: { chatId: "chat-legacy", kind: "text", text: "legacy body" },
        state: "pending",
      });
    } finally {
      migrated?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("project and thread persistence", () => {
  it("binds each project to one Feishu workspace and each thread to one topic", () => {
    const database = new BridgeDatabase(":memory:");
    try {
      database.syncProjects([
        { id: "demo", name: "Demo", rootPath: "D:/demo", enabled: true },
        { id: "other", name: "Other", rootPath: "D:/other", enabled: true },
      ]);
      database.upsertThread({ threadId: "thread-1", projectId: "demo" });
      database.upsertThread({ threadId: "thread-2", projectId: "demo" });

      expect(
        database.bindFeishuProjectSpace({
          projectId: "demo",
          chatId: "oc_demo",
          ownerOpenId: "ou_owner",
          displayName: "[Codex] Demo",
        }),
      ).toMatchObject({ projectId: "demo", chatId: "oc_demo", ownerOpenId: "ou_owner" });
      expect(database.getFeishuProjectSpaceByChat("oc_demo")?.projectId).toBe("demo");

      const route = database.bindFeishuThreadRoute({
        projectId: "demo",
        threadId: "thread-1",
        chatId: "oc_demo",
        topicRootId: "omt_topic_1",
        ownerOpenId: "ou_owner",
      });
      expect(route).toMatchObject({ threadId: "thread-1", topicRootId: "omt_topic_1" });
      expect(database.resolveFeishuThreadRoute("oc_demo", "omt_topic_1")?.threadId).toBe(
        "thread-1",
      );
      expect(database.listFeishuThreadRoutes("demo")).toHaveLength(1);

      expect(() =>
        database.bindFeishuProjectSpace({
          projectId: "other",
          chatId: "oc_demo",
          ownerOpenId: "ou_owner",
          displayName: "[Codex] Other",
        }),
      ).toThrow(/already bound/);
      expect(() =>
        database.bindFeishuThreadRoute({
          projectId: "demo",
          threadId: "thread-2",
          chatId: "oc_demo",
          topicRootId: "omt_topic_1",
          ownerOpenId: "ou_owner",
        }),
      ).toThrow(/already bound/);
    } finally {
      database.close();
    }
  });

  it("promotes a pending Feishu topic after its first Codex turn starts", () => {
    const database = new BridgeDatabase(":memory:");
    try {
      database.syncProjects([{ id: "demo", name: "Demo", rootPath: "D:/demo", enabled: true }]);
      database.bindFeishuProjectSpace({
        projectId: "demo",
        chatId: "oc_demo",
        ownerOpenId: "ou_owner",
        displayName: "[Codex] Demo",
      });
      expect(
        database.bindFeishuPendingTopic({
          projectId: "demo",
          chatId: "oc_demo",
          topicRootId: "omt_new",
          ownerOpenId: "ou_owner",
        }),
      ).toMatchObject({ projectId: "demo", topicRootId: "omt_new" });

      database.upsertThread({ threadId: "thread-first", projectId: "demo" });
      const route = database.promoteFeishuPendingTopic({
        projectId: "demo",
        chatId: "oc_demo",
        topicRootId: "omt_new",
        threadId: "thread-first",
      });

      expect(route).toMatchObject({ threadId: "thread-first", topicRootId: "omt_new" });
      expect(database.resolveFeishuPendingTopic("oc_demo", "omt_new")).toBeUndefined();
      expect(database.resolveFeishuThreadRoute("oc_demo", "omt_new")?.threadId).toBe(
        "thread-first",
      );
    } finally {
      database.close();
    }
  });

  it("uses configured projects only as bootstrap data", () => {
    database.setProjectEnabled("demo", false);
    database.syncProjects([{ id: "demo", name: "Changed", rootPath: "D:/changed", enabled: true }]);

    expect(database.getProject("demo")).toEqual({
      id: "demo",
      name: "Demo",
      rootPath: "D:/demo",
      enabled: false,
    });
  });

  it("bootstraps projects and rejects duplicate ids or root paths", () => {
    database.createProject({
      id: "disabled",
      name: "Disabled",
      rootPath: "D:/disabled",
      enabled: false,
    });

    expect(database.listProjects().map((project) => project.id)).toEqual(["demo"]);
    expect(database.listProjects({ includeDisabled: true })).toHaveLength(2);
    expect(database.getProject("disabled")).toMatchObject({ enabled: false });
    expect(() =>
      database.createProject({ id: "demo", name: "Duplicate", rootPath: "D:/other" }),
    ).toThrow(/Project id "demo" already exists/);
    expect(() =>
      database.createProject({ id: "other", name: "Duplicate path", rootPath: "d:\\DEMO" }),
    ).toThrow(/already registered/);

    expect(database.setProjectEnabled("disabled", true)).toMatchObject({ enabled: true });
    expect(database.listProjects().map((project) => project.id)).toEqual(["demo", "disabled"]);
  });

  it("synchronizes desktop projects in input order and reuses static paths", () => {
    database.setProjectEnabled("demo", false);
    const synchronized = database.syncDesktopProjects([
      { sourceId: "codex-demo", name: "Desktop Demo", rootPath: "d:\\DEMO" },
      { sourceId: "codex-other", name: "Desktop Other", rootPath: "D:/other" },
    ]);

    expect(synchronized).toEqual([
      { id: "demo", name: "Desktop Demo", rootPath: "D:/demo", enabled: true },
      {
        id: "desktop@codex-other",
        name: "Desktop Other",
        rootPath: "D:/other",
        enabled: true,
      },
    ]);
    expect(database.getProject("demo")?.name).toBe("Desktop Demo");
  });

  it("updates generated desktop records and disables records no longer present", () => {
    database.syncDesktopProjects([
      { sourceId: "first", name: "First", rootPath: "D:/first" },
      { sourceId: "second", name: "Second", rootPath: "D:/second" },
    ]);
    database.setProjectEnabled("desktop@first", false);

    expect(
      database.syncDesktopProjects([
        { sourceId: "first", name: "First renamed", rootPath: "D:/first-moved" },
      ]),
    ).toEqual([
      {
        id: "desktop@first",
        name: "First renamed",
        rootPath: "D:/first-moved",
        enabled: true,
      },
    ]);
    expect(database.getProject("desktop@second")?.enabled).toBe(false);
    expect(database.listProjects().map((project) => project.id)).toEqual(["demo", "desktop@first"]);
  });

  it("reuses a stale desktop record when Desktop assigns a new source id to the same root", () => {
    database.syncDesktopProjects([
      { sourceId: "old-source", name: "Before", rootPath: "D:/same-root" },
    ]);
    database.syncDesktopProjects([]);

    const synchronized = database.syncDesktopProjects([
      { sourceId: "new-source", name: "After", rootPath: "d:\\SAME-ROOT" },
    ]);

    expect(synchronized).toEqual([
      {
        id: "desktop@old-source",
        name: "After",
        rootPath: "d:\\SAME-ROOT",
        enabled: true,
      },
    ]);
    expect(database.getProject("desktop@new-source")).toBeUndefined();
  });

  it("rejects a Desktop source identity change while that project has an open task", () => {
    database.syncDesktopProjects([
      { sourceId: "old-source", name: "Before", rootPath: "D:/same-root" },
    ]);
    database.selectProject("chat", "desktop@old-source");
    const task = database.enqueue(
      {
        eventId: "desktop-source-change",
        messageId: "desktop-source-change",
        chatId: "chat",
        senderOpenId: "owner",
        chatType: "p2p",
        text: "queued task",
        receivedAt: new Date().toISOString(),
      },
      "desktop@old-source",
    );
    expect(task).not.toBeNull();

    expect(() =>
      database.syncDesktopProjects([
        { sourceId: "new-source", name: "After", rootPath: "d:\\SAME-ROOT" },
      ]),
    ).toThrow(/cannot change source identity while a task is open/);
    expect(database.getProject("desktop@old-source")).toMatchObject({
      name: "Before",
      enabled: true,
    });
  });

  it("keeps stable local project numbers across reordered listings", () => {
    database.syncDesktopProjects([
      { sourceId: "first", name: "First", rootPath: "D:/first" },
      { sourceId: "second", name: "Second", rootPath: "D:/second" },
    ]);

    expect(database.getOrAssignProjectNumber("desktop@first")).toBe(1);
    expect(database.getOrAssignProjectNumber("desktop@second")).toBe(2);
    expect(database.getProjectByLocalNumber(1)?.id).toBe("desktop@first");

    database.syncDesktopProjects([
      { sourceId: "second", name: "Second", rootPath: "D:/second" },
      { sourceId: "first", name: "First", rootPath: "D:/first" },
    ]);
    expect(database.getOrAssignProjectNumber("desktop@first")).toBe(1);
    expect(database.getOrAssignProjectNumber("desktop@second")).toBe(2);
  });

  it("rejects duplicate desktop inputs without applying partial changes", () => {
    expect(() =>
      database.syncDesktopProjects([
        { sourceId: "duplicate", name: "First", rootPath: "D:/first" },
        { sourceId: "duplicate", name: "Second", rootPath: "D:/second" },
      ]),
    ).toThrow(/Duplicate desktop project source id/);
    expect(() =>
      database.syncDesktopProjects([
        { sourceId: "first", name: "First", rootPath: "D:/same" },
        { sourceId: "second", name: "Second", rootPath: "d:\\SAME" },
      ]),
    ).toThrow(/Duplicate desktop project root path/);

    expect(database.listProjects({ includeDisabled: true })).toEqual([
      { id: "demo", name: "Demo", rootPath: "D:/demo", enabled: true },
    ]);
  });

  it("rolls back desktop updates when a generated id moves onto another project path", () => {
    database.syncDesktopProjects([{ sourceId: "moving", name: "Before", rootPath: "D:/before" }]);
    database.createProject({ id: "occupied", name: "Occupied", rootPath: "D:/occupied" });

    expect(() =>
      database.syncDesktopProjects([
        { sourceId: "fresh", name: "Fresh", rootPath: "D:/fresh" },
        { sourceId: "moving", name: "After", rootPath: "D:/occupied" },
      ]),
    ).toThrow(/already registered by "occupied"/);

    expect(database.getProject("desktop@fresh")).toBeUndefined();
    expect(database.getProject("desktop@moving")).toEqual({
      id: "desktop@moving",
      name: "Before",
      rootPath: "D:/before",
      enabled: true,
    });
  });

  it("restores each project's selected thread when switching projects", () => {
    database.createProject({ id: "other", name: "Other", rootPath: "D:/other" });

    expect(database.selectProject("chat-1", "demo")).toEqual({
      projectId: "demo",
      threadId: null,
    });
    database.setThread("chat-1", "demo", "thread-demo");
    expect(database.selectProject("chat-1", "other")).toEqual({
      projectId: "other",
      threadId: null,
    });
    database.setThread("chat-1", "other", "thread-other");

    expect(database.selectProject("chat-1", "demo")).toEqual({
      projectId: "demo",
      threadId: "thread-demo",
    });
    expect(database.getConversation("chat-1")).toEqual({
      projectId: "demo",
      threadId: "thread-demo",
    });

    database.bindProject("chat-1", "demo");
    expect(database.getProjectState("chat-1", "demo")?.threadId).toBeNull();
    expect(database.selectProject("chat-1", "other").threadId).toBe("thread-other");
  });

  it("assigns stable local thread numbers and filters archived threads", () => {
    const first = database.upsertThread({
      threadId: "thread-1",
      projectId: "demo",
      title: "First",
      status: "idle",
    });
    const second = database.upsertThread({
      threadId: "thread-2",
      projectId: "demo",
      title: "Second",
    });

    expect(first.localNumber).toBe(1);
    expect(second.localNumber).toBe(2);
    expect(
      database.upsertThread({
        threadId: "thread-1",
        projectId: "demo",
        title: "Renamed",
        preview: "latest preview",
      }),
    ).toMatchObject({ localNumber: 1, title: "Renamed", preview: "latest preview" });
    expect(database.getProjectThreadByNumber("demo", 1)?.threadId).toBe("thread-1");

    database.upsertThread({ threadId: "thread-1", projectId: "demo", archived: true });
    expect(database.listProjectThreads("demo").map((thread) => thread.threadId)).toEqual([
      "thread-2",
    ]);
    expect(database.listProjectThreads("demo", { includeArchived: true })).toHaveLength(2);
  });

  it("persists per-thread model settings and snapshots them into queued tasks", () => {
    database.upsertThread({ threadId: "thread-model", projectId: "demo", title: "Model test" });
    expect(database.setThreadExecutionSettings("thread-model", "gpt-test", "medium")).toMatchObject(
      { model: "gpt-test", reasoningEffort: "medium" },
    );
    expect(database.getThreadExecutionSettings("thread-model")).toMatchObject({
      model: "gpt-test",
      reasoningEffort: "medium",
    });
    const task = database.enqueue(
      {
        eventId: "model-event",
        messageId: "model-message",
        chatId: "chat-model",
        chatType: "p2p",
        senderOpenId: "owner",
        text: "run with selected model",
        receivedAt: new Date().toISOString(),
      },
      "demo",
      "thread-model",
      { model: "gpt-test", reasoningEffort: "medium" },
    );
    expect(task).toMatchObject({ model: "gpt-test", reasoningEffort: "medium" });
  });
});
