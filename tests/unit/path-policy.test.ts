import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { areSameResolvedPath, isPathLexicallyWithin } from "../../src/security/path-policy.js";

describe("path policy", () => {
  it("accepts descendants and the root itself", () => {
    expect(isPathLexicallyWithin("D:/work/repo", ".")).toBe(true);
    expect(isPathLexicallyWithin("D:/work/repo", "src/app.ts")).toBe(true);
  });

  it("rejects traversal and sibling-prefix paths", () => {
    expect(isPathLexicallyWithin("D:/work/repo", "../secret.txt")).toBe(false);
    expect(isPathLexicallyWithin("D:/work/repo", "../repository-secret/file.txt")).toBe(false);
  });

  it("treats a migrated junction path and its target as the same project", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "clawbridge-path-alias-"));
    const target = path.join(root, "target");
    const alias = path.join(root, "legacy-alias");
    const { mkdir } = await import("node:fs/promises");
    try {
      await mkdir(target);
      await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
      await expect(areSameResolvedPath(alias, target)).resolves.toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
