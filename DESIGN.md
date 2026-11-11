---
name: Maple
description: Open-source OpenTelemetry observability platform — terminal-native, dark by default, monospace as the body voice.
colors:
    primary: "oklch(0.714 0.154 59)"
    primary-foreground: "oklch(0.207 0.008 67)"
    primary-light: "oklch(0.66 0.16 59)"
    primary-light-foreground: "oklch(0.21 0.008 67)"
    background: "oklch(0.207 0.008 67)"
    foreground: "oklch(0.91 0.016 74)"
    card: "oklch(0.224 0.009 75)"
    sidebar: "oklch(0.185 0.007 56)"
    muted: "oklch(0.26 0.012 67)"
    muted-foreground: "oklch(0.66 0.022 72)"
    border: "oklch(0.268 0.012 67)"
    input: "oklch(0.33 0.015 72)"
    ring: "oklch(0.58 0.02 65)"
    destructive: "oklch(0.654 0.176 30)"
    severity-trace: "oklch(0.603 0.023 72)"
    severity-debug: "oklch(0.693 0.165 254)"
    severity-info: "oklch(0.658 0.134 151)"
    severity-warn: "oklch(0.8 0.15 84)"
    severity-error: "oklch(0.654 0.176 30)"
    severity-fatal: "oklch(0.555 0.174 30)"
    service-1: "oklch(0.68 0.17 250)"
    service-2: "oklch(0.65 0.12 185)"
    service-3: "oklch(0.65 0.15 155)"
    service-4: "oklch(0.65 0.15 130)"
    service-5: "oklch(0.7 0.14 90)"
    service-6: "oklch(0.7 0.16 60)"
    service-7: "oklch(0.65 0.15 45)"
    service-8: "oklch(0.65 0.18 25)"
    service-9: "oklch(0.62 0.16 0)"
    service-10: "oklch(0.62 0.14 340)"
    service-11: "oklch(0.6 0.14 320)"
    service-12: "oklch(0.62 0.14 290)"
    service-13: "oklch(0.62 0.16 270)"
    service-14: "oklch(0.64 0.16 260)"
    service-15: "oklch(0.65 0.13 210)"
    service-16: "oklch(0.6 0.1 230)"
typography:
    display:
        fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
        fontSize: "1.25rem"
        fontWeight: 600
        lineHeight: 1.2
        letterSpacing: "-0.01em"
    body:
        fontFamily: "Geist Mono Variable, ui-monospace, monospace"
        fontSize: "0.875rem"
        fontWeight: 400
        lineHeight: 1.5
        letterSpacing: "normal"
    label:
        fontFamily: "Geist Mono Variable, ui-monospace, monospace"
        fontSize: "0.75rem"
        fontWeight: 500
        lineHeight: 1.333
        letterSpacing: "normal"
    code:
        fontFamily: "Geist Mono Variable, ui-monospace, monospace"
        fontSize: "0.8125rem"
        fontWeight: 400
        lineHeight: 1.5
        letterSpacing: "normal"
rounded:
    sm: "4px"
    md: "6px"
    lg: "8px"
    xl: "12px"
    "2xl": "16px"
    "3xl": "20px"
    "4xl": "24px"
spacing:
    xs: "4px"
    sm: "8px"
    md: "12px"
    lg: "16px"
    xl: "24px"
components:
    button-primary:
        backgroundColor: "{colors.primary}"
        textColor: "{colors.primary-foreground}"
        rounded: "{rounded.lg}"
        height: "32px"
        padding: "0 12px"
        typography: "{typography.label}"
    button-primary-hover:
        backgroundColor: "{colors.primary}"
        textColor: "{colors.primary-foreground}"
    button-secondary:
        backgroundColor: "{colors.muted}"
        textColor: "{colors.foreground}"
        rounded: "{rounded.lg}"
        height: "32px"
        padding: "0 12px"
        typography: "{typography.label}"
    button-ghost:
        backgroundColor: "transparent"
        textColor: "{colors.foreground}"
        rounded: "{rounded.lg}"
        height: "32px"
        padding: "0 8px"
        typography: "{typography.label}"
    card:
        backgroundColor: "{colors.card}"
        textColor: "{colors.foreground}"
        rounded: "{rounded.lg}"
        padding: "16px"
    input:
        backgroundColor: "{colors.input}"
        textColor: "{colors.foreground}"
        rounded: "{rounded.md}"
        height: "32px"
        padding: "0 10px"
        typography: "{typography.body}"
    sidebar:
        backgroundColor: "{colors.sidebar}"
        textColor: "{colors.foreground}"
    chip-severity-error:
        backgroundColor: "color-mix(in oklab, {colors.severity-error} 12%, transparent)"
        textColor: "{colors.severity-error}"
        rounded: "{rounded.sm}"
        padding: "2px 6px"
        typography: "{typography.label}"
