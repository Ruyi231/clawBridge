import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexDesktopProjectDiscovery } from "../../src/projects/codex-desktop-project-discovery.js";

const temporaryDirectories: string[] = [];

function temporaryStateFile(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "clawbridge-desktop-projects-"));
  temporaryDirectories.push(directory);
  return path.join(directory, ".codex-global-state.json");
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value), "utf8");
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("CodexDesktopProjectDiscovery", () => {
  it("returns only ordered Desktop projects and only exposes safe fields", async () => {
    const stateFile = temporaryStateFile();
    writeJson(stateFile, {
      "project-order": ["second", "first"],
      "local-projects": {
        first: {
          id: "first",
          name: " First Project ",
          rootPaths: [" C:\\work\\first "],
          createdAt: 1,
          privateMessage: "must not be exposed",
        },
        second: {
          id: "second",
          name: "Second Project",
          rootPaths: ["D:\\work\\second"],
          updatedAt: 2,
        },
        unlisted: {
          id: "unlisted",
          name: "Hidden Project",
          rootPaths: ["D:\\work\\hidden"],
        },
      },
      messages: ["must not be exposed"],
    });

    const snapshot = await new CodexDesktopProjectDiscovery({ stateFile }).listProjects();

    expect(snapshot).toEqual({
      projects: [
        {
          sourceId: "second",
          name: "Second Project",
          rootPaths: ["D:\\work\\second"],
          order: 0,
          assignedThreadIds: [],
        },
        {
          sourceId: "first",
          name: "First Project",
          rootPaths: ["C:\\work\\first"],
          order: 1,
          assignedThreadIds: [],
        },
      ],
      sourcePath: stateFile,
      usedBackup: false,
    });
    expect(JSON.stringify(snapshot)).not.toContain("privateMessage");
    expect(JSON.stringify(snapshot)).not.toContain("must not be exposed");
  });

  it("rejects a structurally invalid primary snapshot and uses a valid backup", async () => {
    const stateFile = temporaryStateFile();
    writeJson(stateFile, {
      "project-order": [
        "missing",
        "valid",
        "valid",
        "blank-name",
        "empty-roots",
        "invalid-root",
        42,
      ],
      "local-projects": {
        valid: { name: "Valid", rootPaths: ["D:\\valid"] },
        "blank-name": { name: "   ", rootPaths: ["D:\\blank"] },
        "empty-roots": { name: "Empty", rootPaths: [] },
        "invalid-root": { name: "Invalid", rootPaths: ["D:\\valid", null] },
      },
    });

    writeJson(`${stateFile}.bak`, {
      "project-order": ["backup"],
      "local-projects": {
        backup: { name: "Backup", rootPaths: ["D:\\backup"] },
      },
    });

    await expect(new CodexDesktopProjectDiscovery({ stateFile }).listProjects()).resolves.toEqual({
      projects: [
        {
          sourceId: "backup",
          name: "Backup",
          rootPaths: ["D:\\backup"],
          order: 0,
          assignedThreadIds: [],
        },
      ],
      sourcePath: `${stateFile}.bak`,
      usedBackup: true,
    });
  });

  it("rejects control characters and overlong names without exposing them", async () => {
    const stateFile = temporaryStateFile();
    writeJson(stateFile, {
      "project-order": ["unsafe"],
      "local-projects": {
        unsafe: { name: `unsafe\n${"x".repeat(101)}`, rootPaths: ["D:\\unsafe"] },
      },
    });
    writeJson(`${stateFile}.bak`, {
      "project-order": ["unsafe"],
      "local-projects": {
        unsafe: { name: "unsafe\nname", rootPaths: ["D:\\unsafe"] },
      },
    });

    const result = new CodexDesktopProjectDiscovery({ stateFile }).listProjects();
    await expect(result).rejects.toThrow(
      "Unable to read Codex Desktop project state or its backup.",
    );
    await expect(result).rejects.not.toThrow(/unsafe|x{10}/);
  });

  it("falls back to the backup when the primary file cannot be read", async () => {
    const stateFile = temporaryStateFile();
    writeJson(`${stateFile}.bak`, {
      "project-order": ["backup"],
      "local-projects": {
        backup: { name: "Backup", rootPaths: ["D:\\backup"] },
      },
    });

    const snapshot = await new CodexDesktopProjectDiscovery(stateFile).listProjects();

    expect(snapshot).toEqual({
      projects: [
        {
          sourceId: "backup",
          name: "Backup",
          rootPaths: ["D:\\backup"],
          order: 0,
          assignedThreadIds: [],
        },
      ],
      sourcePath: `${stateFile}.bak`,
      usedBackup: true,
    });
  });

  it("falls back to the backup when the primary JSON is malformed", async () => {
    const stateFile = temporaryStateFile();
    writeFileSync(stateFile, "not-json and must not appear in errors", "utf8");
    writeJson(`${stateFile}.bak`, {
      "project-order": [],
      "local-projects": {},
    });

    await expect(
      new CodexDesktopProjectDiscovery({ stateFile }).listProjects(),
    ).resolves.toMatchObject({ usedBackup: true, projects: [] });
  });

  it("uses CODEX_HOME for the default state path", async () => {
    const stateFile = temporaryStateFile();
    vi.stubEnv("CODEX_HOME", path.dirname(stateFile));
    writeJson(stateFile, {
      "project-order": ["default"],
      "local-projects": {
        default: { name: "Default", rootPaths: ["D:\\default"] },
      },
    });

    const snapshot = await new CodexDesktopProjectDiscovery().listProjects();

    expect(snapshot.sourcePath).toBe(stateFile);
    expect(snapshot.projects[0]?.sourceId).toBe("default");
  });

  it("returns only valid thread assignments for each ordered project", async () => {
    const stateFile = temporaryStateFile();
    writeJson(stateFile, {
      "project-order": ["project-a"],
      "local-projects": {
        "project-a": { name: "Project A", rootPaths: ["D:\\project-a"] },
      },
      "thread-project-assignments": {
        "019fa387-c14a-7d53-91bb-da80480dc85a": { projectId: "project-a", private: "ignored" },
        "not a thread id": { projectId: "project-a" },
        "019fa752-2316-76a0-aaba-dc4df7e4ee2d": { projectId: "other" },
      },
    });

    const snapshot = await new CodexDesktopProjectDiscovery({ stateFile }).listProjects();

    expect(snapshot.projects[0]?.assignedThreadIds).toEqual([
      "019fa387-c14a-7d53-91bb-da80480dc85a",
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("private");
  });

  it("fails without leaking file contents when both state files are invalid", async () => {
    const stateFile = temporaryStateFile();
    writeFileSync(stateFile, "primary secret payload", "utf8");
    writeFileSync(`${stateFile}.bak`, "backup secret payload", "utf8");

    const result = new CodexDesktopProjectDiscovery({ stateFile }).listProjects();

    await expect(result).rejects.toThrow(
      "Unable to read Codex Desktop project state or its backup.",
    );
    await expect(result).rejects.not.toThrow(/primary secret payload|backup secret payload/);
  });

  it("registers a created project while preserving unrelated Desktop state", async () => {
    const stateFile = temporaryStateFile();
    writeJson(stateFile, {
      "project-order": ["existing"],
      "local-projects": {
        existing: { id: "existing", name: "Existing", rootPaths: ["D:\\existing"] },
      },
      privateSetting: { keep: true },
    });
    const source = new CodexDesktopProjectDiscovery({
      stateFile,
      registerCreatedProjects: true,
    });

    const result = await source.registerProject({
      name: "test_codex",
      rootPath: "D:\\CodexWorkspace\\test_codex",
    });
    const persisted = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
    const projects = persisted["local-projects"] as Record<string, Record<string, unknown>>;

    expect(result.created).toBe(true);
    expect(result.sourceId).toMatch(/^local-[0-9a-f]{32}$/);
    expect(persisted.privateSetting).toEqual({ keep: true });
    expect(persisted["project-order"]).toEqual(["existing", result.sourceId]);
    expect(projects[result.sourceId]).toMatchObject({
      id: result.sourceId,
      name: "test_codex",
      rootPaths: [path.resolve("D:\\CodexWorkspace\\test_codex")],
    });
  });

  it("does not duplicate an already registered root and requires explicit write opt-in", async () => {
    const stateFile = temporaryStateFile();
    writeJson(stateFile, {
      "project-order": ["existing"],
      "local-projects": {
        existing: {
          id: "existing",
          name: "Existing",
          rootPaths: ["D:\\CodexWorkspace\\test_codex"],
        },
      },
    });

    await expect(
      new CodexDesktopProjectDiscovery({ stateFile }).registerProject({
        name: "test_codex",
        rootPath: "D:\\CodexWorkspace\\test_codex",
      }),
    ).rejects.toThrow("registration is disabled");
    await expect(
      new CodexDesktopProjectDiscovery({
        stateFile,
        registerCreatedProjects: true,
      }).registerProject({
        name: "test_codex",
        rootPath: "D:\\CodexWorkspace\\test_codex",
      }),
    ).resolves.toEqual({ sourceId: "existing", created: false });
  });
});
