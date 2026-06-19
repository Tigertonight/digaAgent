import { describe, expect, it } from "vitest";
import { createSubmitGate } from "./useChatStream";

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