---

# Design System: Maple

## 1. Overview

**Creative North Star: "The Operator Terminal"**

Maple is an observability dashboard built for the engineer in the dark room at 2am — the body font is monospace, the default theme is dark, the surfaces are flat and the motion is kept to things that move. The aesthetic descends from the operations console, not the SaaS marketing site. Confidence comes from precision: every datum carries its unit, every span its identifier, every error its exact failure mode. The dashboard does not flatter the operator. It works.

The system explicitly rejects two reflexes. It rejects **Datadog product chrome** — gradient cards, upsell banners, top-nav clutter, hero-metric tiles. It rejects **AI-startup neon-on-black** — generic dark + electric accent + glow effects, the currently-saturated aesthetic that announces "AI tool" before the engineer has read a word. Maple's dark mode is warm-amber over warm-gray, not violet-cyan over black; its accents earn their saturation through severity meaning, not decorative chroma.

The shared visual posture is **Linear / Vercel / Axiom adjacent**: compact app shell, monospace prominence, severity color treated as semantic, restrained motion. North star references inform posture, not pixels — Maple is not a clone of any of them.

**Key Characteristics:**

- Mono is the body voice. Geist Mono is the default `--font-sans`; Geist (proportional) is reserved for display.
- Dark by default, light when ambient demands. Light theme is a peer, not a fallback.
- Flat surfaces, tonal depth. Layering is done by lightness steps and the hairline; the few shadows are tokens (`docs/design-rules.md`).
- Severity-as-meaning. The 6-step severity ramp (`trace → fatal`) is the most semantically loaded color in the system, not the brand accent.
- Compact density: 32px button height, `text-xs` baseline for tables and panels.

## 2. Colors: The Operator Palette

The palette is **theme-tuned, same hue**. Both themes anchor on Maple's warm amber (hue ~59): dark mode uses `oklch(0.714 0.154 59)`, light mode the same hue tuned slightly deeper (`oklch(0.66 0.16 59)`) so it reads on a white canvas. The dark theme is canonical for the frontmatter (matches `<body class="dark">`); light tokens travel alongside in the `.dark` ↔ `:root` swap.

### Token source of truth

All shared design tokens (color, radius, fonts, severity/service/chart palettes, the `@theme inline` mapping) live in **`packages/ui/src/styles/tokens.css`** and are imported by both `apps/web` and `apps/landing` via `@import "@maple/ui/styles/tokens.css"` (after `@import "tailwindcss"`). Apps must never re-declare a shared token name — `bun run check:tokens` fails CI if they do. The syntax-highlighting `--sh-*` set lives beside it in `syntax-tokens.css`. App-local tokens stay in the apps: landing's marketing set (`--bg-elevated`, `--bg-deep`, `--amber-deep`, `--amber-soft`). Landing is dark-only: it pins `class="dark"` on `<html>` instead of maintaining its own token copy. The ReactFlow controls chrome (flat, square corners, `border-radius: 0`) is part of the shared file — the product rendering is the reference for landing mockups.

### Primary

- **Amber Signal** (`oklch(0.714 0.154 59)`, dark canonical): the accent used on primary actions, the active sidebar item, `chart-1` / `chart-p95`. Severity-warn is a separate yellow-amber (`oklch(0.8 0.15 84)`) so a WARN chip never reads as an action or a selected row. Warm enough to read at low ambient light without burning. (Note: `chart-throughput` used to share this hue, but was split to purple — `oklch(0.66 0.14 290)` — so the built-in alert signal chips can distinguish throughput from p95.)
- **Amber Signal, daylight cut** (`oklch(0.66 0.16 59)`, light counterpart): the same role and hue under light theme, a touch deeper and more chromatic so it holds contrast on white. (An earlier draft used a blue light primary; it shipped briefly as stale shadcn tokens and was rebased to amber.)

