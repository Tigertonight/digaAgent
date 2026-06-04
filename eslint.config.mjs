/**
 * ESLint Flat Config（ESLint 9+）。
 *
 * next 16 移除了 `next lint` 子命令；推荐直接用 `eslint .`。
 * eslint-config-next 16 已原生导出 flat config 数组，无需 FlatCompat 桥接。
 */
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import reactHooks from "eslint-plugin-react-hooks";

const config = [
  {
    ignores: [".next/**", "dist/**", "out/**", "node_modules/**"],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  // Electron 主进程 / preload / 包装脚本是 Node CJS：require() 是必需的。
  // 同理 scripts/ 下的 build 脚本（部分用 ESM .mjs，部分按 CJS 习惯）。
  {
    files: [
      "electron/**/*.js",
      "lib/**/*.cjs",
      "scripts/**/*.{js,mjs}",
      "bin/**/*.js",
      "server.js",
    ],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    files: ["e2e/**/*.ts"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
    },
  },
  // React 19 新增的 react-hooks 严格规则在我们老 pattern 下噪音过大：
  //   - set-state-in-effect: useEffect 里调 load() 然后 setState 是常见
  //     初始化 pattern，按 React 19 文档应迁到 Server Components 或 Suspense，
  //     但本项目还没准备好这级别重构。
  //   - immutability: 误报 useRef 的 .current 赋值（"This value cannot be modified"），
  //     以及对函数声明 hoisting 的合法用法报"Cannot access variable before it is declared"。
  // 暂降为 warning，保留可见性、不阻塞 CI；后续逐文件重构再升回 error。
  {
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/static-components": "warn",
    },
  },
];

export default config;
