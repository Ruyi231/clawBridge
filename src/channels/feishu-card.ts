import { z } from "zod";

const CARD_VERSION = 1 as const;
const MAX_LIST_ITEMS = 10;
const cardPageSchema = z.number().int().min(0).max(1_000);

const projectIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9@._-]+$/, "Invalid internal project ID");

const threadIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/, "Invalid internal thread ID");

const actionSchemas = [
  z.object({ version: z.literal(CARD_VERSION), action: z.literal("menu.refresh") }).strict(),
  z
    .object({
      version: z.literal(CARD_VERSION),
      action: z.literal("project.list"),
      page: cardPageSchema.optional(),
    })
    .strict(),
  z
    .object({
      version: z.literal(CARD_VERSION),
      action: z.literal("project.use"),
      projectId: projectIdSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(CARD_VERSION),
      action: z.literal("project.space"),
      projectId: projectIdSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(CARD_VERSION),
      action: z.literal("thread.list"),
      projectId: projectIdSchema,
      page: cardPageSchema.optional(),
    })
    .strict(),
  z
    .object({
      version: z.literal(CARD_VERSION),
      action: z.literal("thread.use"),
      projectId: projectIdSchema,
      threadId: threadIdSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(CARD_VERSION),
      action: z.literal("thread.new"),
      projectId: projectIdSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(CARD_VERSION),
      action: z.literal("thread.show"),
      projectId: projectIdSchema,
      threadId: threadIdSchema,
    })
    .strict(),
  z.object({ version: z.literal(CARD_VERSION), action: z.literal("task.stop") }).strict(),
  z.object({ version: z.literal(CARD_VERSION), action: z.literal("chat.close") }).strict(),
] as const;

const cardActionSchema = z.discriminatedUnion("action", actionSchemas);

export type CardAction = z.infer<typeof cardActionSchema>;

export function parseCardAction(value: unknown): CardAction {
  return cardActionSchema.parse(value);
}

export interface CardProject {
  id: string;
  name: string;
}

export interface CardThread {
  id: string;
  projectId: string;
  localNumber: number;
  title: string | null;
  preview?: string | null;
  status?: string | null;
}

export interface HomeCardInput {
  project: CardProject | null;
  thread: CardThread | null;
  taskState?: string | null;
  notice?: string | null;
}

export interface ProjectListCardInput {
  projects: CardProject[];
  selectedProjectId?: string | null;
  truncated?: boolean;
  /** Zero-based page number used in callback values. */
  page?: number;
  /** Total page count. Valid pages are 0 through totalPages - 1. */
  totalPages?: number;
}

export interface ThreadListCardInput {
  project: CardProject;
  threads: CardThread[];
  selectedThreadId?: string | null;
  truncated?: boolean;
  /** Zero-based page number used in callback values. */
  page?: number;
  /** Total page count. Valid pages are 0 through totalPages - 1. */
  totalPages?: number;
}

export interface FeishuCard {
  config: {
    wide_screen_mode: true;
    enable_forward: false;
    update_multi: false;
  };
  header: {
    template: "blue";
    title: { tag: "plain_text"; content: string };
  };
  elements: Array<Record<string, unknown>>;
}

function action<T extends CardAction>(value: T): T {
  return value;
}

function button(
  label: string,
  value: CardAction,
  type: "default" | "primary" | "danger" = "default",
): Record<string, unknown> {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    value,
  };
}

function actionRow(actions: Array<Record<string, unknown>>): Record<string, unknown> {
  const layout = actions.length === 2 ? "bisected" : actions.length === 3 ? "trisection" : "flow";
  return { tag: "action", layout, actions };
}

function markdown(content: string): Record<string, unknown> {
  return { tag: "div", text: { tag: "lark_md", content } };
}

function divider(): Record<string, unknown> {
  return { tag: "hr" };
}

function card(title: string, elements: Array<Record<string, unknown>>): FeishuCard {
  return {
    config: { wide_screen_mode: true, enable_forward: false, update_multi: false },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: title },
    },
    elements,
  };
}

