import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import {
  bridgeConfigSchema,
  projectsFileSchema,
  type BridgeConfig,
  type ProjectConfig,
} from "./schema.js";

export interface LoadedConfig {
  config: BridgeConfig;
  projects: ProjectConfig[];
  secrets: { appId: string; appSecret: string; allowedOpenId: string };
}

function resolveFromConfig(configFile: string, target: string): string {
  return path.isAbsolute(target) ? target : path.resolve(path.dirname(configFile), "..", target);
}

function requireEnvironment(name: string, environment: NodeJS.ProcessEnv): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Required environment variable ${name} is not set`);
  return value;
}

export async function loadConfig(
  configPath = process.env.CLAWBRIDGE_CONFIG ?? "config/local.yaml",
  environment = process.env,
  options: { requireFeishuSecrets?: boolean } = {},
): Promise<LoadedConfig> {
  const absoluteConfigPath = path.resolve(configPath);
  const config = bridgeConfigSchema.parse(YAML.parse(await readFile(absoluteConfigPath, "utf8")));
  const projectsPath = resolveFromConfig(absoluteConfigPath, config.projectsFile);
  const projectsDocument = projectsFileSchema.parse(
    YAML.parse(await readFile(projectsPath, "utf8")),
  );

  return {
    config: {
      ...config,
      bridge: {
        ...config.bridge,
        databasePath: resolveFromConfig(absoluteConfigPath, config.bridge.databasePath),
        attachmentDirectory: resolveFromConfig(
          absoluteConfigPath,
          config.bridge.attachmentDirectory,
        ),
      },
      projectManagement: {
        ...config.projectManagement,
        allowedRoots: config.projectManagement.allowedRoots.map((root) =>
          resolveFromConfig(absoluteConfigPath, root),
        ),
        codexDesktopProjects: {
          ...config.projectManagement.codexDesktopProjects,
          ...(config.projectManagement.codexDesktopProjects.stateFile
            ? {
                stateFile: resolveFromConfig(
                  absoluteConfigPath,
                  config.projectManagement.codexDesktopProjects.stateFile,
                ),
              }
            : {}),
        },
      },
      projectsFile: projectsPath,
    },
    projects: projectsDocument.projects,
    secrets: {
      appId:
        options.requireFeishuSecrets === false
          ? (environment[config.feishu.appIdEnv]?.trim() ?? "")
          : requireEnvironment(config.feishu.appIdEnv, environment),
      appSecret:
        options.requireFeishuSecrets === false
          ? (environment[config.feishu.appSecretEnv]?.trim() ?? "")
          : requireEnvironment(config.feishu.appSecretEnv, environment),
      allowedOpenId: requireEnvironment(config.feishu.allowedOpenIdEnv, environment),
    },
  };
}
