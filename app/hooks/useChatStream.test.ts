import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSubmitGate, failOpenProgressSteps } from "./useChatStream";

describe("createSubmitGate", () => {
  it("dedupes repeated submits for the same owner and mode until released", () => {
    const gate = createSubmitGate();

    const release = gate.claim("owner-1", "workflow");

    expect(release).toBeTypeOf("function");
    expect(gate.claim("owner-1", "workflow")).toBeNull();
    expect(gate.claim("owner-1", "goal")).toBeTypeOf("function");
    expect(gate.claim("owner-1", "team")).toBeTypeOf("function");
    expect(gate.claim("owner-2", "workflow")).toBeTypeOf("function");

    release?.();
    expect(gate.claim("owner-1", "workflow")).toBeTypeOf("function");
  });
});

describe("failOpenProgressSteps", () => {
  it("handles malformed progress groups without throwing", () => {
    const out = failOpenProgressSteps({
      groups: [{ id: "g1", index: 1 }],
      steps: undefined,
      artifacts: undefined,
      updatedAt: 1,
    } as never);

    expect(out?.groups).toEqual([
      expect.objectContaining({ id: "g1", steps: [] }),
    ]);
    expect(out?.steps).toEqual([]);
    expect(out?.artifacts).toEqual([]);
  });
});

describe("useChatStream local Team follow-up refresh", () => {
  it("refreshes the active runner when the API returns a local Team answer", () => {
    const source = readFileSync(
      path.join(process.cwd(), "app/hooks/useChatStream.ts"),
      "utf8"
    );
    const appSource = readFileSync(
      path.join(process.cwd(), "app/ChatApp.tsx"),
      "utf8"
    );

    expect(source).toContain("localTeamAnswer");
    expect(source).toContain("localMessages");
    expect(source).toContain("type: \"message_start\"");
    expect(source).toContain("onLocalAgentAnswer?.(ownerKey, aid)");
    expect(appSource).toContain("refreshContextForRunnerRef");
    expect(appSource).toContain("onLocalAgentAnswer: (ownerKey, aid)");
    expect(appSource).toContain("mergeMissingChatMessages(");
    expect(appSource).toContain("skipChatStateOverwrite");
  });
});
