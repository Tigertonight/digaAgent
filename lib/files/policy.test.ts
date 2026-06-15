import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { assertPathAllowed, assertWritePathAllowed } from "./policy";

let tmpRoot: string;
let allowed: string;
let outside: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "files-policy-"));
  allowed = join(tmpRoot, "allowed");
  outside = join(tmpRoot, "outside");
  mkdirSync(allowed, { recursive: true });
  mkdirSync(outside, { recursive: true });
});

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.DIGA_AGENT_FILE_ROOTS;
});

beforeEach(() => {
  process.env.DIGA_AGENT_FILE_ROOTS = allowed;
});

afterEach(() => {
  // 各 case 间清场，但保留 allowed / outside 目录
  for (const f of ["foo.txt", "evil-link", "subdir"]) {
    rmSync(join(allowed, f), { recursive: true, force: true });
  }
});

describe("assertPathAllowed (字面校验)", () => {
  it("放行白名单内路径", () => {
    expect(assertPathAllowed(join(allowed, "x.txt"))).toBe(join(allowed, "x.txt"));
  });
  it("拒绝白名单外路径", () => {
    expect(() => assertPathAllowed(join(outside, "x.txt"))).toThrow(
      /outside allowed file roots/
    );
  });
  it('"/" 视为完全放开', () => {
    process.env.DIGA_AGENT_FILE_ROOTS = "/";
    expect(assertPathAllowed("/etc/passwd")).toBe("/etc/passwd");
  });
});

describe("assertWritePathAllowed (含 symlink 防越界)", () => {
  it("普通路径放行", async () => {
    const p = join(allowed, "foo.txt");
    expect(await assertWritePathAllowed(p)).toBe(p);
  });

  it("中间目录是 symlink 指向 root 外 → 拒", async () => {
    // allowed/evil-link 是软链，指向 root 外的 outside
    symlinkSync(outside, join(allowed, "evil-link"));
    const target = join(allowed, "evil-link", "stolen.txt");
    await expect(assertWritePathAllowed(target)).rejects.toThrow(
      /outside allowed file roots via symlink/
    );
  });

  it("中间目录是 symlink 指向 root 内 → 放行", async () => {
    mkdirSync(join(allowed, "subdir"), { recursive: true });
    symlinkSync(join(allowed, "subdir"), join(allowed, "evil-link"));
    const target = join(allowed, "evil-link", "ok.txt");
    await expect(assertWritePathAllowed(target)).resolves.toBe(target);
  });

  it("父目录尚不存在（mkdir -p 场景）→ 放行", async () => {
    const target = join(allowed, "not-yet", "x.txt");
    await expect(assertWritePathAllowed(target)).resolves.toBe(target);
  });

  it("字面 outside → 在 assertPathAllowed 阶段就拒", async () => {
    await expect(assertWritePathAllowed(join(outside, "x.txt"))).rejects.toThrow(
      /outside allowed file roots/
    );
  });

  it('roots="/" → 不做 realpath 校验', async () => {
    process.env.DIGA_AGENT_FILE_ROOTS = "/";
    // 软链放在 allowed 下指向 outside，但 root="/" 应直接放行
    symlinkSync(outside, join(allowed, "evil-link"));
    writeFileSync(join(outside, "exists.txt"), "x");
    const target = join(allowed, "evil-link", "exists.txt");
    await expect(assertWritePathAllowed(target)).resolves.toBe(target);
  });
});
