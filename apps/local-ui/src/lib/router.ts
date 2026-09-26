// Tiny hash router with query-string support.
//
// The local SPA is served from the binary at a fixed origin, so we route purely
// in the fragment: `#/<path>?<filters>`. Keeping filter state in the hash makes
// every view reload-safe and shareable.

import { useCallback, useMemo, useSyncExternalStore } from "react"
import { Option } from "effect"
import { trySync } from "@maple/ui/lib/try-sync"

function getHash(): string {
	return window.location.hash.replace(/^#/, "")
}

function subscribe(onChange: () => void): () => void {
	window.addEventListener("hashchange", onChange)
	return () => window.removeEventListener("hashchange", onChange)
}

export interface Location {
	/** Path portion of the hash, e.g. `/sessions`. Always starts with `/`. */
	readonly path: string
	/** Parsed query portion. */
	readonly query: URLSearchParams
}

export function parseLocation(hash: string): Location {
	const [rawPath, rawSearch = ""] = hash.split("?")
	const path = rawPath && rawPath.startsWith("/") ? rawPath : "/traces"
	return { path, query: new URLSearchParams(rawSearch) }
}

/** A `#/path?query` href, for real links (keyboard focus, cmd-click, copy link). */
export function hrefFor(path: string, query?: URLSearchParams): string {
	const qs = query?.toString()
	return `#${path}${qs ? `?${qs}` : ""}`
}

/** `decodeURIComponent` that keeps a malformed segment as-is instead of throwing. */
export function decodeSegment(segment: string): string {
	return Option.getOrElse(
		trySync(() => decodeURIComponent(segment)),
		() => segment,
	)
}

// In-app history, so a detail page's Back can return to wherever it was opened
// from. Only hashes seen in this document count: a reload starts it over, and
// anything before that (another site, a pasted link) is never "in-app".
const visited: string[] = typeof window === "undefined" ? [] : [getHash()]
let replacing = false

function trackHashChange(): void {
	const hash = getHash()
	if (replacing) {
		replacing = false
		visited[visited.length - 1] = hash
	} else if (visited.length > 1 && visited[visited.length - 2] === hash) {
		visited.pop()
	} else {
		visited.push(hash)
	}
}

if (typeof window !== "undefined") window.addEventListener("hashchange", trackHashChange)

/** True when the previous history entry is a page of this app. */
export function canGoBackInApp(): boolean {
	return visited.length > 1
}

/**
 * Navigate to a path. Page-to-page moves push a history entry (default);
 * in-place filter updates pass `replace` so the back button steps between
 * pages, not between every filter tweak.
 */
export function navigate(path: string, query?: URLSearchParams, opts?: { replace?: boolean }): void {
	const hash = hrefFor(path, query)
	if (opts?.replace) {
		history.replaceState(history.state, "", hash)
		// replaceState doesn't emit hashchange; nudge the store to re-read.
		replacing = true
		window.dispatchEvent(new HashChangeEvent("hashchange"))
	} else {
		window.location.hash = hash
	}
}

/** Back to the previous in-app page, or to `fallback` when there is none. */
export function goBack(fallbackPath: string, fallbackQuery?: URLSearchParams): void {
	if (canGoBackInApp()) history.back()
	else navigate(fallbackPath, fallbackQuery)
}

/** Reactive current location, parsed from the hash. */
export function useLocation(): Location {
	const hash = useSyncExternalStore(subscribe, getHash, () => "")
	return useMemo(() => parseLocation(hash), [hash])
}

export type ParamUpdates = Record<string, string | null | undefined>

/**
 * Read/update the query params of the current path. Updating preserves the
 * path; setting a key to `null`/empty removes it.
 */
export function useQueryParams(): readonly [URLSearchParams, (updates: ParamUpdates) => void] {
	const { query } = useLocation()
	const setParams = useCallback((updates: ParamUpdates) => {
		// Read the live hash rather than the render-captured location: handlers
		// that call setParams twice in one tick would otherwise clobber each other.
		const current = parseLocation(getHash())
		const next = new URLSearchParams(current.query)
		for (const [key, value] of Object.entries(updates)) {
			if (value == null || value === "") next.delete(key)
			else next.set(key, value)
		}
		navigate(current.path, next, { replace: true })
	}, [])
	return [query, setParams] as const
}
