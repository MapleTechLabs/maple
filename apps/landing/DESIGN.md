# Maple landing — Maple Dither Monumentalism

## Overview

The homepage is a Persuade surface for engineers evaluating open-source observability. Its signature is monumental typography above an Rome-inspired, amber dithered temple and aqueduct. This direction applies to the homepage, pricing page, feature-page illustrations, their locale variants, and the docs home; other marketing pages, the docs reading pages and the application retain their existing design.

## Colors

Homepage variables alias the actual shared dark UI tokens: orange → `--primary` (`oklch(0.714 0.154 59)`, approximately `#E8872A`); canvas → `--background`; panels → `--card`; text → `--foreground`; secondary text → `--muted-foreground`; rules → `--border`. The palette is amber, warm charcoal and bone. Use `--primary-foreground` for text on amber. The logo's `#E86F00` is a separate brand asset color, not the UI primary. Never substitute a guessed orange or redefine shared tokens.

## Typography

Geist Variable is the heavy, tightly set monumental display face: 700 weight, -0.04em tracking, 1.06 line height for the hero. Body uses Geist Variable with readable 1.65 leading. Geist Mono is reserved for technical identifiers, labels, and code. Display scale is intentionally oversized for this pinned monumental direction; fluid sizes and locale wrapping protect small screens.

## Layout

A wide poster opening: announcement, oversized three-line title, architectural art occupying the right and lower field, descriptive copy and two CTAs on the left. A compact proof rail leads into the working product. The stats and customer proof rail are visible in the opening viewport. At mobile widths the rail follows the copy and actions over the artwork, with a dark backdrop that keeps labels readable.

Below the product plate the page is one ruled sheet (`src/styles/home-ledger.css`). Every section is a `.ledger` with the same head (`LedgerHead`): one display line at up to 88px, one sentence, its links on the same baseline at the right. No eyebrow labels. Frames sit in `.ledger-grid`, where cells share hairlines instead of each drawing a border; a caption is a 22px title, one sentence and a link. Sections are divided by a single rule on one background, never by alternating charcoals. The agent section is the one place with a column of points beside a frame: its three points are what the transcript beside it proves.

The sheet has no art. Two saturated breaks carry the Roman identity between the hero and the footer: the proof chapter (amber, the aqueduct panorama across its foot) and the closing arch. The proof chapter quotes a named person from the published customer story and prints that story's own figures and the logo list, all read from content (`quote` and `highlights` on the story, the `logos` collection); nothing in it is written by hand.

Order: signals (the live trace across the sheet, the logs stream and a session replay capture sharing the row under it), the incident walkthrough, proof, the platform wall, ownership (the source, OpenTelemetry and pricing links over Maple Local and the runtimes row), the agent transcript, the iPhone app (three App Store screenshots cut off at their cells' edge, each captioned with the question it answers, and Apple's badge in the head), the plan with the vendor bill under it, questions, the close. The platform wall shows every other surface without a click, in two joined sheets. Captures (service map across two cells, metrics, errors, alerting, web analytics) run three to a row from 1280px, each a legible window of a real screen that opens whole in the lightbox. The live components (Kubernetes, product events, uptime, the pull request review) run two to a row from 1024px, because they lay out by viewport width and a narrow cell squeezes them. A cell is the frame, then the feature's headline, its copy and its link; frames in a row share one height and captions start on one line. Below 768px each sheet is a strip to swipe, a cell most of the screen wide. The bill is one row per vendor and the four lines that decide a bill; the other lines are on `/compare`, which prints the same data (`lib/bill-comparison.ts`) with a column per vendor. A surface that needs more than a heading, one sentence and a link belongs on its feature page.

Motion below the hero is four moments and no loops. Section headlines rise a line at a time, once, as they scroll in. The trace's timeline cells light in start order, once. Captures resolve out of coarse blocks, once. The customer quote inks in a word at a time, tied to the scroll position and nothing else. None of it runs under reduced motion, and anything already on screen at load is simply drawn. The surface wall is a bento: each cell is copy, then a window onto the product that runs off the cell's edge with no fade. Every window holds a scripted frame labelled DEMO, and none holds a capture. Metrics, errors and web analytics draw the dashboard's own chart definitions over example data that moves continuously: the latency line glides, and events and visits land at uneven intervals, never on a beat and never looping back; the service map, alert firing, funnel and uptime frames play a story. A frame runs while it is on screen and holds while it is not; the pod heatmap stays still, because its only motion is a pulse.

## Elevation & Depth

Depth comes from the artwork and flat changes of color. No decorative shadows or glass. Actual product captures preserve their native appearance.

## Shapes

Original shared rounded buttons, sharp frames, thin shared border rules. Dither belongs to generated imagery, not a CSS texture over text.

## Components

Existing navigation, authentication-aware CTAs, carousel, walkthrough, calculator, pricing and FAQs retain their behavior. Buttons have visible hover and keyboard focus. The hero image is eager; lower imagery is lazy. The page is usable without animation and respects reduced motion.

A capture in a narrow column is a crop, not the whole screen scaled down: `MediaFrame` takes `crop` (top-left corner and zoom), the right and bottom edges fade out, and the lightbox still opens the full capture. The session plate uses it, and so does every capture in the platform wall. Pick a window that starts on a layout edge and holds nothing you would not print at full size. Section ledes are 15px (16px from `md`), row titles 15px, row copy and links 14px.

## Do's and Don'ts

Keep localized content and real commercial facts. Use the generated monument at hero scale. Do not tint screenshots, invent metrics, replace working controls with decorative labels, or change the product theme.

