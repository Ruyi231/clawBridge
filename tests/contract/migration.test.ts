import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BridgeDatabase } from "../../src/persistence/database.js";

describe("SQLite migration contract", () => {
  it("upgrades the Phase 0 deliveries table without deleting existing state", () => {
    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "clawbridge-migration-"));
    const databasePath = path.join(temporaryDirectory, "bridge.db");
    let bridgeDatabase: BridgeDatabase | undefined;
    try {
      const legacy = new Database(databasePath);
      legacy.exec(`
        CREATE TABLE deliveries (
          delivery_id TEXT PRIMARY KEY,
          task_id TEXT,
          channel_message_id TEXT,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          updated_at TEXT NOT NULL
        );
        INSERT INTO deliveries(delivery_id, status, updated_at)
        VALUES('legacy-delivery', 'pending', '2026-08-11T00:00:00.000Z');
      `);
      legacy.close();

      bridgeDatabase = new BridgeDatabase(databasePath);
      expect(bridgeDatabase.getDelivery("legacy-delivery")?.state).toBe("dead");
      const queued = bridgeDatabase.queueDelivery({ chatId: "chat-1", body: "new delivery" });
      expect(bridgeDatabase.getDelivery(queued.id)).toMatchObject({
        chatId: "chat-1",
        body: "new delivery",
        state: "pending",
      });
    } finally {
      bridgeDatabase?.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("migrates legacy conversations into per-project state and a stable thread index", () => {
    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "clawbridge-state-migration-"));
    const databasePath = path.join(temporaryDirectory, "bridge.db");
    let bridgeDatabase: BridgeDatabase | undefined;
    try {
      const legacy = new Database(databasePath);
      legacy.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
        INSERT INTO schema_migrations(version, applied_at)
        VALUES(1, '2026-08-11T00:00:00.000Z'), (2, '2026-08-11T00:00:00.000Z');

        CREATE TABLE projects (
          project_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          root_path TEXT NOT NULL,
          enabled INTEGER NOT NULL
        );
        INSERT INTO projects(project_id, name, root_path, enabled)
        VALUES('demo', 'Demo', 'D:/demo', 1);

        CREATE TABLE conversations (
          chat_id TEXT PRIMARY KEY,
          project_id TEXT,
          thread_id TEXT,
          updated_at TEXT NOT NULL
        );
        INSERT INTO conversations(chat_id, project_id, thread_id, updated_at)
        VALUES('chat-legacy', 'demo', 'thread-legacy', '2026-08-11T01:00:00.000Z');
      `);
      legacy.close();

      bridgeDatabase = new BridgeDatabase(databasePath);
      expect(bridgeDatabase.getConversation("chat-legacy")).toEqual({
        projectId: "demo",
        threadId: "thread-legacy",
      });
      expect(bridgeDatabase.getProjectState("chat-legacy", "demo")).toMatchObject({
        threadId: "thread-legacy",
        updatedAt: "2026-08-11T01:00:00.000Z",
      });
      expect(bridgeDatabase.getProjectThread("demo", "thread-legacy")).toMatchObject({
        localNumber: 1,
        archived: false,
        createdAt: "2026-08-11T01:00:00.000Z",
      });
      expect(
        bridgeDatabase.upsertThread({ threadId: "thread-new", projectId: "demo" }).localNumber,
      ).toBe(2);
      expect(bridgeDatabase.getOrAssignProjectNumber("demo")).toBe(1);

      bridgeDatabase.close();
      bridgeDatabase = undefined;
      const migrated = new Database(databasePath, { readonly: true });
      expect(
        migrated.prepare("SELECT version FROM schema_migrations WHERE version = 3").get(),
      ).toEqual({ version: 3 });
      expect(
        migrated
          .prepare("SELECT local_number FROM project_numbers WHERE project_id = 'demo'")
          .get(),
      ).toEqual({ local_number: 1 });
      migrated.close();

      bridgeDatabase = new BridgeDatabase(databasePath);
      expect(
        bridgeDatabase
          .listProjectThreads("demo")
          .map(({ threadId, localNumber }) => [threadId, localNumber]),
      ).toEqual([
        ["thread-new", 2],
        ["thread-legacy", 1],
      ]);
    } finally {
      bridgeDatabase?.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("keeps pre-v5 card audiences unknown and excludes them from p2p proof", () => {
    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "clawbridge-audience-migration-"));
    const databasePath = path.join(temporaryDirectory, "bridge.db");
    let bridgeDatabase: BridgeDatabase | undefined;
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
          (3, '2026-08-11T00:00:00.000Z'),
          (4, '2026-08-13T00:00:00.000Z');

        CREATE TABLE deliveries (
          delivery_id TEXT PRIMARY KEY,
          task_id TEXT,
          chat_id TEXT,
          body TEXT,
          kind TEXT,
          payload TEXT,
          sequence INTEGER NOT NULL DEFAULT 0,
          channel_message_id TEXT,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT,
          last_error TEXT,
          updated_at TEXT NOT NULL
        );
        INSERT INTO deliveries(
          delivery_id, chat_id, body, kind, payload, channel_message_id,
          status, next_attempt_at, updated_at
        ) VALUES
          (
            'legacy-card', 'chat-legacy', 'Legacy card', 'card',
            '{"text":"Legacy card","card":{"schema":"2.0"}}',
            'legacy-card-message', 'sent', '2026-08-13T00:00:00.000Z',
            '2026-08-13T00:00:00.000Z'
          ),
          (
            'legacy-pending-card', 'chat-legacy', 'Pending legacy card', 'card',
            '{"text":"Pending legacy card","card":{"schema":"2.0"}}',
            NULL, 'pending', '2026-08-13T00:00:00.000Z',
            '2026-08-13T00:00:00.000Z'
          );
      `);
      legacy.close();

      bridgeDatabase = new BridgeDatabase(databasePath);
      expect(bridgeDatabase.isSentCardMessage("chat-legacy", "legacy-card-message")).toBe(true);
      expect(bridgeDatabase.isSentCardMessage("chat-legacy", "legacy-card-message", "p2p")).toBe(
        false,
      );

      bridgeDatabase.close();
      bridgeDatabase = undefined;
      const migrated = new Database(databasePath, { readonly: true });
      expect(
        migrated
          .prepare(
            "SELECT delivery_id, audience, status FROM deliveries WHERE delivery_id LIKE 'legacy-%' ORDER BY delivery_id",
          )
          .all(),
      ).toEqual([
        { delivery_id: "legacy-card", audience: null, status: "sent" },
        { delivery_id: "legacy-pending-card", audience: null, status: "dead" },
      ]);
      expect(
        migrated.prepare("SELECT version FROM schema_migrations WHERE version = 5").get(),
      ).toEqual({
        version: 5,
      });
      migrated.close();
    } finally {
      bridgeDatabase?.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("adds the version 6 Feishu workspace routing tables without changing projects", () => {
    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "clawbridge-routing-migration-"));
    const databasePath = path.join(temporaryDirectory, "bridge.db");
    let bridgeDatabase: BridgeDatabase | undefined;
    try {
      const legacy = new Database(databasePath);
      legacy.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE projects (
          project_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          root_path TEXT NOT NULL,
          enabled INTEGER NOT NULL
        );
        INSERT INTO projects(project_id, name, root_path, enabled)
        VALUES('demo', 'Demo', 'D:/demo', 1);
      `);
      legacy.close();

      bridgeDatabase = new BridgeDatabase(databasePath);
      expect(
        bridgeDatabase.bindFeishuProjectSpace({
          projectId: "demo",
          chatId: "oc_demo",
          ownerOpenId: "ou_owner",
          displayName: "[Codex] Demo",
        }).chatId,
      ).toBe("oc_demo");
      bridgeDatabase.close();
      bridgeDatabase = undefined;

      const migrated = new Database(databasePath, { readonly: true });
      expect(
        migrated.prepare("SELECT version FROM schema_migrations WHERE version = 6").get(),
      ).toEqual({ version: 6 });
      expect(migrated.prepare("SELECT name FROM projects WHERE project_id = 'demo'").get()).toEqual(
        {
          name: "Demo",
        },
      );
      expect(
        migrated
          .prepare("SELECT chat_id FROM feishu_project_spaces WHERE project_id = 'demo'")
          .get(),
      ).toEqual({ chat_id: "oc_demo" });
      migrated.close();
    } finally {
      bridgeDatabase?.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("adds version 7 task topic reply routing without changing queued tasks", () => {
    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "clawbridge-task-route-migration-"));
    const databasePath = path.join(temporaryDirectory, "bridge.db");
    let bridgeDatabase: BridgeDatabase | undefined;
    try {
      const legacy = new Database(databasePath);
      legacy.exec(`
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        INSERT INTO schema_migrations(version, applied_at)
        VALUES(1, '2026-08-11T00:00:00.000Z'), (2, '2026-08-11T00:00:00.000Z'),
              (3, '2026-08-11T00:00:00.000Z'), (4, '2026-08-11T00:00:00.000Z'),
              (5, '2026-08-11T00:00:00.000Z'), (6, '2026-08-11T00:00:00.000Z');
        CREATE TABLE projects (
          project_id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL, enabled INTEGER NOT NULL
        );
        INSERT INTO projects VALUES('demo', 'Demo', 'D:/demo', 1);
        CREATE TABLE tasks (
          task_id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, message_id TEXT NOT NULL,
          chat_id TEXT NOT NULL, project_id TEXT NOT NULL, prompt TEXT NOT NULL, state TEXT NOT NULL,
          thread_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT
        );
        INSERT INTO tasks VALUES(
          'task-1', 'event-1', 'message-1', 'chat-1', 'demo', '继续任务', 'queued',
          NULL, '2026-08-13T00:00:00.000Z', '2026-08-13T00:00:00.000Z', NULL
        );
      `);
      legacy.close();

      bridgeDatabase = new BridgeDatabase(databasePath);
      expect(bridgeDatabase.nextQueued()).toMatchObject({
        id: "task-1",
        prompt: "继续任务",
        replyToMessageId: null,
      });
      bridgeDatabase.close();
      bridgeDatabase = undefined;

      const migrated = new Database(databasePath, { readonly: true });
      expect(
        migrated.prepare("SELECT version FROM schema_migrations WHERE version = 7").get(),
      ).toEqual({ version: 7 });
      expect(
        migrated.prepare("SELECT reply_to_message_id FROM tasks WHERE task_id = 'task-1'").get(),
      ).toEqual({ reply_to_message_id: null });
      migrated.close();
    } finally {
      bridgeDatabase?.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("adds version 8 task progress fields with safe empty defaults", () => {
    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "clawbridge-progress-migration-"));
    const databasePath = path.join(temporaryDirectory, "bridge.db");
    let bridgeDatabase: BridgeDatabase | undefined;
    try {
      const legacy = new Database(databasePath);
      legacy.exec(`
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        INSERT INTO schema_migrations(version, applied_at)
        VALUES(1,'x'),(2,'x'),(3,'x'),(4,'x'),(5,'x'),(6,'x'),(7,'x');
        CREATE TABLE projects (
          project_id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL, enabled INTEGER NOT NULL
        );
        INSERT INTO projects VALUES('demo','Demo','D:/demo',1);
        CREATE TABLE tasks (
          task_id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, message_id TEXT NOT NULL,
          chat_id TEXT NOT NULL, project_id TEXT NOT NULL, prompt TEXT NOT NULL, state TEXT NOT NULL,
          thread_id TEXT, reply_to_message_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT
        );
        INSERT INTO tasks VALUES('task-1','event-1','message-1','chat-1','demo','任务','queued',NULL,NULL,'x','x',NULL);
      `);
      legacy.close();

      bridgeDatabase = new BridgeDatabase(databasePath);
      expect(bridgeDatabase.getTask("task-1")).toMatchObject({
        progressText: "",
        progressSummary: null,
      });
      bridgeDatabase.close();
      bridgeDatabase = undefined;

      const migrated = new Database(databasePath, { readonly: true });
      expect(
        migrated.prepare("SELECT version FROM schema_migrations WHERE version=8").get(),
      ).toEqual({ version: 8 });
      migrated.close();
    } finally {
      bridgeDatabase?.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("migrates existing mobile projects to synchronized Desktop lifecycle state", () => {
    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "clawbridge-desktop-sync-"));
    const databasePath = path.join(temporaryDirectory, "bridge.db");
    let bridgeDatabase: BridgeDatabase | undefined;
    try {
      const legacy = new Database(databasePath);
      legacy.exec(`
        CREATE TABLE projects (
          project_id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL, enabled INTEGER NOT NULL
        );
        INSERT INTO projects VALUES
          ('mobile-oldproject', 'Mobile', 'D:/mobile', 1),
          ('desktop@local', 'Desktop', 'D:/desktop', 1);
      `);
      legacy.close();

      bridgeDatabase = new BridgeDatabase(databasePath);
      expect(bridgeDatabase.getDesktopProjectSync("mobile-oldproject")).toMatchObject({
        projectId: "mobile-oldproject",
        sourceId: null,
        state: "synced",
      });
      expect(bridgeDatabase.getDesktopProjectSync("desktop@local")).toBeUndefined();
      expect(bridgeDatabase.setDesktopProjectSync("mobile-oldproject", "removed")).toMatchObject({
        state: "removed",
      });

      bridgeDatabase.close();
      bridgeDatabase = undefined;
      const migrated = new Database(databasePath, { readonly: true });
      expect(
        migrated.prepare("SELECT version FROM schema_migrations WHERE version=12").get(),
      ).toEqual({ version: 12 });
      migrated.close();
    } finally {
      bridgeDatabase?.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
