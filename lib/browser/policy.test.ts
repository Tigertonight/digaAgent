import { describe, expect, it } from "vitest";
import { detectSensitiveAction } from "./policy";

describe("browser policy sensitive action detection", () => {
  it("recognizes sensitive selector-style click targets", () => {
    expect(detectSensitiveAction('button[type="submit"]')).toBe("submit");
    expect(detectSensitiveAction("#login-button")).toBe("login");
    expect(detectSensitiveAction("[data-testid='checkout']")).toBe("payment");
  });
});
