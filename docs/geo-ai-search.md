# GEO / AI search optimization

How Maple's marketing site (`apps/landing`) is optimized to be **cited by AI chatbots**
(ChatGPT, Google AI Overviews & AI Mode, Perplexity) — "Generative Engine Optimization."

This is grounded in Ahrefs' 2026 research (14 studies, 1B+ data points). Each of their 10
headline findings is mapped below to one of three buckets: **shipped** (a concrete change on
the site), **deliberately skipped** (the finding tells us _not_ to invest), or **strategy**
(a directional insight that shapes how we write, not a discrete feature).

## What shipped

| #   | Ahrefs finding                                                                   | What we did                                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | "Best X" listicles are the single most-cited format (43.8% of ChatGPT citations) | New **`/best-open-source-observability-tools`** page — a fair, ranked roundup driven by `src/lib/best-observability-tools.ts`. Honest pros/cons per tool, a methodology note, and `ItemList` schema. The data model makes more listicles cheap.       |
| 8   | 99.9% of AI Overviews appear on **informational-intent** queries                 | New **`/observability`** pillar page ("What is observability?") — definition, the three pillars, observability vs monitoring, how to choose. Quotable one-line definitions lead each section.                                                         |
| 2   | Homepages are cited 23.8% of the time (and are influenceable)                    | Added a concise **FAQ to the homepage** stating Maple's core entity facts plainly (what it is, license/FSL-1.1, OTel-native, pricing, AI/MCP) with `FAQPage` schema.                                                                                  |
| 10  | AI Overviews change every ~2.15 days; freshness churns constantly                | Visible **"Last updated"** dates on the listicle and pillar, and a build-time `lastmod` in the sitemap (`astro.config.mjs`).                                                                                                                          |
| —   | (Enabler the findings assume) AI crawlers must be allowed to fetch the content   | Rewrote **`public/robots.txt`** to explicitly welcome `GPTBot`, `OAI-SearchBot`, `ChatGPT-User`, `ClaudeBot`, `Claude-SearchBot`, `Claude-User`, `anthropic-ai`, `PerplexityBot`, `Perplexity-User`, `Google-Extended`, `Applebot-Extended`, `CCBot`. |
| —   | Internal linking aids crawl + citation                                           | Cross-linked the pillar ↔ listicle ↔ `/opentelemetry`, and added a "Learn" group to the footer.                                                                                                                                                       |

## Deliberately skipped (the finding says don't)

| #   | Ahrefs finding                                                                                                          | Decision                                                                                                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | Adding schema markup had **~zero** impact on AI citations (AIO −4.6%, AI Mode +2.4%, ChatGPT +2.2% — all noise)         | We did **not** do a speculative schema buildout. We add only _format-native_ structured data where it's the natural fit: `ItemList` for the listicle and the existing `FAQPage` / `BreadcrumbList` components. No Article/Product/etc. on spec.                                                                     |
| 6   | YouTube mentions have the **highest** correlation with AI brand visibility (0.737) — above every traditional SEO metric | **Top recommended follow-up, not yet built.** It needs real video assets we don't have. When there's a demo/walkthrough video, embed it (a privacy-friendly click-to-load facade) on the homepage and key pages, with `VideoObject` schema, and seed mentions of it. This is the single highest-leverage next step. |

## Strategy — shapes how we write, not a feature

| #   | Ahrefs finding                                                                                           | How it informs the content                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 3   | 28.3% of ChatGPT's most-cited pages have **zero Google organic visibility** — a separate discovery layer | We invest in AI-citable content (clear listicles, quotable definitions) even where it may not rank in Google. Don't gate GEO content on traditional SEO performance.     |
| 4   | ChatGPT only **cites ~50%** of the URLs it retrieves; being retrieved ≠ being cited                      | Make claims easy to extract and attribute: short quotable lead sentences, clear `<h2>` structure, explicit facts and numbers, fair sourcing.                             |
| 7   | AI Overviews cut clicks to the #1 result by 58% (and accelerating)                                       | The payoff of being _the cited source_ keeps rising — this is why GEO is worth doing at all, and why we optimize for the citation, not just the rank.                    |
| 9   | For the same query, AI Mode & AI Overviews agree 86% of the time but share only **13.7%** of citations   | Cover the topic across multiple surfaces/pages (pillar, listicle, comparisons, feature pages) rather than betting on one URL — different engines cite different sources. |

## Where things live

- Listicle data model: `apps/landing/src/lib/best-observability-tools.ts`
- Listicle page: `apps/landing/src/pages/best-open-source-observability-tools.astro`
- Observability pillar: `apps/landing/src/pages/observability.astro`
- Homepage FAQ: `apps/landing/src/pages/index.astro`
- AI crawler allowlist: `apps/landing/public/robots.txt`
- Sitemap freshness: `apps/landing/astro.config.mjs`
- Shared schema components: `SeoHead.astro`, `FAQ.astro`, `Breadcrumb.astro`

## Next steps (in priority order)

1. **YouTube (#6)** — produce a short demo/walkthrough, embed it, add `VideoObject` schema. Highest correlation of anything studied.
2. More listicles off the same data model — "Best Datadog alternatives", "Best OpenTelemetry backends", "Best open-source APM".
3. A glossary / more informational pillars (distributed tracing, OTLP, spans, sampling) to widen informational-intent coverage (#8) and surface breadth (#9).
