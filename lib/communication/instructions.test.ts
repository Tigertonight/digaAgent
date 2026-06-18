import { describe, expect, it } from "vitest";
import { stripContextAside } from "@/lib/context-aside";
import { withCommunicationInstructions } from "./instructions";

describe("communication instructions", () => {
  it("keeps communication instructions hidden from visible user text", () => {
    const finalText = withCommunicationInstructions("帮我改一下页面", {
      workMode: "daily",
    });

    expect(finalText).toContain("Communication mode: Daily work.");
    expect(stripContextAside(finalText)).toBe("帮我改一下页面");
  });

  it("merges into an existing context aside instead of adding a visible second block", () => {
    const source = [
      "实现设置页",
      "",
      "<<<CONTEXT_ASIDE>>>",
      "Referenced files/folders:",
      "@/tmp/a.ts",
      "<<<END_CONTEXT_ASIDE>>>",
    ].join("\n");
    const finalText = withCommunicationInstructions(source, {
      workMode: "coding",
    });

    expect(finalText.match(/<<<CONTEXT_ASIDE>>>/g)).toHaveLength(1);
    expect(finalText).toContain("Communication mode: Coding.");
    expect(stripContextAside(finalText)).toBe("实现设置页");
  });
});
