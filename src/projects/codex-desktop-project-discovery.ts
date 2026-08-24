import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface DesktopProjectRecord {
  sourceId: string;
  name: string;
  rootPaths: string[];
  order: number;
  assignedThreadIds: string[];
}

export interface DesktopProjectSnapshot {
  projects: DesktopProjectRecord[];
  sourcePath: string;
  usedBackup: boolean;
}

export interface DesktopProjectSource {
  listProjects(): Promise<DesktopProjectSnapshot>;
  isDesktopRunning?(): Promise<boolean>;
  registerProject?(input: { name: string; rootPath: string }): Promise<{
    sourceId: string;
    created: boolean;
  }>;
}

export interface CodexDesktopProjectDiscoveryOptions {
  stateFile?: string;
  registerCreatedProjects?: boolean;
}

interface DesktopStateShape {
  "project-order": unknown;
  "local-projects": unknown;
  "thread-project-assignments"?: unknown;
}

const maxSourceIdLength = 512;
const maxProjectNameLength = 100;
const maxPathLength = 32_767;
const controlCharacterPattern = /[\u0000-\u001f\u007f]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseState(raw: string): DesktopProjectRecord[] {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error("Codex Desktop project state must be an object.");
  }

  const state = parsed as unknown as DesktopStateShape;
  if (!Array.isArray(state["project-order"]) || !isRecord(state["local-projects"])) {
    throw new Error("Codex Desktop project state has an unsupported shape.");
  }

  const localProjects = state["local-projects"];
  const assignments = isRecord(state["thread-project-assignments"])
    ? state["thread-project-assignments"]
    : {};
  const assignedThreads = new Map<string, string[]>();
  for (const [threadId, value] of Object.entries(assignments)) {
    if (!/^[0-9a-f-]{16,64}$/i.test(threadId) || !isRecord(value)) continue;
    const projectId = value.projectId;
    if (typeof projectId !== "string" || !projectId || projectId.length > maxSourceIdLength)
      continue;
    const threads = assignedThreads.get(projectId) ?? [];
    threads.push(threadId);
    assignedThreads.set(projectId, threads);
  }
  const projects: DesktopProjectRecord[] = [];
  const seen = new Set<string>();

  for (const [order, sourceIdValue] of state["project-order"].entries()) {
    if (
      typeof sourceIdValue !== "string" ||
      !sourceIdValue ||
      sourceIdValue.length > maxSourceIdLength ||
      controlCharacterPattern.test(sourceIdValue) ||
      seen.has(sourceIdValue)
    )
      throw new Error("Codex Desktop project order contains an invalid entry.");
    seen.add(sourceIdValue);

    if (!Object.prototype.hasOwnProperty.call(localProjects, sourceIdValue))
      throw new Error("Codex Desktop project order references a missing project.");
    const candidate = localProjects[sourceIdValue];
    if (!isRecord(candidate)) throw new Error("Codex Desktop project entry must be an object.");

    const name = candidate.name;
    const rootPaths = candidate.rootPaths;
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.trim().length > maxProjectNameLength ||
      controlCharacterPattern.test(name) ||
      !Array.isArray(rootPaths)
    )
      throw new Error("Codex Desktop project entry has an invalid name or root list.");
    if (
      rootPaths.length === 0 ||
      rootPaths.some(
        (rootPath) =>
          typeof rootPath !== "string" ||
          !rootPath.trim() ||
          rootPath.trim().length > maxPathLength ||
          controlCharacterPattern.test(rootPath),
      )
    )
      throw new Error("Codex Desktop project entry has an invalid root path.");

    projects.push({
      sourceId: sourceIdValue,
      name: name.trim(),
      rootPaths: rootPaths.map((rootPath) => (rootPath as string).trim()),
      order,
      assignedThreadIds: assignedThreads.get(sourceIdValue) ?? [],
    });
  }

  return projects;
}

function defaultStateFile(): string {
  const configuredHome = process.env.CODEX_HOME?.trim();
  const codexHome = configuredHome || path.join(homedir(), ".codex");
  return path.join(codexHome, ".codex-global-state.json");
}