Homepage buttons use the original shared `buttonVariants` (hero size `xl`, primary and outline variants). Preserve their radius, shadows, focus rings, hover and pressed states; homepage surface overrides exclude buttons and links.

The stats and customer logos overlay the lower hero artwork with a soft charcoal gradient and text shadow for contrast. There is no divider or separate strip. The GitHub count uses the existing PixelStar icon. Keep the proof visible in the opening viewport.

The Roman hero uses medium-fine dithering in stone and shadows, with crisp architectural edges. Avoid large checkerboard blocks or overly smooth engraving.

Hero headline restored: “Open-source observability. / Built on OpenTelemetry. / Your agent reads it too.” The first two lines use bone; the final line uses the shared amber primary. Supporting copy is one short product description without repeating OpenTelemetry or the agent claim.

## Pricing

Pricing carries the shared orange-and-charcoal palette, Geist typography, sharp panel frames and original rounded buttons into a focused purchasing surface. Use a compact introduction with a distinct Roman countryside engraving with cultivated fields, an aqueduct and a winding merchant route, enlarged across the right background and softly faded behind the copy; rates and the plan price take priority over display typography. Keep the offer, calculator, supported-stack section, deployment options and FAQs. Omit homepage-style artwork, customer-logo bands and a large promotional closing CTA. Prices, trial terms, retention and calculator behavior remain sourced from the existing commercial data. English, Japanese and Korean share the styling. Mobile rate cells form two columns and offer panels stack; text must not overflow.

## Feature illustrations

Each `/features/*` page has its own Roman engraving in the hero, shared across English, Japanese and Korean. Match the balanced hero's amber-on-charcoal palette and medium-fine dithering. Choose a subject that relates to the feature: aqueduct channels for tracing, an archive for logs, a water clock for metrics, a connected city for services, a cracked keystone for errors, a watchtower for alerts, a theater for session replay, a scholar's instrument for MCP, and an organized harbor for Kubernetes.

Every feature hero shows the product in the first viewport. The copy takes the left track and the page's real product the right one: its live artifact by default, a cropped capture (`heroShot`) where a screen says it better, or a piece built for the hero (`heroAside`). The frame is top-aligned with the headline, and whatever sits in the hero appears nowhere else on the page: a lifted artifact keeps its title and lede as the frame's caption and loses its own section, and a lifted capture leaves the gallery. On phones the frame follows the copy and CTAs directly.

The illustration is the backdrop to that frame. It fills the right half of the hero, anchored on the monument, fades out to the left behind the copy and out at the bottom before the caption; the frame covers its middle, so the crown of the monument rises above the frame and its flank shows beside it. On smaller screens its opacity drops to keep the full-width text readable. Pages without an engraving keep the dot-grid veil. Preserve all localized copy, breadcrumbs, CTAs, real screenshots and interactive demos. Illustration paths belong to the feature registry; generated WebP assets and prompts live in `public/art/features/`.

Captures on a feature page are windows, not whole screens: panel plates show the app's main pane without the sidebar, gallery shots show the part of the screen their title names (`crop` in the registry), and on phones every cropped capture tightens from its top-left corner until its text is readable. The lightbox opens the whole capture. The text-only tail (capability ledger, plan facts, cross links) runs on one three-track grid, key, title, sentence, with no index numbers.

A use-case page opens on its story: the pinned pane starts beside the headline and holds the first screen of the path. Under reduced motion the pane never swaps; it stays through the first step and each later step shows its own plate. Comparison heroes retain their existing layout.

## Documentation home

`/docs` pairs a heavy display title with the shared Maple Waterfall component on a flat background. The example checkout trace is pre-rendered, and readers can expand or collapse spans once the page loads. "Start here" is a framed strip beneath the opening, with amber icons that match the sidebar. Sections use an eyebrow, a heavy heading and sharp hairline frames. Cells have no radius and hover to `--card`. The "Any OTLP exporter" row spans the language grid. Article pages use the docs reading scale and place diagrams beside the concepts they explain. The docs 404 uses the same title weight and sharp list frame.

## Social previews

The 1200 × 630 OG cards use the same shared dark tokens, local Geist fonts and tree mark. The general card reuses `maple-rome-balanced.webp`; docs uses the Roman archive from `features/log-management.webp`. Large left-aligned text sits over a charcoal fade, with the architecture filling the right side. Keep the graphics recognizable at social-preview size.

Run `bun run --cwd apps/landing generate:og` to regenerate both public PNGs and the application's matching `og-image.png`. The script uses this workspace's Playwright devDependency (install its Chromium browser with `apps/landing/node_modules/.bin/playwright install chromium` if needed). It renders local HTML with embedded assets, so generation needs no running app or network. Existing metadata paths continue to point to these files.

## Product frames on the other marketing pages

Pricing, EU, integrations, OpenTelemetry, observability, customers, comparisons, alternatives and the open-source roundup show a real product frame in the first viewport: beside the hero copy from `lg`, directly under the copy and buttons on a phone. Every frame comes from `src/components/marketing/ProductFrame.astro`, which picks a live component or a cropped capture by id; none of these pages draws its own UI. On pricing the frame sits over the engraving, which stays as the backdrop. On a comparison page the hero stacks the two marks (one compact row) over a live trace, and the Surfaces section comes before the difference table; a vendor without one gets the service map under the table. The long text pages add a frame where the text reaches that surface (`ProductBand.astro`), so no run of more than about three screens is text only. `/opentelemetry` and `/integrations/<runtime>` are one shared template per page (`OtelPage.astro`, `IntegrationPage.astro`); the locale files only claim the route.
