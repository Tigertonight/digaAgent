import { describe, expect, it } from "vitest";
import { annotationBrowserIds } from "./extension";

describe("browser extension annotation lookup", () => {
  it("includes session standalone browser ids before the default fallback", () => {
    expect(
      annotationBrowserIds("agent-1", [
        "standalone:session:s1",
        "standalone:session:s1",
        "",
      ]),
    ).toEqual([
      "agent:agent-1",
      "standalone:session:s1",
      "standalone:default",
    ]);
  });
});