export class CodexDesktopProjectDiscovery implements DesktopProjectSource {
  private readonly stateFile: string;
  private readonly registerCreatedProjects: boolean;

  constructor(options: CodexDesktopProjectDiscoveryOptions | string = {}) {
    this.stateFile =
      typeof options === "string" ? options : (options.stateFile ?? defaultStateFile());
    this.registerCreatedProjects =
      typeof options === "string" ? false : (options.registerCreatedProjects ?? false);
  }

  async listProjects(): Promise<DesktopProjectSnapshot> {
    try {
      return await this.readSnapshot(this.stateFile, false);
    } catch {
      const backupPath = `${this.stateFile}.bak`;
      try {
        return await this.readSnapshot(backupPath, true);
      } catch {
        throw new Error("Unable to read Codex Desktop project state or its backup.");
      }
    }
  }

  async isDesktopRunning(): Promise<boolean> {
    if (process.platform !== "win32") return true;
    const script = [
      "$match = Get-Process -Name ChatGPT -ErrorAction SilentlyContinue",
      "| Where-Object { $_.Path -match '[\\\\/]OpenAI\\.Codex_[^\\\\/]*[\\\\/]app[\\\\/]ChatGPT\\.exe$' }",
      "| Select-Object -First 1",
      "; if ($null -eq $match) { 'false' } else { 'true' }",
    ].join(" ");
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true, timeout: 4_000, encoding: "utf8" },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        },
      );
    });
    return output.trim().toLowerCase() === "true";
  }

  async registerProject(input: { name: string; rootPath: string }): Promise<{
    sourceId: string;
    created: boolean;
  }> {
    if (!this.registerCreatedProjects) {
      throw new Error("Codex Desktop project registration is disabled.");
    }

    const original = await readFile(this.stateFile, "utf8");
    const parsed: unknown = JSON.parse(original);
    if (!isRecord(parsed)) throw new Error("Codex Desktop project state must be an object.");
    const order = parsed["project-order"];
    const localProjects = parsed["local-projects"];
    if (!Array.isArray(order) || !isRecord(localProjects)) {
      throw new Error("Codex Desktop project state has an unsupported shape.");
    }

    const targetRoot = canonicalPath(input.rootPath);
    let existingSourceId: string | undefined;
    for (const [sourceId, candidate] of Object.entries(localProjects)) {
      if (!isRecord(candidate) || !Array.isArray(candidate.rootPaths)) continue;
      if (
        candidate.rootPaths.some(
          (rootPath) => typeof rootPath === "string" && canonicalPath(rootPath) === targetRoot,
        )
      ) {
        existingSourceId = sourceId;
        if (order.includes(sourceId)) return { sourceId, created: false };
        order.push(sourceId);
        break;
      }
    }

    const sourceId = existingSourceId ?? `local-${randomBytes(16).toString("hex")}`;
    const now = Date.now();
    if (!existingSourceId) {
      localProjects[sourceId] = {
        id: sourceId,
        name: input.name,
        rootPaths: [path.resolve(input.rootPath)],
        createdAt: now,
        updatedAt: now,
      };
      order.push(sourceId);
    }

    const temporary = `${this.stateFile}.${process.pid}.${now}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(parsed), { encoding: "utf8", flag: "wx" });
      const current = await readFile(this.stateFile, "utf8");
      if (current !== original) {
        throw new Error(
          "Codex Desktop project state changed while ClawBridge was registering the project; retry after Desktop becomes idle.",
        );
      }
      await rename(temporary, this.stateFile);
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
    return { sourceId, created: !existingSourceId };
  }

  private async readSnapshot(
    sourcePath: string,
    usedBackup: boolean,
  ): Promise<DesktopProjectSnapshot> {
    const raw = await readFile(sourcePath, "utf8");
    return {
      projects: parseState(raw),
      sourcePath,
      usedBackup,
    };
  }
}

function canonicalPath(candidate: string): string {
  const resolved = path.resolve(candidate);
  return process.platform === "win32" ? resolved.toLocaleLowerCase() : resolved;
}
