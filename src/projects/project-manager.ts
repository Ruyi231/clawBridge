import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { BridgeError } from "../core/errors.js";
import type { BridgeDatabase, ProjectRecord } from "../persistence/database.js";

const projectIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const windowsReservedNamePattern = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function canonical(candidate: string): string {
  const resolved = path.resolve(candidate);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function validateProject(projectId: string, name: string): string {
  if (!projectIdPattern.test(projectId)) {
    throw new BridgeError(
      "INVALID_PROJECT",
      "项目 ID 只能包含小写字母、数字、下划线和连字符，且最长 64 个字符。",
    );
  }
  const normalizedName = name.trim();
  if (!normalizedName || normalizedName.length > 100) {
    throw new BridgeError("INVALID_PROJECT", "项目名称不能为空，且不能超过 100 个字符。");
  }
  return normalizedName;
}

function validateDirectoryName(directoryName: string): string {
  const normalized = directoryName.trim();
  if (
    !normalized ||
    normalized.length > 100 ||
    normalized === "." ||
    normalized === ".." ||
    /[\\/:*?"<>|\u0000-\u001f]/.test(normalized) ||
    /[. ]$/.test(normalized) ||
    windowsReservedNamePattern.test(normalized)
  ) {
    throw new BridgeError(
      "INVALID_PROJECT_PATH",
      "项目目录名称无效；不能包含路径保留字符、控制字符、结尾空格/句点或 Windows 保留名称。",
    );
  }
  return normalized;
}

function isExplicitAbsolute(candidate: string): boolean {
  return path.isAbsolute(candidate) || path.win32.isAbsolute(candidate);
}

export class ProjectManager {
  constructor(
    private readonly database: BridgeDatabase,
    private readonly options: {
      allowedRoots: string[];
      allowCreateDirectory: boolean;
      allowRegisterExisting: boolean;
    },
  ) {}

  async createProject(
    projectId: string,
    name = projectId,
    directoryName = projectId,
  ): Promise<ProjectRecord> {
    const normalizedName = validateProject(projectId, name);
    const normalizedDirectoryName = validateDirectoryName(directoryName);
    this.assertNewProjectId(projectId);
    if (!this.options.allowCreateDirectory) {
      throw new BridgeError("PROJECT_CREATE_DISABLED", "当前配置不允许通过机器人创建项目目录。");
    }

    const root = await this.primaryRoot();
    const target = path.resolve(root, normalizedDirectoryName);
    if (!isWithin(root, target) || canonical(target) === canonical(root)) {
      throw new BridgeError("PATH_OUTSIDE_PROJECT", "项目目录超出允许的项目根目录。");
    }

    try {
      await mkdir(target, { recursive: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new BridgeError(
          "PROJECT_PATH_EXISTS",
          "目标目录已经存在；请使用 /project import 导入已有目录。",
        );
      }
      throw error;
    }

    const realTarget = await realpath(target);
    if (!isWithin(root, realTarget)) {
      throw new BridgeError("PATH_OUTSIDE_PROJECT", "项目目录解析后超出允许范围。");
    }
    try {
      return this.database.createProject({
        id: projectId,
        name: normalizedName,
        rootPath: realTarget,
        enabled: true,
      });
    } catch (error) {
      throw new BridgeError(
        "INVALID_PROJECT",
        `目录 ${realTarget} 已创建，但项目登记失败。目录不会被自动删除；排除故障后可用 /project import ${projectId} ${projectId} 重新登记。`,
        false,
        { cause: error },
      );
    }
  }

  async importProject(
    projectId: string,
    relativePath: string,
    name = projectId,
  ): Promise<ProjectRecord> {
    const normalizedName = validateProject(projectId, name);
    this.assertNewProjectId(projectId);
    if (!this.options.allowRegisterExisting) {
      throw new BridgeError(
        "PROJECT_IMPORT_DISABLED",
        "当前配置不允许通过机器人导入已有项目目录。",
      );
    }
    if (!relativePath || isExplicitAbsolute(relativePath)) {
      throw new BridgeError("INVALID_PROJECT_PATH", "导入路径必须是允许项目根目录下的相对路径。");
    }
    const segments = relativePath.split(/[\\/]+/);
    if (segments.includes("..") || segments.includes("")) {
      throw new BridgeError("INVALID_PROJECT_PATH", "导入路径不能包含空段或 ..。");
    }

    const roots = await this.existingRoots();
    const matches: string[] = [];
    for (const root of roots) {
      const candidate = path.resolve(root, relativePath);
      if (!isWithin(root, candidate) || canonical(candidate) === canonical(root)) continue;
      try {
        const resolved = await realpath(candidate);
        if (!isWithin(root, resolved)) continue;
        if ((await stat(resolved)).isDirectory()) matches.push(resolved);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    const uniqueMatches = [
      ...new Map(matches.map((match) => [canonical(match), path.resolve(match)])).values(),
    ];
    if (uniqueMatches.length === 0) {
      throw new BridgeError("PROJECT_NOT_FOUND", "允许的项目根目录下没有找到该目录。");
    }
    if (uniqueMatches.length > 1) {
      throw new BridgeError(
        "PROJECT_PATH_AMBIGUOUS",
        "多个允许根目录中存在同名目录，请改用更明确的相对路径。",
      );
    }

    const rootPath = uniqueMatches[0];
    if (!rootPath) throw new BridgeError("PROJECT_NOT_FOUND", "没有找到项目目录。");
    const pathOwner = this.database
      .listProjects({ includeDisabled: true })
      .find((project) => canonical(project.rootPath) === canonical(rootPath));
    if (pathOwner) {
      throw new BridgeError(
        "INVALID_PROJECT",
        `该目录已经登记为项目 ${pathOwner.name} (${pathOwner.id})。`,
      );
    }
    return this.database.createProject({
      id: projectId,
      name: normalizedName,
      rootPath,
      enabled: true,
    });
  }

  private assertNewProjectId(projectId: string): void {
    if (this.database.getProject(projectId)) {
      throw new BridgeError("INVALID_PROJECT", `项目 ID ${projectId} 已经存在。`);
    }
  }

  private async existingRoots(): Promise<string[]> {
    const roots: string[] = [];
    for (const configured of this.options.allowedRoots) {
      try {
        const resolved = await realpath(path.resolve(configured));
        roots.push(resolved);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const uniqueRoots = [...new Map(roots.map((root) => [canonical(root), root])).values()];
    if (uniqueRoots.length === 0) {
      throw new BridgeError("PROJECT_ROOT_MISSING", "尚未配置可用的项目根目录。");
    }
    return uniqueRoots;
  }

  private async primaryRoot(): Promise<string> {
    const configured = this.options.allowedRoots[0];
    if (!configured) {
      throw new BridgeError("PROJECT_ROOT_MISSING", "尚未配置可用的项目根目录。");
    }
    try {
      return await realpath(path.resolve(configured));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new BridgeError(
          "PROJECT_ROOT_MISSING",
          `首个项目根目录不存在：${path.resolve(configured)}`,
          false,
          { cause: error },
        );
      }
      throw error;
    }
  }
}
