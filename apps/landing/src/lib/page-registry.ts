/**
 * Shared types and helpers for the feature and use-case registries.
 *
 * Two rules govern everything in this file and its two consumers:
 *
 * 1. **Messages are stored as thunks, never as called values.** Paraglide
 *    resolves the active locale per call, through an AsyncLocalStorage the
 *    astro integration sets up around each page render. A module-scope
 *    `title: m.x()` would evaluate once at module-eval time and freeze
 *    whichever locale happened to render first — so every page in the build
 *    would inherit it. Store the function reference and let the template call
 *    it. `NavBar.ts` already uses this exact `() => string` shape.
 *
 *    The same rule is why `getStaticPaths()` must never call a message either:
 *    it runs outside that storage and always resolves to the source locale.
 *
 * 2. **No `.astro` and no `astro:i18n` imports here.** `NavBar.ts` is a
 *    `client:load` island that reads these registries, so anything imported
 *    here ships to the browser. Component references live in
 *    `components/page/slots.ts`, which only the templates import; paths are
 *    built by the pure helpers below rather than by `getRelativeLocaleUrl`.
 */

import type { FeaturePlan } from "./feature-plan"

type Locale = "en" | "ja" | "ko"

/** A Paraglide message, uncalled. See rule 1 above. */
type Msg = () => string

/**
 * Ids resolved to components in `components/page/slots.ts`. Strings rather
 * than imports so this module stays free of `.astro`.
 */
export type ArtifactId =
	| "trace-visualization"
	| "browser-sessions"
	| "log-stream"
	| "logs-volume"
	| "service-map"
	| "mcp-transcript"
	| "k8s-heatmap"
	| "alert-firing"
	| "funnel"
	| "pr-review"
	| "uptime"
	| "anomaly"
	| "status-page"

export type SectionId =
	| "k8s-console"
	| "k8s-views"
	| "k8s-correlation"
	| "k8s-install"
	| "product-events-paths"
	| "product-events-sources"
	| "github-ci"
	| "github-after-merge"
	| "uptime-check-trace"
	| "uptime-setup"
	| "status-page-timeline"
	| "status-page-themes"
	| "status-page-feeds"
	| "cost-explorer"
	| "cost-sources"
	| "cost-budgets"

/** A live piece built for the hero, on a page with no artifact to put there. */
export type HeroAsideId = "cost-statement" | "trace-waterfall"

/**
 * A legible window of a capture. `x` and `y` are the window's top-left corner as
 * fractions of the image and `zoom` is how much larger than the frame the image is
 * drawn. `aspect` (width / height) reshapes the frame; it defaults to the capture's.
 */
export interface Crop {
	x: number
	y: number
	zoom: number
	aspect?: number
	/** The window ends on a content edge inside the capture, so the right side must not fade. */
	hardRight?: boolean
}

/** The app's main pane at full height: every 1440 px capture has the same 256 px sidebar. */
const SIDEBAR = 0.1785
export const APP_MAIN: Crop = {
	x: SIDEBAR,
	y: 0,
	zoom: 1 / (1 - SIDEBAR),
	aspect: ((1 - SIDEBAR) * 1440) / 810,
}

/**
 * A plate. `src` unset renders MediaFrame's placeholder, which prints the
 * capture spec and swaps to the real asset later with no layout shift.
 *
 * `alt`/`caption` are literal English, matching the homepage's own plates.
 * They describe what a capture shows rather than making an argument, and the
 * screenshots themselves are English-only.
 */
interface Plate {
	src?: string
	/** The capture's intrinsic size — MediaFrame never crops, so this is the aspect. */
	width: number
	height: number
	alt: string
	/** Placeholder-only: what to capture. */
	caption?: string
	/** Show this window of the capture instead of the whole screen. A use-case plate uses it below lg. */
	crop?: Crop
}

/** One row of the operator gutter. `op` is a literal product string. */
interface Capability {
	op: string
	title: Msg
	body: Msg
}

interface SurfacePanelSpec {
	/** Frame head, left: the route. Literal. */
	route: string
	/** Frame head, right: one real constant from the shot. Literal. */
	constant: string
	plate: Plate
	/** Key/value facts. Both sides literal — product vocabulary, not prose. */
	facts: { key: string; value: string }[]
	title: Msg
	lede: Msg
}

