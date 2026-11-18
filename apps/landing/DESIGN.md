# Maple landing — Maple Dither Monumentalism

## Overview

The homepage is a Persuade surface for engineers evaluating open-source observability. Its signature is monumental typography above an Rome-inspired, amber dithered temple and aqueduct. This direction applies to the homepage, pricing page, feature-page illustrations, their locale variants, and the docs home; other marketing pages, the docs reading pages and the application retain their existing design.

## Colors

Homepage variables alias the actual shared dark UI tokens: orange → `--primary` (`oklch(0.714 0.154 59)`, approximately `#E8872A`); canvas → `--background`; panels → `--card`; text → `--foreground`; secondary text → `--muted-foreground`; rules → `--border`. The palette is amber, warm charcoal and bone. Use `--primary-foreground` for text on amber. The logo's `#E86F00` is a separate brand asset color, not the UI primary. Never substitute a guessed orange or redefine shared tokens.

## Typography

Geist Variable is the heavy, tightly set monumental display face: 700 weight, -0.04em tracking, 1.06 line height for the hero. Body uses Geist Variable with readable 1.65 leading. Geist Mono is reserved for technical identifiers, labels, and code. Display scale is intentionally oversized for this pinned monumental direction; fluid sizes and locale wrapping protect small screens.

## Layout

A wide poster opening: announcement, oversized three-line title, architectural art on the right, descriptive copy and two CTAs on the left. The hero stops at about 72% of the viewport and the product plate overlaps its lower edge, so the top of the app is inside the first viewport on desktop and on phones, with the monument's base running behind it. The plate's rail and caption sit under the stage, not above it. The stats and customer logos follow the plate as a plain rail, then the four objections. Below, the product is shown large and the copy stays short: one line of copy per plate, and no column of sub-points beside a frame. The agent section is the exception: its three points are what the transcript beside it proves. Two saturated color breaks remain.

The home page has four product moments. The plate (three captures). Signals: the live trace waterfall across the full shell, with the live logs stream and a session replay capture at half the shell under it. The incident walkthrough. The platform explorer: one frame the width of the shell with a tab per surface (service map, metrics, errors, alerting, Kubernetes, web analytics, product events, uptime, GitHub), which is also the link hub to the feature pages. A surface that needs more than a heading, one sentence and a link belongs on its feature page.

## Elevation & Depth

Depth comes from the artwork and flat changes of color. No decorative shadows or glass. Actual product captures preserve their native appearance.

## Shapes

Original shared rounded buttons, sharp frames, thin shared border rules. Dither belongs to generated imagery, not a CSS texture over text.

## Components

Existing navigation, authentication-aware CTAs, carousel, walkthrough, calculator, pricing and FAQs retain their behavior. Buttons have visible hover and keyboard focus. The hero image is eager; lower imagery is lazy. The page is usable without animation and respects reduced motion.

A capture in a narrow column is a crop, not the whole screen scaled down: `MediaFrame` takes `crop` (top-left corner and zoom), the right and bottom edges fade out, and the lightbox still opens the full capture. The session plate uses it, and so does every capture in the platform explorer below `md`, where a whole screen would be unreadable. The hero plate crops to the capture's top left corner on phones for the same reason. Pick a window that starts on a layout edge and holds nothing you would not print at full size. Section ledes are 15px (16px from `md`), row titles 15px, row copy and links 14px.

## Do's and Don'ts

Keep localized content and real commercial facts. Use the generated monument at hero scale. Do not tint screenshots, invent metrics, replace working controls with decorative labels, or change the product theme.

Homepage buttons use the original shared `buttonVariants` (hero size `xl`, primary and outline variants). Preserve their radius, shadows, focus rings, hover and pressed states; homepage surface overrides exclude buttons and links.

The stats and customer logos sit under the product plate on its floor, with no gradient or text shadow. The GitHub count uses the existing PixelStar icon. The opening viewport belongs to the headline, the actions and the product; the star count is also in the nav.

