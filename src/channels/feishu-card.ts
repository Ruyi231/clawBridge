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

const modelIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9@._:/-]+$/);
const effortSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/);
const interactionTokenSchema = z.string().uuid();
const questionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

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
      action: z.literal("task.list"),
      projectId: projectIdSchema.optional(),
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
  z.object({ version: z.literal(CARD_VERSION), action: z.literal("project.create.show") }).strict(),
  z.object({ version: z.literal(CARD_VERSION), action: z.literal("project.create") }).strict(),
  z
    .object({
      version: z.literal(CARD_VERSION),
      action: z.literal("model.list"),
      projectId: projectIdSchema,
      threadId: threadIdSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(CARD_VERSION),
      action: z.literal("model.use"),
      projectId: projectIdSchema,
      threadId: threadIdSchema,
      model: modelIdSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(CARD_VERSION),
      action: z.literal("reasoning.use"),
      projectId: projectIdSchema,
      threadId: threadIdSchema,
      model: modelIdSchema,
      reasoningEffort: effortSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(CARD_VERSION),
      action: z.literal("approval.resolve"),
      token: interactionTokenSchema,
      decision: z.enum(["accept", "decline", "cancel"]),
    })
    .strict(),
  z
    .object({
      version: z.literal(CARD_VERSION),
      action: z.literal("question.answer"),
      token: interactionTokenSchema,
      questionId: questionIdSchema,
      answer: z.string().min(1).max(500).optional(),
    })
    .strict(),
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

export interface CardTask {
  id: string;
  projectName: string;
  state: string;
  prompt: string;
  progressSummary?: string | null;
  updatedAt: string;
}

export interface HomeCardInput {
  project: CardProject | null;
  thread: CardThread | null;
  taskState?: string | null;
  notice?: string | null;
}

export interface ProjectSpaceCardInput {
  project: CardProject;
  thread?: CardThread | null;
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
  projectSpace?: boolean;
}

export interface TaskCenterCardInput {
  tasks: CardTask[];
  project?: CardProject | null;
  page?: number;
  totalPages?: number;
  projectSpace?: boolean;
}

export interface ModelListCardInput {
  project: CardProject;
  thread: CardThread;
  models: Array<{
    model: string;
    displayName: string;
    description: string;
    isDefault: boolean;
    defaultReasoningEffort: string;
    supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  }>;
  selectedModel?: string | null;
  selectedReasoningEffort?: string | null;
  projectSpace?: boolean;
}

export interface ApprovalCardInput {
  token: string;
  kind: "command" | "file";
  title: string;
  detail: string;
  reason?: string | null;
}

export interface QuestionCardInput {
  token: string;
  questionId: string;
  header: string;
  question: string;
  options?: Array<{ label: string; description: string }> | null;
  secret?: boolean;
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
  actionName: "project.space" | "thread.list" | "thread.new",
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
        button("全部任务", action({ version: CARD_VERSION, action: "task.list" })),
        button(
          "项目任务",
          action({ version: CARD_VERSION, action: "task.list", projectId: input.project.id }),
        ),
      ]),
      ...(input.thread
        ? [
            actionRow([
              button(
                "模型设置",
                action({
                  version: CARD_VERSION,
                  action: "model.list",
                  projectId: input.project.id,
                  threadId: input.thread.id,
                }),
              ),
            ]),
          ]
        : []),
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
        button("全部任务", action({ version: CARD_VERSION, action: "task.list" })),
        button("停止任务", action({ version: CARD_VERSION, action: "task.stop" }), "danger"),
      ]),
      actionRow([button("交还桌面", action({ version: CARD_VERSION, action: "chat.close" }))]),
    );
  }
  return card("ClawBridge 控制台", elements);
}

