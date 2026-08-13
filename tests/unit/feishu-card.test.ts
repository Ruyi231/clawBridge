import { describe, expect, it } from "vitest";
import {
  parseCardAction,
  renderHomeCard,
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
      { version: 1, action: "project.list" },
      { version: 1, action: "project.list", page: 1_000 },
      { version: 1, action: "project.use", projectId: "desktop@abc-123" },
      { version: 1, action: "project.space", projectId: "claw" },
      { version: 1, action: "task.list" },
      { version: 1, action: "task.list", projectId: "claw", page: 3 },
      { version: 1, action: "thread.list", projectId: "claw" },
      { version: 1, action: "thread.list", projectId: "claw", page: 7 },
      { version: 1, action: "thread.use", projectId: "claw", threadId: "019f-aa" },
      { version: 1, action: "thread.new", projectId: "claw" },
      { version: 1, action: "thread.show", projectId: "claw", threadId: "019f-aa" },
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

    expect(card.header.title.content).toBe("ClawBridge 控制台");
    expect(actions(card).map((item) => item.action)).toEqual([
      "project.list",
      "thread.list",
      "project.space",
      "thread.new",
      "task.list",
      "task.list",
      "model.list",
      "menu.refresh",
      "chat.close",
      "task.stop",
    ]);
    const actionRows = card.elements.filter((element) => element.tag === "action");
    expect(actionRows).toHaveLength(6);
    expect(actionRows.map((row) => row.layout)).toEqual([
      "bisected",
      "bisected",
      "bisected",
      "flow",
      "bisected",
      "flow",
    ]);
    expect(
      actionRows.map((row) =>
        (row.actions as Array<{ text: { content: string } }>).map((item) => item.text.content),
      ),
    ).toEqual([
      ["选择项目", "选择对话"],
      ["项目群", "新对话"],
      ["全部任务", "项目任务"],
      ["模型设置"],
      ["刷新", "交还桌面"],
      ["停止任务"],
    ]);
    expect(actionRows.every((row) => (row.actions as unknown[]).length <= 2)).toBe(true);
    const summary = card.elements[0] as { text: { content: string } };
    expect(summary.text.content).toContain("修复 \\*卡片\\* \\[测试\\]");
    expect(JSON.stringify(card)).not.toContain("D:\\");
  });

  it("omits project-specific actions when no project is selected", () => {
    const card = renderHomeCard({ project: null, thread: null });
    expect(actions(card).map((item) => item.action)).toEqual([
      "project.list",
      "menu.refresh",
      "task.list",
      "task.stop",
      "chat.close",
    ]);
    const actionRows = card.elements.filter((element) => element.tag === "action");
    expect(actionRows.map((row) => row.layout)).toEqual(["bisected", "bisected", "flow"]);
    expect(
      actionRows.map((row) =>
        (row.actions as Array<{ text: { content: string } }>).map((item) => item.text.content),
      ),
    ).toEqual([["选择项目", "刷新"], ["全部任务", "停止任务"], ["交还桌面"]]);
    expect(actionRows.every((row) => (row.actions as unknown[]).length <= 2)).toBe(true);
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
    expect(cardActions.filter((item) => item.action === "thread.show")).toHaveLength(10);
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

    expect(card.header.title.content).toBe("项目任务中心");
    expect(JSON.stringify(card)).toContain("正在同步数据库");
    expect(actions(card)).toContainEqual({
      version: 1,
      action: "task.list",
      projectId: "claw",
      page: 1,
    });
  });
});
