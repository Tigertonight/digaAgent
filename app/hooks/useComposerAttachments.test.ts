import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("useComposerAttachments owner scoping", () => {
  it("captures ownerKey before async image conversion and writes back by owner", () => {
    const source = readFileSync(
      path.join(process.cwd(), "app/hooks/useComposerAttachments.ts"),
      "utf8"
    );
    const ownerCapture = source.indexOf("const ownerKey = getOwnerKey?.();");
    const conversion = source.indexOf("await Promise.all");
    const scopedWrite = source.indexOf("writePendingImages(ownerKey");

    expect(ownerCapture).toBeGreaterThan(-1);
    expect(conversion).toBeGreaterThan(ownerCapture);
    expect(scopedWrite).toBeGreaterThan(conversion);
    expect(source).toContain("setPendingImagesForOwner(ownerKey, v)");
    expect(source).toContain("setPendingFilesForOwner(ownerKey, v)");
  });
});
