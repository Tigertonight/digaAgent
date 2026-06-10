import { describe, expect, it } from "vitest";
import { isTailscaleIPv4 } from "./network";

describe("remote network helpers", () => {
  it("detects Tailscale carrier-grade NAT IPv4 addresses", () => {
    expect(isTailscaleIPv4("100.64.0.1")).toBe(true);
    expect(isTailscaleIPv4("100.100.100.100")).toBe(true);
    expect(isTailscaleIPv4("100.127.255.254")).toBe(true);
  });

  it("rejects non-Tailscale IPv4 addresses", () => {
    expect(isTailscaleIPv4("100.63.255.255")).toBe(false);
    expect(isTailscaleIPv4("100.128.0.1")).toBe(false);
    expect(isTailscaleIPv4("192.168.1.5")).toBe(false);
    expect(isTailscaleIPv4("not-an-ip")).toBe(false);
  });
});
