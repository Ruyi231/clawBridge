import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeDatabase } from "../../src/persistence/database.js";
import { ProjectManager } from "../../src/projects/project-manager.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ProjectManager", () => {
  it("creates a project beneath the configured root", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "clawbridge-projects-"));
    temporaryDirectories.push(root);
    const database = new BridgeDatabase(":memory:");
    const manager = new ProjectManager(database, {
      allowedRoots: [root],
      allowCreateDirectory: true,
      allowRegisterExisting: true,
    });

    const project = await manager.createProject("demo", "Demo Project");

    expect(project).toMatchObject({ id: "demo", name: "Demo Project", enabled: true });
    expect(path.dirname(project.rootPath)).toBe(path.resolve(root));
    database.close();
  });

  it("imports an existing relative directory and rejects traversal", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "clawbridge-projects-"));
    temporaryDirectories.push(root);
    mkdirSync(path.join(root, "existing"));
    const database = new BridgeDatabase(":memory:");
    const manager = new ProjectManager(database, {
      allowedRoots: [root],
      allowCreateDirectory: true,
      allowRegisterExisting: true,
    });

    await expect(manager.importProject("existing", "existing", "Existing")).resolves.toMatchObject({
      id: "existing",
    });
    await expect(manager.importProject("escape", "../outside", "Escape")).rejects.toMatchObject({
      code: "INVALID_PROJECT_PATH",
    });
    database.close();
  });

  it("rejects absolute imports, invalid ids, and existing create targets", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "clawbridge-projects-"));
    temporaryDirectories.push(root);
    mkdirSync(path.join(root, "taken"));
    const database = new BridgeDatabase(":memory:");
    const manager = new ProjectManager(database, {
      allowedRoots: [root],
      allowCreateDirectory: true,
      allowRegisterExisting: true,
    });

    await expect(
      manager.importProject("absolute", path.resolve(root, "taken")),
    ).rejects.toMatchObject({
      code: "INVALID_PROJECT_PATH",
    });
    await expect(manager.createProject("UpperCase")).rejects.toMatchObject({
      code: "INVALID_PROJECT",
    });
    await expect(manager.createProject("taken")).rejects.toMatchObject({
      code: "PROJECT_PATH_EXISTS",
    });
    expect(database.getProject("taken")).toBeUndefined();
    database.close();
  });

  it("enforces create and import feature flags independently", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "clawbridge-projects-"));
    temporaryDirectories.push(root);
    mkdirSync(path.join(root, "existing"));
    const database = new BridgeDatabase(":memory:");
    const manager = new ProjectManager(database, {
      allowedRoots: [root],
      allowCreateDirectory: false,
      allowRegisterExisting: false,
    });

    await expect(manager.createProject("blocked-create")).rejects.toMatchObject({
      code: "PROJECT_CREATE_DISABLED",
    });
    await expect(manager.importProject("blocked-import", "existing")).rejects.toMatchObject({
      code: "PROJECT_IMPORT_DISABLED",
    });
    database.close();
  });

  it("does not silently create beneath a later root when the primary root is missing", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "clawbridge-projects-"));
    temporaryDirectories.push(parent);
    const missingPrimary = path.join(parent, "missing-primary");
    const secondary = path.join(parent, "secondary");
    mkdirSync(secondary);
    const database = new BridgeDatabase(":memory:");
    const manager = new ProjectManager(database, {
      allowedRoots: [missingPrimary, secondary],
      allowCreateDirectory: true,
      allowRegisterExisting: true,
    });

    await expect(manager.createProject("must-not-move")).rejects.toMatchObject({
      code: "PROJECT_ROOT_MISSING",
    });
    expect(database.getProject("must-not-move")).toBeUndefined();
    database.close();
  });
});
