import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

export default {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // 角色色（命名跟 docs/design-tokens.md 对齐）
        bg: "var(--bg)",
        panel: "var(--bg-panel)",
        hover: "var(--bg-hover)",
        selected: "var(--bg-selected)",
        subtle: "var(--bg-subtle)",
        text: "var(--text)",
        muted: "var(--text-muted)",
        dim: "var(--text-dim)",
        accent: {
          DEFAULT: "var(--accent)",
          hover: "var(--accent-hover)",
        },
        "user-bg": "var(--user-bg)",
        "assistant-bg": "var(--assistant-bg)",
        "tool-bg": "var(--tool-bg)",
      },
      borderColor: {
        DEFAULT: "var(--border)",
        subtle: "var(--bg-subtle)",
      },
      transitionDuration: {
        DEFAULT: "150ms",
      },
      transitionTimingFunction: {
        DEFAULT: "cubic-bezier(0.4, 0, 0.2, 1)",
      },
    },
  },
  plugins: [typography],
} satisfies Config;