### Secondary: Severity Ramp (the system's loudest semantic color)

Six steps that always carry meaning. Use them only for log levels and incident severity. Never decoratively.

- **Trace** (`oklch(0.603 0.023 72)`): warm gray. The "no-news" tier.
- **Debug** (`oklch(0.693 0.165 254)`): blue. Diagnostic information, not action-needed.
- **Info** (`oklch(0.658 0.134 151)`): green. Normal operations.
- **Warn** (`oklch(0.8 0.15 84)`): yellow-amber, deliberately off the hue-59 primary in both themes (light: `oklch(0.73 0.165 88)`), so a WARN bar or chip never reads as a button, a link or the selected row.
- **Error** (`oklch(0.654 0.176 30)`): red-orange. Page-level failure.
- **Fatal** (`oklch(0.555 0.174 30)`): deeper red. Reserved for service-down / data-loss tier; appears in seconds-per-day, not hours.

### Tone as text: ink

A tone's fill is tuned to be seen as a bar, a dot or a wash; on a white canvas that leaves it near 3:1 as type. So each tone has an **ink**: `text-primary`, `text-severity-*`, `text-success`, `text-warning` and `text-info` resolve to `--*-ink` (the `--text-color-*` block in tokens.css), a deeper step of the same hue that clears 4.5:1 on the page and on the tone's own `-a2` wash. In dark the fills read as type already, so the inks are the fills (trace and fatal aside). Fills, borders and strokes keep the tone itself. Never set a fill token as `color` in a style object.

### Tertiary: Service Categorical Palette (16 hues, evenly distributed)

The service map and per-service charts. Each hue is roughly 22° apart on the OKLCH wheel, lightness ~0.6–0.7 in dark theme. Never repurpose a service color for a non-service role.

- `service-1` Blue (250°) → `service-16` Slate (230°): see frontmatter for full values.

### Neutral

- **Background** (`oklch(0.207 0.008 67)`): warm dark gray, tinted toward amber — never `#000` or pure neutral. The base canvas.
- **Card** (`oklch(0.224 0.009 75)`): one lightness step above background. Cards float by tone, not by shadow.
- **Sidebar** (`oklch(0.185 0.007 56)`): one step _below_ background. The sidebar recedes; the canvas is the stage.
- **Muted** (`oklch(0.26 0.012 67)`): hover backdrops, secondary button surface, inactive states.
- **Foreground** (`oklch(0.91 0.016 74)`): warm-tinted near-white. Body text, dense data, monospace numerals.
- **Muted Foreground** (`oklch(0.66 0.022 72)`): secondary text, axis labels, timestamps. Under it sit `foreground-subtle` (the last step that carries information, 4.5:1) and `foreground-faint` (separators and empty cells only).
- **Border** (`oklch(0.268 0.012 67)`): hairline strokes. At 2× DPI, `--border-hairline` halves to 0.5px — never thicker by reflex.

### Named Rules

**The Tonal-Depth Rule.** Surfaces stack via lightness steps — sidebar (0.185) ↘ background (0.207) ↘ card (0.224) ↘ muted (0.26). If you need to lift an element, raise its lightness by one step. The only shadows are the tokens in `docs/design-rules.md` (`shadow-raised`, `shadow-popup`, …); sizes and raw `box-shadow` values are lint errors.

**The Severity-Owns-Color Rule.** The severity ramp is the system's most legible semantic color. Do not use red for "delete" if it sits within 0.05 chroma of `--severity-error` in the same context — it dilutes the signal. Destructive actions get red only when the severity ramp is not on screen.

**The Service-Color-Is-Categorical Rule.** The 16-color service palette is for service identity only. Never for sentiment ("green = good"), state ("blue = active"), or charting metrics. Categorical color encoding fails for 16 hues under deuteranopia/protanopia, so service color always pairs with the service initial or icon.

## 3. Typography

**Display Font:** Geist Variable (proportional sans)
**Body Font:** Geist Mono Variable
**Label / Code Font:** Geist Mono Variable

