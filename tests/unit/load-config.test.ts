import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load-config.js";

const temporaryDirectories: string[] = [];

async function writeConfiguration(projectManagement = ""): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "clawbridge-config-"));
  temporaryDirectories.push(root);
  const configDirectory = path.join(root, "config");
  const configPath = path.join(configDirectory, "local.yaml");
  await mkdir(configDirectory);
  await writeFile(
    path.join(root, "projects.yaml"),
    [
      "projects:",
      "  - id: demo",
      "    name: Demo",
      `    rootPath: ${JSON.stringify(root)}`,
      "    enabled: true",
      "",
    ].join("\n"),
  );
  await writeFile(
    configPath,
    [
      "bridge: {}",
      "feishu:",
      "  appIdEnv: TEST_APP_ID",
      "  appSecretEnv: TEST_APP_SECRET",
      "  allowedOpenIdEnv: TEST_ALLOWED_OPEN_ID",
      "codex: {}",
      ...(projectManagement ? ["projectManagement:", ...projectManagement.split("\n")] : []),
      "projectsFile: projects.yaml",
      "",
    ].join("\n"),
  );
  return configPath;
}

const environment = {
  TEST_APP_ID: "app-id",
  TEST_APP_SECRET: "app-secret",
  TEST_ALLOWED_OPEN_ID: "open-id",
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("loadConfig", () => {
  it("keeps old configurations compatible by disabling desktop projects", async () => {
    const configPath = await writeConfiguration();

    const loaded = await loadConfig(configPath, environment);

    expect(loaded.config.projectManagement.codexDesktopProjects).toEqual({
      enabled: false,
      registerCreatedProjects: false,
    });
    expect(loaded.config.bridge.attachmentDirectory).toBe(
      path.resolve(path.dirname(configPath), "..", "data/attachments"),
    );
    expect(loaded.config.bridge.attachmentMaxBytes).toBe(20 * 1024 * 1024);
  });

  it("resolves a relative desktop state file like other local paths", async () => {
    const configPath = await writeConfiguration(
      ["  codexDesktopProjects:", "    enabled: true", "    stateFile: state/desktop.json"].join(
        "\n",
      ),
    );

    const loaded = await loadConfig(configPath, environment);

    expect(loaded.config.projectManagement.codexDesktopProjects).toEqual({
      enabled: true,
      registerCreatedProjects: false,
      stateFile: path.resolve(path.dirname(configPath), "..", "state/desktop.json"),
    });
  });

  it("preserves an absolute desktop state file path", async () => {
    const configPath = await writeConfiguration();
    const absoluteStateFile = path.join(path.parse(configPath).root, "codex", "state.json");
    const content = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      content.replace(
        "projectsFile: projects.yaml",
        [
          "projectManagement:",
          "  codexDesktopProjects:",
          "    enabled: true",
          `    stateFile: ${JSON.stringify(absoluteStateFile)}`,
          "projectsFile: projects.yaml",
        ].join("\n"),
      ),
    );

    const loaded = await loadConfig(configPath, environment);

    expect(loaded.config.projectManagement.codexDesktopProjects.stateFile).toBe(absoluteStateFile);
  });

  it("resolves relative bootstrap project paths from the repository root", async () => {
    const configPath = await writeConfiguration();
    const projectsPath = path.resolve(path.dirname(configPath), "..", "projects.yaml");
    await writeFile(
      projectsPath,
      ["projects:", "  - id: demo", "    name: Demo", "    rootPath: .", ""].join("\n"),
    );

    const loaded = await loadConfig(configPath, environment);

    expect(loaded.projects[0]?.rootPath).toBe(path.resolve(path.dirname(configPath), ".."));
  });
});