function displayText(value: string, maxLength: number): string {
  const compact = value.replace(/[\r\n\t]+/g, " ").trim();
  const shortened =
    compact.length <= maxLength ? compact : `${compact.slice(0, Math.max(0, maxLength - 1))}…`;
  return shortened.replace(/([\\*_~`\[\]])/g, "\\$1");
}

function projectAction(projectId: string): CardAction {
  return parseCardAction(action({ version: CARD_VERSION, action: "project.use", projectId }));
}

function projectListAction(page?: number): CardAction {
  return parseCardAction(
    action({
      version: CARD_VERSION,
      action: "project.list",
      ...(page === undefined ? {} : { page }),
    }),
  );
}

function projectScopedAction(
  actionName: "thread.list" | "thread.new",
  projectId: string,
  page?: number,
): CardAction {
  return parseCardAction(
    action({
      version: CARD_VERSION,
      action: actionName,
      projectId,
      ...(actionName === "thread.list" && page !== undefined ? { page } : {}),
    }),
  );
}

function pagination(input: { page?: number; totalPages?: number }): {
  page: number;
  totalPages: number;
} {
  const page = cardPageSchema.parse(input.page ?? 0);
  const totalPages = z
    .number()
    .int()
    .min(1)
    .max(1_001)
    .parse(input.totalPages ?? page + 1);
  if (page >= totalPages) throw new Error("Card page must be smaller than totalPages");
  return { page, totalPages };
}

function threadAction(
  actionName: "thread.use" | "thread.show",
  projectId: string,
  threadId: string,
): CardAction {
  return parseCardAction(
    action({ version: CARD_VERSION, action: actionName, projectId, threadId }),
  );
}

export function renderHomeCard(input: HomeCardInput): FeishuCard {
  const projectName = input.project ? displayText(input.project.name, 60) : "未选择";
  const threadName = input.thread
    ? `#${input.thread.localNumber} ${displayText(input.thread.title || "未命名对话", 56)}`
    : "未选择";
  const taskState = displayText(input.taskState?.trim() || "空闲", 40);
  const elements: Array<Record<string, unknown>> = [
    markdown(
      `**当前项目：** ${projectName}\n**当前对话：** ${threadName}\n**任务状态：** ${taskState}`,
    ),
  ];

  if (input.notice?.trim()) {
    elements.push(markdown(`💡 ${displayText(input.notice, 160)}`));
  }

  const projectActions: Array<Record<string, unknown>> = [
    button("选择项目", action({ version: CARD_VERSION, action: "project.list" }), "primary"),
  ];
  if (input.project) {
    projectActions.push(button("选择对话", projectScopedAction("thread.list", input.project.id)));
  } else {
    projectActions.push(button("刷新", action({ version: CARD_VERSION, action: "menu.refresh" })));
  }

  elements.push(divider(), actionRow(projectActions));
  if (input.project) {
    elements.push(
      actionRow([
        button(
          "项目群",
          action({ version: CARD_VERSION, action: "project.space", projectId: input.project.id }),
        ),
        button("新对话", projectScopedAction("thread.new", input.project.id)),
      ]),
      actionRow([
        button("刷新", action({ version: CARD_VERSION, action: "menu.refresh" })),
        button("交还桌面", action({ version: CARD_VERSION, action: "chat.close" })),
      ]),
    );
    elements.push(
      actionRow([
        button("停止任务", action({ version: CARD_VERSION, action: "task.stop" }), "danger"),
      ]),
    );
  } else {
    elements.push(
      actionRow([
        button("停止任务", action({ version: CARD_VERSION, action: "task.stop" }), "danger"),
        button("交还桌面", action({ version: CARD_VERSION, action: "chat.close" })),
      ]),
    );
  }
  return card("ClawBridge 控制台", elements);
}

export function renderProjectListCard(input: ProjectListCardInput): FeishuCard {
  const { page, totalPages } = pagination(input);
  const projects = input.projects.slice(0, MAX_LIST_ITEMS);
  const elements: Array<Record<string, unknown>> = [
    markdown("选择后，后续任务会在该项目目录中执行。"),
    divider(),
  ];

  if (projects.length === 0) {
    elements.push(markdown("暂无可用项目。"));
  } else {
    for (const project of projects) {
      const selected = project.id === input.selectedProjectId;
      elements.push({
        tag: "div",
        text: {
          tag: "lark_md",
          content: `${selected ? "▶ " : ""}**${displayText(project.name, 72)}**`,
        },
        extra: button(
          selected ? "当前" : "选择",
          projectAction(project.id),
          selected ? "primary" : "default",
        ),
      });
    }
  }

  if (input.truncated || input.projects.length > MAX_LIST_ITEMS)
    elements.push(markdown(`本页最多显示 ${MAX_LIST_ITEMS} 个项目。`));
  elements.push(markdown(`第 ${page + 1} / ${totalPages} 页`));
  const pageActions: Array<Record<string, unknown>> = [];
  if (page > 0) pageActions.push(button("上一页", projectListAction(page - 1)));
  if (page + 1 < totalPages) pageActions.push(button("下一页", projectListAction(page + 1)));
  if (pageActions.length > 0) elements.push(actionRow(pageActions));
  elements.push(
    divider(),
    actionRow([
      button("返回控制台", action({ version: CARD_VERSION, action: "menu.refresh" })),
      button("刷新项目", projectListAction(page)),
    ]),
  );
  return card("选择项目", elements);
}

export function renderThreadListCard(input: ThreadListCardInput): FeishuCard {
  const { page, totalPages } = pagination(input);
  const threads = input.threads
    .filter((thread) => thread.projectId === input.project.id)
    .slice(0, MAX_LIST_ITEMS);
  const elements: Array<Record<string, unknown>> = [
    markdown(`**项目：** ${displayText(input.project.name, 72)}`),
    actionRow([
      button("新对话", projectScopedAction("thread.new", input.project.id), "primary"),
      button("返回控制台", action({ version: CARD_VERSION, action: "menu.refresh" })),
    ]),
    divider(),
  ];

  if (threads.length === 0) {
    elements.push(markdown("该项目还没有可用对话。点击“新对话”即可开始。"));
  } else {
    for (const thread of threads) {
      const selected = thread.id === input.selectedThreadId;
      const title = displayText(thread.title || thread.preview || "未命名对话", 64);
      const status = thread.status ? ` · ${displayText(thread.status, 24)}` : "";
      elements.push(
        markdown(`${selected ? "▶ " : ""}**#${thread.localNumber} ${title}**${status}`),
        actionRow([
          button(
            selected ? "当前对话" : "继续对话",
            threadAction("thread.use", input.project.id, thread.id),
            selected ? "primary" : "default",
          ),
          button("查看内容", threadAction("thread.show", input.project.id, thread.id)),
        ]),
      );
    }
  }

  if (input.truncated || input.threads.length > MAX_LIST_ITEMS)
    elements.push(markdown(`本页最多显示 ${MAX_LIST_ITEMS} 个对话。`));
  elements.push(markdown(`第 ${page + 1} / ${totalPages} 页`));
  const pageActions: Array<Record<string, unknown>> = [];
  if (page > 0)
    pageActions.push(
      button("上一页", projectScopedAction("thread.list", input.project.id, page - 1)),
    );
  if (page + 1 < totalPages)
    pageActions.push(
      button("下一页", projectScopedAction("thread.list", input.project.id, page + 1)),
    );
  if (pageActions.length > 0) elements.push(actionRow(pageActions));
  elements.push(
    divider(),
    actionRow([
      button("刷新对话", projectScopedAction("thread.list", input.project.id, page)),
      button("选择项目", projectListAction()),
    ]),
  );
  return card("选择对话", elements);
}
