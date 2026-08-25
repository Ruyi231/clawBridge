import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  DeliveryRecord,
  DeliveryState,
  InboundEvent,
  InboundMessage,
  OutboundMessage,
  TaskRecord,
  TaskState,
} from "../core/types.js";

const schema = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1))
);

CREATE TABLE IF NOT EXISTS desktop_project_sync (
  project_id TEXT PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
  source_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending', 'synced', 'removed')),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_numbers (
  project_id TEXT PRIMARY KEY REFERENCES projects(project_id),
  local_number INTEGER NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS conversations (
  chat_id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(project_id),
  thread_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_state (
  chat_id TEXT PRIMARY KEY,
  active_project_id TEXT REFERENCES projects(project_id),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_chat_state (
  chat_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  active_thread_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(chat_id, project_id)
);

CREATE TABLE IF NOT EXISTS thread_index (
  thread_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  local_number INTEGER NOT NULL,
  title TEXT,
  preview TEXT,
  status TEXT,
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_synced_at TEXT,
  UNIQUE(project_id, local_number)
);

CREATE INDEX IF NOT EXISTS idx_thread_index_project_updated
ON thread_index(project_id, archived, updated_at DESC);

CREATE TABLE IF NOT EXISTS feishu_project_spaces (
  project_id TEXT PRIMARY KEY REFERENCES projects(project_id),
  chat_id TEXT NOT NULL UNIQUE,
  owner_open_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feishu_thread_routes (
  thread_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  chat_id TEXT NOT NULL,
  topic_root_id TEXT NOT NULL,
  owner_open_id TEXT NOT NULL,
  toolbar_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(chat_id, topic_root_id),
  FOREIGN KEY(project_id) REFERENCES feishu_project_spaces(project_id)
);

CREATE INDEX IF NOT EXISTS idx_feishu_thread_routes_project
ON feishu_thread_routes(project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS feishu_pending_topics (
  topic_root_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  chat_id TEXT NOT NULL,
  owner_open_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(chat_id, topic_root_id),
  FOREIGN KEY(project_id) REFERENCES feishu_project_spaces(project_id)
);

CREATE INDEX IF NOT EXISTS idx_feishu_pending_topics_project
ON feishu_pending_topics(project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  message_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  prompt TEXT NOT NULL,
  state TEXT NOT NULL,
  thread_id TEXT,
  reply_to_message_id TEXT,
  progress_text TEXT NOT NULL DEFAULT '',
  progress_summary TEXT,
  model TEXT,
  reasoning_effort TEXT,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error TEXT
);

CREATE TABLE IF NOT EXISTS thread_execution_settings (
  thread_id TEXT PRIMARY KEY REFERENCES thread_index(thread_id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_state_created ON tasks(state, created_at);

CREATE TABLE IF NOT EXISTS inbound_events (
  event_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  sender_open_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS thread_leases (
  thread_id TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(task_id),
  chat_id TEXT,
  body TEXT,
  kind TEXT,
  payload TEXT,
  audience TEXT,
  sequence INTEGER NOT NULL DEFAULT 0,
  channel_message_id TEXT,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

`;

export interface ProjectRecord {
  id: string;
  name: string;
  rootPath: string;
  enabled: boolean;
}

export type DesktopProjectSyncState = "pending" | "synced" | "removed";

export interface DesktopProjectSyncRecord {
  projectId: string;
  sourceId: string | null;
  state: DesktopProjectSyncState;
  updatedAt: string;
}

export interface ProjectChatStateRecord {
  chatId: string;
  projectId: string;
  threadId: string | null;
  updatedAt: string;
}

export interface ThreadIndexRecord {
  threadId: string;
  projectId: string;
  localNumber: number;
  title: string | null;
  preview: string | null;
  status: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  lastSyncedAt: string | null;
}

export interface FeishuProjectSpaceRecord {
  projectId: string;
  chatId: string;
  ownerOpenId: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

export interface FeishuThreadRouteRecord {
  threadId: string;
  projectId: string;
  chatId: string;
  topicRootId: string;
  ownerOpenId: string;
  toolbarMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FeishuPendingTopicRecord {
  projectId: string;
  chatId: string;
  topicRootId: string;
  ownerOpenId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadExecutionSettingsRecord {
  threadId: string;
  model: string;
  reasoningEffort: string;
  updatedAt: string;
}

interface ProjectRow {
  project_id: string;
  name: string;
  root_path: string;
  enabled: number;
}

interface DesktopProjectSyncRow {
  project_id: string;
  source_id: string | null;
  state: DesktopProjectSyncState;
  updated_at: string;
}

interface ProjectChatStateRow {
  chat_id: string;
  project_id: string;
  active_thread_id: string | null;
  updated_at: string;
}

interface ThreadIndexRow {
  thread_id: string;
  project_id: string;
  local_number: number;
  title: string | null;
  preview: string | null;
  status: string | null;
  archived: number;
  created_at: string;
  updated_at: string;
  last_synced_at: string | null;
}

interface FeishuProjectSpaceRow {
  project_id: string;
  chat_id: string;
  owner_open_id: string;
  display_name: string;
  created_at: string;
  updated_at: string;
}

interface FeishuThreadRouteRow {
  thread_id: string;
  project_id: string;
  chat_id: string;
  topic_root_id: string;
  owner_open_id: string;
  toolbar_message_id: string | null;
  created_at: string;
  updated_at: string;
}

interface FeishuPendingTopicRow {
  project_id: string;
  chat_id: string;
  topic_root_id: string;
  owner_open_id: string;
  created_at: string;
  updated_at: string;
}

interface TaskRow {
  task_id: string;
  event_id: string;
  message_id: string;
  chat_id: string;
  project_id: string;
  prompt: string;
  state: TaskState;
  thread_id: string | null;
  reply_to_message_id: string | null;
  progress_text: string;
  progress_summary: string | null;
  model: string | null;
  reasoning_effort: string | null;
  attachments_json: string;
  created_at: string;
  updated_at: string;
  error: string | null;
}

interface DeliveryRow {
  delivery_id: string;
  task_id: string | null;
  chat_id: string;
  body: string;
  kind: string;
  payload: string;
  audience: "p2p" | "group" | null;
  sequence: number;
  status: DeliveryState;
  attempts: number;
  next_attempt_at: string;
  channel_message_id: string | null;
  last_error: string | null;
  updated_at: string;
}

function toTask(row: TaskRow): TaskRecord {
  return {
    id: row.task_id,
    eventId: row.event_id,
    messageId: row.message_id,
    chatId: row.chat_id,
    projectId: row.project_id,
    prompt: row.prompt,
    state: row.state,
    threadId: row.thread_id,
    replyToMessageId: row.reply_to_message_id,
    progressText: row.progress_text,
    progressSummary: row.progress_summary,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    attachments: JSON.parse(row.attachments_json) as TaskRecord["attachments"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    error: row.error,
  };
}

function toDelivery(row: DeliveryRow): DeliveryRecord {
  const common = {
    id: row.delivery_id,
    taskId: row.task_id,
    chatId: row.chat_id,
    sequence: row.sequence,
    state: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    channelMessageId: row.channel_message_id,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
  const payload = JSON.parse(row.payload) as unknown;
  if (row.kind === "text" && isRecord(payload) && typeof payload.text === "string") {
    const replyToMessageId =
      typeof payload.replyToMessageId === "string" ? payload.replyToMessageId : undefined;
    return {
      ...common,
      kind: "text",
      payload: { text: payload.text, ...(replyToMessageId ? { replyToMessageId } : {}) },
      message: {
        chatId: row.chat_id,
        kind: "text",
        text: payload.text,
        ...(replyToMessageId ? { replyToMessageId } : {}),
      },
      body: row.body,
    };
  }
  if (row.kind === "card" && isRecord(payload) && isRecord(payload.card)) {
    if (row.audience !== "p2p" && row.audience !== "group") {
      throw new Error(`Delivery ${row.delivery_id} has no trusted card audience`);
    }
    const text = typeof payload.text === "string" ? payload.text : row.body;
    return {
      ...common,
      kind: "card",
      audience: row.audience,
      payload: { text, card: payload.card },
      message: {
        chatId: row.chat_id,
        kind: "card",
        audience: row.audience,
        text,
        card: payload.card,
        ...(typeof payload.replyToMessageId === "string"
          ? { replyToMessageId: payload.replyToMessageId }
          : {}),
      },
      body: row.body,
    };
  }
  throw new Error(`Delivery ${row.delivery_id} has an invalid ${row.kind} payload`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.project_id,
    name: row.name,
    rootPath: row.root_path,
    enabled: row.enabled === 1,
  };
}

function toProjectChatState(row: ProjectChatStateRow): ProjectChatStateRecord {
  return {
    chatId: row.chat_id,
    projectId: row.project_id,
    threadId: row.active_thread_id,
    updatedAt: row.updated_at,
  };
}

function toThreadIndex(row: ThreadIndexRow): ThreadIndexRecord {
  return {
    threadId: row.thread_id,
    projectId: row.project_id,
    localNumber: row.local_number,
    title: row.title,
    preview: row.preview,
    status: row.status,
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSyncedAt: row.last_synced_at,
  };
}

function canonicalRootPath(rootPath: string): string {
  return path.resolve(rootPath).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

export class BridgeDatabase {
  private readonly database: Database.Database;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.database.exec(schema);
    this.ensureDeliveryColumns();
    this.database.exec(
      "CREATE INDEX IF NOT EXISTS idx_deliveries_due ON deliveries(status, next_attempt_at, updated_at)",
    );
    this.database
      .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, ?)")
      .run(new Date().toISOString());
    this.database
      .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(2, ?)")
      .run(new Date().toISOString());
    this.migrateProjectState();
    this.migrateOutboundDeliveries();
    this.migrateDeliveryAudience();
    this.database
      .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(6, ?)")
      .run(new Date().toISOString());
    this.migrateTaskReplyRouting();
    this.migrateTaskProgress();
    this.migrateThreadExecutionSettings();
    this.migrateTaskAttachments();
    this.migratePendingFeishuTopics();
    this.migrateDesktopProjectSync();
    this.migrateFeishuThreadToolbar();
  }

  close(): void {
    this.database.close();
  }

  recordInboundEvent(message: InboundEvent): boolean {
    const result = this.database
      .prepare(
        `
      INSERT OR IGNORE INTO inbound_events(event_id, message_id, chat_id, sender_open_id, received_at, recorded_at)
      VALUES(?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        message.eventId,
        message.messageId,
        message.chatId,
        message.senderOpenId,
        message.receivedAt,
        new Date().toISOString(),
      );
    return result.changes === 1;
  }

  syncProjects(
    projects: Array<{ id: string; name: string; rootPath: string; enabled: boolean }>,
  ): void {
    const statement = this.database.prepare(`
      INSERT INTO projects(project_id, name, root_path, enabled) VALUES(@id, @name, @rootPath, @enabled)
      ON CONFLICT(project_id) DO NOTHING
    `);
    this.database.transaction(() => {
      for (const project of projects)
        statement.run({ ...project, enabled: project.enabled ? 1 : 0 });
    })();
  }

  syncDesktopProjects(
    projects: Array<{ sourceId: string; name: string; rootPath: string }>,
  ): ProjectRecord[] {
    return this.database.transaction(() => {
      const seenSourceIds = new Set<string>();
      const seenRootPaths = new Set<string>();
      for (const project of projects) {
        if (seenSourceIds.has(project.sourceId)) {
          throw new Error(`Duplicate desktop project source id "${project.sourceId}"`);
        }
        seenSourceIds.add(project.sourceId);

        const canonicalPath = canonicalRootPath(project.rootPath);
        if (seenRootPaths.has(canonicalPath)) {
          throw new Error(`Duplicate desktop project root path "${project.rootPath}"`);
        }
        seenRootPaths.add(canonicalPath);
      }

      const existingProjects = this.listProjects({ includeDisabled: true });
      const retainedDesktopIds = new Set<string>();
      const mappedIds: string[] = [];

      for (const project of projects) {
        const generatedId = `desktop@${project.sourceId}`;
        const canonicalPath = canonicalRootPath(project.rootPath);
        const generatedProject = this.getProject(generatedId);
        const pathOwners = existingProjects.filter(
          (existing) => canonicalRootPath(existing.rootPath) === canonicalPath,
        );

        if (generatedProject) {
          const conflictingPathOwner = pathOwners.find((existing) => existing.id !== generatedId);
          if (conflictingPathOwner) {
            throw new Error(
              `Desktop project root path "${project.rootPath}" is already registered by "${conflictingPathOwner.id}"`,
            );
          }
          if (canonicalRootPath(generatedProject.rootPath) !== canonicalPath) {
            if (this.hasOpenTaskForProject(generatedId)) {
              throw new Error(
                `Desktop project "${generatedId}" cannot change root path while a task is open`,
              );
            }
            this.database
              .prepare(
                "UPDATE project_chat_state SET active_thread_id = NULL, updated_at = ? WHERE project_id = ?",
              )
              .run(new Date().toISOString(), generatedId);
            this.database
              .prepare(
                "UPDATE conversations SET thread_id = NULL, updated_at = ? WHERE project_id = ?",
              )
              .run(new Date().toISOString(), generatedId);
            this.database.prepare("DELETE FROM thread_index WHERE project_id = ?").run(generatedId);
          }
          this.database
            .prepare(
              "UPDATE projects SET name = ?, root_path = ?, enabled = 1 WHERE project_id = ?",
            )
            .run(project.name, project.rootPath, generatedId);
          const existingIndex = existingProjects.findIndex(
            (existing) => existing.id === generatedId,
          );
          if (existingIndex >= 0) {
            existingProjects[existingIndex] = {
              id: generatedId,
              name: project.name,
              rootPath: project.rootPath,
              enabled: true,
            };
          }
          retainedDesktopIds.add(generatedId);
          mappedIds.push(generatedId);
          continue;
        }

        const pathOwner = pathOwners[0];
        if (pathOwner && pathOwners.length === 1 && !pathOwner.id.startsWith("desktop@")) {
          this.database
            .prepare("UPDATE projects SET name = ?, enabled = 1 WHERE project_id = ?")
            .run(project.name, pathOwner.id);
          mappedIds.push(pathOwner.id);
          continue;
        }

        if (
          pathOwner?.id.startsWith("desktop@") &&
          !seenSourceIds.has(pathOwner.id.slice("desktop@".length))
        ) {
          if (this.hasOpenTaskForProject(pathOwner.id)) {
            throw new Error(
              `Desktop project "${pathOwner.id}" cannot change source identity while a task is open`,
            );
          }
          this.database
            .prepare(
              "UPDATE projects SET name = ?, root_path = ?, enabled = 1 WHERE project_id = ?",
            )
            .run(project.name, project.rootPath, pathOwner.id);
          const existingIndex = existingProjects.findIndex(
            (existing) => existing.id === pathOwner.id,
          );
          if (existingIndex >= 0) {
            existingProjects[existingIndex] = {
              id: pathOwner.id,
              name: project.name,
              rootPath: project.rootPath,
              enabled: true,
            };
          }
          retainedDesktopIds.add(pathOwner.id);
          mappedIds.push(pathOwner.id);
          continue;
        }

        if (pathOwner) {
          throw new Error(
            `Desktop project root path "${project.rootPath}" is already registered by "${pathOwner.id}"`,
          );
        }

        this.database
          .prepare("INSERT INTO projects(project_id, name, root_path, enabled) VALUES(?, ?, ?, 1)")
          .run(generatedId, project.name, project.rootPath);
        existingProjects.push({
          id: generatedId,
          name: project.name,
          rootPath: project.rootPath,
          enabled: true,
        });

        retainedDesktopIds.add(generatedId);
        mappedIds.push(generatedId);
      }

      for (const existing of existingProjects) {
        if (existing.id.startsWith("desktop@") && !retainedDesktopIds.has(existing.id)) {
          this.database
            .prepare("UPDATE projects SET enabled = 0 WHERE project_id = ?")
            .run(existing.id);
        }
      }

      return mappedIds.map((projectId) => {
        const project = this.getProject(projectId);
        if (!project) throw new Error(`Failed to persist desktop project "${projectId}"`);
        return project;
      });
    })();
  }

  listProjects(options: { includeDisabled?: boolean } = {}): ProjectRecord[] {
    const rows = this.database
      .prepare(
        options.includeDisabled
          ? "SELECT * FROM projects ORDER BY project_id"
          : "SELECT * FROM projects WHERE enabled = 1 ORDER BY project_id",
      )
      .all() as ProjectRow[];
    return rows.map(toProject);
  }

  getProject(projectId: string): ProjectRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM projects WHERE project_id = ?")
      .get(projectId) as ProjectRow | undefined;
    return row ? toProject(row) : undefined;
  }

  getOrAssignProjectNumber(projectId: string): number {
    return this.database.transaction(() => {
      const existing = this.database
        .prepare("SELECT local_number FROM project_numbers WHERE project_id = ?")
        .get(projectId) as { local_number: number } | undefined;
      if (existing) return existing.local_number;
      if (!this.getProject(projectId)) throw new Error(`Project "${projectId}" does not exist`);
      const next = this.database
        .prepare("SELECT COALESCE(MAX(local_number), 0) + 1 AS value FROM project_numbers")
        .get() as { value: number };
      this.database
        .prepare("INSERT INTO project_numbers(project_id, local_number) VALUES(?, ?)")
        .run(projectId, next.value);
      return next.value;
    })();
  }

  getProjectByLocalNumber(localNumber: number): ProjectRecord | undefined {
    const row = this.database
      .prepare(
        `
        SELECT p.* FROM projects p
        INNER JOIN project_numbers n ON n.project_id = p.project_id
        WHERE n.local_number = ?
      `,
      )
      .get(localNumber) as ProjectRow | undefined;
    return row ? toProject(row) : undefined;
  }

  createProject(input: {
    id: string;
    name: string;
    rootPath: string;
    enabled?: boolean;
  }): ProjectRecord {
    return this.database.transaction(() => {
      if (this.getProject(input.id)) throw new Error(`Project id "${input.id}" already exists`);
      const canonicalInputPath = canonicalRootPath(input.rootPath);
      const pathOwner = this.listProjects({ includeDisabled: true }).find(
        (project) => canonicalRootPath(project.rootPath) === canonicalInputPath,
      );
      if (pathOwner) {
        throw new Error(
          `Project root path "${input.rootPath}" is already registered by "${pathOwner.id}"`,
        );
      }
      this.database
        .prepare("INSERT INTO projects(project_id, name, root_path, enabled) VALUES(?, ?, ?, ?)")
        .run(input.id, input.name, input.rootPath, input.enabled === false ? 0 : 1);
      const project = this.getProject(input.id);
      if (!project) throw new Error(`Failed to persist project "${input.id}"`);
      return project;
    })();
  }

  setProjectEnabled(projectId: string, enabled: boolean): ProjectRecord | undefined {
    const result = this.database
      .prepare("UPDATE projects SET enabled = ? WHERE project_id = ?")
      .run(enabled ? 1 : 0, projectId);
    return result.changes === 0 ? undefined : this.getProject(projectId);
  }

  ensureDesktopProjectSync(
    projectId: string,
    initialState: DesktopProjectSyncState = "pending",
  ): DesktopProjectSyncRecord {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT OR IGNORE INTO desktop_project_sync(project_id, source_id, state, updated_at)
         VALUES(?, NULL, ?, ?)`,
      )
      .run(projectId, initialState, now);
    const record = this.getDesktopProjectSync(projectId);
    if (!record) throw new Error(`Failed to persist Desktop sync state for "${projectId}"`);
    return record;
  }

  setDesktopProjectSync(
    projectId: string,
    state: DesktopProjectSyncState,
    sourceId?: string | null,
  ): DesktopProjectSyncRecord {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO desktop_project_sync(project_id, source_id, state, updated_at)
         VALUES(?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           source_id=CASE WHEN excluded.source_id IS NULL THEN desktop_project_sync.source_id ELSE excluded.source_id END,
           state=excluded.state,
           updated_at=excluded.updated_at`,
      )
      .run(projectId, sourceId ?? null, state, now);
    const record = this.getDesktopProjectSync(projectId);
    if (!record) throw new Error(`Failed to update Desktop sync state for "${projectId}"`);
    return record;
  }

  getDesktopProjectSync(projectId: string): DesktopProjectSyncRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM desktop_project_sync WHERE project_id = ?")
      .get(projectId) as DesktopProjectSyncRow | undefined;
    return row ? toDesktopProjectSync(row) : undefined;
  }

  listDesktopProjectSync(): DesktopProjectSyncRecord[] {
    return (
      this.database
        .prepare("SELECT * FROM desktop_project_sync ORDER BY project_id")
        .all() as DesktopProjectSyncRow[]
    ).map(toDesktopProjectSync);
  }

  selectProject(chatId: string, projectId: string): { projectId: string; threadId: string | null } {
    return this.database.transaction(() => {
      const now = new Date().toISOString();
      this.database
        .prepare(
          `
        INSERT INTO chat_state(chat_id, active_project_id, updated_at) VALUES(?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
          active_project_id=excluded.active_project_id,
          updated_at=excluded.updated_at
      `,
        )
        .run(chatId, projectId, now);
      this.database
        .prepare(
          `
        INSERT INTO project_chat_state(chat_id, project_id, active_thread_id, updated_at)
        VALUES(?, ?, NULL, ?)
        ON CONFLICT(chat_id, project_id) DO NOTHING
      `,
        )
        .run(chatId, projectId, now);
      const state = this.getProjectState(chatId, projectId);
      const threadId = state?.threadId ?? null;
      this.writeLegacyConversation(chatId, projectId, threadId, now);
      return { projectId, threadId };
    })();
  }

  bindProject(chatId: string, projectId: string): void {
    this.selectProject(chatId, projectId);
    this.clearThread(chatId, projectId);
  }

  getConversation(
    chatId: string,
  ): { projectId: string | null; threadId: string | null } | undefined {
    return this.database
      .prepare(
        `
        SELECT cs.active_project_id AS projectId, pcs.active_thread_id AS threadId
        FROM chat_state cs
        LEFT JOIN project_chat_state pcs
          ON pcs.chat_id = cs.chat_id AND pcs.project_id = cs.active_project_id
        WHERE cs.chat_id = ?
      `,
      )
      .get(chatId) as { projectId: string | null; threadId: string | null } | undefined;
  }

  listChatIdsForSelectedProject(projectId: string): string[] {
    return (
      this.database
        .prepare(
          "SELECT chat_id FROM chat_state WHERE active_project_id = ? ORDER BY updated_at DESC",
        )
        .all(projectId) as Array<{ chat_id: string }>
    ).map((row) => row.chat_id);
  }

  clearSelectedProject(chatId: string, expectedProjectId: string): boolean {
    return this.database.transaction(() => {
      const current = this.getConversation(chatId);
      if (current?.projectId !== expectedProjectId) return false;
      const now = new Date().toISOString();
      this.database
        .prepare("UPDATE chat_state SET active_project_id = NULL, updated_at = ? WHERE chat_id = ?")
        .run(now, chatId);
      this.database
        .prepare(
          `INSERT INTO conversations(chat_id, project_id, thread_id, updated_at)
           VALUES(?, NULL, NULL, ?)
           ON CONFLICT(chat_id) DO UPDATE SET
             project_id=NULL,
             thread_id=NULL,
             updated_at=excluded.updated_at`,
        )
        .run(chatId, now);
      return true;
    })();
  }

  setThread(chatId: string, projectId: string, threadId: string): void {
    this.upsertThread({ threadId, projectId });
    this.database.transaction(() => {
      const now = new Date().toISOString();
      this.database
        .prepare(
          `
        INSERT INTO chat_state(chat_id, active_project_id, updated_at) VALUES(?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
          active_project_id=excluded.active_project_id,
          updated_at=excluded.updated_at
      `,
        )
        .run(chatId, projectId, now);
      this.database
        .prepare(
          `
        INSERT INTO project_chat_state(chat_id, project_id, active_thread_id, updated_at)
        VALUES(?, ?, ?, ?)
        ON CONFLICT(chat_id, project_id) DO UPDATE SET
          active_thread_id=excluded.active_thread_id,
          updated_at=excluded.updated_at
      `,
        )
        .run(chatId, projectId, threadId, now);
      this.writeLegacyConversation(chatId, projectId, threadId, now);
    })();
  }

  clearThread(chatId: string, projectId?: string): ProjectChatStateRecord | undefined {
    const selectedProjectId = projectId ?? this.getConversation(chatId)?.projectId ?? undefined;
    if (!selectedProjectId) return undefined;
    return this.database.transaction(() => {
      const now = new Date().toISOString();
      this.database
        .prepare(
          `
        INSERT INTO project_chat_state(chat_id, project_id, active_thread_id, updated_at)
        VALUES(?, ?, NULL, ?)
        ON CONFLICT(chat_id, project_id) DO UPDATE SET
          active_thread_id=NULL,
          updated_at=excluded.updated_at
      `,
        )
        .run(chatId, selectedProjectId, now);
      const conversation = this.getConversation(chatId);
      if (conversation?.projectId === selectedProjectId) {
        this.writeLegacyConversation(chatId, selectedProjectId, null, now);
      }
      return this.getProjectState(chatId, selectedProjectId);
    })();
  }

  getProjectState(chatId: string, projectId: string): ProjectChatStateRecord | undefined {
    const row = this.database
      .prepare(
        `
        SELECT chat_id, project_id, active_thread_id, updated_at
        FROM project_chat_state
        WHERE chat_id = ? AND project_id = ?
      `,
      )
      .get(chatId, projectId) as ProjectChatStateRow | undefined;
    return row ? toProjectChatState(row) : undefined;
  }

  upsertThread(input: {
    threadId: string;
    projectId: string;
    localNumber?: number;
    title?: string | null;
    preview?: string | null;
    status?: string | null;
    archived?: boolean;
    createdAt?: string;
    updatedAt?: string;
    lastSyncedAt?: string | null;
  }): ThreadIndexRecord {
    return this.database.transaction(() => {
      const existing = this.database
        .prepare("SELECT * FROM thread_index WHERE thread_id = ?")
        .get(input.threadId) as ThreadIndexRow | undefined;
      if (existing && existing.project_id !== input.projectId) {
        throw new Error(
          `Thread "${input.threadId}" is already indexed under project "${existing.project_id}"`,
        );
      }
      if (
        existing &&
        input.localNumber !== undefined &&
        input.localNumber !== existing.local_number
      ) {
        throw new Error(
          `Thread "${input.threadId}" already has local number ${existing.local_number}`,
        );
      }

      const now = new Date().toISOString();
      if (!existing) {
        const nextNumber = input.localNumber ?? this.nextThreadNumber(input.projectId);
        this.database
          .prepare(
            `
          INSERT INTO thread_index(
            thread_id, project_id, local_number, title, preview, status, archived,
            created_at, updated_at, last_synced_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
          )
          .run(
            input.threadId,
            input.projectId,
            nextNumber,
            input.title ?? null,
            input.preview ?? null,
            input.status ?? null,
            input.archived === true ? 1 : 0,
            input.createdAt ?? now,
            input.updatedAt ?? now,
            input.lastSyncedAt ?? null,
          );
      } else {
        this.database
          .prepare(
            `
          UPDATE thread_index SET
            title = CASE WHEN @hasTitle = 1 THEN @title ELSE title END,
            preview = CASE WHEN @hasPreview = 1 THEN @preview ELSE preview END,
            status = CASE WHEN @hasStatus = 1 THEN @status ELSE status END,
            archived = CASE WHEN @hasArchived = 1 THEN @archived ELSE archived END,
            updated_at = @updatedAt,
            last_synced_at = CASE
              WHEN @hasLastSyncedAt = 1 THEN @lastSyncedAt ELSE last_synced_at
            END
          WHERE thread_id = @threadId
        `,
          )
          .run({
            threadId: input.threadId,
            hasTitle: input.title !== undefined ? 1 : 0,
            title: input.title ?? null,
            hasPreview: input.preview !== undefined ? 1 : 0,
            preview: input.preview ?? null,
            hasStatus: input.status !== undefined ? 1 : 0,
            status: input.status ?? null,
            hasArchived: input.archived !== undefined ? 1 : 0,
            archived: input.archived === true ? 1 : 0,
            updatedAt: input.updatedAt ?? now,
            hasLastSyncedAt: input.lastSyncedAt !== undefined ? 1 : 0,
            lastSyncedAt: input.lastSyncedAt ?? null,
          });
      }
      const record = this.getProjectThread(input.projectId, input.threadId);
      if (!record) throw new Error(`Failed to persist thread "${input.threadId}"`);
      return record;
    })();
  }

  listProjectThreads(
    projectId: string,
    options: { includeArchived?: boolean; limit?: number } = {},
  ): ThreadIndexRecord[] {
    const conditions = ["project_id = @projectId"];
    if (!options.includeArchived) conditions.push("archived = 0");
    const limit = options.limit;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new Error("Thread list limit must be a positive integer");
    }
    const rows = this.database
      .prepare(
        `
        SELECT * FROM thread_index
        WHERE ${conditions.join(" AND ")}
        ORDER BY updated_at DESC, local_number DESC
        ${limit === undefined ? "" : "LIMIT @limit"}
      `,
      )
      .all({ projectId, limit: limit ?? null }) as ThreadIndexRow[];
    return rows.map(toThreadIndex);
  }

  getProjectThreadByNumber(projectId: string, localNumber: number): ThreadIndexRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM thread_index WHERE project_id = ? AND local_number = ?")
      .get(projectId, localNumber) as ThreadIndexRow | undefined;
    return row ? toThreadIndex(row) : undefined;
  }

  getProjectThread(projectId: string, threadId: string): ThreadIndexRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM thread_index WHERE project_id = ? AND thread_id = ?")
      .get(projectId, threadId) as ThreadIndexRow | undefined;
    return row ? toThreadIndex(row) : undefined;
  }

  clearThreadBindingsForThread(projectId: string, threadId: string): number {
    return this.database
      .prepare(
        `UPDATE project_chat_state
         SET active_thread_id = NULL, updated_at = ?
         WHERE project_id = ? AND active_thread_id = ?`,
      )
      .run(new Date().toISOString(), projectId, threadId).changes;
  }

  bindFeishuProjectSpace(input: {
    projectId: string;
    chatId: string;
    ownerOpenId: string;
    displayName: string;
  }): FeishuProjectSpaceRecord {
    const project = this.getProject(input.projectId);
    if (!project) throw new Error(`Unknown project "${input.projectId}"`);
    const conflicting = this.database
      .prepare("SELECT project_id FROM feishu_project_spaces WHERE chat_id = ?")
      .get(input.chatId) as { project_id: string } | undefined;
    if (conflicting && conflicting.project_id !== input.projectId) {
      throw new Error(`Feishu chat is already bound to project "${conflicting.project_id}"`);
    }
    const now = new Date().toISOString();
    this.database
      .prepare(
        `
        INSERT INTO feishu_project_spaces(
          project_id, chat_id, owner_open_id, display_name, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          chat_id=excluded.chat_id,
          owner_open_id=excluded.owner_open_id,
          display_name=excluded.display_name,
          updated_at=excluded.updated_at
      `,
      )
      .run(input.projectId, input.chatId, input.ownerOpenId, input.displayName, now, now);
    return this.getFeishuProjectSpace(input.projectId)!;
  }

  replaceFeishuProjectSpace(input: {
    projectId: string;
    chatId: string;
    ownerOpenId: string;
    displayName: string;
  }): FeishuProjectSpaceRecord {
    return this.database.transaction(() => {
      const space = this.bindFeishuProjectSpace(input);
      this.deleteFeishuThreadRoutes(input.projectId);
      this.deleteFeishuPendingTopics(input.projectId);
      return space;
    })();
  }

  getFeishuProjectSpace(projectId: string): FeishuProjectSpaceRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM feishu_project_spaces WHERE project_id = ?")
      .get(projectId) as FeishuProjectSpaceRow | undefined;
    return row ? this.toFeishuProjectSpace(row) : undefined;
  }

  getFeishuProjectSpaceByChat(chatId: string): FeishuProjectSpaceRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM feishu_project_spaces WHERE chat_id = ?")
      .get(chatId) as FeishuProjectSpaceRow | undefined;
    return row ? this.toFeishuProjectSpace(row) : undefined;
  }

  listFeishuProjectSpaces(): FeishuProjectSpaceRecord[] {
    return (
      this.database
        .prepare("SELECT * FROM feishu_project_spaces ORDER BY updated_at DESC, project_id")
        .all() as FeishuProjectSpaceRow[]
    ).map((row) => this.toFeishuProjectSpace(row));
  }

  deleteFeishuProjectSpace(projectId: string): boolean {
    return this.database.transaction(() => {
      this.deleteFeishuThreadRoutes(projectId);
      this.deleteFeishuPendingTopics(projectId);
      return (
        this.database
          .prepare("DELETE FROM feishu_project_spaces WHERE project_id = ?")
          .run(projectId).changes > 0
      );
    })();
  }

  bindFeishuThreadRoute(input: {
    threadId: string;
    projectId: string;
    chatId: string;
    topicRootId: string;
    ownerOpenId: string;
  }): FeishuThreadRouteRecord {
    const thread = this.getProjectThread(input.projectId, input.threadId);
    if (!thread)
      throw new Error(`Unknown thread "${input.threadId}" in project "${input.projectId}"`);
    const space = this.getFeishuProjectSpace(input.projectId);
    if (!space || space.chatId !== input.chatId) {
      throw new Error("Thread route must use the project's registered Feishu chat");
    }
    if (space.ownerOpenId !== input.ownerOpenId) {
      throw new Error("Thread route owner must match the project space owner");
    }
    const conflict = this.database
      .prepare("SELECT thread_id FROM feishu_thread_routes WHERE chat_id = ? AND topic_root_id = ?")
      .get(input.chatId, input.topicRootId) as { thread_id: string } | undefined;
    if (conflict && conflict.thread_id !== input.threadId) {
      throw new Error(`Feishu topic is already bound to thread "${conflict.thread_id}"`);
    }
    const now = new Date().toISOString();
    this.database
      .prepare(
        `
        INSERT INTO feishu_thread_routes(
          thread_id, project_id, chat_id, topic_root_id, owner_open_id, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          project_id=excluded.project_id,
          chat_id=excluded.chat_id,
          topic_root_id=excluded.topic_root_id,
          owner_open_id=excluded.owner_open_id,
          updated_at=excluded.updated_at
      `,
      )
      .run(
        input.threadId,
        input.projectId,
        input.chatId,
        input.topicRootId,
        input.ownerOpenId,
        now,
        now,
      );
    return this.getFeishuThreadRoute(input.threadId)!;
  }

  bindFeishuPendingTopic(input: {
    projectId: string;
    chatId: string;
    topicRootId: string;
    ownerOpenId: string;
  }): FeishuPendingTopicRecord {
    const space = this.getFeishuProjectSpace(input.projectId);
    if (!space || space.chatId !== input.chatId) {
      throw new Error("Pending topic must use the project's registered Feishu chat");
    }
    if (space.ownerOpenId !== input.ownerOpenId) {
      throw new Error("Pending topic owner must match the project space owner");
    }
    if (this.resolveFeishuThreadRoute(input.chatId, input.topicRootId)) {
      throw new Error("Feishu topic is already bound to a Codex thread");
    }
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO feishu_pending_topics(
          project_id, chat_id, topic_root_id, owner_open_id, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?)
        ON CONFLICT(topic_root_id) DO UPDATE SET
          project_id=excluded.project_id,
          chat_id=excluded.chat_id,
          owner_open_id=excluded.owner_open_id,
          updated_at=excluded.updated_at`,
      )
      .run(input.projectId, input.chatId, input.topicRootId, input.ownerOpenId, now, now);
    return this.resolveFeishuPendingTopic(input.chatId, input.topicRootId)!;
  }

  resolveFeishuPendingTopic(
    chatId: string,
    topicRootId: string,
  ): FeishuPendingTopicRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM feishu_pending_topics WHERE chat_id = ? AND topic_root_id = ?")
      .get(chatId, topicRootId) as FeishuPendingTopicRow | undefined;
    return row ? this.toFeishuPendingTopic(row) : undefined;
  }

  promoteFeishuPendingTopic(input: {
    projectId: string;
    chatId: string;
    topicRootId: string;
    threadId: string;
  }): FeishuThreadRouteRecord {
    return this.database.transaction(() => {
      const pending = this.resolveFeishuPendingTopic(input.chatId, input.topicRootId);
      if (!pending || pending.projectId !== input.projectId) {
        throw new Error("Pending Feishu topic is no longer available");
      }
      const route = this.bindFeishuThreadRoute({
        threadId: input.threadId,
        projectId: input.projectId,
        chatId: input.chatId,
        topicRootId: input.topicRootId,
        ownerOpenId: pending.ownerOpenId,
      });
      this.database
        .prepare("DELETE FROM feishu_pending_topics WHERE topic_root_id = ?")
        .run(input.topicRootId);
      return route;
    })();
  }

  getFeishuThreadRoute(threadId: string): FeishuThreadRouteRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM feishu_thread_routes WHERE thread_id = ?")
      .get(threadId) as FeishuThreadRouteRow | undefined;
    return row ? this.toFeishuThreadRoute(row) : undefined;
  }

  setFeishuThreadToolbarMessage(threadId: string, messageId: string): boolean {
    return (
      this.database
        .prepare(
          "UPDATE feishu_thread_routes SET toolbar_message_id = ?, updated_at = ? WHERE thread_id = ?",
        )
        .run(messageId, new Date().toISOString(), threadId).changes > 0
    );
  }

  resolveFeishuThreadRoute(
    chatId: string,
    topicRootId: string,
  ): FeishuThreadRouteRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM feishu_thread_routes WHERE chat_id = ? AND topic_root_id = ?")
      .get(chatId, topicRootId) as FeishuThreadRouteRow | undefined;
    return row ? this.toFeishuThreadRoute(row) : undefined;
  }

  listFeishuThreadRoutes(projectId: string): FeishuThreadRouteRecord[] {
    return (
      this.database
        .prepare("SELECT * FROM feishu_thread_routes WHERE project_id = ? ORDER BY updated_at DESC")
        .all(projectId) as FeishuThreadRouteRow[]
    ).map((row) => this.toFeishuThreadRoute(row));
  }

  deleteFeishuThreadRoutes(projectId: string): number {
    return this.database
      .prepare("DELETE FROM feishu_thread_routes WHERE project_id = ?")
      .run(projectId).changes;
  }

  deleteFeishuPendingTopics(projectId: string): number {
    return this.database
      .prepare("DELETE FROM feishu_pending_topics WHERE project_id = ?")
      .run(projectId).changes;
  }

  deleteFeishuThreadRoute(threadId: string): boolean {
    return (
      this.database.prepare("DELETE FROM feishu_thread_routes WHERE thread_id = ?").run(threadId)
        .changes > 0
    );
  }

  private toFeishuProjectSpace(row: FeishuProjectSpaceRow): FeishuProjectSpaceRecord {
    return {
      projectId: row.project_id,
      chatId: row.chat_id,
      ownerOpenId: row.owner_open_id,
      displayName: row.display_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toFeishuThreadRoute(row: FeishuThreadRouteRow): FeishuThreadRouteRecord {
    return {
      threadId: row.thread_id,
      projectId: row.project_id,
      chatId: row.chat_id,
      topicRootId: row.topic_root_id,
      ownerOpenId: row.owner_open_id,
      toolbarMessageId: row.toolbar_message_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toFeishuPendingTopic(row: FeishuPendingTopicRow): FeishuPendingTopicRecord {
    return {
      projectId: row.project_id,
      chatId: row.chat_id,
      topicRootId: row.topic_root_id,
      ownerOpenId: row.owner_open_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  enqueue(
    message: InboundMessage,
    projectId: string,
    threadId?: string | null,
    execution?: { model: string; reasoningEffort: string } | null,
  ): TaskRecord | null {
    const now = new Date().toISOString();
    const id = randomUUID();
    const result = this.database
      .prepare(
        `
      INSERT OR IGNORE INTO tasks(
        task_id, event_id, message_id, chat_id, project_id, prompt, state, thread_id,
        reply_to_message_id, model, reasoning_effort, attachments_json, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        message.eventId,
        message.messageId,
        message.chatId,
        projectId,
        message.text,
        threadId ?? null,
        message.topicRootId ?? null,
        execution?.model ?? null,
        execution?.reasoningEffort ?? null,
        JSON.stringify(message.attachments ?? []),
        now,
        now,
      );
    if (result.changes === 0) return null;
    return this.getTask(id) ?? null;
  }

  getThreadExecutionSettings(threadId: string): ThreadExecutionSettingsRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM thread_execution_settings WHERE thread_id=?")
      .get(threadId) as
      | { thread_id: string; model: string; reasoning_effort: string; updated_at: string }
      | undefined;
    return row
      ? {
          threadId: row.thread_id,
          model: row.model,
          reasoningEffort: row.reasoning_effort,
          updatedAt: row.updated_at,
        }
      : undefined;
  }

  setThreadExecutionSettings(
    threadId: string,
    model: string,
    reasoningEffort: string,
  ): ThreadExecutionSettingsRecord {
    const updatedAt = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO thread_execution_settings(thread_id,model,reasoning_effort,updated_at)
         VALUES(?,?,?,?)
         ON CONFLICT(thread_id) DO UPDATE SET
           model=excluded.model,
           reasoning_effort=excluded.reasoning_effort,
           updated_at=excluded.updated_at`,
      )
      .run(threadId, model, reasoningEffort, updatedAt);
    return { threadId, model, reasoningEffort, updatedAt };
  }

  getTask(taskId: string): TaskRecord | undefined {
    const row = this.database.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as
      | TaskRow
      | undefined;
    return row ? toTask(row) : undefined;
  }

  nextQueued(): TaskRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM tasks WHERE state = 'queued' ORDER BY created_at LIMIT 1")
      .get() as TaskRow | undefined;
    return row ? toTask(row) : undefined;
  }

  hasAnyOpenTask(): boolean {
    return Boolean(
      this.database
        .prepare(
          `
          SELECT 1 FROM tasks
          WHERE state IN ('queued', 'running', 'waiting_approval')
          LIMIT 1
        `,
        )
        .get(),
    );
  }

  hasOpenTask(chatId: string): boolean {
    return Boolean(
      this.database
        .prepare(
          `
          SELECT 1 FROM tasks
          WHERE chat_id = ? AND state IN ('queued', 'running', 'waiting_approval')
          LIMIT 1
        `,
        )
        .get(chatId),
    );
  }

  hasOpenTaskForProject(projectId: string): boolean {
    return Boolean(
      this.database
        .prepare(
          `
          SELECT 1 FROM tasks
          WHERE project_id = ? AND state IN ('queued', 'running', 'waiting_approval')
          LIMIT 1
        `,
        )
        .get(projectId),
    );
  }

  hasOpenTaskForThread(threadId: string): boolean {
    return Boolean(
      this.database
        .prepare(
          `
          SELECT 1 FROM tasks
          WHERE thread_id = ? AND state IN ('queued', 'running', 'waiting_approval')
          LIMIT 1
        `,
        )
        .get(threadId),
    );
  }

  updateTask(
    taskId: string,
    state: TaskState,
    values: { threadId?: string; error?: string | null } = {},
  ): void {
    this.database
      .prepare(
        `
      UPDATE tasks
      SET state = @state,
          thread_id = COALESCE(@threadId, thread_id),
          error = @error,
          updated_at = @updatedAt
      WHERE task_id = @taskId
    `,
      )
      .run({
        taskId,
        state,
        threadId: values.threadId ?? null,
        error: values.error ?? null,
        updatedAt: new Date().toISOString(),
      });
  }

  updateTaskProgress(taskId: string, progressText: string, progressSummary?: string | null): void {
    this.database
      .prepare("UPDATE tasks SET progress_text=?, progress_summary=?, updated_at=? WHERE task_id=?")
      .run(progressText, progressSummary ?? null, new Date().toISOString(), taskId);
  }

  listTasks(options: { projectId?: string; limit?: number } = {}): TaskRecord[] {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    const rows = options.projectId
      ? (this.database
          .prepare("SELECT * FROM tasks WHERE project_id=? ORDER BY created_at DESC LIMIT ?")
          .all(options.projectId, limit) as TaskRow[])
      : (this.database
          .prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?")
          .all(limit) as TaskRow[]);
    return rows.map(toTask);
  }

  interruptRunningTasks(): number {
    return this.database
      .prepare(
        "UPDATE tasks SET state='interrupted', updated_at=? WHERE state IN ('running', 'waiting_approval')",
      )
      .run(new Date().toISOString()).changes;
  }

  acquireLease(threadId: string, holder: string, ttlMs: number): boolean {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const result = this.database
      .prepare(
        `
      INSERT INTO thread_leases(thread_id, holder, expires_at) VALUES(?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET holder=excluded.holder, expires_at=excluded.expires_at
      WHERE thread_leases.expires_at < ? OR thread_leases.holder = excluded.holder
    `,
      )
      .run(threadId, holder, expiresAt, now.toISOString());
    return result.changes === 1;
  }

  releaseLease(threadId: string, holder: string): void {
    this.database
      .prepare("DELETE FROM thread_leases WHERE thread_id = ? AND holder = ?")
      .run(threadId, holder);
  }

  isThreadLeased(threadId: string): boolean {
    return Boolean(
      this.database
        .prepare("SELECT 1 FROM thread_leases WHERE thread_id = ? AND expires_at >= ? LIMIT 1")
        .get(threadId, new Date().toISOString()),
    );
  }

  queueDelivery(input: {
    chatId: string;
    body: string;
    taskId?: string | null;
    sequence?: number;
  }): DeliveryRecord {
    return this.queueOutbound(
      { chatId: input.chatId, kind: "text", text: input.body },
      {
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
        ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
      },
    );
  }

  queueOutbound(
    message: OutboundMessage,
    metadata: { taskId?: string | null; sequence?: number } = {},
  ): DeliveryRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    const kind = message.kind === "card" ? "card" : "text";
    const payload =
      message.kind === "card"
        ? {
            text: message.text,
            card: message.card,
            ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
          }
        : {
            text: message.text,
            ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
          };
    const body = message.text;
    this.database
      .prepare(
        `
      INSERT INTO deliveries(
        delivery_id, task_id, chat_id, body, kind, payload, audience, sequence,
        status, attempts, next_attempt_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
    `,
      )
      .run(
        id,
        metadata.taskId ?? null,
        message.chatId,
        body,
        kind,
        JSON.stringify(payload),
        message.kind === "card" ? message.audience : null,
        metadata.sequence ?? 0,
        now,
        now,
      );
    const delivery = this.getDelivery(id);
    if (!delivery) throw new Error("Failed to persist delivery");
    return delivery;
  }

  getDelivery(deliveryId: string): DeliveryRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM deliveries WHERE delivery_id = ?")
      .get(deliveryId) as DeliveryRow | undefined;
    return row ? toDelivery(row) : undefined;
  }

  claimNextDelivery(now = new Date()): DeliveryRecord | undefined {
    return this.database.transaction(() => {
      const row = this.database
        .prepare(
          `
        SELECT * FROM deliveries
        WHERE status IN ('pending', 'retry') AND next_attempt_at <= ?
        ORDER BY updated_at, sequence, delivery_id
        LIMIT 1
      `,
        )
        .get(now.toISOString()) as DeliveryRow | undefined;
      if (!row) return undefined;
      const updatedAt = new Date().toISOString();
      this.database
        .prepare(
          "UPDATE deliveries SET status='sending', attempts=attempts+1, updated_at=? WHERE delivery_id=?",
        )
        .run(updatedAt, row.delivery_id);
      return this.getDelivery(row.delivery_id);
    })();
  }

  markDeliverySent(deliveryId: string, channelMessageId: string): void {
    this.database
      .prepare(
        `
      UPDATE deliveries
      SET status='sent', channel_message_id=?, last_error=NULL, updated_at=?
      WHERE delivery_id=?
    `,
      )
      .run(channelMessageId, new Date().toISOString(), deliveryId);
  }

  recordSentCardUpdate(input: {
    chatId: string;
    channelMessageId: string;
    body: string;
    card: Record<string, unknown>;
  }): boolean {
    const result = this.database
      .prepare(
        `
        UPDATE deliveries
        SET body = ?, payload = ?, updated_at = ?
        WHERE chat_id = ?
          AND channel_message_id = ?
          AND kind = 'card'
          AND status = 'sent'
      `,
      )
      .run(
        input.body,
        JSON.stringify({ text: input.body, card: input.card }),
        new Date().toISOString(),
        input.chatId,
        input.channelMessageId,
      );
    return result.changes > 0;
  }

  getLatestSentCardMessageId(input: {
    chatId: string;
    body?: string;
    audience: "p2p" | "group";
  }): string | undefined {
    const bodyClause = input.body === undefined ? "" : " AND body = ?";
    const parameters =
      input.body === undefined
        ? [input.chatId, input.audience]
        : [input.chatId, input.body, input.audience];
    const row = this.database
      .prepare(
        `
        SELECT channel_message_id
        FROM deliveries
        WHERE chat_id = ?
          ${bodyClause}
          AND kind = 'card'
          AND audience = ?
          AND status = 'sent'
          AND channel_message_id IS NOT NULL
        ORDER BY updated_at DESC, rowid DESC
        LIMIT 1
      `,
      )
      .get(...parameters) as { channel_message_id: string } | undefined;
    return row?.channel_message_id;
  }

  isSentCardMessage(
    chatId: string,
    channelMessageId: string,
    requiredAudience?: "p2p" | "group",
  ): boolean {
    const audienceClause = requiredAudience ? " AND audience = ?" : "";
    return Boolean(
      this.database
        .prepare(
          `
          SELECT 1
          FROM deliveries
          WHERE status = 'sent'
            AND kind = 'card'
            AND chat_id = ?
            AND channel_message_id = ?
            ${audienceClause}
          LIMIT 1
        `,
        )
        .get(
          ...(requiredAudience
            ? [chatId, channelMessageId, requiredAudience]
            : [chatId, channelMessageId]),
        ),
    );
  }

  markDeliveryFailed(
    deliveryId: string,
    error: string,
    retryAt: Date,
    maxAttempts: number,
  ): DeliveryState {
    const delivery = this.getDelivery(deliveryId);
    if (!delivery) throw new Error(`Delivery ${deliveryId} was not found`);
    const state: DeliveryState = delivery.attempts >= maxAttempts ? "dead" : "retry";
    this.database
      .prepare(
        `
      UPDATE deliveries SET status=?, last_error=?, next_attempt_at=?, updated_at=?
      WHERE delivery_id=?
    `,
      )
      .run(state, error, retryAt.toISOString(), new Date().toISOString(), deliveryId);
    return state;
  }

  recoverSendingDeliveries(): number {
    const now = new Date().toISOString();
    return this.database
      .prepare(
        `
      UPDATE deliveries SET status='retry', next_attempt_at=?, updated_at=? WHERE status='sending'
    `,
      )
      .run(now, now).changes;
  }

  private migrateProjectState(): void {
    const applied = this.database
      .prepare("SELECT 1 FROM schema_migrations WHERE version = 3")
      .get();
    if (applied) return;

    this.database.transaction(() => {
      const legacyThreads = this.database
        .prepare(
          `
          SELECT c.project_id, c.thread_id,
                 MIN(c.updated_at) AS created_at,
                 MAX(c.updated_at) AS updated_at
          FROM conversations c
          INNER JOIN projects p ON p.project_id = c.project_id
          WHERE c.thread_id IS NOT NULL
          GROUP BY c.project_id, c.thread_id
          ORDER BY c.project_id, created_at, c.thread_id
        `,
        )
        .all() as Array<{
        project_id: string;
        thread_id: string;
        created_at: string;
        updated_at: string;
      }>;
      for (const thread of legacyThreads) {
        const exists = this.database
          .prepare("SELECT 1 FROM thread_index WHERE thread_id = ?")
          .get(thread.thread_id);
        if (exists) continue;
        this.database
          .prepare(
            `
            INSERT INTO thread_index(
              thread_id, project_id, local_number, title, preview, status, archived,
              created_at, updated_at, last_synced_at
            ) VALUES(?, ?, ?, NULL, NULL, NULL, 0, ?, ?, NULL)
          `,
          )
          .run(
            thread.thread_id,
            thread.project_id,
            this.nextThreadNumber(thread.project_id),
            thread.created_at,
            thread.updated_at,
          );
      }

      this.database.exec(`
        INSERT INTO chat_state(chat_id, active_project_id, updated_at)
        SELECT c.chat_id,
               CASE WHEN p.project_id IS NULL THEN NULL ELSE c.project_id END,
               c.updated_at
        FROM conversations c
        LEFT JOIN projects p ON p.project_id = c.project_id
        ON CONFLICT(chat_id) DO NOTHING;

        INSERT INTO project_chat_state(chat_id, project_id, active_thread_id, updated_at)
        SELECT c.chat_id, c.project_id, c.thread_id, c.updated_at
        FROM conversations c
        INNER JOIN projects p ON p.project_id = c.project_id
        ON CONFLICT(chat_id, project_id) DO NOTHING;
      `);
      this.database
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(3, ?)")
        .run(new Date().toISOString());
    })();
  }

  private nextThreadNumber(projectId: string): number {
    const row = this.database
      .prepare(
        "SELECT COALESCE(MAX(local_number), 0) + 1 AS next_number FROM thread_index WHERE project_id = ?",
      )
      .get(projectId) as { next_number: number };
    return row.next_number;
  }

  private writeLegacyConversation(
    chatId: string,
    projectId: string,
    threadId: string | null,
    updatedAt: string,
  ): void {
    this.database
      .prepare(
        `
        INSERT INTO conversations(chat_id, project_id, thread_id, updated_at)
        VALUES(?, ?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
          project_id=excluded.project_id,
          thread_id=excluded.thread_id,
          updated_at=excluded.updated_at
      `,
      )
      .run(chatId, projectId, threadId, updatedAt);
  }

  private ensureDeliveryColumns(): void {
    const columns = this.database.prepare("PRAGMA table_info(deliveries)").all() as Array<{
      name: string;
    }>;
    const names = new Set(columns.map((column) => column.name));
    const additions = [
      ["chat_id", "TEXT"],
      ["body", "TEXT"],
      ["kind", "TEXT"],
      ["payload", "TEXT"],
      ["audience", "TEXT"],
      ["sequence", "INTEGER NOT NULL DEFAULT 0"],
      ["next_attempt_at", "TEXT"],
    ] as const;
    for (const [name, definition] of additions) {
      if (!names.has(name))
        this.database.exec(`ALTER TABLE deliveries ADD COLUMN ${name} ${definition}`);
    }
    const now = new Date().toISOString();
    this.database
      .prepare("UPDATE deliveries SET next_attempt_at=? WHERE next_attempt_at IS NULL")
      .run(now);
    this.database
      .prepare(
        `
      UPDATE deliveries
      SET status='dead', last_error='Legacy delivery is missing chat_id or message payload', updated_at=?
      WHERE chat_id IS NULL OR (body IS NULL AND payload IS NULL)
    `,
      )
      .run(now);
  }

  private migrateOutboundDeliveries(): void {
    const applied = this.database
      .prepare("SELECT 1 FROM schema_migrations WHERE version = 4")
      .get();
    if (applied) return;

    this.database.transaction(() => {
      const rows = this.database
        .prepare("SELECT delivery_id, body, kind, payload, status, last_error FROM deliveries")
        .all() as Array<{
        delivery_id: string;
        body: string | null;
        kind: string | null;
        payload: string | null;
        status: DeliveryState;
        last_error: string | null;
      }>;
      const update = this.database.prepare(
        "UPDATE deliveries SET body=?, kind=?, payload=?, status=?, last_error=? WHERE delivery_id=?",
      );
      const now = new Date().toISOString();
      for (const row of rows) {
        const normalized = this.normalizeDeliveryPayload(row);
        update.run(
          normalized.body,
          normalized.kind,
          normalized.payload,
          normalized.valid ? row.status : "dead",
          normalized.valid ? row.last_error : normalized.error,
          row.delivery_id,
        );
      }
      this.database
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(4, ?)")
        .run(now);
    })();
  }

  private normalizeDeliveryPayload(row: {
    body: string | null;
    kind: string | null;
    payload: string | null;
  }): {
    body: string;
    kind: "text" | "card";
    payload: string;
    valid: boolean;
    error: string | null;
  } {
    if (!row.kind && !row.payload && row.body !== null) {
      return {
        body: row.body,
        kind: "text",
        payload: JSON.stringify({ text: row.body }),
        valid: true,
        error: null,
      };
    }

    try {
      const payload: unknown = row.payload === null ? undefined : JSON.parse(row.payload);
      if (row.kind === "text" && isRecord(payload) && typeof payload.text === "string") {
        return {
          body: payload.text,
          kind: "text",
          payload: JSON.stringify({ text: payload.text }),
          valid: true,
          error: null,
        };
      }
      if (row.kind === "card" && isRecord(payload) && isRecord(payload.card)) {
        const text = typeof payload.text === "string" ? payload.text : (row.body ?? "");
        return {
          body: text,
          kind: "card",
          payload: JSON.stringify({ text, card: payload.card }),
          valid: true,
          error: null,
        };
      }
    } catch {
      // Normalize malformed persisted JSON to a dead, readable delivery below.
    }

    return {
      body: row.body ?? "",
      kind: "text",
      payload: JSON.stringify({ text: row.body ?? "" }),
      valid: false,
      error: "Delivery has an invalid outbound message payload",
    };
  }

  private migrateDeliveryAudience(): void {
    const applied = this.database
      .prepare("SELECT 1 FROM schema_migrations WHERE version = 5")
      .get();
    if (applied) return;

    const now = new Date().toISOString();
    this.database.transaction(() => {
      // A pre-v5 card has no proof of whether it was sent to a p2p or group chat. Keep the
      // audience NULL so it can never satisfy an audience-qualified callback check. Pending
      // legacy cards are made dead rather than resent under an invented audience.
      this.database
        .prepare(
          `
          UPDATE deliveries
          SET status = 'dead',
              last_error = 'Legacy card delivery has no trusted audience',
              updated_at = ?
          WHERE kind = 'card'
            AND audience IS NULL
            AND status IN ('pending', 'sending', 'retry')
        `,
        )
        .run(now);
      this.database
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(5, ?)")
        .run(now);
    })();
  }

  private migrateTaskReplyRouting(): void {
    const applied = this.database
      .prepare("SELECT 1 FROM schema_migrations WHERE version = 7")
      .get();
    if (applied) return;
    const columns = this.database.prepare("PRAGMA table_info(tasks)").all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === "reply_to_message_id")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN reply_to_message_id TEXT");
    }
    this.database
      .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(7, ?)")
      .run(new Date().toISOString());
  }

  private migrateTaskProgress(): void {
    const applied = this.database
      .prepare("SELECT 1 FROM schema_migrations WHERE version = 8")
      .get();
    if (applied) return;
    const columns = new Set(
      (this.database.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    if (!columns.has("progress_text")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN progress_text TEXT NOT NULL DEFAULT ''");
    }
    if (!columns.has("progress_summary")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN progress_summary TEXT");
    }
    this.database
      .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(8, ?)")
      .run(new Date().toISOString());
  }

  private migrateThreadExecutionSettings(): void {
    const applied = this.database
      .prepare("SELECT 1 FROM schema_migrations WHERE version = 9")
      .get();
    if (applied) return;
    const columns = new Set(
      (this.database.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    if (!columns.has("model")) this.database.exec("ALTER TABLE tasks ADD COLUMN model TEXT");
    if (!columns.has("reasoning_effort")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN reasoning_effort TEXT");
    }
    this.database.exec(`CREATE TABLE IF NOT EXISTS thread_execution_settings (
      thread_id TEXT PRIMARY KEY REFERENCES thread_index(thread_id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      reasoning_effort TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    this.database
      .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(9, ?)")
      .run(new Date().toISOString());
  }

  private migrateTaskAttachments(): void {
    const applied = this.database
      .prepare("SELECT 1 FROM schema_migrations WHERE version = 10")
      .get();
    if (applied) return;
    const columns = new Set(
      (this.database.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    if (!columns.has("attachments_json")) {
      this.database.exec(
        "ALTER TABLE tasks ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'",
      );
    }
    this.database
      .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(10, ?)")
      .run(new Date().toISOString());
  }

  private migratePendingFeishuTopics(): void {
    const applied = this.database
      .prepare("SELECT 1 FROM schema_migrations WHERE version = 11")
      .get();
    if (applied) return;
    this.database.exec(`CREATE TABLE IF NOT EXISTS feishu_pending_topics (
      topic_root_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(project_id),
      chat_id TEXT NOT NULL,
      owner_open_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(chat_id, topic_root_id),
      FOREIGN KEY(project_id) REFERENCES feishu_project_spaces(project_id)
    );
    CREATE INDEX IF NOT EXISTS idx_feishu_pending_topics_project
      ON feishu_pending_topics(project_id, updated_at DESC);`);
    this.database
      .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(11, ?)")
      .run(new Date().toISOString());
  }

  private migrateDesktopProjectSync(): void {
    const applied = this.database
      .prepare("SELECT 1 FROM schema_migrations WHERE version = 12")
      .get();
    if (applied) return;
    const now = new Date().toISOString();
    this.database.transaction(() => {
      // Releases before v2.5 continuously re-registered every mobile project. Treat those
      // existing rows as already synchronized so a Desktop-side removal becomes authoritative.
      this.database
        .prepare(
          `INSERT OR IGNORE INTO desktop_project_sync(project_id, source_id, state, updated_at)
           SELECT project_id, NULL, 'synced', ? FROM projects WHERE project_id LIKE 'mobile-%'`,
        )
        .run(now);
      this.database
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(12, ?)")
        .run(now);
    })();
  }

  private migrateFeishuThreadToolbar(): void {
    const applied = this.database
      .prepare("SELECT 1 FROM schema_migrations WHERE version = 13")
      .get();
    if (applied) return;
    const columns = new Set(
      (
        this.database.prepare("PRAGMA table_info(feishu_thread_routes)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    if (!columns.has("toolbar_message_id")) {
      this.database.exec("ALTER TABLE feishu_thread_routes ADD COLUMN toolbar_message_id TEXT");
    }
    this.database
      .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(13, ?)")
      .run(new Date().toISOString());
  }
}

function toDesktopProjectSync(row: DesktopProjectSyncRow): DesktopProjectSyncRecord {
  return {
    projectId: row.project_id,
    sourceId: row.source_id,
    state: row.state,
    updatedAt: row.updated_at,
  };
}