**Character:** Maple inverts the conventional sans-body / mono-code split. The body is monospace because the operator's daily diet is identifiers, timestamps, durations, span IDs, hostnames — strings that align better in fixed-width. Proportional Geist is reserved for headings (display) and any prose that benefits from variable letterforms (onboarding copy, long-form errors). This single choice does most of the work distinguishing Maple from generic SaaS dashboards.

### Hierarchy

- **Display** (Geist Variable, 600, `tracking-tight`): the page title at 24px (`text-2xl`), a detail or card title at 20px.
- **Body** (Geist Mono Variable, 400): 12px (`text-xs`) in tables, panels, meta and the sidebar, 14px (`text-sm`) for row titles and button labels.
- **Label** (Geist Mono Variable, 500): chip text, status pills and compact metadata at 10 to 12px. Column heads and eyebrows are 10px uppercase at `tracking-overline` (0.12em). Sizes under 12px (`text-2xs`, `-3xs`, `-4xs`) are for labels and meta.
- **Code** (Geist Mono Variable, 400, 0.8125rem / 13px): inline span IDs, query snippets, log payloads. Sugar High syntax tokens (`--sh-class`, `--sh-string`, etc.) live in OKLCH and respect theme.

Weights are 400, 500 and 600. Tracking is a token (`tracking-overline`, `tracking-caption`, `tracking-figure`) or `tracking-tight`. Sentences (descriptions, empty and error copy) read in `font-prose`.

### Named Rules

**The Mono-As-Body Rule.** Geist Mono is `--font-sans`. The whole app body inherits it. Do not "fix" this by switching panels to proportional sans; the alignment of timestamps, IDs, and durations across rows is the point.

**The Tabular-Numerals Rule.** Wherever numbers appear in dense rows (trace lists, log tables, percentiles), they must align. Geist Mono handles this natively — but in any proportional context (display sizes, dashboards), reach for `font-variant-numeric: tabular-nums` explicitly.

## 4. Elevation

**Maple is a flat system.** Depth is conveyed by **tonal layering** and the hairline: each dark surface sits at a distinct OKLCH lightness so the eye reads the stack without artificial lift. The light canvas and its cards are both white, so there the hairline does the separating. The shadow tokens are few and named for their job (a raised control, a popup, a sticky edge); see `docs/design-rules.md`.

The lightness ladder in dark mode:

| Layer         | Token                  | Lightness |
| ------------- | ---------------------- | --------- |
| Sidebar       | `--sidebar`            | 0.185     |
| Background    | `--background`         | 0.207     |
| Card          | `--card` / `--popover` | 0.224     |
| Muted (hover) | `--muted` / `--accent` | 0.26      |
| Input         | `--input`              | 0.33      |

Hover lands in the frame it happens, never eased: a row hovers `surface-sunken`, a control `accent`. Focus draws one `--ring` ring; an input takes the soft halo (`docs/design-rules.md`).

### Named Rules

**The Flat-By-Default Rule.** No shadow outside the tokens. No glassmorphism. No "elevation 3" mid-element. If something needs to feel raised, raise its lightness one step — that's the system's vocabulary for depth.

**The Hairline Rule.** Borders are 1px in standard DPI, 0.5px on Retina (`@media (min-resolution: 192dpi) { --border-hairline: 0.5px }`). Never thicker by reflex. A 2px border in app chrome reads as a UI from 2014.

## 5. Components

### Buttons

