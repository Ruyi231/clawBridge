import path from "node:path";
import { realpath } from "node:fs/promises";
import { BridgeError } from "../core/errors.js";

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export async function resolveProjectPath(rootPath: string, requestedPath = "."): Promise<string> {
  const realRoot = await realpath(path.resolve(rootPath));
  const realCandidate = await realpath(path.resolve(realRoot, requestedPath));
  if (!isWithin(realRoot, realCandidate)) {
    throw new BridgeError(
      "PATH_OUTSIDE_PROJECT",
      "Requested path is outside the configured project",
    );
  }
  return realCandidate;
}

export function isPathLexicallyWithin(rootPath: string, requestedPath: string): boolean {
  return isWithin(path.resolve(rootPath), path.resolve(rootPath, requestedPath));
}
