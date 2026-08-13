import path from "node:path";
import { stat } from "node:fs/promises";
import type { Logger } from "pino";
import type { ChannelAdapter } from "../channels/channel-adapter.js";
import {
  parseCardAction,
  renderHomeCard,
  renderModelListCard,
  renderProjectCreateCard,
  renderProjectListCard,
  renderTaskCenterCard,
  renderThreadListCard,
  type CardAction,
  type FeishuCard,
} from "../channels/feishu-card.js";
import type {
  CodexRunner,
  CodexThreadDetails,
  CodexThreadSummary,
} from "../codex/protocol-types.js";
import type { BridgeConfig, ProjectConfig } from "../config/schema.js";
import { renderFinalReply, splitMessage } from "../delivery/reply-renderer.js";
import { TaskStreamPump } from "../delivery/task-stream-pump.js";
import type { BridgeDatabase, ProjectRecord, ThreadIndexRecord } from "../persistence/database.js";
import type { DesktopProjectSource } from "../projects/codex-desktop-project-discovery.js";
import { ProjectManager } from "../projects/project-manager.js";
import { authorizeMessage } from "../security/authorization.js";
import { resolveProjectPath } from "../security/path-policy.js";
import {
  parseCommand,
  type ChatCommand,
  type ParsedCommand,
  type ProjectCommand,
} from "./command-router.js";
import { BridgeError } from "./errors.js";
import type { InboundCardAction, InboundEvent, InboundMessage, TaskRecord } from "./types.js";

const helpText = [
  "ClawBridge 命令",
  "/menu — 打开手机端交互控制台",
  "",
  "项目：",
  "/project list — 列出 Codex Desktop 项目及目录",
  "/project create <ID> [名称] — 在允许根目录中新建项目",
  "/project import <ID> <相对路径> [名称] — 导入已有目录",
  "/project use <名称|#编号|ID> — 切换项目并恢复该项目上次对话",
  "/project status — 查看当前项目与对话",
  "/project disable|enable <ID> — 停用或启用项目登记（不删除文件）",
  "",
  "对话：",
  "/chat new [名称] — 立即创建并选择新对话",
  "/chat list [archived|all] — 列出当前项目的对话",
  "/chat use <编号或ID> — 选择对话，后续普通消息会继续它",
  "/chat show <编号或ID> — 查阅对话历史",
  "/chat rename <编号或ID> <名称> — 重命名对话",
  "/chat archive|unarchive <编号或ID> — 归档或恢复对话",
  "/chat close — 释放当前对话供 Codex Desktop 使用（不删除历史）",
  "",
  "兼容命令：/projects、/use、/new、/threads、/resume、/status",
  "控制命令：/menu、/stop、/health、/help",
].join("\n");

export class Bridge {
  private startPromise: Promise<void> | undefined;
  private queueWorker: Promise<void> | undefined;
  private deliveryWorker: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private stopping = false;
  private deliveryTimer: NodeJS.Timeout | undefined;
  private readonly messageTails = new Map<string, Promise<void>>();
  private readonly immediateTasks = new Set<Promise<void>>();
  private readonly activeTasks = new Map<
    string,
    { taskId: string; projectId: string; threadId: string; turnId: string }
  >();
  private readonly projectManager: ProjectManager;
  private desktopProjectOrder: string[] = [];
  private readonly desktopProjectIds = new Set<string>();
  private readonly projectNumbers = new Map<string, number>();
  private desktopSyncWarning: string | undefined;
  private desktopRefreshPromise: Promise<void> | undefined;
  private codexClosing = false;

  constructor(
    private readonly dependencies: {
      channel: ChannelAdapter;
      codex: CodexRunner;
      database: BridgeDatabase;
      config: BridgeConfig;
      projects: ProjectConfig[];
      desktopProjects?: DesktopProjectSource;
      allowedOpenId: string;
      logger: Logger;
    },
  ) {
    this.projectManager = new ProjectManager(
      dependencies.database,
      dependencies.config.projectManagement,
    );
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    const start = this.startOnce();
    this.startPromise = start;
    return start;
  }

  private async startOnce(): Promise<void> {
    const { database, projects, channel, logger } = this.dependencies;
    const bootstrapProjects = await this.normalizeProjectRoots(projects);
    if (this.stopping) return;
    database.syncProjects(bootstrapProjects);
    await this.refreshDesktopProjects();
    if (this.stopping) return;
    await this.assertUniqueProjectRoots(database.listProjects());
    if (this.stopping) return;
    const interrupted = database.interruptRunningTasks();
    if (interrupted) logger.warn({ interrupted }, "Marked stale tasks as interrupted");
    const recoveredDeliveries = database.recoverSendingDeliveries();
    if (recoveredDeliveries) logger.warn({ recoveredDeliveries }, "Recovered in-flight deliveries");
    await channel.start((event) => this.onInboundEvent(event));
    if (this.stopping) {
      await channel.stop();
      return;
    }
    void this.drainQueue();
    void this.drainDeliveries();
    logger.info("ClawBridge started");
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    this.stopping = true;
    if (this.deliveryTimer) clearTimeout(this.deliveryTimer);
    await this.dependencies.channel.stop();
    if (this.startPromise) await Promise.allSettled([this.startPromise]);
    await this.dependencies.channel.stop();
    await this.dependencies.codex.stop();
    await Promise.allSettled([
      ...this.messageTails.values(),
      ...this.immediateTasks,
      ...(this.queueWorker ? [this.queueWorker] : []),
      ...(this.deliveryWorker ? [this.deliveryWorker] : []),
    ]);
    // A final stop closes the narrow race where an already-running handler passed its guard at
    // the same time shutdown began. Handlers also guard every post-await Codex call below.
    await this.dependencies.codex.stop();
    this.dependencies.database.close();
  }

  private async onInboundEvent(event: InboundEvent): Promise<void> {
    const { config, allowedOpenId, logger, database } = this.dependencies;
    if (this.stopping) return;
    try {
      if (allowedOpenId === "ou_pending_pairing" && event.chatType === "p2p") {
        logger.warn(
          { pairingCandidateOpenId: event.senderOpenId },
          "Pairing required: copy this Open ID into CLAWBRIDGE_FEISHU_ALLOWED_OPEN_ID and restart",
        );
        return;
      }
      if (!("text" in event)) {
        // card.action.trigger does not expose chat_type. Prove that the click
        // belongs to a card this Bridge successfully sent to the same chat,
        // then apply the sender allowlist without inventing a p2p classification.
        if (!database.isSentCardMessage(event.chatId, event.messageId, "p2p")) {
          throw new BridgeError("UNAUTHORIZED", "Card source is not recognized");
        }
        authorizeMessage(event, { allowedOpenId, directMessagesOnly: false });
      } else {
        if (event.chatType === "group") {
          authorizeMessage(event, { allowedOpenId, directMessagesOnly: false });
          const space = database.getFeishuProjectSpaceByChat(event.chatId);
          if (!space || space.ownerOpenId !== event.senderOpenId) {
            throw new BridgeError("UNAUTHORIZED", "Group workspace is not registered");
          }
          if (!event.topicRootId) {
            throw new BridgeError(
              "GROUP_DISABLED",
              "Send Codex tasks inside a registered project topic",
            );
          }
          const route = database.resolveFeishuThreadRoute(event.chatId, event.topicRootId);
          if (!route || route.ownerOpenId !== event.senderOpenId) {
            throw new BridgeError("UNAUTHORIZED", "Project topic is not registered");
          }
        } else {
          authorizeMessage(event, {
            allowedOpenId,
            directMessagesOnly: config.feishu.directMessagesOnly,
          });
        }
      }
      if (!database.recordInboundEvent(event)) {
        logger.info({ eventId: event.eventId }, "Ignored duplicate event");
        return;
      }

      if (!("text" in event)) {
        this.scheduleCardAction(event);
        return;
      }

      const command = parseCommand(event.text);
      if (command?.group === "control" && command.action === "stop") {
        if (this.codexClosing) {
          this.reply(event.chatId, "Codex 会话正在释放，无需再执行 /stop，请稍后查看结果。");
          return;
        }
        const task = this.runStop(event.chatId).catch((error: unknown) =>
          this.handleInboundError(event, error),
        );
        this.immediateTasks.add(task);
        void task.then(
          () => this.immediateTasks.delete(task),
          () => this.immediateTasks.delete(task),
        );
        return;
      }
      this.scheduleMessage(event);
    } catch (error) {
      logger.warn({ err: error, eventId: event.eventId }, "Rejected inbound event");
    }
  }

