export type ProjectCommand =
  | { group: "project"; action: "list" | "status" }
  | { group: "project"; action: "create"; projectId: string; name?: string }
  | {
      group: "project";
      action: "import";
      projectId: string;
      relativePath: string;
      name?: string;
    }
  | {
      group: "project";
      action: "use";
      projectId: string;
      clearThread: boolean;
    }
  | { group: "project"; action: "disable" | "enable"; projectId: string };

export type ChatCommand =
  | { group: "chat"; action: "new"; title?: string; lazy: boolean }
  | { group: "chat"; action: "list"; mode: "current" | "archived" | "all" }
  | { group: "chat"; action: "close" }
  | { group: "chat"; action: "use" | "show" | "archive" | "unarchive"; reference: string }
  | { group: "chat"; action: "rename"; reference: string; title: string };

export type ParsedCommand =
  | ProjectCommand
  | ChatCommand
  | { group: "control"; action: "help" | "health" | "stop" | "menu" }
  | { group: "invalid"; message: string };

interface TokenizeResult {
  tokens: string[];
  error?: string;
}

export function tokenizeCommand(input: string): TokenizeResult {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;

  const push = (): void => {
    if (current.length > 0) tokens.push(current);
    current = "";
  };

  for (const character of input.trim()) {
    if (escaped) {
      current += character === quote || character === "\\" ? character : `\\${character}`;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote) {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) push();
    else current += character;
  }
  if (escaped) current += "\\";
  if (quote) return { tokens, error: "引号没有闭合。" };
  push();
  return { tokens };
}

function joined(tokens: string[]): string | undefined {
  const value = tokens.join(" ").trim();
  return value || undefined;
}

function invalid(message: string): ParsedCommand {
  return { group: "invalid", message };
}

export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const parsed = tokenizeCommand(trimmed);
  if (parsed.error) return invalid(parsed.error);
  const [rawCommand, ...arguments_] = parsed.tokens;
  const command = rawCommand?.toLowerCase();

  switch (command) {
    case "/help":
      return { group: "control", action: "help" };
    case "/health":
      return { group: "control", action: "health" };
    case "/stop":
      return { group: "control", action: "stop" };
    case "/menu":
      return arguments_.length === 0
        ? { group: "control", action: "menu" }
        : invalid("用法：/menu");
    case "/projects":
      return { group: "project", action: "list" };
    case "/status":
      return { group: "project", action: "status" };
    case "/use": {
      const projectId = arguments_[0];
      return projectId
        ? { group: "project", action: "use", projectId, clearThread: true }
        : invalid("用法：/use <项目名称|#编号|ID>");
    }
    case "/new":
      return { group: "chat", action: "new", lazy: true };
    case "/threads":
      return { group: "chat", action: "list", mode: "current" };
    case "/resume": {
      const reference = arguments_[0];
      return reference
        ? { group: "chat", action: "use", reference }
        : invalid("用法：/resume <对话ID>");
    }
    case "/project":
      return parseProjectCommand(arguments_);
    case "/chat":
      return parseChatCommand(arguments_);
    default:
      return invalid("未知命令。使用 /help 查看可用命令。");
  }
}

function parseProjectCommand(arguments_: string[]): ParsedCommand {
  const [rawAction, ...rest] = arguments_;
  const action = rawAction?.toLowerCase();
  if (action === "list") return { group: "project", action: "list" };
  if (action === "status") return { group: "project", action: "status" };

  if (action === "create") {
    const [projectId, ...nameParts] = rest;
    const name = joined(nameParts);
    return projectId
      ? {
          group: "project",
          action: "create",
          projectId,
          ...(name ? { name } : {}),
        }
      : invalid("用法：/project create <项目ID> [项目名称]");
  }

  if (action === "import") {
    const [projectId, relativePath, ...nameParts] = rest;
    const name = joined(nameParts);
    return projectId && relativePath
      ? {
          group: "project",
          action: "import",
          projectId,
          relativePath,
          ...(name ? { name } : {}),
        }
      : invalid("用法：/project import <项目ID> <相对路径> [项目名称]");
  }

  if (action === "use") {
    const projectId = rest[0];
    return projectId
      ? { group: "project", action: "use", projectId, clearThread: false }
      : invalid("用法：/project use <项目名称|#编号|ID>");
  }

  if (action === "disable" || action === "enable") {
    const projectId = rest[0];
    return projectId
      ? { group: "project", action, projectId }
      : invalid(`用法：/project ${action} <项目ID>`);
  }

  return invalid("项目命令：/project list | create | import | use | status | disable | enable");
}

function parseChatCommand(arguments_: string[]): ParsedCommand {
  const [rawAction, ...rest] = arguments_;
  const action = rawAction?.toLowerCase();
  if (action === "new") {
    const title = joined(rest);
    return { group: "chat", action: "new", lazy: false, ...(title ? { title } : {}) };
  }
  if (action === "list") {
    const option = rest[0]?.toLowerCase();
    const mode =
      option === "archived" || option === "--archived"
        ? "archived"
        : option === "all" || option === "--all"
          ? "all"
          : "current";
    return { group: "chat", action: "list", mode };
  }
  if (action === "close") {
    return rest.length === 0 ? { group: "chat", action: "close" } : invalid("用法：/chat close");
  }
  if (action === "rename") {
    const [reference, ...titleParts] = rest;
    const title = joined(titleParts);
    return reference && title
      ? { group: "chat", action: "rename", reference, title }
      : invalid("用法：/chat rename <编号或对话ID> <新名称>");
  }
  if (action === "use" || action === "show" || action === "archive" || action === "unarchive") {
    const reference = rest[0];
    return reference
      ? { group: "chat", action, reference }
      : invalid(`用法：/chat ${action} <编号或对话ID>`);
  }
  return invalid("对话命令：/chat new | list | use | show | rename | archive | unarchive | close");
}