/**
 * One capture in a feature page's gallery, produced by
 * `scripts/screenshots/capture.ts` as `/screenshots/<id>.webp` at
 * `GALLERY_SHOT_SIZE`. Literal English, like `Plate`.
 */
export interface GalleryShot {
	/** Shot id in `scripts/screenshots/shots.ts`. */
	id: string
	/** Frame head, left: the route the shot shows. */
	route: string
	/** Frame head, right: what to look at. */
	title: string
	alt: string
	/** The part of the screen the title points at. Unset shows the main pane. */
	crop?: Crop
}

/**
 * A capture beside the hero copy, for a page whose main surface is a screen
 * rather than its live artifact. Shown nowhere else on the page.
 */
export interface HeroShot extends GalleryShot {
	crop: Crop
}

/** Every capture is 1440×810 CSS px at 2x. */
export const GALLERY_SHOT_SIZE = { width: 2880, height: 1620 } as const

interface ArtifactSpec {
	id: ArtifactId
	title: Msg
	lede: Msg
	wide?: boolean
}

export interface Feature {
	slug: string
	/** Decorative Roman engraving, shared by all locale variants. Unset renders a plain hero. */
	illustration?: string
	/** What the engraving shows. Literal English, like the captures' alt text. */
	illustrationAlt?: string
	/**
	 * What the hero shows beside the copy: `heroAside`, else `heroShot`, else the
	 * artifact, which then has no section of its own lower down.
	 */
	heroAside?: HeroAsideId
	heroShot?: HeroShot
	navLabel: Msg
	navDesc: Msg
	seoTitle: Msg
	seoDescription: Msg
	heroTitle: Msg
	heroLede: Msg
	/** Null on pages whose surface is carried by a bespoke section instead. */
	panel: SurfacePanelSpec | null
	/** One per page. Two live artifacts plus the amber CTA reads speckled. */
	artifact: ArtifactSpec | null
	extraSections: SectionId[]
	/** More of the surface, below the artifact. Empty when the demo world cannot show it yet. */
	gallery: GalleryShot[]
	capTitle: Msg
	capabilities: Capability[]
	/** Price, retention and setup doc: the facts agents and buyers ask for first. */
	plan: FeaturePlan
	/** The closing call to action, for a page whose first step is not sending telemetry. */
	cta?: { title: Msg; lede: Msg }
	/** Questions a searcher asks about the feature, answered on the page and in FAQPage data. */
	faq?: { question: Msg; answer: Msg }[]
	/** Hand-picked, so no slug ends up with zero inbound links. */
	related: string[]
	relatedUseCases: string[]
	/** Drives hreflang. Every page ships in all three today. */
	locales: readonly Locale[]
}

export interface StoryStepSpec {
	surface: string
	route: string
	elapsed: string
	title: Msg
	body: Msg
	/** A real capture, always: the story pane has no placeholder state, so `src` is required. */
	plate: Plate & { src: string }
}

export interface UseCase {
	slug: string
	navLabel: Msg
	navDesc: Msg
	seoTitle: Msg
	seoDescription: Msg
	heroTitle: Msg
	heroLede: Msg
	/** The literal signal that opens the story, shown in the hero. */
	signal: string
	/** The one thing that holds across every step. Literal. */
	constant: string
	constantLabel: string
	storyTitle: Msg
	storyLede: Msg
	/** Capture aspect shared by this story's plates, e.g. "1280 / 660". */
	storyAspect: string
	steps: StoryStepSpec[]
	outcomeLine: Msg
	/** Values are literal; only the labels are translated. */
	outcomeMetrics: { value: string; label: Msg }[]
	capTitle: Msg
	capabilities: Capability[]
	related: string[]
	relatedFeatures: string[]
	locales: readonly Locale[]
}

/**
 * Path helpers. Pure, so both the Astro templates and the nav island can
 * use them and agree — NavBar builds hrefs with the same `/${locale}${path}`
 * shape, and `getRelativeLocaleUrl` produces the same strings for these routes.
 */
const localePath = (locale: string, path: string) => (locale === "en" ? path : `/${locale}${path}`)

export const featuresIndexPath = (locale: string) => localePath(locale, "/features")

export const featurePath = (locale: string, slug: string) => localePath(locale, `/features/${slug}`)

export const useCasePath = (locale: string, slug: string) => localePath(locale, `/use-cases/${slug}`)

export const pricingPath = (locale: string) => localePath(locale, "/pricing")
