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
        // Legacy aliases kept while components migrate.
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
        surface: {
          DEFAULT: "var(--color-surface)",
          hover: "var(--color-surface-hover)",
          selected: "var(--color-surface-selected)",
          subtle: "var(--color-surface-subtle)",
        },
        content: {
          DEFAULT: "var(--color-text)",
          muted: "var(--color-text-muted)",
          dim: "var(--color-text-dim)",
        },
        status: {
          success: "var(--color-success)",
          warning: "var(--color-warning)",
          danger: "var(--color-danger)",
          info: "var(--color-info)",
          "success-bg": "var(--color-success-bg)",
          "warning-bg": "var(--color-warning-bg)",
          "danger-bg": "var(--color-danger-bg)",
          "info-bg": "var(--color-info-bg)",
        },
      },
      borderColor: {
        DEFAULT: "var(--border)",
        token: "var(--color-border)",
        subtle: "var(--bg-subtle)",
        soft: "var(--color-border-soft)",
      },
      borderRadius: {
        token: "var(--radius-md)",
        "token-xs": "var(--radius-xs)",
        "token-sm": "var(--radius-sm)",
        "token-lg": "var(--radius-lg)",
        sheet: "var(--radius-sheet)",
      },
      fontSize: {
        "token-xs": ["var(--text-xs)", { lineHeight: "var(--line-ui)" }],
        "token-sm": ["var(--text-sm)", { lineHeight: "var(--line-ui)" }],
        "token-ui": ["var(--text-ui)", { lineHeight: "var(--line-ui)" }],
        "token-body": ["var(--text-body)", { lineHeight: "var(--line-body)" }],
        "token-mobile": ["var(--text-mobile)", { lineHeight: "var(--line-body)" }],
        "token-title": ["var(--text-title)", { lineHeight: "var(--line-tight)" }],
        "token-page-title": ["var(--text-page-title)", { lineHeight: "var(--line-tight)" }],
      },
      spacing: {
        "control-xs": "var(--control-xs)",
        "control-sm": "var(--control-sm)",
        "control-md": "var(--control-md)",
        "control-lg": "var(--control-lg)",
        "control-mobile": "var(--control-mobile)",
      },
      boxShadow: {
        popover: "var(--shadow-popover)",
        modal: "var(--shadow-modal)",
        sidebar: "var(--shadow-sidebar)",
      },
      transitionDuration: {
        DEFAULT: "var(--motion-base)",
        fast: "var(--motion-fast)",
        slow: "var(--motion-slow)",
      },
      transitionTimingFunction: {
        DEFAULT: "var(--motion-ease)",
      },
    },
  },
  plugins: [typography],
} satisfies Config;
