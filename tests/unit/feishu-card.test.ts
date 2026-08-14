import { describe, expect, it } from "vitest";
import {
  parseCardAction,
  renderConversationToolbarCard,
  renderHomeCard,
  renderModelListCard,
  renderQuotaCard,
  renderProjectSpaceCard,
  renderApprovalCard,
  renderQuestionCard,
  renderProjectListCard,
  renderTaskCenterCard,
  renderThreadListCard,
  type FeishuCard,
} from "../../src/channels/feishu-card.js";

function collectValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(collectValues);
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  return [
    ...(Object.prototype.hasOwnProperty.call(object, "value") ? [object.value] : []),
    ...Object.values(object).flatMap(collectValues),
  ];
}

function actions(card: FeishuCard) {
  return collectValues(card).map(parseCardAction);
}

describe("parseCardAction", () => {
  it("accepts every supported action with the required internal IDs", () => {
    const inputs = [
      { version: 1, action: "menu.refresh" },
      { version: 1, action: "quota.show" },
      { version: 1, action: "project.list" },
      { version: 1, action: "project.list", page: 1_000 },
      { version: 1, action: "project.use", projectId: "desktop@abc-123" },
      { version: 1, action: "project.space", projectId: "claw" },
      { version: 1, action: "project.leave", projectId: "claw" },
      { version: 1, action: "project.dissolve", projectId: "claw" },
      { version: 1, action: "task.list" },
      { version: 1, action: "task.list", projectId: "claw", page: 3 },
      { version: 1, action: "thread.list", projectId: "claw" },
      {
        version: 1,
        action: "approval.resolve",
        token: "00000000-0000-4000-8000-000000000001",
        decision: "accept",
      },
      {
        version: 1,
        action: "question.answer",
        token: "00000000-0000-4000-8000-000000000002",
        questionId: "choice",
        answer: "safe",
      },
      { version: 1, action: "thread.list", projectId: "claw", page: 7 },
      { version: 1, action: "thread.use", projectId: "claw", threadId: "019f-aa" },
      { version: 1, action: "thread.new", projectId: "claw" },
      { version: 1, action: "thread.show", projectId: "claw", threadId: "019f-aa" },
      { version: 1, action: "model.list", projectId: "claw", threadId: "019f-aa" },
      { version: 1, action: "model.close", projectId: "claw", threadId: "019f-aa" },
      {
        version: 1,
        action: "model.use",
        projectId: "claw",
        threadId: "019f-aa",
        model: "gpt-test",
      },
      {
        version: 1,
        action: "reasoning.use",
        projectId: "claw",
        threadId: "019f-aa",
        model: "gpt-test",
        reasoningEffort: "high",
      },
      { version: 1, action: "task.stop" },
      { version: 1, action: "chat.close" },
    ];

    expect(inputs.map(parseCardAction)).toEqual(inputs);
  });

  it.each([
    { version: 2, action: "menu.refresh" },
    { version: 1, action: "shell.run", command: "whoami" },
    { version: 1, action: "project.use" },
    { version: 1, action: "thread.use", projectId: "claw", threadId: "../secret" },
    { version: 1, action: "thread.new", projectId: "D:\\workspace\\claw" },
    { version: 1, action: "task.stop", extra: true },
    { version: 1, action: "project.list", page: -1 },
    { version: 1, action: "project.list", page: 1_001 },
    { version: 1, action: "project.list", page: 1.5 },
    { version: 1, action: "thread.list", projectId: "claw", page: "1" },
  ])("rejects an unsupported or non-strict action: %j", (input) => {
    expect(() => parseCardAction(input)).toThrow();
  });
});

