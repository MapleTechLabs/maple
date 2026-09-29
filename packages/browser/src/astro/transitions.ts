// Page loads, `<ClientRouter />` navigations and island load errors, for
// `@maple-dev/browser/astro/client`.
//
// Without `<ClientRouter />` every link loads a new document, and each document
// is one `pageload` span, ended at the window's `load`. With it, links swap the
// page in place: each is a `navigate` span from `astro:before-preparation` to
// `astro:page-load`, with the request for the next page under it. Spans are
// named after `<html data-route>`, the page's route template, which the
// router copies from the new page on swap.
import { captureException } from "../errors"
import { endNavigation, startNavigation, traced } from "../navigation"

/** What this reads of Astro's `astro:before-preparation` event. */
interface BeforePreparationEvent extends Event {
	readonly to: URL
	readonly signal: AbortSignal
	loader: () => Promise<void>
}

/** Set while the listeners are registered: once per document. */
let listening: AbortController | undefined

/**
 * Trace page loads and `<ClientRouter />` navigations. The `maple()` integration calls it on every page;
 * without it, call it from the `<script>` in your layout that calls `MapleBrowser.init()`.
 */
export function traceAstroNavigation(): void {
	if (listening || typeof document === "undefined") return
	listening = new AbortController()
	const { signal } = listening

	const template = () => document.documentElement.dataset.route
	/** The document's own page load is open, until `load`. */
	let pageLoad = false
	/** The navigation in flight swapped its page in: `astro:page-load` also fires once for the document. */
	let swapped = false

	const endPageLoad = () => {
		if (!pageLoad) return
		pageLoad = false
		endNavigation(template())
	}
	const startPageLoad = () => {
		startNavigation(location.pathname)
		pageLoad = true
		if (document.readyState === "complete") endPageLoad()
		else addEventListener("load", endPageLoad, { once: true, signal })
	}
	// After every module script ran, including the one that calls `MapleBrowser.init()`,
	// wherever it is on the page: before it, nothing would be spanned
	const [entry] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[]
	if (entry && !entry.domContentLoadedEventStart) {
		document.addEventListener("DOMContentLoaded", startPageLoad, { once: true, signal })
	} else startPageLoad()

	document.addEventListener(
		"astro:before-preparation",
		(event) => {
			const preparation = event as BeforePreparationEvent
			pageLoad = false
			swapped = false
			startNavigation(preparation.to.pathname)
			const load = preparation.loader
			preparation.loader = async () => {
				// The request for the next page's HTML, and the server render behind it
				await traced("load page", load)
				// Astro falls back to a full page load, which gets its own pageload span.
				// Aborted: a newer navigation already ended this one.
				if (preparation.defaultPrevented && !preparation.signal.aborted) endNavigation()
			}
		},
		{ signal },
	)
	document.addEventListener(
		"astro:before-swap",
		() => {
			swapped = true
		},
		{ signal },
	)
	document.addEventListener(
		"astro:page-load",
		() => {
			if (!swapped) return
			swapped = false
			endNavigation(template())
		},
		{ signal },
	)
	// An island whose code failed to load: Astro catches the error and only logs it
	document.addEventListener(
		"astro:hydration-error",
		(event) => {
			captureException((event as CustomEvent<{ readonly error: unknown }>).detail.error, {
				name: "astro.hydration_error",
			})
		},
		{ signal },
	)
}

/** Test seam: remove the listeners, as if the document had just loaded. */
export function resetAstroNavigationForTests(): void {
	listening?.abort()
	listening = undefined
}