  private scheduleCardAction(event: InboundCardAction): void {
    const previous = this.messageTails.get(event.chatId) ?? Promise.resolve();
    const next = previous
      .then(() => this.processCardAction(event))
      .catch((error: unknown) => this.handleInboundError(event, error));
    this.messageTails.set(event.chatId, next);
    void next.finally(() => {
      if (this.messageTails.get(event.chatId) === next) this.messageTails.delete(event.chatId);
    });
  }

  private scheduleMessage(message: InboundMessage): void {
    const previous = this.messageTails.get(message.chatId) ?? Promise.resolve();
    const next = previous
      .then(() => this.processMessage(message))
      .catch((error: unknown) => this.handleInboundError(message, error));
    this.messageTails.set(message.chatId, next);
    void next.finally(() => {
      if (this.messageTails.get(message.chatId) === next) this.messageTails.delete(message.chatId);
    });
  }

  private handleInboundError(message: InboundEvent, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.dependencies.logger.warn({ err: error, eventId: message.eventId }, "Message failed");
    this.reply(message.chatId, `❌ ${detail}`);
  }

  private async processMessage(message: InboundMessage): Promise<void> {
    if (this.stopping) return;
    if (message.chatType === "group") {
      const route = this.dependencies.database.resolveFeishuThreadRoute(
        message.chatId,
        message.topicRootId!,
      );
      if (!route) throw new Error("项目话题尚未绑定 Codex 对话");
      this.dependencies.database.selectProject(message.chatId, route.projectId);
      this.dependencies.database.setThread(message.chatId, route.projectId, route.threadId);
    }
    const command = parseCommand(message.text);
    const requestsCardMenu =
      (command?.group === "control" && command.action === "menu") ||
      /^(菜单|控制台)$/i.test(message.text.trim());
    if (requestsCardMenu && message.chatType !== "p2p") {
      this.reply(message.chatId, "交互卡片仅支持机器人单聊，请在与机器人的单聊中发送“菜单”。");
      return;
    }
    if (this.codexClosing && !(command?.group === "chat" && command.action === "close")) {
      this.reply(message.chatId, "Codex 会话正在释放，请稍后重新发送命令或任务。");
      return;
    }
    if (command) {
      if (message.chatType === "group") {
        this.reply(
          message.chatId,
          "项目话题中请直接发送任务；项目、对话和系统管理请在机器人单聊控制台操作。",
        );
        return;
      }
      await this.executeCommand(message, command);
      return;
    }
    if (requestsCardMenu) {
      await this.showHomeCard(message.chatId);
      return;
    }
    await this.refreshDesktopProjects();
    this.assertNotStopping();
    this.enqueueTask(message);
  }

  private enqueueTask(message: InboundMessage): void {
    const { database, logger } = this.dependencies;
    if (this.codexClosing) {
      this.reply(message.chatId, "Codex 会话正在释放，请稍后重新发送任务。");
      return;
    }
    if (database.hasOpenTask(message.chatId)) {
      this.reply(
        message.chatId,
        "当前已有任务在排队或运行，请等待完成后再发送下一项任务；可用 /stop 停止正在运行的任务。",
      );
      return;
    }

    let conversation = database.getConversation(message.chatId);
    if (!conversation?.projectId) {
      const enabled = database.listProjects();
      if (enabled.length !== 1 || !enabled[0]) {
        this.reply(message.chatId, "请先使用 /project list 和 /project use <项目ID> 选择工作区。");
        return;
      }
      conversation = database.selectProject(message.chatId, enabled[0].id);
    }
    const projectId = conversation.projectId;
    if (!projectId) return;
    const project = database.getProject(projectId);
    if (!project?.enabled || !this.isDesktopProjectAuthorized(project)) {
      this.reply(message.chatId, "当前项目不存在或已停用，请先选择其他项目。");
      return;
    }

    const execution = conversation.threadId
      ? database.getThreadExecutionSettings(conversation.threadId)
      : undefined;
    const task = database.enqueue(message, projectId, conversation.threadId, execution ?? null);
    if (!task) {
      logger.info({ eventId: message.eventId }, "Ignored duplicate event");
      return;
    }
    this.reply(message.chatId, `📋 已入队：${task.id}`, task.id, task.replyToMessageId);
    void this.drainQueue();
  }

  private drainQueue(): Promise<void> {
    if (this.queueWorker) return this.queueWorker;
    if (this.stopping) return Promise.resolve();
    const worker = this.runQueueLoop();
    this.queueWorker = worker;
    void worker.then(
      () => {
        if (this.queueWorker === worker) this.queueWorker = undefined;
      },
      () => {
        if (this.queueWorker === worker) this.queueWorker = undefined;
      },
    );
    return worker;
  }

  private async runQueueLoop(): Promise<void> {
    try {
      let task: TaskRecord | undefined;
      while (!this.stopping && (task = this.dependencies.database.nextQueued())) {
        await this.runTask(task);
      }
    } catch (error) {
      this.dependencies.logger.error({ err: error }, "Queue worker failed");
      throw error;
    }
  }

