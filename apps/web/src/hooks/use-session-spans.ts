import * as React from "react"

import type { AiSessionSpan, AiSessionSpanCursor, AiSessionSpanScope } from "@maple/domain/http"

import {
	getAiSessionSpans,
	type AiSessionSpansInput,
	type AiSessionSpansPage,
} from "@/api/warehouse/ai-sessions"
import type { SessionWindow } from "@/lib/agent-sessions/session-window"
import { Result, useAtomValue, type Atom } from "@/lib/effect-atom"
import { displayError } from "@/lib/error-messages"
import { mapleRuntime } from "@/lib/registry"
import { logClientError } from "@/lib/services/common/telemetry"
import { aiSessionSpansResultAtom, type QueryAtomFailure } from "@/lib/services/atoms/warehouse-query-atoms"

/**
 * How far the background load of a session larger than one page has come.
 *
 * `agent`: the agent's own spans are still arriving — the transcript's input,
 * so the END of the session is not in hand yet. `app`: every agent span is
 * loaded and the app's HTTP/DB spans are filling in behind them. `complete`:
 * the whole session is here. `failed`: a page did not come back; what was
 * loaded stays, and `retry` picks up where it stopped. `agentSpansComplete`
 * is what a view that reads the agent's spans alone should look at: a page of
 * the app's spans failing does not make the transcript's end go missing.
 */
export interface SessionLoadProgress {
	readonly phase: "agent" | "app" | "complete" | "failed"
	/** Every agent span is in hand, whatever the app's pages are doing. */
	readonly agentSpansComplete: boolean
	/** Every span in hand, both kinds. */
	readonly loadedSpans: number
	/** Agent spans in hand. */
	readonly loadedAgentSpans: number
	readonly retry: () => void
}

export interface SessionSpansState {
	/** The first page — the atom's `Result`, which is what the page renders on. */
	readonly firstPage: Result.Result<AiSessionSpansPage, QueryAtomFailure>
	/** Every span loaded so far, deduplicated, in the session's own order. */
	readonly spans: readonly AiSessionSpan[]
	/**
	 * The session did not fit the first page and is (or was) being loaded in
	 * the background. `undefined` for a session that came whole: then the spans
	 * in hand ARE the session.
	 */
	readonly progress: SessionLoadProgress | undefined
}

/** Spans a page carries past the first: the same ceiling the first page has. */
const PAGE_SIZE = 2_000
/**
 * The floor a page shrinks to when the byte cap (a 413) ends it. Spans heavy
 * enough to trip 10MB at this many rows carry ~40KB each after mapping, which
 * no session in production has come near.
 */
const MIN_PAGE_SIZE = 250
const SESSION_TOO_LARGE_TAG = "@maple/http/ai-sessions/AiSessionTooLargeError"

/** The two reads, injectable so a test can stand in fakes for both. */
export interface SessionSpansReads {
	/** The first page — an atom, so the page keeps its skeleton/retention semantics. */
	readonly firstPageAtom: (input: AiSessionSpansInput) => Atom.Atom<Result.Result<AiSessionSpansPage, QueryAtomFailure>>
	/** Every page past the first. */
	readonly fetchPage: (data: AiSessionSpansInput) => Promise<AiSessionSpansPage>
}

const warehouseReads: SessionSpansReads = {
	firstPageAtom: (input) => aiSessionSpansResultAtom({ data: input }),
	fetchPage: (data) => mapleRuntime.runPromise(getAiSessionSpans({ data })),
}

/** What the hook has loaded past the first page, for one first-page input. */
interface Loaded {
	readonly key: string
	/** Pages of the agent's spans, in order. */
	readonly pages: ReadonlyArray<AiSessionSpansPage>
	/** Pages of the app's spans, in order — read once every agent page is in. */
	readonly appPages: ReadonlyArray<AiSessionSpansPage>
	readonly status: "loading" | "complete" | "failed"
	/** Bumped by `retry`, which is what restarts the loader after a failure. */
	readonly attempt: number
}

// Shared empties, so the derived `loaded` below keeps its identities across
// renders while nothing has been fetched under the key — every memo downstream
// of `spans` is keyed on them.
const NO_PAGES: ReadonlyArray<AiSessionSpansPage> = []

const nothingLoaded = (key: string): Loaded => ({
	key,
	pages: NO_PAGES,
	appPages: NO_PAGES,
	status: "loading",
	attempt: 0,
})

/**
 * A session's spans, all of them, loaded in the order the reader needs them.
 *
 * The first page is the session's opening, every span of it — a session that
 * fits is complete after one read, which is the common case. A session that
 * does not fit is drained in the background from the moment the first page
 * lands, without anything being asked of the reader: first every page of the
 * AGENT's spans, which are what the transcript and the findings are built from
 * and a fraction of a large session's rows (in production a tenth, the rest
 * being the app's own SQL and HTTP), then every page of the app's spans behind
 * them. Each view renders what is in hand and grows as pages arrive; the
 * page's one progress indicator is the only sign anything is happening.
 *
 * Both phases continue from the first page's cursor: the cursor is a keyset
 * position in the session's one span order, and a scope only filters rows, so
 * `after` the first page's last span skips exactly the spans that page already
 * carried — of either kind.
 *
 * Pages after the first live in component state rather than in atoms: they
 * are appended to one growing list keyed by the first page's input, the way
 * the list page's `useInfiniteAiSessions` does it. A window or session change
 * drops them, because they belong to the read they extended — the key on the
 * state is what says which read that was, and a response landing after the
 * key moved on is discarded.
 */
