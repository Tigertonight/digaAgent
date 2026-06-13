# Diga Agent Design Tokens

This document is the source of truth for UI styling in `diga-agent`.
New UI should consume tokens instead of hard-coded colors, arbitrary font sizes,
ad-hoc radii, or component-local shadow values.

## Token Layers

1. Primitive tokens describe raw visual scales:
   `--space-*`, `--radius-*`, `--text-*`, `--line-*`, `--control-*`,
   `--size-icon-*`, `--shadow-*`, `--motion-*`, and `--z-*`.

2. Semantic tokens describe product meaning:
   `--color-bg`, `--color-surface`, `--color-text`, `--color-accent`,
   `--color-success`, `--color-warning`, `--color-danger`, `--color-info`,
   plus message and tool surfaces.

3. Component tokens describe reusable UI parts:
   `--menu-*`, `--button-*`, `--field-*`, `--badge-*`, `--sheet-*`,
   and `--sidebar-row-*`.

Legacy aliases such as `--bg`, `--text`, `--accent`, `--fg`, and
`--border-soft` remain available while old components migrate.

## Core Values

Typography keeps system sans as the product default. Code, paths, logs, and
numeric diagnostics use `.font-mono`.

| Token | Value | Usage |
| --- | --- | --- |
| `--text-xs` | `11px` | dense meta text |
| `--text-sm` | `12px` | compact controls |
| `--text-ui` | `13px` | desktop UI labels |
| `--text-body` | `14px` | default desktop reading |
| `--text-mobile` | `15px` | mobile composer/content |
| `--text-title` | `18px` | panel titles |
| `--text-page-title` | `28px` | settings/page headings |

Radii are intentionally restrained. Ordinary cards and rows should not exceed
`--radius-md`; mobile bottom sheets may use `--radius-sheet`.

| Token | Value |
| --- | --- |
| `--radius-xs` | `4px` |
| `--radius-sm` | `6px` |
| `--radius-md` | `8px` |
| `--radius-lg` | `12px` |
| `--radius-sheet` | `20px` |
| `--radius-full` | `999px` |

Control and icon sizes:

| Token | Value |
| --- | --- |
| `--control-xs` | `24px` |
| `--control-sm` | `28px` |
| `--control-md` | `32px` |
| `--control-lg` | `36px` |
| `--control-mobile` | `44px` |
| `--size-icon-xs` | `12px` |
| `--size-icon-sm` | `14px` |
| `--size-icon-md` | `16px` |
| `--size-icon-lg` | `20px` |
| `--size-icon-xl` | `24px` |

## Component Rules

- Menus use `Menu` and `MenuItem` from `app/components/DesignPrimitives.tsx`.
  Menu items are `36px` high, `14px` text, `18px` icons.
- Buttons should use `Button`, `TokenIconButton`, or the existing `IconButton`
  after it has been migrated to token sizes.
- Status labels should use semantic tones: `success`, `warning`, `danger`, or
  `info`; do not use raw Tailwind palette classes for new status UI.
- Mobile bottom sheets use `BottomSheet`; desktop popovers use `FloatingLayer`
  plus tokenized content components.
- Settings and auth/provider rows should use `Badge`, `Button`, and semantic
  status tokens instead of `.settings-page` global palette overrides.

## Tailwind Mapping

`tailwind.config.ts` exposes token-backed utilities:

- Colors: `bg-surface`, `bg-surface-hover`, `text-content-muted`,
  `bg-status-warning-bg`, `text-status-danger`.
- Radius: `rounded-token`, `rounded-token-sm`, `rounded-sheet`.
- Font sizes: `text-token-xs`, `text-token-ui`, `text-token-body`.
- Shadows: `shadow-popover`, `shadow-modal`.
- Control sizes: `h-control-sm`, `h-control-mobile`.

Use these utilities for layout ergonomics, and CSS variables directly when a
component token is clearer.

## Drift Check

Run:

```bash
npm run design-tokens:check
```

The report is informational. It flags hard-coded colors, arbitrary font sizes,
arbitrary radii, arbitrary shadows, and raw Tailwind palette tones so future
migrations can be prioritized without blocking day-to-day work.