  private async runTask(task: TaskRecord): Promise<void> {
    const { database, codex, config, logger, channel } = this.dependencies;
    await this.refreshDesktopProjects();
    this.assertNotStopping();
    const project = database.getProject(task.projectId);
    if (!project?.enabled || !this.isDesktopProjectAuthorized(project)) {
      database.updateTask(task.id, "failed", { error: "Project is unavailable" });
      this.reply(
        task.chatId,
        renderFinalReply({
          state: "failed",
          text: "项目不存在或已停用。",
          projectId:
            project?.name ??
            (task.projectId.startsWith("desktop@")
              ? "已撤销的 Codex Desktop 项目"
              : task.projectId),
        }),
        task.id,
        task.replyToMessageId,
      );
      return;
    }

    const threadId = task.threadId;
    let activeThreadId = threadId;
    let leasedThreadId = threadId;
    const holder = `task:${task.id}`;
    let streamId: string | undefined;
    let streamPump: TaskStreamPump | undefined;
    if (threadId && !database.acquireLease(threadId, holder, config.codex.turnTimeoutMs + 30_000)) {
      database.updateTask(task.id, "failed", { error: "Thread is already leased" });
      this.reply(
        task.chatId,
        renderFinalReply({
          state: "failed",
          text: "该对话正在被其他任务使用。",
          projectId: project.name,
          threadId,
        }),
        task.id,
        task.replyToMessageId,
      );
      return;
    }

    database.updateTask(task.id, "running", { ...(threadId ? { threadId } : {}) });
    try {
      if (channel.startTaskStream && channel.updateTaskStream) {
        try {
          const stream = await channel.startTaskStream({
            chatId: task.chatId,
            replyToMessageId: task.replyToMessageId,
            title: `${project.name} · 任务运行中`,
            initialText: "正在连接 Codex…",
          });
          streamId = stream.streamId;
          streamPump = new TaskStreamPump(
            (content) => channel.updateTaskStream!(stream.streamId, content),
            400,
          );
        } catch (error) {
          logger.warn({ err: error, taskId: task.id }, "Task streaming is unavailable");
        }
      }
      const cwd = await this.resolveRuntimeProjectPath(project.rootPath);
      this.assertNotStopping();
      const result = await codex.runTurn({
        cwd,
        prompt: task.prompt,
        threadId,
        approvalPolicy: config.codex.approvalPolicy,
        sandbox: config.codex.sandbox,
        ...(task.model ? { model: task.model } : {}),
        ...(task.reasoningEffort ? { reasoningEffort: task.reasoningEffort } : {}),
        onStarted: ({ threadId: startedThreadId, turnId }) => {
          activeThreadId = startedThreadId;
          database.upsertThread({
            threadId: startedThreadId,
            projectId: task.projectId,
            status: "active",
            lastSyncedAt: new Date().toISOString(),
          });
          database.setThread(task.chatId, task.projectId, startedThreadId);
          database.updateTask(task.id, "running", { threadId: startedThreadId });
          this.activeTasks.set(task.chatId, {
            taskId: task.id,
            projectId: task.projectId,
            threadId: startedThreadId,
            turnId,
          });
          if (!leasedThreadId) {
            database.acquireLease(startedThreadId, holder, config.codex.turnTimeoutMs + 30_000);
            leasedThreadId = startedThreadId;
          }
        },
        onProgress: (event) => {
          if (event.type === "assistantDelta") {
            const current = database.getTask(task.id)?.progressText ?? "";
            const next = `${current}${event.delta}`.slice(-30_000);
            database.updateTaskProgress(task.id, next, this.preview(next));
            streamPump?.push(next);
            return;
          }
          if (event.type === "plan") {
            const summary = event.steps
              .map((step) => `${step.status === "completed" ? "✓" : "·"} ${step.step}`)
              .join(" · ");
            database.updateTaskProgress(
              task.id,
              database.getTask(task.id)?.progressText ?? "",
              summary,
            );
            streamPump?.push(`**当前计划**\n${summary}`);
          }
        },
      });
      try {
        await streamPump?.close(result.finalText);
        if (streamId && channel.finishTaskStream) {
          await channel.finishTaskStream(streamId, `${project.name} · 已完成`);
        }
      } catch (streamError) {
        logger.warn({ err: streamError, taskId: task.id }, "Failed to finalize task stream");
      }
      database.upsertThread({
        threadId: result.threadId,
        projectId: task.projectId,
        status: "idle",
        preview: this.preview(result.finalText),
        lastSyncedAt: new Date().toISOString(),
      });
      database.setThread(task.chatId, task.projectId, result.threadId);
      database.updateTask(task.id, "completed", { threadId: result.threadId });
      this.reply(
        task.chatId,
        renderFinalReply({
          state: "completed",
          text: result.finalText,
          projectId: project.name,
          threadId: result.threadId,
        }),
        task.id,
        task.replyToMessageId,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      try {
        await streamPump?.close(`任务结束：${detail}`);
        if (streamId && channel.finishTaskStream) {
          await channel.finishTaskStream(streamId, `${project.name} · 任务结束`);
        }
      } catch (streamError) {
        logger.warn({ err: streamError, taskId: task.id }, "Failed to finalize task stream");
      }
      if (activeThreadId) {
        database.upsertThread({
          threadId: activeThreadId,
          projectId: task.projectId,
          status: "failed",
          lastSyncedAt: new Date().toISOString(),
        });
      }
      if (error instanceof BridgeError && error.code === "CODEX_INTERRUPTED") {
        logger.info({ taskId: task.id }, "Task cancelled");
        database.updateTask(task.id, "cancelled", { error: null });
        this.reply(
          task.chatId,
          renderFinalReply({
            state: "cancelled",
            text: "任务已停止。",
            projectId: project.name,
            threadId: activeThreadId,
          }),
          task.id,
          task.replyToMessageId,
        );
      } else {
        logger.error({ err: error, taskId: task.id }, "Task failed");
        database.updateTask(task.id, "failed", { error: detail });
        this.reply(
          task.chatId,
          renderFinalReply({
            state: "failed",
            text: detail,
            projectId: project.name,
            threadId: activeThreadId,
          }),
          task.id,
          task.replyToMessageId,
        );
      }
    } finally {
      if (activeThreadId && !this.stopping) {
        const released = await this.releaseThreadSubscription(activeThreadId, {
          context: "completed task",
          currentTaskId: task.id,
          maxMessageTails: 0,
          allowQueuedTasks: true,
        });
        if (!released) {
          this.reply(
            task.chatId,
            "⚠️ 任务已经结束，但 Codex 会话自动释放失败。请在没有其他任务运行时执行 /chat close，再到 Codex Desktop 打开该对话。",
            undefined,
            task.replyToMessageId,
          );
        }
      }
      if (this.activeTasks.get(task.chatId)?.taskId === task.id)
        this.activeTasks.delete(task.chatId);
      if (leasedThreadId) database.releaseLease(leasedThreadId, holder);
    }
  }

  private async executeCommand(message: InboundMessage, command: ParsedCommand): Promise<void> {
    if (command.group === "invalid") {
      this.reply(message.chatId, command.message);
      return;
    }
    if (command.group === "control") {
      if (command.action === "menu") await this.showHomeCard(message.chatId);
      else if (command.action === "help") this.reply(message.chatId, helpText);
      else if (command.action === "health")
        this.reply(message.chatId, "Bridge：正常\n数据库：正常\nCodex：按需启动");
      else await this.runStop(message.chatId);
      return;
    }
    if (command.group === "project") {
      await this.runProjectCommand(message.chatId, command);
      return;
    }
    if (command.action === "close") {
      await this.runChatClose(message.chatId);
      return;
    }
    await this.refreshDesktopProjects();
    this.assertNotStopping();
    await this.runChatCommand(message.chatId, command);
  }

  private async processCardAction(event: InboundCardAction): Promise<void> {
    if (this.stopping) return;
    const action = parseCardAction(event.value);
    if (this.codexClosing && action.action !== "chat.close" && action.action !== "menu.refresh") {
      throw new Error("Codex 会话正在释放，请稍后点击刷新。");
    }

    switch (action.action) {
      case "menu.refresh":
        await this.showHomeCard(event.chatId);
        return;
      case "project.list":
        await this.showProjectCard(event.chatId, action.page ?? 0);
        return;
      case "project.create.show":
        this.replyCard(event.chatId, renderProjectCreateCard(), "新建项目");
        return;
      case "project.create": {
        const rawName = event.formValue?.projectName;
        if (typeof rawName !== "string") throw new Error("请输入项目名称。");
        const name = rawName.trim();
        if (!name || name.length > 80 || /[\\/:*?"<>|\r\n]/.test(name)) {
          throw new Error("项目名称需为 1–80 个字符，且不能包含路径保留字符。 ");
        }
        const projectId = `mobile-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
        const project = await this.projectManager.createProject(projectId, name);
        this.dependencies.database.selectProject(event.chatId, project.id);
        await this.openProjectSpace(event.chatId, event.senderOpenId, project.id);
        return;
      }
      case "project.use":
        await this.runProjectCommand(event.chatId, {
          group: "project",
          action: "use",
          projectId: action.projectId,
          clearThread: false,
        });
        await this.showHomeCard(event.chatId, "项目已切换");
        return;
      case "project.space":
        await this.openProjectSpace(event.chatId, event.senderOpenId, action.projectId);
        return;
      case "thread.list":
        await this.ensureCardProjectSelected(event.chatId, action.projectId);
        await this.showThreadCard(event.chatId, action.projectId, action.page ?? 0);
        return;
      case "thread.use":
        await this.ensureCardProjectSelected(event.chatId, action.projectId);
        await this.runChatCommand(event.chatId, {
          group: "chat",
          action: "use",
          reference: action.threadId,
        });
        await this.showHomeCard(event.chatId, "对话已选择");
        return;
      case "thread.new":
        await this.ensureCardProjectSelected(event.chatId, action.projectId);
        await this.runChatCommand(event.chatId, {
          group: "chat",
          action: "new",
          lazy: false,
        });
        await this.openProjectSpace(event.chatId, event.senderOpenId, action.projectId);
        return;
      case "thread.show":
        await this.ensureCardProjectSelected(event.chatId, action.projectId);
        await this.runChatCommand(event.chatId, {
          group: "chat",
          action: "show",
          reference: action.threadId,
        });
        return;
      case "task.stop":
        await this.runStop(event.chatId);
        return;
      case "task.list":
        await this.showTaskCenter(event.chatId, action.projectId, action.page ?? 0);
        return;
      case "model.list":
        await this.showModelCard(event.chatId, action.projectId, action.threadId);
        return;
      case "model.use":
        await this.setModelSettings(event.chatId, action.projectId, action.threadId, action.model);
        return;
      case "reasoning.use":
        await this.setModelSettings(
          event.chatId,
          action.projectId,
          action.threadId,
          action.model,
          action.reasoningEffort,
        );
        return;
      case "chat.close":
        await this.runChatClose(event.chatId);
        return;
    }
  }

  private async ensureCardProjectSelected(chatId: string, projectId: string): Promise<void> {
    const conversation = this.dependencies.database.getConversation(chatId);
    if (conversation?.projectId === projectId) return;
    await this.runProjectCommand(chatId, {
      group: "project",
      action: "use",
      projectId,
      clearThread: false,
    });
  }

  private async openProjectSpace(
    controlChatId: string,
    ownerOpenId: string,
    projectId: string,
  ): Promise<void> {
    const { channel, database } = this.dependencies;
    const project = database.getProject(projectId);
    if (!project?.enabled || !this.isDesktopProjectAuthorized(project)) {
      throw new Error("项目不存在或已停用，请刷新项目列表。");
    }
    let space = database.getFeishuProjectSpace(projectId);
    if (!space) {
      if (!channel.createProjectSpace) throw new Error("当前消息通道不支持创建项目群。");
      const created = await channel.createProjectSpace({
        projectId,
        projectName: project.name,
        ownerOpenId,
        idempotencyKey: `clawbridge-project-${projectId}`,
      });
      space = database.bindFeishuProjectSpace({
        projectId,
        chatId: created.chatId,
        ownerOpenId,
        displayName: created.displayName,
      });
    }

    const selected = database.getConversation(controlChatId);
    const thread =
      selected?.projectId === projectId && selected.threadId
        ? database.getProjectThread(projectId, selected.threadId)
        : undefined;
    if (thread && !database.getFeishuThreadRoute(thread.threadId)) {
      if (!channel.createProjectTopic) throw new Error("当前消息通道不支持创建项目话题。");
      const created = await channel.createProjectTopic({
        chatId: space.chatId,
        title: thread.title || `对话 #${thread.localNumber}`,
        idempotencyKey: `clawbridge-thread-${thread.threadId}`,
      });
      database.bindFeishuThreadRoute({
        threadId: thread.threadId,
        projectId,
        chatId: space.chatId,
        topicRootId: created.topicRootId,
        ownerOpenId,
      });
      await this.showHomeCard(
        controlChatId,
        `项目群已就绪，对话 #${thread.localNumber} 已建立话题`,
      );
      return;
    }
    await this.showHomeCard(
      controlChatId,
      thread
        ? "项目群和当前对话话题已经存在"
        : "项目群已创建；选择一个对话后再次点击“项目群”建立话题",
    );
  }

  private async showHomeCard(chatId: string, notice?: string): Promise<void> {
    await this.refreshDesktopProjects();
    const { database } = this.dependencies;
    const conversation = database.getConversation(chatId);
    const project = conversation?.projectId
      ? database.getProject(conversation.projectId)
      : undefined;
    const thread =
      project && conversation?.threadId
        ? database.getProjectThread(project.id, conversation.threadId)
        : undefined;
    const active = this.activeTasks.get(chatId);
    const taskState = active
      ? "运行中"
      : database.hasOpenTask(chatId)
        ? "排队中"
        : this.codexClosing
          ? "正在交还 Desktop"
          : "空闲";
    this.replyCard(
      chatId,
      renderHomeCard({
        project: project ? { id: project.id, name: project.name } : null,
        thread: thread
          ? {
              id: thread.threadId,
              projectId: thread.projectId,
              localNumber: thread.localNumber,
              title: thread.title,
              preview: thread.preview,
              status: thread.status,
            }
          : null,
        taskState,
        ...(notice ? { notice } : {}),
      }),
      "ClawBridge 控制台",
    );
  }

  private async showProjectCard(chatId: string, requestedPage = 0): Promise<void> {
    await this.refreshDesktopProjects();
    const projects = this.orderedProjects(false);
    const totalPages = Math.max(1, Math.ceil(projects.length / 10));
    const page = Math.min(requestedPage, totalPages - 1);
    const offset = page * 10;
    const selectedProjectId = this.dependencies.database.getConversation(chatId)?.projectId ?? null;
    this.replyCard(
      chatId,
      renderProjectListCard({
        projects: projects
          .slice(offset, offset + 10)
          .map((project) => ({ id: project.id, name: project.name })),
        selectedProjectId,
        page,
        totalPages,
      }),
      "选择项目",
    );
  }

  private async showTaskCenter(
    chatId: string,
    projectId?: string,
    requestedPage = 0,
  ): Promise<void> {
    const { database } = this.dependencies;
    const project = projectId ? database.getProject(projectId) : undefined;
    if (projectId && !project) throw new Error("项目不存在，请刷新控制台。");
    const rows = database.listTasks({ ...(projectId ? { projectId } : {}), limit: 100 });
    const totalPages = Math.max(1, Math.ceil(rows.length / 10));
    const page = Math.min(requestedPage, totalPages - 1);
    this.replyCard(
      chatId,
      renderTaskCenterCard({
        tasks: rows.slice(page * 10, page * 10 + 10).map((task) => ({
          id: task.id,
          projectName: database.getProject(task.projectId)?.name ?? task.projectId,
          state: task.state,
          prompt: task.prompt,
          progressSummary: task.progressSummary,
          updatedAt: task.updatedAt,
        })),
        ...(project ? { project: { id: project.id, name: project.name } } : {}),
        page,
        totalPages,
      }),
      project ? "项目任务中心" : "全局任务中心",
    );
  }

  private async showModelCard(chatId: string, projectId: string, threadId: string): Promise<void> {
    const { database, codex } = this.dependencies;
    const conversation = database.getConversation(chatId);
    if (conversation?.projectId !== projectId || conversation.threadId !== threadId) {
      throw new Error("该卡片对应的项目或对话已不是当前选择，请返回控制台刷新。 ");
    }
    const project = database.getProject(projectId);
    const thread = database.getProjectThread(projectId, threadId);
    if (!project || !thread) throw new Error("当前对话不存在，请刷新控制台。 ");
    this.assertNotStopping();
    const models = await codex.listModels();
    this.assertNotStopping();
    const current = database.getThreadExecutionSettings(threadId);
    const defaultModel = models.find((model) => model.isDefault) ?? models[0];
    this.replyCard(
      chatId,
      renderModelListCard({
        project: { id: project.id, name: project.name },
        thread: {
          id: thread.threadId,
          projectId: thread.projectId,
          localNumber: thread.localNumber,
          title: thread.title,
        },
        models,
        selectedModel: current?.model ?? defaultModel?.model ?? null,
        selectedReasoningEffort:
          current?.reasoningEffort ?? defaultModel?.defaultReasoningEffort ?? null,
      }),
      "模型与推理强度",
    );
  }

  private async setModelSettings(
    chatId: string,
    projectId: string,
    threadId: string,
    requestedModel: string,
    requestedEffort?: string,
  ): Promise<void> {
    const { database, codex } = this.dependencies;
    const conversation = database.getConversation(chatId);
    if (conversation?.projectId !== projectId || conversation.threadId !== threadId) {
      throw new Error("该卡片已过期，请返回控制台重新打开模型设置。 ");
    }
    this.assertNotStopping();
    const models = await codex.listModels();
    this.assertNotStopping();
    const model = models.find((entry) => entry.model === requestedModel);
    if (!model) throw new Error("该模型当前不可用，请刷新模型列表。 ");
    const existing = database.getThreadExecutionSettings(threadId);
    const effort =
      requestedEffort ??
      (existing?.model === model.model ? existing.reasoningEffort : model.defaultReasoningEffort);
    if (!model.supportedReasoningEfforts.some((entry) => entry.reasoningEffort === effort)) {
      throw new Error("该推理强度不受当前模型支持，请重新选择。 ");
    }
    database.setThreadExecutionSettings(threadId, model.model, effort);
    await this.showModelCard(chatId, projectId, threadId);
  }

  private async showThreadCard(
    chatId: string,
    projectId: string,
    requestedPage = 0,
  ): Promise<void> {
    const { database } = this.dependencies;
    const project = database.getProject(projectId);
    if (!project?.enabled || !this.isDesktopProjectAuthorized(project)) {
      throw new Error("项目不存在或已停用，请刷新项目列表。");
    }
    const projectRoot = await this.resolveRuntimeProjectPath(project.rootPath);
    this.assertNotStopping();
    await this.refreshThreadList(project, projectRoot);
    const rows = database
      .listProjectThreads(project.id, { includeArchived: false })
      .filter((row) => !row.archived);
    const totalPages = Math.max(1, Math.ceil(rows.length / 10));
    const page = Math.min(requestedPage, totalPages - 1);
    const offset = page * 10;
    const selectedThreadId = database.getConversation(chatId)?.threadId ?? null;
    this.replyCard(
      chatId,
      renderThreadListCard({
        project: { id: project.id, name: project.name },
        threads: rows.slice(offset, offset + 10).map((row) => ({
          id: row.threadId,
          projectId: row.projectId,
          localNumber: row.localNumber,
          title: row.title,
          preview: row.preview,
          status: this.statusLabel(row.status),
        })),
        selectedThreadId,
        page,
        totalPages,
      }),
      `选择 ${project.name} 的对话`,
    );
  }

  private async runChatClose(chatId: string): Promise<void> {
    if (this.codexClosing) throw new Error("Codex 会话正在释放，请稍后重试 /chat close。");
    this.codexClosing = true;
    const { database, codex, logger } = this.dependencies;
    try {
      if (this.messageTails.size > 1) {
        throw new Error("其他飞书消息仍在处理中，暂时不能释放 Codex 会话，请稍后重试。");
      }
      if (this.immediateTasks.size > 0) {
        throw new Error("停止任务的请求仍在处理中，暂时不能释放 Codex 会话，请稍后重试。");
      }
      if (database.hasAnyOpenTask()) {
        throw new Error(
          "仍有任务正在排队或运行，不能释放 Codex 会话。请先等待任务结束，或使用 /stop 停止当前任务后再执行 /chat close。",
        );
      }

      // A task marks its database row terminal before running its final unsubscribe/release work.
      // Wait for that worker to settle so close cannot race the task's App Server cleanup.
      if (this.queueWorker) await this.queueWorker;

      const conversation = database.getConversation(chatId);
      const threadId = conversation?.threadId ?? null;
      if (threadId) {
        try {
          const status = await codex.unsubscribeThread(threadId);
          logger.info({ chatId, threadId, status }, "Unsubscribed Codex thread before close");
        } catch (error) {
          // Stopping the on-demand App Server below is the authoritative immediate release. A
          // failed unsubscribe is therefore logged but does not leave the user permanently stuck.
          logger.warn({ err: error, chatId, threadId }, "Could not unsubscribe Codex thread");
        }
      }

      // No new task can be enqueued while codexClosing is true. Recheck after the protocol await
      // to cover a task that was already queued by another handler before close began.
      if (database.hasAnyOpenTask()) {
        throw new Error("释放期间出现了新的排队或运行任务，已取消关闭，请稍后重试。");
      }
      await codex.stop();
      if (conversation?.projectId) database.clearThread(chatId, conversation.projectId);
      this.reply(
        chatId,
        threadId
          ? "✅ 当前飞书对话已关闭并释放给 Codex Desktop。历史记录未删除；下次请用 /chat use <编号或ID> 重新选择，或用 /chat new 创建新对话。"
          : "✅ 当前没有绑定对话；空闲的 Codex App Server 已关闭。历史记录未删除。",
      );
    } finally {
      this.codexClosing = false;
    }
  }

  private async runProjectCommand(chatId: string, command: ProjectCommand): Promise<void> {
    const { database } = this.dependencies;
    if (command.action === "list") {
      await this.refreshDesktopProjects();
      const currentProjectId = database.getConversation(chatId)?.projectId;
      const projects = this.orderedProjects(true);
      const text = projects
        .map((project) => {
          const marker = project.id === currentProjectId ? "▶" : " ";
          const state = project.enabled ? "启用" : "停用";
          const source = this.desktopProjectIds.has(project.id) ? "Codex Desktop" : "ClawBridge";
          return `${marker} #${this.ensureProjectNumber(project.id)} ${project.name} [${source} · ${state}]\n   ${project.rootPath}`;
        })
        .join("\n");
      const warning = this.desktopSyncWarning ? `\n\n⚠️ ${this.desktopSyncWarning}` : "";
      this.reply(chatId, `${text || "尚未发现项目。"}${warning}`);
      return;
    }

    if (command.action === "status") {
      await this.refreshDesktopProjects();
      this.assertNotStopping();
      const conversation = database.getConversation(chatId);
      if (!conversation?.projectId) {
        this.reply(chatId, "尚未选择项目。");
        return;
      }
      const project = database.getProject(conversation.projectId);
      const authorized = project ? this.isDesktopProjectAuthorized(project) : false;
      const thread = conversation.threadId
        ? database.getProjectThread(conversation.projectId, conversation.threadId)
        : undefined;
      this.reply(
        chatId,
        [
          `项目：${project ? this.projectLabel(project) : conversation.projectId}`,
          `项目编号：${project ? `#${this.ensureProjectNumber(project.id)}` : "未知"}`,
          `目录：${project?.rootPath ?? "未知"}`,
          `状态：${project?.enabled === false || !authorized ? "停用" : "启用"}`,
          `对话：${thread ? `#${thread.localNumber} ${thread.title ?? thread.threadId}` : (conversation.threadId ?? "未创建")}`,
        ].join("\n"),
      );
      return;
    }

    if (command.action === "create") {
      const project = await this.projectManager.createProject(command.projectId, command.name);
      this.reply(
        chatId,
        `✅ 已创建项目 ${project.name} (${project.id})\n目录：${project.rootPath}\n使用 /project use ${project.id} 切换到该项目。`,
      );
      return;
    }

    if (command.action === "import") {
      const project = await this.projectManager.importProject(
        command.projectId,
        command.relativePath,
        command.name,
      );
      this.reply(
        chatId,
        `✅ 已导入项目 ${project.name} (${project.id})\n目录：${project.rootPath}\n使用 /project use ${project.id} 切换到该项目。`,
      );
      return;
    }

    if (command.action === "use") {
      this.assertNoOpenTask(chatId, "切换项目");
      await this.refreshDesktopProjects();
      const project = this.resolveProjectReference(command.projectId);
      if (!project?.enabled) throw new Error("项目不存在或未启用，请先使用 /project list 查看。");
      if (command.clearThread) {
        database.bindProject(chatId, project.id);
        this.reply(
          chatId,
          `已切换到 ${project.name}\n目录：${project.rootPath}\n下一条任务将创建新对话。`,
        );
        return;
      }
      const projectRoot = await this.resolveRuntimeProjectPath(project.rootPath);
      this.assertNotStopping();
      const savedThreadId = database.getProjectState(chatId, project.id)?.threadId;
      if (savedThreadId) {
        try {
          await this.refreshThreadList(project, projectRoot);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          database.selectProject(chatId, project.id);
          this.reply(
            chatId,
            `已切换到 ${this.projectLabel(project)}，但 Codex 暂时无法验证之前保存的对话（${detail}）。绑定仍保留，请稍后重试 /project use "${project.name}"。`,
          );
          return;
        }
        const savedRecord = database.getProjectThread(project.id, savedThreadId);
        if (savedRecord?.archived) {
          database.selectProject(chatId, project.id);
          database.clearThread(chatId, project.id);
          this.reply(
            chatId,
            `已切换到 ${this.projectLabel(project)}，但之前保存的对话已经归档，绑定已清除。可用 /chat list archived 查看并恢复。`,
          );
          return;
        }

        let savedSummary: CodexThreadSummary;
        try {
          this.assertNotStopping();
          savedSummary = await this.dependencies.codex.readThread(savedThreadId);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          database.selectProject(chatId, project.id);
          if (this.isMissingThreadError(error)) {
            database.clearThread(chatId, project.id);
            this.reply(
              chatId,
              `已切换到 ${this.projectLabel(project)}，但之前保存的对话已不存在（${detail}），绑定已清除。可用 /chat list 或 /chat new 重新选择。`,
            );
          } else {
            this.reply(
              chatId,
              `已切换到 ${this.projectLabel(project)}，但 Codex 暂时无法读取之前保存的对话（${detail}）。绑定仍保留，请稍后重试。`,
            );
          }
          return;
        }
        if (!savedSummary.cwd || !this.samePath(savedSummary.cwd, projectRoot)) {
          database.selectProject(chatId, project.id);
          database.clearThread(chatId, project.id);
          this.reply(
            chatId,
            `已切换到 ${this.projectLabel(project)}，但之前保存的对话不属于该项目，绑定已清除。`,
          );
          return;
        }
        try {
          this.assertThreadIdle(savedThreadId, savedSummary);
          this.indexThread(project.id, savedSummary, false);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          database.selectProject(chatId, project.id);
          this.reply(
            chatId,
            `已切换到 ${this.projectLabel(project)}，保存的对话仍保留，但暂时不能继续（${detail}）。`,
          );
          return;
        }
      }
      const state = database.selectProject(chatId, project.id);
      const thread = state.threadId
        ? database.getProjectThread(project.id, state.threadId)
        : undefined;
      this.reply(
        chatId,
        thread
          ? `已切换到 ${this.projectLabel(project)}\n目录：${project.rootPath}\n已恢复对话 #${thread.localNumber}：${thread.title ?? thread.threadId}`
          : `已切换到 ${this.projectLabel(project)}\n目录：${project.rootPath}\n该项目尚未选择对话。可用 /chat new 创建。`,
      );
      return;
    }

    if (command.action !== "disable" && command.action !== "enable") return;
    await this.refreshDesktopProjects();
    const project = this.resolveProjectReference(command.projectId);
    if (!project) throw new Error("项目不存在。");
    if (command.action === "disable") {
      if (project.id.startsWith("desktop@") || this.desktopProjectIds.has(project.id)) {
        throw new Error("该项目由 Codex Desktop 自动管理；请在 Codex Desktop 中移除项目。");
      }
      if (database.hasOpenTaskForProject(project.id))
        throw new Error("该项目仍有排队或运行中的任务，不能停用。");
      database.setProjectEnabled(project.id, false);
      this.reply(
        chatId,
        `已停用项目 ${project.name} (${project.id})。项目目录和对话历史均未删除。`,
      );
      return;
    }
    if (project.id.startsWith("desktop@")) {
      throw new Error("该项目由 Codex Desktop 自动管理；重新加入 Desktop 后会自动启用。");
    }
    await this.assertUniqueProjectRoots([
      ...database.listProjects().filter((enabled) => enabled.id !== project.id),
      { ...project, enabled: true },
    ]);
    database.setProjectEnabled(project.id, true);
    this.reply(chatId, `已启用项目 ${project.name} (${project.id})。`);
  }

  private async runChatCommand(
    chatId: string,
    command: Exclude<ChatCommand, { action: "close" }>,
  ): Promise<void> {
    const { database, codex, config } = this.dependencies;
    const project = this.currentProject(chatId);
    const projectRoot = await this.resolveRuntimeProjectPath(project.rootPath);
    this.assertNotStopping();

    if (command.action === "new") {
      this.assertNoOpenTask(chatId, "创建新对话");
      if (command.lazy) {
        database.clearThread(chatId, project.id);
        this.reply(chatId, "当前对话已解除绑定，下一条普通消息将创建新对话。");
        return;
      }
      if (command.title && command.title.length > 120)
        throw new Error("对话名称不能超过 120 个字符。");
      const summary = await codex.startThread({
        cwd: projectRoot,
        approvalPolicy: config.codex.approvalPolicy,
        sandbox: config.codex.sandbox,
      });
      let record: ThreadIndexRecord | undefined;
      try {
        try {
          this.validateThreadProject(summary, projectRoot);
          record = this.indexThread(project.id, summary, false);
          database.setThread(chatId, project.id, summary.id);
        } catch (error) {
          let compensation = "已尝试将它归档";
          if (this.stopping) {
            compensation = "Bridge 正在停止，未重新启动 App Server 执行自动归档";
          } else {
            try {
              await codex.archiveThread(summary.id);
            } catch {
              compensation = "自动归档也失败";
            }
          }
          throw new Error(`Codex 已创建对话 ${summary.id}，但本地登记失败；${compensation}。`, {
            cause: error,
          });
        }
        if (command.title) {
          try {
            this.assertNotStopping();
            await codex.nameThread(summary.id, command.title);
            record = database.upsertThread({
              threadId: summary.id,
              projectId: project.id,
              title: command.title,
              lastSyncedAt: new Date().toISOString(),
            });
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.reply(
              chatId,
              `⚠️ 已创建并选择对话 #${record.localNumber}（${summary.id}），但命名失败：${detail}\n对话仍可正常使用，可稍后执行 /chat rename ${record.localNumber} <名称>。`,
            );
            return;
          }
        }
        this.reply(
          chatId,
          `✅ 已创建并选择对话 #${record.localNumber}：${record.title ?? "未命名对话"}\n后续普通消息会继续这个对话。`,
        );
        return;
      } finally {
        if (!this.stopping) {
          const released = await this.releaseThreadSubscription(summary.id, {
            context: "new chat",
            maxMessageTails: 1,
            allowQueuedTasks: false,
          });
          if (!released && record) {
            this.reply(
              chatId,
              "⚠️ 新对话已经创建，但 Codex 会话自动释放失败。需要在 Desktop 打开时，请先执行 /chat close。",
            );
          }
        }
      }
    }

    if (command.action === "list") {
      await this.refreshThreadList(project, projectRoot);
      const rows = database
        .listProjectThreads(project.id, {
          includeArchived: command.mode !== "current",
          ...(command.mode === "archived" ? {} : { limit: 50 }),
        })
        .filter((row) =>
          command.mode === "archived"
            ? row.archived
            : command.mode === "current"
              ? !row.archived
              : true,
        )
        .slice(0, 50);
      const selected = database.getConversation(chatId)?.threadId;
      const text = rows
        .map((row) => this.formatThreadRow(row, row.threadId === selected))
        .join("\n");
      this.reply(
        chatId,
        text ||
          (command.mode === "archived"
            ? "当前项目没有已归档对话。"
            : "当前项目还没有对话，可用 /chat new 创建。"),
      );
      return;
    }

    if (command.action === "unarchive") await this.refreshThreadList(project, projectRoot);
    const { record, summary } = await this.resolveThread(
      project,
      projectRoot,
      command.reference,
      true,
    );

    if (command.action === "show") {
      this.assertNotStopping();
      const details = await codex.readThreadDetails(record.threadId, true);
      this.validateThreadProject(details, projectRoot);
      this.indexThread(project.id, details, record.archived);
      this.reply(chatId, this.renderThreadDetails(record, details));
      return;
    }

    if (command.action === "use") {
      this.assertNoOpenTask(chatId, "切换对话");
      if (record.archived) throw new Error("该对话已归档，请先使用 /chat unarchive 恢复。");
      this.assertThreadIdle(record.threadId, summary);
      database.setThread(chatId, project.id, record.threadId);
      this.reply(
        chatId,
        `已选择对话 #${record.localNumber}：${record.title ?? record.threadId}\n下一条普通消息将继续该对话。`,
      );
      return;
    }

    if (command.action === "rename") {
      if (command.title.length > 120) throw new Error("对话名称不能超过 120 个字符。");
      this.assertThreadIdle(record.threadId, summary);
      this.assertNotStopping();
      await codex.nameThread(record.threadId, command.title);
      const renamed = database.upsertThread({
        threadId: record.threadId,
        projectId: project.id,
        title: command.title,
        lastSyncedAt: new Date().toISOString(),
      });
      this.reply(chatId, `已将对话 #${renamed.localNumber} 重命名为：${command.title}`);
      return;
    }

    if (command.action === "archive") {
      if (record.archived) throw new Error("该对话已经归档。");
      this.assertThreadIdle(record.threadId, summary);
      this.assertNotStopping();
      await codex.archiveThread(record.threadId);
      database.upsertThread({
        threadId: record.threadId,
        projectId: project.id,
        archived: true,
        status: "archived",
        lastSyncedAt: new Date().toISOString(),
      });
      if (database.getConversation(chatId)?.threadId === record.threadId) {
        database.clearThread(chatId, project.id);
      }
      try {
        await this.refreshThreadList(project, projectRoot);
      } catch (error) {
        this.dependencies.logger.warn(
          { err: error, projectId: project.id, threadId: record.threadId },
          "Could not reconcile thread archive state",
        );
      }
      this.reply(
        chatId,
        `已归档对话 #${record.localNumber}。如需恢复：/chat unarchive ${record.localNumber}`,
      );
      return;
    }

    this.assertNotStopping();
    const restoredResult = await codex.unarchiveThread(record.threadId);
    this.assertNotStopping();
    const restored = restoredResult.cwd
      ? restoredResult
      : await codex.readThread(restoredResult.id);
    this.validateThreadProject(restored, projectRoot);
    const restoredRecord = this.indexThread(project.id, restored, false);
    this.reply(
      chatId,
      `已恢复对话 #${restoredRecord.localNumber}，但未自动切换。使用 /chat use ${restoredRecord.localNumber} 选择它。`,
    );
  }

  private async refreshThreadList(project: ProjectRecord, projectRoot: string): Promise<void> {
    this.assertNotStopping();
    const requests: Array<Promise<{ archived: boolean; threads: CodexThreadSummary[] }>> = [
      this.dependencies.codex
        .listThreads({ cwd: projectRoot, limit: 50, archived: false })
        .then((threads) => ({ archived: false, threads })),
      this.dependencies.codex
        .listThreads({ cwd: projectRoot, limit: 50, archived: true })
        .then((threads) => ({ archived: true, threads })),
    ];
    for (const result of await Promise.all(requests)) {
      for (const summary of result.threads) {
        if (summary.cwd && this.samePath(summary.cwd, projectRoot)) {
          this.indexThread(project.id, summary, result.archived);
        }
      }
    }
  }

  private async resolveThread(
    project: ProjectRecord,
    projectRoot: string,
    reference: string,
    includeArchived: boolean,
  ): Promise<{ record: ThreadIndexRecord; summary: CodexThreadSummary }> {
    const normalizedReference = reference.startsWith("#") ? reference.slice(1) : reference;
    let record: ThreadIndexRecord | undefined;
    if (/^\d+$/.test(normalizedReference)) {
      record = this.dependencies.database.getProjectThreadByNumber(
        project.id,
        Number(normalizedReference),
      );
      if (!record) throw new Error(`当前项目没有编号为 #${normalizedReference} 的对话。`);
    } else {
      record = this.dependencies.database.getProjectThread(project.id, normalizedReference);
      if (!record && normalizedReference.length >= 8) {
        const matches = this.dependencies.database
          .listProjectThreads(project.id, { includeArchived: true })
          .filter((candidate) => candidate.threadId.startsWith(normalizedReference));
        if (matches.length > 1) throw new Error("对话 ID 前缀不唯一，请输入更长的 ID。");
        record = matches[0];
      }
    }

    const threadId = record?.threadId ?? normalizedReference;
    let summary: CodexThreadSummary;
    try {
      this.assertNotStopping();
      summary = await this.dependencies.codex.readThread(threadId);
    } catch (error) {
      if (!record) throw new Error("没有找到该对话。", { cause: error });
      throw error;
    }
    this.validateThreadProject(summary, projectRoot);
    record = this.indexThread(project.id, summary, record?.archived ?? false);
    if (!includeArchived && record.archived) throw new Error("该对话已归档。");
    return { record, summary };
  }

  private indexThread(
    projectId: string,
    summary: CodexThreadSummary,
    archived: boolean,
  ): ThreadIndexRecord {
    const now = new Date().toISOString();
    return this.dependencies.database.upsertThread({
      threadId: summary.id,
      projectId,
      title: summary.name,
      preview: summary.preview,
      status: summary.status,
      archived,
      updatedAt: this.codexTimestamp(summary.updatedAt) ?? now,
      lastSyncedAt: now,
    });
  }

  private renderThreadDetails(record: ThreadIndexRecord, details: CodexThreadDetails): string {
    const messages = details.turns.flatMap((turn) => turn.messages);
    const visible = messages.slice(-20);
    const lines = [
      `对话 #${record.localNumber}：${details.name ?? record.title ?? "未命名对话"}`,
      `ID：${details.id}`,
      `状态：${this.statusLabel(details.status)}${record.archived ? " / 已归档" : ""}`,
      "",
    ];
    if (messages.length > visible.length)
      lines.push(`（共 ${messages.length} 条消息，仅显示最近 ${visible.length} 条）`, "");
    if (visible.length === 0) lines.push("该对话还没有文本消息。");
    for (const message of visible) {
      const label = message.role === "user" ? "👤 你" : "🤖 Codex";
      const text = message.text.length > 2_000 ? `${message.text.slice(0, 2_000)}…` : message.text;
      lines.push(`${label}：`, text, "");
    }
    return lines.join("\n").trimEnd();
  }

  private formatThreadRow(record: ThreadIndexRecord, selected: boolean): string {
    const marker = selected ? "▶" : " ";
    const status = record.archived ? "已归档" : this.statusLabel(record.status);
    const title = record.title || this.preview(record.preview ?? "") || "未命名对话";
    return `${marker} #${record.localNumber} [${status}] ${title}\n   ${record.threadId}`;
  }

  private currentProject(chatId: string): ProjectRecord {
    const conversation = this.dependencies.database.getConversation(chatId);
    if (!conversation?.projectId) throw new Error("尚未选择项目，请先使用 /project use <项目ID>。");
    const project = this.dependencies.database.getProject(conversation.projectId);
    if (!project?.enabled) throw new Error("当前项目不存在或已停用，请先选择其他项目。");
    return project;
  }

  private validateThreadProject(thread: CodexThreadSummary, projectRoot: string): void {
    if (!thread.cwd || !this.samePath(thread.cwd, projectRoot)) {
      throw new Error("该对话不属于当前项目。");
    }
  }

  private assertNoOpenTask(chatId: string, action: string): void {
    if (this.dependencies.database.hasOpenTask(chatId)) {
      throw new Error(`当前仍有排队或运行中的任务，不能${action}。请等待完成或使用 /stop。`);
    }
  }

  private assertThreadIdle(threadId: string, summary: CodexThreadSummary): void {
    if (
      summary.status === "active" ||
      this.dependencies.database.hasOpenTaskForThread(threadId) ||
      this.dependencies.database.isThreadLeased(threadId) ||
      [...this.activeTasks.values()].some((task) => task.threadId === threadId)
    ) {
      throw new Error("该对话正在执行任务，暂时不能进行此操作。");
    }
  }

  private async releaseThreadSubscription(
    threadId: string,
    options: {
      context: string;
      currentTaskId?: string;
      maxMessageTails: number;
      allowQueuedTasks: boolean;
    },
  ): Promise<boolean> {
    const { codex, database, logger } = this.dependencies;
    try {
      const status = await codex.unsubscribeThread(threadId);
      logger.info(
        { threadId, status, context: options.context },
        "Released Codex thread subscription",
      );
      return true;
    } catch (error) {
      logger.warn(
        { err: error, threadId, context: options.context },
        "Could not unsubscribe Codex thread",
      );
    }

    const hasOtherActiveTask = [...this.activeTasks.values()].some(
      (task) => task.taskId !== options.currentTaskId,
    );
    const canStopAppServer =
      !this.stopping &&
      !this.codexClosing &&
      this.immediateTasks.size === 0 &&
      this.messageTails.size <= options.maxMessageTails &&
      !hasOtherActiveTask &&
      (options.allowQueuedTasks || !database.hasAnyOpenTask());
    if (!canStopAppServer) return false;

    this.codexClosing = true;
    try {
      await codex.stop();
      logger.warn(
        { threadId, context: options.context },
        "Stopped idle Codex App Server after unsubscribe failure",
      );
      return true;
    } catch (error) {
      logger.error(
        { err: error, threadId, context: options.context },
        "Could not stop Codex App Server after unsubscribe failure",
      );
      return false;
    } finally {
      this.codexClosing = false;
    }
  }

  private async runStop(chatId: string): Promise<void> {
    if (this.stopping) return;
    const active = this.activeTasks.get(chatId);
    if (!active) {
      this.reply(
        chatId,
        this.dependencies.database.hasOpenTask(chatId)
          ? "任务仍在等待 Codex 启动，暂时还没有可中断的回合，请稍后重试 /stop。"
          : "当前没有可停止的活动任务。",
      );
      return;
    }
    await this.dependencies.codex.interrupt(active.threadId, active.turnId);
    this.reply(chatId, `🛑 已请求停止任务：${active.taskId}`);
  }

  private samePath(left: string, right: string): boolean {
    const normalizedLeft = path.resolve(left);
    const normalizedRight = path.resolve(right);
    return process.platform === "win32"
      ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
      : normalizedLeft === normalizedRight;
  }

  private resolveRuntimeProjectPath(rootPath: string): Promise<string> {
    return resolveProjectPath(rootPath);
  }

  private assertNotStopping(): void {
    if (this.stopping) {
      throw new BridgeError("CODEX_INTERRUPTED", "ClawBridge 正在停止，已取消新的 Codex 操作。");
    }
  }

  private codexTimestamp(value: number | null): string | undefined {
    if (value === null || !Number.isFinite(value)) return undefined;
    const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }

  private preview(text: string): string {
    return text.replace(/\s+/g, " ").trim().slice(0, 160);
  }

  private statusLabel(status: string | null): string {
    switch (status) {
      case "active":
        return "运行中";
      case "archived":
        return "已归档";
      case "failed":
        return "上次失败";
      case "idle":
      case "notLoaded":
        return "空闲";
      default:
        return status || "未知";
    }
  }

  private reply(
    chatId: string,
    text: string,
    taskId?: string,
    replyToMessageId?: string | null,
  ): void {
    const chunks = splitMessage(text);
    chunks.forEach((body, sequence) =>
      this.dependencies.database.queueOutbound(
        {
          chatId,
          kind: "text",
          text: body,
          ...(replyToMessageId ? { replyToMessageId } : {}),
        },
        { sequence, ...(taskId ? { taskId } : {}) },
      ),
    );
    void this.drainDeliveries();
  }

  private replyCard(chatId: string, card: FeishuCard, fallbackText: string): void {
    this.dependencies.database.queueOutbound({
      kind: "card",
      chatId,
      audience: "p2p",
      text: fallbackText,
      card: card as unknown as Record<string, unknown>,
    });
    void this.drainDeliveries();
  }

  private drainDeliveries(): Promise<void> {
    if (this.deliveryWorker) return this.deliveryWorker;
    if (this.stopping) return Promise.resolve();
    const worker = this.runDeliveryLoop();
    this.deliveryWorker = worker;
    void worker.then(
      () => {
        if (this.deliveryWorker === worker) this.deliveryWorker = undefined;
      },
      () => {
        if (this.deliveryWorker === worker) this.deliveryWorker = undefined;
      },
    );
    return worker;
  }

  private async runDeliveryLoop(): Promise<void> {
    try {
      let delivery = this.dependencies.database.claimNextDelivery();
      while (!this.stopping && delivery) {
        try {
          const channelMessageId = await this.dependencies.channel.send(delivery.message);
          this.dependencies.database.markDeliverySent(delivery.id, channelMessageId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const baseDelay = this.dependencies.config.bridge.deliveryRetryBaseMs;
          const delay = Math.min(baseDelay * 2 ** Math.max(0, delivery.attempts - 1), 60_000);
          const state = this.dependencies.database.markDeliveryFailed(
            delivery.id,
            message,
            new Date(Date.now() + delay),
            this.dependencies.config.bridge.deliveryMaxAttempts,
          );
          this.dependencies.logger.warn(
            { err: error, deliveryId: delivery.id, attempts: delivery.attempts, state },
            "Delivery failed",
          );
          if (state === "retry") {
            this.scheduleDeliveryDrain(delay);
            return;
          }
        }
        delivery = this.dependencies.database.claimNextDelivery();
      }
    } catch (error) {
      this.dependencies.logger.error({ err: error }, "Delivery worker failed");
      throw error;
    }
  }

  private scheduleDeliveryDrain(delayMs: number): void {
    if (this.deliveryTimer) clearTimeout(this.deliveryTimer);
    this.deliveryTimer = setTimeout(() => {
      this.deliveryTimer = undefined;
      void this.drainDeliveries();
    }, delayMs);
    this.deliveryTimer.unref();
  }

  private refreshDesktopProjects(): Promise<void> {
    const source = this.dependencies.desktopProjects;
    if (!source) return Promise.resolve();
    if (this.desktopRefreshPromise) return this.desktopRefreshPromise;

    const refresh = this.refreshDesktopProjectsOnce(source).finally(() => {
      if (this.desktopRefreshPromise === refresh) this.desktopRefreshPromise = undefined;
    });
    this.desktopRefreshPromise = refresh;
    return refresh;
  }

  private async refreshDesktopProjectsOnce(source: DesktopProjectSource): Promise<void> {
    try {
      const snapshot = await source.listProjects();
      if (snapshot.usedBackup) {
        this.revokeDesktopProjectSnapshot(
          "Codex Desktop 主状态文件不可用；为避免沿用过期授权，备份项目不会用于执行",
        );
        return;
      }
      const registrations: Array<{ sourceId: string; name: string; rootPath: string }> = [];
      const warnings: string[] = [];
      for (const project of snapshot.projects) {
        const primaryRoot = project.rootPaths[0];
        if (!primaryRoot || !path.isAbsolute(primaryRoot)) {
          warnings.push(`${project.name} 没有有效的绝对主目录`);
          continue;
        }
        if (project.rootPaths.length > 1) {
          warnings.push(`${project.name} 含多个目录，当前使用主目录 ${primaryRoot}`);
        }
        try {
          const resolvedRoot = await resolveProjectPath(primaryRoot);
          if (!(await stat(resolvedRoot)).isDirectory()) {
            throw new Error("主路径不是目录");
          }
          registrations.push({
            sourceId: project.sourceId,
            name: project.name,
            rootPath: resolvedRoot,
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          warnings.push(`${project.name} 的目录不可用（${detail}）`);
        }
      }
      if (snapshot.projects.length > 0 && registrations.length === 0) {
        throw new Error("没有任何 Codex Desktop 项目拥有可用的主目录");
      }

      const records = this.dependencies.database.syncDesktopProjects(registrations);
      this.desktopProjectOrder = records.map((record) => record.id);
      for (const record of records) this.ensureProjectNumber(record.id);
      this.desktopProjectIds.clear();
      for (const record of records) this.desktopProjectIds.add(record.id);
      this.desktopSyncWarning = warnings.length > 0 ? warnings.join("；") : undefined;
      this.dependencies.logger.info(
        {
          discovered: snapshot.projects.length,
          synchronized: records.length,
          usedBackup: snapshot.usedBackup,
        },
        "Synchronized Codex Desktop projects",
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.revokeDesktopProjectSnapshot(`Codex Desktop 项目同步失败：${detail}`);
      this.dependencies.logger.warn({ err: error }, "Failed to synchronize Codex Desktop projects");
    }
  }

  private revokeDesktopProjectSnapshot(warning: string): void {
    this.dependencies.database.syncDesktopProjects([]);
    this.desktopProjectOrder = [];
    this.desktopProjectIds.clear();
    this.desktopSyncWarning = warning;
  }

  private orderedProjects(includeDisabled = false): ProjectRecord[] {
    const projects = this.dependencies.database
      .listProjects({ includeDisabled })
      .filter(
        (project) => !project.id.startsWith("desktop@") || this.desktopProjectIds.has(project.id),
      );
    const byId = new Map(projects.map((project) => [project.id, project]));
    const ordered: ProjectRecord[] = [];
    for (const projectId of this.desktopProjectOrder) {
      const project = byId.get(projectId);
      if (!project) continue;
      this.ensureProjectNumber(project.id);
      ordered.push(project);
      byId.delete(projectId);
    }
    for (const project of [...byId.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    )) {
      this.ensureProjectNumber(project.id);
      ordered.push(project);
    }
    return ordered;
  }

  private resolveProjectReference(reference: string): ProjectRecord | undefined {
    const normalized = reference.trim();
    const direct = this.dependencies.database.getProject(normalized);
    if (direct && (!direct.id.startsWith("desktop@") || this.desktopProjectIds.has(direct.id)))
      return direct;

    const number = /^#(\d+)$/.exec(normalized)?.[1];
    if (number) {
      const requestedNumber = Number(number);
      return this.orderedProjects(true).find(
        (project) => this.projectNumbers.get(project.id) === requestedNumber,
      );
    }

    const folded = normalized.toLocaleLowerCase();
    const matches = this.orderedProjects(true).filter(
      (project) => project.name.toLocaleLowerCase() === folded,
    );
    if (matches.length > 1) {
      throw new Error(`项目名称“${normalized}”不唯一，请改用 /project list 中的 #编号。`);
    }
    return matches[0];
  }

  private ensureProjectNumber(projectId: string): number {
    const existing = this.projectNumbers.get(projectId);
    if (existing) return existing;
    const assigned = this.dependencies.database.getOrAssignProjectNumber(projectId);
    this.projectNumbers.set(projectId, assigned);
    return assigned;
  }

  private projectLabel(project: ProjectRecord): string {
    return project.id.startsWith("desktop@") || this.desktopProjectIds.has(project.id)
      ? project.name
      : `${project.name} (${project.id})`;
  }

  private isDesktopProjectAuthorized(project: ProjectRecord): boolean {
    if (!this.dependencies.desktopProjects) return true;
    return !project.id.startsWith("desktop@") || this.desktopProjectIds.has(project.id);
  }

  private async normalizeProjectRoots(projects: ProjectConfig[]): Promise<ProjectConfig[]> {
    const normalized: ProjectConfig[] = [];
    for (const project of projects) {
      const configuredRoot = path.resolve(project.rootPath);
      if (!project.enabled) {
        normalized.push({ ...project, rootPath: configuredRoot });
        continue;
      }
      try {
        normalized.push({ ...project, rootPath: await resolveProjectPath(configuredRoot) });
      } catch (error) {
        throw new BridgeError(
          "CONFIG_INVALID",
          `项目 ${project.id} 的目录不可用：${configuredRoot}`,
          false,
          { cause: error },
        );
      }
    }
    this.assertNoDuplicateProjectRoots(normalized.filter((project) => project.enabled));
    return normalized;
  }

  private async assertUniqueProjectRoots(projects: ProjectRecord[]): Promise<void> {
    const normalized: ProjectRecord[] = [];
    for (const project of projects) {
      try {
        normalized.push({ ...project, rootPath: await resolveProjectPath(project.rootPath) });
      } catch (error) {
        throw new BridgeError(
          "CONFIG_INVALID",
          `已启用项目 ${project.id} 的目录不可用：${project.rootPath}`,
          false,
          { cause: error },
        );
      }
    }
    this.assertNoDuplicateProjectRoots(normalized);
  }

  private assertNoDuplicateProjectRoots(
    projects: Array<Pick<ProjectRecord, "id" | "rootPath">>,
  ): void {
    const owners = new Map<string, string>();
    for (const project of projects) {
      const key =
        process.platform === "win32"
          ? path.resolve(project.rootPath).toLowerCase()
          : path.resolve(project.rootPath);
      const existing = owners.get(key);
      if (existing) {
        throw new BridgeError(
          "CONFIG_INVALID",
          `项目 ${existing} 与 ${project.id} 指向同一目录：${project.rootPath}`,
        );
      }
      owners.set(key, project.id);
    }
  }

  private isMissingThreadError(error: unknown): boolean {
    const messages: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    }
    return /(?:thread|conversation|对话).*(?:not found|does not exist|missing|不存在)|(?:not found|does not exist).*(?:thread|conversation)/i.test(
      messages.join(" "),
    );
  }
}