export function useSessionSpans(
	sessionId: string,
	window: SessionWindow | undefined,
	reads: SessionSpansReads = warehouseReads,
): SessionSpansState {
	const input = React.useMemo(() => ({ sessionId, ...window }), [sessionId, window])
	const key = JSON.stringify(input)
	const firstPage = useAtomValue(reads.firstPageAtom(input))

	const [stored, setStored] = React.useState<Loaded>(() => nothingLoaded(key))
	// Derived on render rather than reset in an effect: a stale entry is simply
	// not this key's, and the first write under the new key replaces it.
	const loaded = stored.key === key ? stored : nothingLoaded(key)
	// A change for a key that is no longer current is dropped: it belongs to a
	// read the page moved on from, and writing it would wipe the current key's.
	const update = React.useCallback(
		(forKey: string, change: (previous: Loaded) => Loaded) =>
			setStored((previous) => {
				const current = previous.key === forKey ? previous : key === forKey ? nothingLoaded(forKey) : undefined
				return current === undefined ? previous : change(current)
			}),
		[key],
	)

	const firstCursor = Result.isSuccess(firstPage) ? firstPage.value.nextCursor : undefined

	// The loader reads where to resume from at start rather than from its
	// closure: a retry after a failure continues from the pages in hand, and
	// those are in state, not in the effect's dependencies.
	const loadedRef = React.useRef(loaded)
	loadedRef.current = loaded

	React.useEffect(() => {
		if (firstCursor === undefined) return
		const resumeFrom = loadedRef.current.key === key ? loadedRef.current : nothingLoaded(key)
		if (resumeFrom.status === "complete") return
		let cancelled = false
		const append = (scope: AiSessionSpanScope, page: AiSessionSpansPage) =>
			update(key, (previous) =>
				scope === "ai"
					? { ...previous, pages: [...previous.pages, page] }
					: { ...previous, appPages: [...previous.appPages, page] },
			)
		const setStatus = (status: Loaded["status"]) => update(key, (previous) => ({ ...previous, status }))

		/** Fetches pages of one scope from `cursor` until the read ends. False if it stopped short. */
		const drain = async (scope: AiSessionSpanScope, from: AiSessionSpanCursor | undefined): Promise<boolean> => {
			let cursor: AiSessionSpanCursor | undefined = from
			let limit = PAGE_SIZE
			while (cursor !== undefined) {
				if (cancelled) return false
				let page: AiSessionSpansPage
				try {
					page = await reads.fetchPage({ ...input, scope, after: cursor, limit })
				} catch (error: unknown) {
					// The byte cap, not the row cap, ended the page: the same read
					// with fewer rows is the fix the 413 asks for.
					if (displayError(error)._tag === SESSION_TOO_LARGE_TAG && limit > MIN_PAGE_SIZE) {
						limit = Math.max(MIN_PAGE_SIZE, Math.floor(limit / 2))
						continue
					}
					logClientError("ai_session.pagination_failed", error)
					if (!cancelled) setStatus("failed")
					return false
				}
				if (cancelled) return false
				append(scope, page)
				cursor = page.nextCursor
			}
			return true
		}

		const lastCursor = (pages: ReadonlyArray<AiSessionSpansPage>) => pages[pages.length - 1]?.nextCursor
		void (async () => {
			if (resumeFrom.status === "failed") setStatus("loading")
			const agentDone =
				resumeFrom.pages.length > 0 && lastCursor(resumeFrom.pages) === undefined
					? true
					: await drain("ai", lastCursor(resumeFrom.pages) ?? firstCursor)
			if (!agentDone) return
			const appDone = await drain(
				"app",
				resumeFrom.appPages.length > 0 ? lastCursor(resumeFrom.appPages) : firstCursor,
			)
			if (appDone && !cancelled) setStatus("complete")
		})()

		return () => {
			cancelled = true
		}
		// `loaded.attempt` is the retry signal; the pages themselves are read
		// from the ref at start and must not restart the loop as they arrive.
	}, [reads, input, key, firstCursor, loaded.attempt, update])

	const spans = React.useMemo(() => {
		const first = Result.isSuccess(firstPage) ? firstPage.value.data : []
		return dedupeInOrder([
			...first,
			...loaded.pages.flatMap((page) => page.data),
			...loaded.appPages.flatMap((page) => page.data),
		])
	}, [firstPage, loaded.pages, loaded.appPages])

	const retry = React.useCallback(
		() => update(key, (previous) => (previous.status === "failed" ? { ...previous, attempt: previous.attempt + 1 } : previous)),
		[key, update],
	)

	const progress = React.useMemo<SessionLoadProgress | undefined>(() => {
		if (firstCursor === undefined) return undefined
		const agentDone = loaded.pages.length > 0 && loaded.pages[loaded.pages.length - 1]!.nextCursor === undefined
		const phase: SessionLoadProgress["phase"] =
			loaded.status === "failed"
				? "failed"
				: loaded.status === "complete"
					? "complete"
					: agentDone
						? "app"
						: "agent"
		let loadedAgentSpans = 0
		for (const span of spans) if (span.isAiSpan) loadedAgentSpans += 1
		return { phase, agentSpansComplete: agentDone, loadedSpans: spans.length, loadedAgentSpans, retry }
	}, [firstCursor, loaded.status, loaded.pages, spans, retry])

	return { firstPage, spans, progress }
}

/**
 * The scopes never overlap and the cursor skips the first page, so no span
 * should arrive twice — but a session whose spans share a timestamp AND id
 * across traces would, and one copy is the honest render. First occurrence
 * wins, and the session's order — the page order — is kept, since every
 * consumer sorts by start time anyway.
 */
function dedupeInOrder(spans: readonly AiSessionSpan[]): readonly AiSessionSpan[] {
	const seen = new Set<string>()
	const kept: AiSessionSpan[] = []
	for (const span of spans) {
		if (seen.has(span.spanId)) continue
		seen.add(span.spanId)
		kept.push(span)
	}
	return kept
}
