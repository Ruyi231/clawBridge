import { describe, expect, it } from "vitest";
import { parseCommand, tokenizeCommand } from "../../src/core/command-router.js";

describe("command parser", () => {
  it("keeps quoted project names and relative paths together", () => {
    expect(parseCommand('/project create vision "视觉 项目"')).toEqual({
      group: "project",
      action: "create",
      projectId: "vision",
      name: "视觉 项目",
    });
    expect(parseCommand('/project import old "已有 项目" "旧工程"')).toEqual({
      group: "project",
      action: "import",
      projectId: "old",
      relativePath: "已有 项目",
      name: "旧工程",
    });
    expect(parseCommand('/project import win "foo\\bar baz" "Windows 工程"')).toEqual({
      group: "project",
      action: "import",
      projectId: "win",
      relativePath: "foo\\bar baz",
      name: "Windows 工程",
    });
  });

  it("maps legacy commands without losing their compatibility semantics", () => {
    expect(parseCommand("/use demo")).toEqual({
      group: "project",
      action: "use",
      projectId: "demo",
      clearThread: true,
    });
    expect(parseCommand("/new")).toEqual({ group: "chat", action: "new", lazy: true });
    expect(parseCommand("/resume 019abc")).toEqual({
      group: "chat",
      action: "use",
      reference: "019abc",
    });
  });

  it("parses archive filters and reports specific argument errors", () => {
    expect(parseCommand("/chat list --archived")).toEqual({
      group: "chat",
      action: "list",
      mode: "archived",
    });
    expect(parseCommand("/chat rename 2")).toEqual({
      group: "invalid",
      message: "用法：/chat rename <编号或对话ID> <新名称>",
    });
    expect(tokenizeCommand('/chat new "unfinished')).toMatchObject({ error: "引号没有闭合。" });
  });

  it("parses chat close without arguments and rejects extra arguments", () => {
    expect(parseCommand("/chat close")).toEqual({ group: "chat", action: "close" });
    expect(parseCommand("/chat CLOSE")).toEqual({ group: "chat", action: "close" });
    expect(parseCommand("/chat close now")).toEqual({
      group: "invalid",
      message: "用法：/chat close",
    });
  });

  it("parses the mobile card menu command without arguments", () => {
    expect(parseCommand("/menu")).toEqual({ group: "control", action: "menu" });
    expect(parseCommand("/MENU")).toEqual({ group: "control", action: "menu" });
    expect(parseCommand("/menu now")).toEqual({
      group: "invalid",
      message: "用法：/menu",
    });
  });
});
