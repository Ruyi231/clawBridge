import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
        },
        {
          sourceId: "first",
          name: "First Project",
          rootPaths: ["C:\\work\\first"],
          order: 1,
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
      projects: [{ sourceId: "backup", name: "Backup", rootPaths: ["D:\\backup"], order: 0 }],
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
      projects: [{ sourceId: "backup", name: "Backup", rootPaths: ["D:\\backup"], order: 0 }],
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
});
