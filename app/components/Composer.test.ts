import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Composer send button", () => {
  it("uses type=button so clicks cannot also submit an ancestor form", () => {
    const source = readFileSync(
      path.join(process.cwd(), "app/components/Composer.tsx"),
      "utf8",
    );

    expect(source).toContain('<button\n                type="button"');
    expect(source).toContain("onClick={() => void handleSend()}");
  });
});
