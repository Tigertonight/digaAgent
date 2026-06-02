import { describe, it, expect } from "vitest";
import { approxBase64Bytes, formatBytes } from "./image-utils";

describe("approxBase64Bytes", () => {
  it("returns 0 for empty string", () => {
    expect(approxBase64Bytes("")).toBe(0);
  });

  it("computes 3 bytes per 4 chars without padding", () => {
    // "abcd" → 3 bytes
    expect(approxBase64Bytes("abcd")).toBe(3);
    // 8 chars → 6 bytes
    expect(approxBase64Bytes("abcdefgh")).toBe(6);
  });

  it("subtracts 1 for single '=' padding", () => {
    // "abc=" → floor(4*3/4) - 1 = 3 - 1 = 2
    expect(approxBase64Bytes("abc=")).toBe(2);
  });

  it("subtracts 2 for '==' padding", () => {
    // "ab==" → floor(4*3/4) - 2 = 3 - 2 = 1
    expect(approxBase64Bytes("ab==")).toBe(1);
  });

  it("handles realistic png header roughly", () => {
    // 一个真实 1x1 透明 PNG 的 base64 长度 ~88，期望解码后 ~64 字节量级
    const oneByOnePng =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const n = approxBase64Bytes(oneByOnePng);
    expect(n).toBeGreaterThan(60);
    expect(n).toBeLessThan(80);
  });
});

describe("formatBytes", () => {
  it("formats bytes (< 1 KB)", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("formats KB with 1 decimal (< 1 MB)", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1023)).toBe("1023.0 KB");
  });

  it("formats MB with 1 decimal", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 2.5)).toBe("2.5 MB");
  });
});