export function renderProjectSpaceCard(input: ProjectSpaceCardInput): FeishuCard {
  const thread = input.thread
    ? `#${input.thread.localNumber} ${displayText(input.thread.title || "未命名对话", 56)}`
    : "未选择";
  const elements: Array<Record<string, unknown>> = [
    markdown(
      `**项目：** ${displayText(input.project.name, 60)}\n**当前对话：** ${thread}\n\n项目操作在本群完成；Codex 任务请进入对应的独立话题发送。`,
    ),
  ];
  if (input.notice?.trim()) elements.push(markdown(`💡 ${displayText(input.notice, 160)}`));
  elements.push(
    divider(),
    actionRow([
      button("查看对话", projectScopedAction("thread.list", input.project.id), "primary"),
      button("新建对话", projectScopedAction("thread.new", input.project.id)),
    ]),
    actionRow([
      button(
        "项目任务",
        action({ version: CARD_VERSION, action: "task.list", projectId: input.project.id }),
      ),
      ...(input.thread
        ? [
            button(
              "模型设置",
              action({
                version: CARD_VERSION,
                action: "model.list",
                projectId: input.project.id,
                threadId: input.thread.id,
              }),
            ),
          ]
        : []),
    ]),
  );
  return card(`${displayText(input.project.name, 50)} · 项目控制台`, elements);
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
    actionRow([
      button(
        "新建项目",
        action({ version: CARD_VERSION, action: "project.create.show" }),
        "primary",
      ),
    ]),
  );
  return card("选择项目", elements);
}

export function renderProjectCreateCard(): FeishuCard {
  return card("新建项目", [
    markdown("输入项目名称。ClawBridge 会在已授权的项目根目录中创建安全目录。"),
    {
      tag: "form",
      name: "project_create",
      elements: [
        {
          tag: "input",
          name: "projectName",
          label: { tag: "plain_text", content: "项目名称" },
          placeholder: { tag: "plain_text", content: "例如：robot-demo" },
          required: true,
          max_length: 80,
        },
        {
          ...button(
            "创建并选择",
            action({ version: CARD_VERSION, action: "project.create" }),
            "primary",
          ),
          name: "project_create_submit",
          action_type: "form_submit",
          complex_interaction: true,
        },
      ],
    },
    actionRow([button("取消", projectListAction())]),
  ]);
}

export function renderModelListCard(input: ModelListCardInput): FeishuCard {
  const elements: Array<Record<string, unknown>> = [
    markdown(
      `**对话：** #${input.thread.localNumber} ${displayText(input.thread.title || "未命名", 48)}`,
    ),
    markdown(
      `**当前模型：** ${displayText(input.selectedModel || "Codex 默认", 48)}\n**推理强度：** ${displayText(input.selectedReasoningEffort || "模型默认", 32)}`,
    ),
    divider(),
  ];
  for (const model of input.models.slice(0, MAX_LIST_ITEMS)) {
    const selected = model.model === input.selectedModel;
    elements.push(
      markdown(
        `**${displayText(model.displayName, 52)}**${model.isDefault ? " · 默认" : ""}\n${displayText(model.description, 100)}`,
      ),
      actionRow([
        button(
          selected ? "当前模型" : "选择模型",
          action({
            version: CARD_VERSION,
            action: "model.use",
            projectId: input.project.id,
            threadId: input.thread.id,
            model: model.model,
          }),
          selected ? "primary" : "default",
        ),
      ]),
    );
    if (selected) {
      const efforts = model.supportedReasoningEfforts.slice(0, 4).map((effort) =>
        button(
          effort.reasoningEffort === input.selectedReasoningEffort
            ? `✓ ${effort.reasoningEffort}`
            : effort.reasoningEffort,
          action({
            version: CARD_VERSION,
            action: "reasoning.use",
            projectId: input.project.id,
            threadId: input.thread.id,
            model: model.model,
            reasoningEffort: effort.reasoningEffort,
          }),
          effort.reasoningEffort === input.selectedReasoningEffort ? "primary" : "default",
        ),
      );
      if (efforts.length) elements.push(actionRow(efforts));
    }
  }
  elements.push(
    divider(),
    actionRow([
      input.projectSpace
        ? button("返回项目", projectScopedAction("project.space", input.project.id))
        : button("返回控制台", action({ version: CARD_VERSION, action: "menu.refresh" })),
    ]),
  );
  return card("模型与推理强度", elements);
}

export function renderApprovalCard(input: ApprovalCardInput): FeishuCard {
  return card(input.kind === "command" ? "Codex 命令审批" : "Codex 文件修改审批", [
    markdown(`**${displayText(input.title, 80)}**\n${displayText(input.detail, 500)}`),
    ...(input.reason ? [markdown(`**原因：** ${displayText(input.reason, 240)}`)] : []),
    divider(),
    actionRow([
      button(
        "允许一次",
        action({
          version: CARD_VERSION,
          action: "approval.resolve",
          token: input.token,
          decision: "accept",
        }),
        "primary",
      ),
      button(
        "拒绝",
        action({
          version: CARD_VERSION,
          action: "approval.resolve",
          token: input.token,
          decision: "decline",
        }),
        "danger",
      ),
    ]),
    actionRow([
      button(
        "拒绝并停止",
        action({
          version: CARD_VERSION,
          action: "approval.resolve",
          token: input.token,
          decision: "cancel",
        }),
        "danger",
      ),
    ]),
  ]);
}

