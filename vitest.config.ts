import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * RFC-test-infra：首批引入 vitest，仅覆盖 lib/ 下的纯函数模块。
 * - 不需要 jsdom（暂无 React 组件单测）
 * - 不收集 e2e/ 目录（仍由 playwright 跑）
 * - @/* 别名映射到工程根（与 tsconfig paths 保持一致）
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.{test,spec}.ts"],
    exclude: ["node_modules", ".next", "dist", "e2e"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      "server-only": path.resolve(__dirname, "test/server-only-stub.ts"),
    },
  },
});
