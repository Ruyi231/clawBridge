import { realpath, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import YAML from "yaml";

function argumentValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function resolveFromConfig(configFile, target) {
  return path.isAbsolute(target)
    ? path.normalize(target)
    : path.resolve(path.dirname(configFile), "..", target);
}

async function requireDirectory(candidate, label) {
  const resolved = await realpath(candidate);
  if (!(await stat(resolved)).isDirectory())
    throw new Error(`${label} is not a directory: ${resolved}`);
  return resolved;
}

const configPath = path.resolve(argumentValue("--config", "config/local.yaml"));
let failures = 0;

function ok(message) {
  process.stdout.write(`[OK] ${message}\n`);
}

function info(message) {
  process.stdout.write(`[INFO] ${message}\n`);
}

function fail(message) {
  failures += 1;
  process.stderr.write(`[FAIL] ${message}\n`);
}

try {
  const config = YAML.parse(await readFile(configPath, "utf8"));
  const projectsFile = resolveFromConfig(configPath, config.projectsFile ?? "config/projects.yaml");
  const projects = YAML.parse(await readFile(projectsFile, "utf8"))?.projects ?? [];
  const seenPaths = new Map();

  for (const project of projects) {
    try {
      const configuredPath = resolveFromConfig(configPath, project.rootPath);
      const resolved = await requireDirectory(configuredPath, `Project ${project.id}`);
      const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
      const previous = seenPaths.get(key);
      if (previous)
        throw new Error(
          `Projects ${previous} and ${project.id} resolve to the same directory: ${resolved}`,
        );
      seenPaths.set(key, project.id);
      ok(`bootstrap project ${project.id}: ${resolved}`);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  const management = config.projectManagement ?? {};
  const allowedRoots = management.allowedRoots ?? [];
  if (allowedRoots.length === 0) {
    info("allowedRoots is empty; remote project creation/import is disabled by path policy.");
  }
  for (const configuredRoot of allowedRoots) {
    try {
      const resolved = await requireDirectory(
        resolveFromConfig(configPath, configuredRoot),
        "Allowed project root",
      );
      ok(`allowed project root: ${resolved}`);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  if (management.codexDesktopProjects?.enabled) {
    const explicitStateFile = management.codexDesktopProjects.stateFile;
    const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
    const stateFile = explicitStateFile
      ? resolveFromConfig(configPath, explicitStateFile)
      : path.join(codexHome, ".codex-global-state.json");
    try {
      const { CodexDesktopProjectDiscovery } = await import(
        "../dist/src/projects/codex-desktop-project-discovery.js"
      );
      const snapshot = await new CodexDesktopProjectDiscovery({ stateFile }).listProjects();
      let validDesktopProjects = 0;
      for (const project of snapshot.projects) {
        try {
          const roots = [];
          for (const root of project.rootPaths) {
            roots.push(await requireDirectory(root, `Codex Desktop project ${project.name}`));
          }
          validDesktopProjects += 1;
          ok(`Codex Desktop project ${project.name}: ${roots.join(" | ")}`);
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
      }
      info(
        `Codex Desktop discovery used ${snapshot.sourcePath}${snapshot.usedBackup ? " (backup)" : ""}; ${validDesktopProjects}/${snapshot.projects.length} project paths are valid.`,
      );
    } catch (error) {
      fail(
        `Codex Desktop project discovery is enabled but could not be verified at ${stateFile}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    info("Codex Desktop project discovery is disabled.");
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

if (failures > 0) {
  process.stderr.write(`Project path verification failed with ${failures} error(s).\n`);
  process.exit(1);
}
process.stdout.write("Project path verification passed.\n");
