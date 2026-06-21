import { describe, expect, it } from "vitest";
import { extractStructuredInput } from "./structured-input";

describe("extractStructuredInput", () => {
  it("extracts mode even when restored as a cold-start literal", () => {
    expect(extractStructuredInput("/goal ship it", null)).toEqual({
      mode: "goal",
      paths: [],
      text: "ship it",
      changed: true,
    });
  });

  it("extracts file mentions and removes their literal tokens", () => {
    expect(extractStructuredInput("review @/Users/me/app.ts please", null)).toEqual({
      mode: null,
      paths: ["/Users/me/app.ts"],
      text: "review please",
      changed: true,
    });
  });

  it("extracts mode and mentions in one pass", () => {
    expect(
      extractStructuredInput("/workflow audit @/Users/me/app.ts", null)
    ).toEqual({
      mode: "workflow",
      paths: ["/Users/me/app.ts"],
      text: "audit",
      changed: true,
    });
  });

  it("does not overwrite an existing mode chip", () => {
    expect(extractStructuredInput("/goal text", "workflow")).toEqual({
      mode: null,
      paths: [],
      text: "/goal text",
      changed: false,
    });
  });

  it("extracts /team as a structured mode", () => {
    expect(extractStructuredInput("/team research naming", null)).toEqual({
      mode: "team",
      paths: [],
      text: "research naming",
      changed: true,
    });
  });
});
