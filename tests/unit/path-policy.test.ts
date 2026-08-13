import { describe, expect, it } from "vitest";
import { isPathLexicallyWithin } from "../../src/security/path-policy.js";

describe("path policy", () => {
  it("accepts descendants and the root itself", () => {
    expect(isPathLexicallyWithin("D:/work/repo", ".")).toBe(true);
    expect(isPathLexicallyWithin("D:/work/repo", "src/app.ts")).toBe(true);
  });

  it("rejects traversal and sibling-prefix paths", () => {
    expect(isPathLexicallyWithin("D:/work/repo", "../secret.txt")).toBe(false);
    expect(isPathLexicallyWithin("D:/work/repo", "../repository-secret/file.txt")).toBe(false);
  });
});
