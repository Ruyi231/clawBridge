import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export interface LocalOutputArtifact {
  path: string;
  name: string;
  type: "image" | "file";
  size: number;
}

const imageExtensions = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".bmp",
  ".ico",
  ".tif",
  ".tiff",
]);

const sensitiveNames = new Set([".env", ".env.local", ".npmrc", ".pypirc"]);
const sensitiveExtensions = new Set([".key", ".pem", ".p12", ".pfx"]);

function markdownDestinations(markdown: string): string[] {
  const destinations: string[] = [];
  const pattern = /!?\[[^\]\r\n]*\]\(\s*(<[^>]+>|[^)\r\n]+)\s*\)/g;
  for (const match of markdown.matchAll(pattern)) {
    let destination = match[1]?.trim() ?? "";
    if (destination.startsWith("<") && destination.endsWith(">")) {
      destination = destination.slice(1, -1);
    } else {
      // Markdown permits an optional quoted title after the destination.
      destination = destination.replace(/\s+["'][^"']*["']\s*$/, "").trim();
    }
    if (destination) destinations.push(destination);
  }
  return destinations;
}

function localPathFromDestination(destination: string, cwd: string): string | undefined {
  let decoded = destination;
  try {
    decoded = decodeURI(destination);
  } catch {
    // Keep the literal destination; malformed escapes will fail the file checks below.
  }
  if (/^file:\/\//i.test(decoded)) {
    try {
      decoded = new URL(decoded).pathname;
      if (/^\/[A-Za-z]:\//.test(decoded)) decoded = decoded.slice(1);
    } catch {
      return undefined;
    }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(decoded) && !/^[A-Za-z]:[\\/]/.test(decoded)) {
    return undefined;
  } else if (decoded.startsWith("#")) {
    return undefined;
  }
  return path.resolve(cwd, decoded.replaceAll("/", path.sep));
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function collectLinkedOutputArtifacts(input: {
  markdown: string;
  projectRoot: string;
  maxFiles?: number;
  maxBytes?: number;
}): Promise<LocalOutputArtifact[]> {
  const root = await realpath(input.projectRoot);
  const maxFiles = input.maxFiles ?? 20;
  const maxBytes = input.maxBytes ?? 30 * 1024 * 1024;
  const artifacts: LocalOutputArtifact[] = [];
  const seen = new Set<string>();

  for (const destination of markdownDestinations(input.markdown)) {
    if (artifacts.length >= maxFiles) break;
    const candidate = localPathFromDestination(destination, root);
    if (!candidate) continue;
    let resolved: string;
    let metadata;
    try {
      resolved = await realpath(candidate);
      metadata = await stat(resolved);
    } catch {
      continue;
    }
    if (!metadata.isFile() || metadata.size === 0 || metadata.size > maxBytes) continue;
    if (!isInside(root, resolved)) continue;
    const normalized = resolved.toLowerCase();
    if (seen.has(normalized)) continue;
    const name = path.basename(resolved);
    const extension = path.extname(name).toLowerCase();
    if (sensitiveNames.has(name.toLowerCase()) || sensitiveExtensions.has(extension)) continue;
    seen.add(normalized);
    artifacts.push({
      path: resolved,
      name,
      type: imageExtensions.has(extension) ? "image" : "file",
      size: metadata.size,
    });
  }
  return artifacts;
}