export function renderQuestionCard(input: QuestionCardInput): FeishuCard {
  const elements: Array<Record<string, unknown>> = [
    markdown(`**${displayText(input.header, 40)}**\n${displayText(input.question, 400)}`),
  ];
  if (input.options?.length) {
    for (const option of input.options.slice(0, 3)) {
      elements.push(
        actionRow([
          button(
            displayText(option.label, 24),
            action({
              version: CARD_VERSION,
              action: "question.answer",
              token: input.token,
              questionId: input.questionId,
              answer: option.label,
            }),
            "primary",
          ),
        ]),
        markdown(displayText(option.description, 160)),
      );
    }
  } else if (!input.secret) {
    elements.push({
      tag: "form",
      name: "question_answer",
      elements: [
        {
          tag: "input",
          name: "answerText",
          required: true,
          max_length: 500,
          placeholder: { tag: "plain_text", content: "输入回答" },
        },
        {
          ...button(
            "提交回答",
            action({
              version: CARD_VERSION,
              action: "question.answer",
              token: input.token,
              questionId: input.questionId,
            }),
            "primary",
          ),
          name: "question_answer_submit",
          action_type: "form_submit",
          complex_interaction: true,
        },
      ],
    });
  } else {
    elements.push(markdown("该问题要求秘密输入。为避免敏感内容进入飞书记录，已拒绝远程回答。"));
  }
  return card("Codex 需要你的回答", elements);
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
      input.projectSpace
        ? button("返回项目", projectScopedAction("project.space", input.project.id))
        : button("返回控制台", action({ version: CARD_VERSION, action: "menu.refresh" })),
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
      input.projectSpace
        ? button("返回项目", projectScopedAction("project.space", input.project.id))
        : button("选择项目", projectListAction()),
    ]),
  );
  return card("选择对话", elements);
}

export function renderTaskCenterCard(input: TaskCenterCardInput): FeishuCard {
  const { page, totalPages } = pagination(input);
  const scope = input.project ? `项目：${displayText(input.project.name, 56)}` : "全部项目";
  const elements: Array<Record<string, unknown>> = [markdown(`**范围：** ${scope}`), divider()];
  if (input.tasks.length === 0) {
    elements.push(markdown("暂无任务。"));
  } else {
    for (const task of input.tasks.slice(0, MAX_LIST_ITEMS)) {
      const summary = task.progressSummary?.trim() || task.prompt;
      elements.push(
        markdown(
          `**${displayText(task.projectName, 32)} · ${displayText(task.state, 20)}**\n${displayText(summary, 120)}\n_${displayText(task.updatedAt, 32)} · ${displayText(task.id, 12)}_`,
        ),
      );
    }
  }
  elements.push(markdown(`第 ${page + 1} / ${totalPages} 页`));
  const pageActions: Array<Record<string, unknown>> = [];
  if (page > 0) {
    pageActions.push(
      button(
        "上一页",
        action({
          version: CARD_VERSION,
          action: "task.list",
          ...(input.project ? { projectId: input.project.id } : {}),
          page: page - 1,
        }),
      ),
    );
  }
  if (page + 1 < totalPages) {
    pageActions.push(
      button(
        "下一页",
        action({
          version: CARD_VERSION,
          action: "task.list",
          ...(input.project ? { projectId: input.project.id } : {}),
          page: page + 1,
        }),
      ),
    );
  }
  if (pageActions.length) elements.push(actionRow(pageActions));
  elements.push(
    divider(),
    actionRow([
      input.projectSpace && input.project
        ? button("返回项目", projectScopedAction("project.space", input.project.id))
        : button("返回控制台", action({ version: CARD_VERSION, action: "menu.refresh" })),
      button(
        "刷新任务",
        action({
          version: CARD_VERSION,
          action: "task.list",
          ...(input.project ? { projectId: input.project.id } : {}),
          page,
        }),
      ),
    ]),
  );
  return card(input.project ? "项目任务中心" : "全局任务中心", elements);
}
