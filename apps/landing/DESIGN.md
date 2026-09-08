# Maple landing — Maple Dither Monumentalism

## Overview

The homepage is a Persuade surface for engineers evaluating open-source observability. Its signature is monumental typography above an Rome-inspired, amber dithered temple and aqueduct. This direction applies to the homepage and its locale variants; other marketing pages and the application retain their existing design.

## Colors

Homepage variables alias the actual shared dark UI tokens: orange → `--primary` (`oklch(0.714 0.154 59)`, approximately `#E8872A`); canvas → `--background`; panels → `--card`; text → `--foreground`; secondary text → `--muted-foreground`; rules → `--border`. The palette is amber, warm charcoal and bone. Use `--primary-foreground` for text on amber. The logo's `#E86F00` is a separate brand asset color, not the UI primary. Never substitute a guessed orange or redefine shared tokens.

## Typography

Geist Variable is the heavy, tightly set monumental display face: 700 weight, -0.04em tracking, 1.06 line height for the hero. Body uses Geist Variable with readable 1.65 leading. Geist Mono is reserved for technical identifiers, labels, and code. Display scale is intentionally oversized for this pinned monumental direction; fluid sizes and locale wrapping protect small screens.

## Layout

A wide poster opening: announcement, oversized three-line title, architectural art occupying the right and lower field, descriptive copy and two CTAs on the left. A compact proof rail leads into the working product. Below, preserve the existing product narrative and interactive demonstrations with stronger headings, asymmetric layouts and two saturated color breaks. The stats and customer proof rail are visible in the opening viewport. At mobile widths the rail follows the copy and actions over the artwork, with a dark backdrop that keeps labels readable.

## Elevation & Depth

Depth comes from the artwork and flat changes of color. No decorative shadows or glass. Actual product captures preserve their native appearance.

## Shapes

Original shared rounded buttons, sharp frames, thin shared border rules. Dither belongs to generated imagery, not a CSS texture over text.

## Components

Existing navigation, authentication-aware CTAs, carousel, walkthrough, calculator, pricing and FAQs retain their behavior. Buttons have visible hover and keyboard focus. The hero image is eager; lower imagery is lazy. The page is usable without animation and respects reduced motion.

## Do's and Don'ts

Keep localized content and real commercial facts. Use the generated monument at hero scale. Do not tint screenshots, invent metrics, replace working controls with decorative labels, or change the product theme.

Homepage buttons use the original shared `buttonVariants` (hero size `xl`, primary and outline variants). Preserve their radius, shadows, focus rings, hover and pressed states; homepage surface overrides exclude buttons and links.

The stats and customer logos overlay the lower hero artwork with a soft charcoal gradient and text shadow for contrast. There is no divider or separate strip. The GitHub count uses the existing PixelStar icon. Keep the proof visible in the opening viewport.

The Roman hero uses medium-fine dithering in stone and shadows, with crisp architectural edges. Avoid large checkerboard blocks or overly smooth engraving.

Hero headline restored: “Open-source observability. / Built on OpenTelemetry. / Your agent reads it too.” The first two lines use bone; the final line uses the shared amber primary. Supporting copy is one short product description without repeating OpenTelemetry or the agent claim.