- **Shape:** Gently rounded — `--radius: 8px` (large by Maple's standards; chips use 4px, inputs 6px).
- **Default size:** `h-8` (32px). Compact `h-7` (28px) for inline contexts, `h-6` (24px) for chip-like buttons.
- **Primary:** `--primary` background, `--primary-foreground` text. Used for the single most important action per surface. **Rarity is the point** — the amber primary should appear once per screen, not three times.
- **Secondary:** `--muted` background, `--foreground` text. The everyday button.
- **Ghost:** transparent background, `--foreground` text. Sidebar items, table-row affordances, anything that should disappear when not under cursor.
- **Hover / Focus:** a ghost or outline button hovers `accent` or `surface-sunken`, a filled one dims a step; the change is instant. Focus adds the `--ring` ring.

### Cards

- **Background:** `--card` (one tonal step above the canvas).
- **Border:** 1px `--border` hairline (or 0.5px on Retina).
- **Radius:** 8px (`--radius`).
- **Padding:** 16px default; 12px in compact panels (`data-size="sm"`).
- **No shadow. No gradient. No accent stripe.** Cards earn their separation through tone and hairline.
- **Nested cards are forbidden.** If you need a section inside a card, use a horizontal divider or change the inner background to `--background`.

### Inputs / Fields

- **Background:** `--background`, with a faint `--input` wash in dark.
- **Border:** 1px `--input`; on focus the border turns `--ring` and carries a soft 3px halo (`ring-ring/24`).
- **Radius:** 8px (`--radius-lg`), matching buttons.
- **Height:** 32px to match buttons.

### Severity Chips

- **Background:** a wash of the tone (the `-a2` step on kit badges, a 10% mix on the log severity badge).
- **Text:** the tone's ink (`text-severity-*`). Only FATAL is a solid fill with `--on-fill` text.
- **Radius:** 4px (`--radius-sm`).
- **Always paired with the explicit severity word** ("ERROR", "WARN") — color is never the sole signal.

### Sidebar Navigation

- **Background:** `--sidebar` (one step below canvas — recedes).
- **Active item:** `--sidebar-accent` background, text in the primary ink (`text-sidebar-primary`), and a primary rail on its leading edge. The amber is never the row's fill.
- **Hover:** `bg-sidebar-accent/50`, half the selected tint, landing instantly.
- **Mobile:** sidebar collapses to a drawer; ghost-button icons remain.

### Charts (`packages/views/src/charts`)

- **Series colors:** `--chart-1` through `--chart-5` for arbitrary series; **percentile-specific tokens** for performance charts (`--chart-p50` blue, `--chart-p95` amber, `--chart-p99` red-orange). Use percentile tokens for percentile charts — do not pick from the generic ramp.
- **Reference lines:** dashed, never solid.
- **Grid lines:** at `--border` lightness, hairline. Never bolder.

## 6. Do's and Don'ts

### Do

- **Do use Geist Mono as the default body voice.** It is `--font-sans`. The alignment of timestamps and identifiers across rows is load-bearing.
- **Do convey depth through tonal layering** (sidebar 0.185 → background 0.207 → card 0.224 → muted 0.26), not shadows.
- **Do reserve the amber primary for the single most important action per surface.** Rarity is the point.
- **Do pair every severity color with an explicit label** ("ERROR", "WARN"). Color is never the only signal.
- **Do respect `prefers-reduced-motion`.** New motion must disable itself under it. Nothing pulses.
- **Do use percentile-specific chart tokens** (`--chart-p50`, `--chart-p95`, `--chart-p99`) for latency charts — they're tuned for the role.
- **Do keep borders hairline.** 1px standard, 0.5px on Retina. Never thicker by reflex.

### Don't

- **Don't use Datadog product chrome.** No upsell banners, no gradient cards, no overpacked top nav. Maple's product surface competes with the _data_, not the brand.
- **Don't drift toward AI-startup neon-on-black.** No electric purple/cyan on pure black, no glow effects, no glassmorphism. The amber-on-warm-gray is a deliberate refusal of that aesthetic.
- **Don't use `#000`.** Every dark neutral is tinted toward the warm gray family (hue ~67–75). The light canvas is white with cool zinc neutrals (hue ~286).
- **Don't add shadows.** The shadow tokens are the whole set. The system is flat by doctrine; if you need lift, change tone.
- **Don't nest cards.** A card inside a card is a structural failure. Use a divider or change background.
- **Don't use the hero-metric template** — big number, small label, supporting stats, gradient accent. SaaS cliché.
- **Don't grid identical icon-cards.** Repeated card+icon+title+blurb tiles are the SaaS-landing reflex; the dashboard rejects them.
- **Don't stripe a card.** The current row's 2px leading accent (`shadow-accent-start`) and a 2px tone rail beside a quoted or flagged block are the only stripes; nothing thicker, and never as a card's decoration.
- **Don't repurpose a service color** (`--service-N`) for sentiment, state, or chart metrics. It's categorical-only.
- **Don't ship loading spinners by default.** Maple's stance is "fast trust" — skeleton shimmers exist for measurable wait, but most queries should land before motion would help.
