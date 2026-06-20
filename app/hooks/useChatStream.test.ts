import { describe, expect, it } from "vitest";
import { createSubmitGate, failOpenProgressSteps } from "./useChatStream";

describe("createSubmitGate", () => {
  it("dedupes repeated submits for the same owner and mode until released", () => {
    const gate = createSubmitGate();

    const release = gate.claim("owner-1", "workflow");

    expect(release).toBeTypeOf("function");
    expect(gate.claim("owner-1", "workflow")).toBeNull();
    expect(gate.claim("owner-1", "goal")).toBeTypeOf("function");
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
