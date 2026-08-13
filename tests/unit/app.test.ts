import { describe, expect, it } from "vitest";
import pino from "pino";
import {
  createBridgeLoggerOptions,
  removeFeishuCredentialsFromEnvironment,
  takeLifecycleFiles,
} from "../../src/app.js";
import { codexChildEnvironment } from "../../src/codex/app-server-client.js";

describe("removeFeishuCredentialsFromEnvironment", () => {
  it("removes the configured Feishu credentials without changing loaded copies", () => {
    const environment: NodeJS.ProcessEnv = {
      CUSTOM_APP_ID: "test-app-id",
      CUSTOM_APP_SECRET: "test-app-secret",
      CUSTOM_ALLOWED_OPEN_ID: "test-open-id",
      KEEP_ME: "unchanged",
    };
    const loadedSecrets = {
      appId: environment.CUSTOM_APP_ID,
      appSecret: environment.CUSTOM_APP_SECRET,
      allowedOpenId: environment.CUSTOM_ALLOWED_OPEN_ID,
    };

    removeFeishuCredentialsFromEnvironment(environment, {
      appIdEnv: "CUSTOM_APP_ID",
      appSecretEnv: "CUSTOM_APP_SECRET",
      allowedOpenIdEnv: "CUSTOM_ALLOWED_OPEN_ID",
    });

    expect(environment).toEqual({ KEEP_ME: "unchanged" });
    expect(loadedSecrets).toEqual({
      appId: "test-app-id",
      appSecret: "test-app-secret",
      allowedOpenId: "test-open-id",
    });
  });

  it("removes custom credential names as well as the well-known defaults", () => {
    const environment: NodeJS.ProcessEnv = {
      CUSTOM_APP_ID: "custom-id",
      CUSTOM_APP_SECRET: "custom-secret",
      CUSTOM_ALLOWED_OPEN_ID: "custom-open-id",
      CLAWBRIDGE_FEISHU_APP_ID: "legacy-id",
      CLAWBRIDGE_FEISHU_APP_SECRET: "legacy-secret",
      CLAWBRIDGE_FEISHU_ALLOWED_OPEN_ID: "legacy-open-id",
      KEEP_ME: "unchanged",
    };

    removeFeishuCredentialsFromEnvironment(environment, {
      appIdEnv: "CUSTOM_APP_ID",
      appSecretEnv: "CUSTOM_APP_SECRET",
      allowedOpenIdEnv: "CUSTOM_ALLOWED_OPEN_ID",
    });

    expect(environment).toEqual({ KEEP_ME: "unchanged" });
  });
});

describe("takeLifecycleFiles", () => {
  it("takes lifecycle paths without leaving control variables for child processes", () => {
    const environment: NodeJS.ProcessEnv = {
      CLAWBRIDGE_READY_FILE: "data/ready.json",
      CLAWBRIDGE_SHUTDOWN_FILE: "data/shutdown.json",
      KEEP_ME: "unchanged",
    };

    const files = takeLifecycleFiles(environment);

    expect(files.readyFile).toMatch(/[\\/]data[\\/]ready\.json$/);
    expect(files.shutdownFile).toMatch(/[\\/]data[\\/]shutdown\.json$/);
    expect(environment).toEqual({ KEEP_ME: "unchanged" });
  });
});

describe("createBridgeLoggerOptions", () => {
  it("suppresses nested sensitive diagnostic objects before serializers can expose them", () => {
    const output: string[] = [];
    const logger = pino(createBridgeLoggerOptions("trace"), {
      write: (line: string) => output.push(line),
    });

    logger.error(
      { err: { config: { data: { app_id: "cli-sensitive", app_secret: "secret-value" } } } },
      "request failed",
    );

    expect(output.join("\n")).not.toContain("cli-sensitive");
    expect(output.join("\n")).not.toContain("secret-value");
    expect(output.join("\n")).toContain("Sensitive diagnostic event suppressed");
  });
});

describe("codexChildEnvironment", () => {
  it("keeps runtime variables while excluding common credential variables", () => {
    expect(
      codexChildEnvironment({
        PATH: "C:\\tools",
        CODEX_HOME: "C:\\codex",
        CLAWBRIDGE_FEISHU_APP_SECRET: "secret",
        OPENAI_API_KEY: "key",
        SOME_ACCESS_TOKEN: "token",
      }),
    ).toEqual({ PATH: "C:\\tools", CODEX_HOME: "C:\\codex" });
  });
});