describe("Feishu card rendering", () => {
  it("renders approval and question cards with one-time token actions", () => {
    const approval = renderApprovalCard({
      token: "00000000-0000-4000-8000-000000000001",
      kind: "command",
      title: "执行命令",
      detail: "npm test",
      reason: "verify",
    });
    expect(actions(approval).map((value) => value.action)).toEqual([
      "approval.resolve",
      "approval.resolve",
      "approval.resolve",
    ]);
    const question = renderQuestionCard({
      token: "00000000-0000-4000-8000-000000000002",
      questionId: "choice",
      header: "模式",
      question: "选择模式",
      options: [{ label: "安全", description: "只读" }],
    });
    expect(actions(question)).toContainEqual(
      expect.objectContaining({ action: "question.answer", answer: "安全" }),
    );
  });
  it("renders a mobile-friendly home card using only whitelisted actions", () => {
    const card = renderHomeCard({
      project: { id: "claw", name: "claw" },
      thread: {
        id: "019f-aa",
        projectId: "claw",
        localNumber: 7,
        title: "修复 *卡片* [测试]",
      },
      taskState: "空闲",
      notice: "直接发送自然语言即可创建任务",
    });

    expect(card.header?.title.content).toBe("ClawBridge 控制台");
    expect(actions(card).map((item) => item.action)).toEqual([
      "project.list",
      "menu.refresh",
      "project.space",
      "quota.show",
      "chat.close",
    ]);
    const actionRows = card.elements.filter((element) => element.tag === "action");
    expect(actionRows).toHaveLength(3);
    expect(actionRows.map((row) => row.layout)).toEqual(["bisected", "flow", "bisected"]);
    expect(
      actionRows.map((row) =>
        (row.actions as Array<{ text: { content: string } }>).map((item) => item.text.content),
      ),
    ).toEqual([["选择项目", "刷新"], ["项目群"], ["剩余额度", "交还桌面"]]);
    expect(actionRows.every((row) => (row.actions as unknown[]).length <= 2)).toBe(true);
    const summary = card.elements[0] as { text: { content: string } };
    expect(summary.text.content).toContain("本控制台只负责选择项目和进入项目群");
    expect(JSON.stringify(card)).not.toContain("D:\\");
  });

  it("omits project-specific actions when no project is selected", () => {
    const card = renderHomeCard({ project: null, thread: null });
    expect(actions(card).map((item) => item.action)).toEqual([
      "project.list",
      "menu.refresh",
      "quota.show",
      "chat.close",
    ]);
    const actionRows = card.elements.filter((element) => element.tag === "action");
    expect(actionRows.map((row) => row.layout)).toEqual(["bisected", "bisected"]);
    expect(
      actionRows.map((row) =>
        (row.actions as Array<{ text: { content: string } }>).map((item) => item.text.content),
      ),
    ).toEqual([
      ["选择项目", "刷新"],
      ["剩余额度", "交还桌面"],
    ]);
    expect(actionRows.every((row) => (row.actions as unknown[]).length <= 2)).toBe(true);
  });

  it("renders a one-click AppLink when the project group is ready", () => {
    const projectSpaceUrl =
      "https://applink.feishu.cn/client/chat/open?openChatId=oc_project_ready";
    const card = renderHomeCard({
      project: { id: "demo", name: "Demo" },
      thread: null,
      projectSpaceUrl,
    });
    const serialized = JSON.stringify(card);

    expect(serialized).toContain(projectSpaceUrl);
    expect(serialized).toContain(`\"pc_url\":\"${projectSpaceUrl}\"`);
    expect(serialized).toContain(`\"android_url\":\"${projectSpaceUrl}\"`);
    expect(serialized).toContain(`\"ios_url\":\"${projectSpaceUrl}\"`);
    expect(actions(card).map((item) => item.action)).not.toContain("project.space");
    expect(serialized).toContain("项目群");
  });

  it("renders project controls in the group without exposing cross-project actions", () => {
    const card = renderProjectSpaceCard({
      project: { id: "demo", name: "Demo" },
      thread: {
        id: "thread-1",
        projectId: "demo",
        localNumber: 3,
        title: "修复登录",
      },
    });
    expect(card.header?.title.content).toBe("Demo · 项目控制台");
    expect(actions(card).map((item) => item.action)).toEqual([
      "thread.list",
      "thread.new",
      "task.list",
      "project.dissolve",
    ]);
    expect(actions(card).every((item) => !("projectId" in item) || item.projectId === "demo")).toBe(
      true,
    );
    expect(JSON.stringify(card)).toContain("任务请进入对应的独立话题");
  });

  it("renders a compact conversation toolbar with only model controls", () => {
    const card = renderConversationToolbarCard({
      project: { id: "demo", name: "Demo" },
      thread: { id: "thread-1", projectId: "demo", localNumber: 3, title: "修复登录" },
      selectedModel: "gpt-test",
      selectedReasoningEffort: "high",
    });
    expect(actions(card)).toEqual([
      { version: 1, action: "model.list", projectId: "demo", threadId: "thread-1" },
    ]);
    expect(card.header).toBeUndefined();
    expect(card.elements).toHaveLength(1);
    expect(JSON.stringify(card)).toContain("gpt-test");
    expect(JSON.stringify(card)).toContain("high");
    expect(JSON.stringify(card)).not.toContain("直接在本话题发送下一项任务");
    expect(JSON.stringify(card)).not.toContain("查看状态");
  });

  it("renders a compact model picker without descriptions or project navigation", () => {
    const card = renderModelListCard({
      project: { id: "demo", name: "Demo" },
      thread: { id: "thread-1", projectId: "demo", localNumber: 3, title: "修复登录" },
      models: [
        {
          model: "gpt-test",
          displayName: "GPT Test",
          description: "This description must not consume mobile space.",
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "Balanced" },
            { reasoningEffort: "high", description: "Deep" },
          ],
        },
        {
          model: "gpt-fast",
          displayName: "GPT Fast",
          description: "Another long description.",
          isDefault: false,
          defaultReasoningEffort: "low",
          supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }],
        },
      ],
      selectedModel: "gpt-test",
      selectedReasoningEffort: "high",
      projectSpace: true,
    });
    expect(card.header?.title.content).toBe("切换模型");
    expect(JSON.stringify(card)).not.toContain("This description");
    expect(JSON.stringify(card)).not.toContain("Another long description");
    expect(JSON.stringify(card)).not.toContain("返回项目");
    expect(actions(card).map((item) => item.action)).toEqual([
      "model.use",
      "reasoning.use",
      "reasoning.use",
      "model.use",
      "model.close",
    ]);
  });

  it("renders remaining quota and refresh controls", () => {
    const card = renderQuotaCard({
      buckets: [
        {
          id: "codex",
          name: "Codex",
          planType: "plus",
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: null },
          secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: null },
        },
      ],
      availableResetCredits: 2,
    });
    expect(JSON.stringify(card)).toContain("剩余 75%");
    expect(JSON.stringify(card)).toContain("剩余 60%");
    expect(JSON.stringify(card)).toContain("可用额度重置次数");
    expect(actions(card).map((item) => item.action)).toEqual(["quota.show", "menu.refresh"]);
  });

  it("requires confirmation before exiting and discarding a project group", () => {
    const card = renderProjectSpaceCard({
      project: { id: "demo", name: "Demo" },
    });
    expect(actions(card).map((item) => item.action)).toContain("project.dissolve");
    expect(actions(card).map((item) => item.action)).not.toContain("project.leave");
    expect(JSON.stringify(card)).toContain("确认退出并丢弃项目群");
    expect(JSON.stringify(card)).toContain("下次进入会新建空群");
    expect(JSON.stringify(card)).toContain("Codex 本地项目与对话历史会保留");
  });

  it("refuses to render a filesystem path as an action project ID", () => {
    expect(() =>
      renderHomeCard({
        project: { id: "D:\\workspace\\claw", name: "claw" },
        thread: null,
      }),
    ).toThrow();
  });

  it("limits project choices to ten and carries only the project ID", () => {
    const projects = Array.from({ length: 12 }, (_, index) => ({
      id: `project-${index + 1}`,
      name: `项目 ${index + 1}`,
    }));
    const card = renderProjectListCard({
      projects,
      selectedProjectId: "project-2",
    });
    const projectUses = actions(card).filter((item) => item.action === "project.use");

    expect(projectUses).toHaveLength(10);
    expect(projectUses[1]).toEqual({
      version: 1,
      action: "project.use",
      projectId: "project-2",
    });
    expect(JSON.stringify(projectUses)).not.toContain("项目");
    expect(JSON.stringify(card)).toContain("本页最多显示 10 个项目");
  });

  it("renders zero-based project pagination without re-slicing current-page items", () => {
    const card = renderProjectListCard({
      projects: [
        { id: "current-a", name: "当前页 A" },
        { id: "current-b", name: "当前页 B" },
      ],
      page: 2,
      totalPages: 4,
    });
    const cardActions = actions(card);

    expect(cardActions).toContainEqual({
      version: 1,
      action: "project.use",
      projectId: "current-a",
    });
    expect(cardActions).toContainEqual({
      version: 1,
      action: "project.use",
      projectId: "current-b",
    });
    expect(
      cardActions.flatMap((item) =>
        item.action === "project.list" && item.page !== undefined ? [item.page] : [],
      ),
    ).toEqual([1, 3, 2]);
    expect(JSON.stringify(card)).toContain("第 3 / 4 页");
  });

  it("renders up to ten threads from the selected project with use and show actions", () => {
    const threads = Array.from({ length: 12 }, (_, index) => ({
      id: `019f-${index + 1}`,
      projectId: "claw",
      localNumber: index + 1,
      title: `对话 ${index + 1}`,
      preview: null,
      status: "idle",
    }));
    threads.splice(2, 0, {
      id: "other-thread",
      projectId: "other",
      localNumber: 1,
      title: "不应显示",
      preview: null,
      status: "idle",
    });

    const card = renderThreadListCard({
      project: { id: "claw", name: "ClawBridge" },
      threads,
      selectedThreadId: "019f-2",
    });
    const cardActions = actions(card);

    expect(cardActions.filter((item) => item.action === "thread.use")).toHaveLength(10);
    expect(cardActions.filter((item) => item.action === "thread.show")).toHaveLength(0);
    expect(cardActions).not.toContainEqual(expect.objectContaining({ threadId: "other-thread" }));
    expect(JSON.stringify(card)).toContain("本页最多显示 10 个对话");
  });

  it("renders thread pagination with the project ID and bounded pages", () => {
    const card = renderThreadListCard({
      project: { id: "claw", name: "ClawBridge" },
      threads: [],
      page: 1,
      totalPages: 3,
    });
    const pageActions = actions(card).filter(
      (item) => item.action === "thread.list" && item.page !== undefined,
    );

    expect(pageActions).toEqual([
      { version: 1, action: "thread.list", projectId: "claw", page: 0 },
      { version: 1, action: "thread.list", projectId: "claw", page: 2 },
      { version: 1, action: "thread.list", projectId: "claw", page: 1 },
    ]);
    expect(JSON.stringify(card)).toContain("第 2 / 3 页");
  });

  it("returns from a project-group thread list without exposing the global project picker", () => {
    const card = renderThreadListCard({
      project: { id: "claw", name: "ClawBridge" },
      threads: [],
      projectSpace: true,
    });
    expect(actions(card)).toContainEqual({
      version: 1,
      action: "project.space",
      projectId: "claw",
    });
    expect(actions(card).some((item) => item.action === "project.list")).toBe(false);
    expect(actions(card).some((item) => item.action === "menu.refresh")).toBe(false);
  });

  it("rejects invalid renderer page ranges", () => {
    expect(() => renderProjectListCard({ projects: [], page: 1, totalPages: 1 })).toThrow(
      "smaller than totalPages",
    );
    expect(() =>
      renderThreadListCard({
        project: { id: "claw", name: "ClawBridge" },
        threads: [],
        page: 1_001,
        totalPages: 1_001,
      }),
    ).toThrow();
  });

  it("renders a scoped task center with safe pagination", () => {
    const card = renderTaskCenterCard({
      project: { id: "claw", name: "ClawBridge" },
      tasks: [
        {
          id: "task-123456789",
          projectName: "ClawBridge",
          state: "running",
          prompt: "实现任务中心",
          progressSummary: "正在同步数据库",
          updatedAt: "2026-08-13T06:00:00Z",
        },
      ],
      page: 0,
      totalPages: 2,
    });

    expect(card.header?.title.content).toBe("项目任务中心");
    expect(JSON.stringify(card)).toContain("正在同步数据库");
    expect(actions(card)).toContainEqual({
      version: 1,
      action: "task.list",
      projectId: "claw",
      page: 1,
    });
  });

  it("returns from a project-group task center to that same project", () => {
    const card = renderTaskCenterCard({
      project: { id: "claw", name: "ClawBridge" },
      tasks: [],
      projectSpace: true,
    });
    expect(actions(card)).toContainEqual({
      version: 1,
      action: "project.space",
      projectId: "claw",
    });
    expect(actions(card).some((item) => item.action === "menu.refresh")).toBe(false);
  });
});
