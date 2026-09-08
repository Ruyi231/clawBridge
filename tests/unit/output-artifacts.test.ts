import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectLinkedOutputArtifacts } from "../../src/core/output-artifacts.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("collectLinkedOutputArtifacts", () => {
  it("collects unique project-local image and file links", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "clawbridge-output-"));
    roots.push(root);
    await mkdir(path.join(root, "outputs"));
    await writeFile(path.join(root, "outputs", "preview.png"), "image");
    await writeFile(path.join(root, "outputs", "report.pdf"), "pdf");

    const artifacts = await collectLinkedOutputArtifacts({
      projectRoot: root,
      markdown: [
        "![预览](outputs/preview.png)",
        `[报告](<${path.join(root, "outputs", "report.pdf")}>)`,
        "[重复](outputs/report.pdf)",
        "[网页](https://example.com/report.pdf)",
      ].join("\n"),
    });

    expect(artifacts.map(({ name, type }) => ({ name, type }))).toEqual([
      { name: "preview.png", type: "image" },
      { name: "report.pdf", type: "file" },
    ]);
  });

  it("rejects links outside the project, symlink escapes, secrets, and oversized files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "clawbridge-output-"));
    const outside = await mkdtemp(path.join(tmpdir(), "clawbridge-outside-"));
    roots.push(root, outside);
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await writeFile(path.join(root, ".env"), "TOKEN=secret");
    await writeFile(path.join(root, "large.txt"), "12345");
    await symlink(outside, path.join(root, "outside-link"), "junction");

    const artifacts = await collectLinkedOutputArtifacts({
      projectRoot: root,
      markdown: [
        `[outside](${path.join(outside, "secret.txt")})`,
        "[escape](outside-link/secret.txt)",
        "[secret](.env)",
        "[large](large.txt)",
      ].join("\n"),
      maxBytes: 4,
    });

    expect(artifacts).toEqual([]);
  });
});