The Roman hero uses medium-fine dithering in stone and shadows, with crisp architectural edges. Avoid large checkerboard blocks or overly smooth engraving.

Hero headline restored: “Open-source observability. / Built on OpenTelemetry. / Your agent reads it too.” The first two lines use bone; the final line uses the shared amber primary. Supporting copy is one short product description without repeating OpenTelemetry or the agent claim.

## Pricing

Pricing carries the shared orange-and-charcoal palette, Geist typography, sharp panel frames and original rounded buttons into a focused purchasing surface. Use a compact introduction with a distinct Roman countryside engraving with cultivated fields, an aqueduct and a winding merchant route, enlarged across the right background and softly faded behind the copy; rates and the plan price take priority over display typography. Keep the offer, calculator, supported-stack section, deployment options and FAQs. Omit homepage-style artwork, customer-logo bands and a large promotional closing CTA. Prices, trial terms, retention and calculator behavior remain sourced from the existing commercial data. English, Japanese and Korean share the styling. Mobile rate cells form two columns and offer panels stack; text must not overflow.

## Feature illustrations

Each `/features/*` page has its own Roman engraving in the hero, shared across English, Japanese and Korean. Match the balanced hero's amber-on-charcoal palette and medium-fine dithering. Choose a subject that relates to the feature: aqueduct channels for tracing, an archive for logs, a water clock for metrics, a connected city for services, a cracked keystone for errors, a watchtower for alerts, a theater for session replay, a scholar's instrument for MCP, and an organized harbor for Kubernetes.

The illustration occupies the right background and fades behind the copy; on smaller screens its opacity drops to keep the full-width text readable. Preserve all localized copy, breadcrumbs, CTAs, real screenshots and interactive demos. Illustration paths belong to the feature registry; generated WebP assets and prompts live in `public/art/features/`. Use-case and comparison heroes retain their existing layout.

## Documentation home

`/docs` pairs a heavy display title with the shared Maple Waterfall component on a flat background. The example checkout trace is pre-rendered, and readers can expand or collapse spans once the page loads. "Start here" is a framed strip beneath the opening, with amber icons that match the sidebar. Sections use an eyebrow, a heavy heading and sharp hairline frames. Cells have no radius and hover to `--card`. The "Any OTLP exporter" row spans the language grid. Article pages use the docs reading scale and place diagrams beside the concepts they explain. The docs 404 uses the same title weight and sharp list frame.

## Social previews

The 1200 × 630 OG cards use the same shared dark tokens, local Geist fonts and tree mark. The general card reuses `maple-rome-balanced.webp`; docs uses the Roman archive from `features/log-management.webp`. Large left-aligned text sits over a charcoal fade, with the architecture filling the right side. Keep the graphics recognizable at social-preview size.

Run `bun run --cwd apps/landing generate:og` to regenerate both public PNGs and the application's matching `og-image.png`. The script uses this workspace's Playwright devDependency (install its Chromium browser with `apps/landing/node_modules/.bin/playwright install chromium` if needed). It renders local HTML with embedded assets, so generation needs no running app or network. Existing metadata paths continue to point to these files.

## Product frames on the other marketing pages

Pricing, EU, integrations, OpenTelemetry, observability, customers, comparisons, alternatives and the open-source roundup show a real product frame in the first viewport: beside the hero copy from `lg`, directly under the copy and buttons on a phone. Every frame comes from `src/components/marketing/ProductFrame.astro`, which picks a live component or a cropped capture by id; none of these pages draws its own UI. On pricing the frame sits over the engraving, which stays as the backdrop. On a comparison page the hero stacks the two marks (one compact row) over a live trace, and the Surfaces section comes before the difference table; a vendor without one gets the service map under the table. The long text pages add a frame where the text reaches that surface (`ProductBand.astro`), so no run of more than about three screens is text only. `/opentelemetry` and `/integrations/<runtime>` are one shared template per page (`OtelPage.astro`, `IntegrationPage.astro`); the locale files only claim the route.
