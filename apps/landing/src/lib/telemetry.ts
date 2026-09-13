/**
 * Maple's own browser telemetry on the marketing site.
 *
 * We sell session replay and product analytics, so the landing site runs the
 * public `@maple-dev/browser` SDK exactly as a customer would — same package,
 * same config surface. Two things follow from that:
 *
 * - The visitor id is a cookie scoped to the registered domain (see
 *   `packages/browser-session/src/identity/visitor.ts`), so a visit to `maple.dev` and
 *   the session that follows on `app.maple.dev` resolve to the *same*
 *   `VisitorId`. That is the join that makes "which campaign produced this
 *   signup" answerable — the session ids stay separate on purpose.
 *
 * Privacy posture matches what the site already did with its third-party
 * analytics tag: no consent gate, inputs masked, and Global Privacy Control
 * honored by default (it suppresses the persistent visitor id).
 */

import { MapleBrowser, type TrackProps } from "@maple-dev/browser"

const INGEST_KEY = import.meta.env.PUBLIC_MAPLE_INGEST_KEY
const ENDPOINT = import.meta.env.PUBLIC_INGEST_URL || "https://ingest.maple.dev"
/**
 * Escape hatch for hosts where the cookie-domain probe can't find a shared
 * parent — chiefly local dev, where browsers make `*.localhost` cookies
 * host-only and `landing.localhost` / `web.localhost` would never link.
 */
const COOKIE_DOMAIN = import.meta.env.PUBLIC_MAPLE_COOKIE_DOMAIN

/**
 * Event names, `object_action`. Keeping them in a closed set rather than
 * free-form strings is what stops `cta_click` and `clicked_cta` from both
 * existing three months from now — the warehouse has no schema to catch it.
 *
 * This is a runtime set, not just a union, because the `data-track` attributes
 * below are strings in markup that no compiler ever sees. The type is derived
 * from it so the two cannot drift.
 */
const LANDING_EVENTS = [
	"cta_click",
	"pricing_plan_selected",
	"pricing_calculator_changed",
	"install_command_copied",
	"docs_search",
	"docs_snippet_copied",
	"brand_asset_copied",
	"brand_asset_downloaded",
	"media_opened",
	"objection_opened",
	"page_scrolled",
] as const

export type LandingEvent = (typeof LANDING_EVENTS)[number]

function isLandingEvent(name: string): name is LandingEvent {
	return (LANDING_EVENTS as ReadonlyArray<string>).includes(name)
}

let started = false

/**
 * Initialize telemetry and bind the declarative `data-track` handler. Safe to
 * call on every page load; Astro is MPA, so it runs once per navigation and the
 * session/visitor identifiers carry across.
 */
export function startLandingTelemetry(): void {
	// No key configured (fresh clone, `astro dev` without env) — stay silent
	// rather than post a marketing site's traffic at whatever the default is.
	if (started || !INGEST_KEY || typeof window === "undefined") return
	started = true

	MapleBrowser.init({
		ingestKey: INGEST_KEY,
		endpoint: ENDPOINT,
		serviceName: "maple-landing",
		serviceNamespace: "core",
		environment: import.meta.env.MODE,
		replay: { enabled: true },
		privacy: {
			maskAllInputs: true,
			// Empty means "unset" — the SDK's probe finds the shared domain on its
			// own, and an explicit "" would pin the cookie host-only in production.
			...(COOKIE_DOMAIN ? { cookieDomain: COOKIE_DOMAIN } : undefined),
		},
	})

	bindDeclarativeTracking()
	bindScrollDepth()
}

/**
 * Scroll depth, as one `page_scrolled` event per threshold per page view.
 *
 * A bounce rate alone cannot tell "read the hero and left" from "read the whole
 * page and left" — both are one page view — and those two want opposite fixes.
 * Thresholds are coarse on purpose: quartiles answer "did the fold hold them",
 * and anything finer just multiplies event volume without moving a decision.
 */
const SCROLL_MARKS = [25, 50, 75, 100] as const

function bindScrollDepth(): void {
	let remaining = [...SCROLL_MARKS]
	let queued = false

	const measure = () => {
		queued = false
		const scrollable = document.documentElement.scrollHeight - window.innerHeight
		// A page shorter than the viewport is 100% read the moment it is opened;
		// reporting 25/50/75 for it would inflate every quartile.
		const percent =
			scrollable <= 0
				? 100
				: ((window.scrollY + window.innerHeight) / document.documentElement.scrollHeight) * 100
		const reached = remaining.filter((mark) => percent >= mark)
		if (reached.length === 0) return
		remaining = remaining.filter((mark) => percent < mark)
		for (const mark of reached) {
			trackLanding("page_scrolled", { depth: String(mark), path: window.location.pathname })
		}
	}

	// rAF-coalesced: scroll fires far faster than the SDK should be asked to
	// serialize an event, and the thresholds only need the resting position.
	const onScroll = () => {
		if (queued) return
		queued = true
		requestAnimationFrame(measure)
	}

	window.addEventListener("scroll", onScroll, { passive: true })
	window.addEventListener("resize", onScroll, { passive: true })
	// Fires the short-page 100% case, and any depth restored from a #fragment.
	measure()
}

/** Record a custom event. No-ops before init; the SDK queues pre-init events. */
export function trackLanding(event: LandingEvent, props?: TrackProps): void {
	MapleBrowser.track(event, props)
}

/**
 * Attach the signed-in user to the session. Called from the NavBar island,
 * which is the one place Clerk is mounted. The email is deliberately left off —
 * this is our own dogfooding instance, and the id is the join key that matters.
 */
export function identifyLanding(userId: string | null | undefined): void {
	MapleBrowser.identify(userId ? { id: userId } : null)
}

/**
 * One delegated click listener for `data-track` elements.
 *
 * Most of this site is static Astro with no islands, so the alternative to a
 * declarative hook is hydrating a React component per CTA just to attach an
 * onClick. `data-track-*` attributes become event properties:
 *
 * ```html
 * <a href="…" data-track="cta_click" data-track-location="hero">
 * ```
 */
function bindDeclarativeTracking(): void {
	document.addEventListener(
		"click",
		(event) => {
			const target = event.target
			if (!(target instanceof Element)) return
			const host = target.closest<HTMLElement>("[data-track]")
			const name = host?.dataset.track
			if (!host || !name) return
			// The markup is the one path into `track()` that the compiler never
			// checks, so a typo'd `data-track` would otherwise ship silently and
			// show up as a second event name in the warehouse weeks later.
			if (!isLandingEvent(name)) {
				if (import.meta.env.DEV) {
					console.warn(
						`[maple] ignoring unknown data-track="${name}" — add it to LANDING_EVENTS first.`,
					)
				}
				return
			}

			const props: Record<string, string> = {}
			for (const [key, value] of Object.entries(host.dataset)) {
				if (key === "track" || !key.startsWith("track") || value === undefined) continue
				// `data-track-location` → dataset.trackLocation → `location`.
				props[key.slice(5).replace(/^./, (c) => c.toLowerCase())] = value
			}
			// Which page a CTA was clicked on is not knowable from the markup —
			// the same nav renders on every route — and stamping it in the
			// component would make the SSR and client attribute disagree. Read it
			// here, at click time, where there is only ever one answer. Markup
			// wins, so a page can still name its own `data-track-path`.
			trackLanding(name, { path: window.location.pathname, ...props })
		},
		// Capture, so a handler that stops propagation (or a React island that
		// re-renders the node away) can't swallow the event first.
		{ capture: true },
	)
}
