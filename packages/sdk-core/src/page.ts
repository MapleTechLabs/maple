// Page-wide coordination between SDK copies. Both SDKs can run on one page, and
// each bundles its own copy of this module, so the state lives on `globalThis`:
// one error is one issue, one copy runs each collector, and errors reach both.
import type { SpanLink } from "./log-record"

/** One page-level signal that must be collected once per page: one per option, so each SDK keeps its own settings. */
export type PageSignal =
	| "breadcrumbs"
	| "browserReports"
	| "console"
	| "csp"
	| "longFrames"
	| "slowInteractions"
	| "webVitals"

interface Lease {
	readonly owner: symbol
	count: number
}

interface PageState {
	readonly version: 1
	readonly reported: WeakSet<object>
	readonly errorListeners: Set<(link: SpanLink) => void>
	readonly leases: Map<PageSignal, Lease>
}

/** Versioned: a copy with another layout gets its own slot instead of overwriting this one. */
const KEY = "__MAPLE_SDK_PAGE_V1__"
/** This bundled copy: instances of one copy share a lease, another copy does not. */
const COPY = Symbol("maple-sdk-copy")

const isPageState = (value: unknown): value is PageState =>
	typeof value === "object" && value !== null && "version" in value && value.version === 1

function page(): PageState {
	const owner: Record<string, unknown> = globalThis
	const existing = owner[KEY]
	if (isPageState(existing)) return existing
	const fresh: PageState = {
		version: 1,
		reported: new WeakSet(),
		errorListeners: new Set(),
		leases: new Map(),
	}
	owner[KEY] = fresh
	return fresh
}

/** Whether this exact error object was already recorded, by either SDK. */
export function wasReported(error: unknown): boolean {
	return typeof error === "object" && error !== null && page().reported.has(error)
}

/** Claim `error` as recorded, so a rethrow or a second handler does not record it again. */
export function markReported(error: unknown): void {
	if (typeof error === "object" && error !== null) page().reported.add(error)
}

/** Told about every recorded error: breadcrumbs export their trail, a buffered replay keeps itself. */
export function onErrorRecorded(listener: (link: SpanLink) => void): () => void {
	page().errorListeners.add(listener)
	return () => page().errorListeners.delete(listener)
}

export function notifyErrorRecorded(link: SpanLink): void {
	for (const listener of page().errorListeners) {
		// A listener must never turn one error into another.
		try {
			listener(link)
		} catch {}
	}
}

/**
 * Lease one page collector for this bundled copy. `undefined` means another
 * copy already runs it, and starting it again would report everything twice.
 */
export function claimPageSignal(signal: PageSignal): (() => void) | undefined {
	const leases = page().leases
	const lease = leases.get(signal)
	if (lease && lease.owner !== COPY) return undefined
	const held = lease ?? { owner: COPY, count: 0 }
	held.count++
	leases.set(signal, held)
	let released = false
	return () => {
		if (released) return
		released = true
		held.count--
		if (held.count <= 0 && leases.get(signal) === held) leases.delete(signal)
	}
}

/** Test seam: how many instances of this copy hold `signal`, 0 when another copy or nobody does. */
export function pageSignalLeasesForTests(signal: PageSignal): number {
	const lease = page().leases.get(signal)
	return lease?.owner === COPY ? lease.count : 0
}

/** Test seam: have another bundled copy hold `signal`. */
export function leasePageSignalAsOtherCopyForTests(signal: PageSignal): void {
	page().leases.set(signal, { owner: Symbol("other maple-sdk copy"), count: 1 })
}

/** Test seam: forget reported errors and leases; listeners belong to live SDK instances and stay. */
export function resetPageForTests(): void {
	const listeners = page().errorListeners
	const owner: Record<string, unknown> = globalThis
	owner[KEY] = { version: 1, reported: new WeakSet(), errorListeners: listeners, leases: new Map() }
}
