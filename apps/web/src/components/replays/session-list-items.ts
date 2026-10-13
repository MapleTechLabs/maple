import type { SessionTag } from "@maple/domain/query-engine"
import { isSessionLive } from "./replay-format"
import { SESSION_TAG_LABELS, noiseTierOf } from "./session-tags"

interface ListableSession {
	readonly sessionId: string
	readonly status: string
	readonly startTime: string
	readonly lastActivityAt: string | null
	readonly errorCount: number
	readonly tags: ReadonlyArray<SessionTag>
}

export type SessionListItem<S extends ListableSession> =
	| { readonly kind: "session"; readonly session: S; readonly lowSignal: boolean }
	| {
			readonly kind: "quiet"
			/** The run's first session id: stable while later pages extend the run. */
			readonly key: string
			readonly count: number
			readonly summary: string
			/** Sessions per tier in the run, most common first. */
			readonly tiers: ReadonlyArray<{ readonly tag: SessionTag; readonly count: number }>
			readonly expanded: boolean
	  }

/**
 * A session you can skip: a noise tier with no errors that is not happening right
 * now. An errored bot or a live bounce still gets its own row.
 */
export const isLowSignal = (session: ListableSession, nowMs: number): boolean =>
	noiseTierOf(session.tags) !== undefined && session.errorCount === 0 && !isSessionLive(session, nowMs)

const tiersOf = (sessions: ReadonlyArray<ListableSession>) => {
	const counts = new Map<SessionTag, number>()
	for (const session of sessions) {
		const tier = noiseTierOf(session.tags)
		if (tier !== undefined) counts.set(tier, (counts.get(tier) ?? 0) + 1)
	}
	return [...counts].sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count }))
}

const summarize = (tiers: ReadonlyArray<{ readonly tag: SessionTag; readonly count: number }>) =>
	tiers
		.map(({ tag, count }) => `${count} ${SESSION_TAG_LABELS[tag].toLowerCase()}${count === 1 ? "" : "s"}`)
		.join(" · ")

/**
 * The rows the list renders. With `collapse`, each run of two or more adjacent
 * low-signal sessions folds into one summary row, followed by its sessions when
 * the run's key is in `expanded`. A lone one stays a (dimmed) row of its own.
 */
export function sessionListItems<S extends ListableSession>(
	sessions: ReadonlyArray<S>,
	options: { readonly collapse: boolean; readonly expanded: ReadonlySet<string>; readonly nowMs: number },
): Array<SessionListItem<S>> {
	const items: Array<SessionListItem<S>> = []
	let run: Array<S> = []

	const flush = () => {
		if (run.length === 1) items.push({ kind: "session", session: run[0]!, lowSignal: true })
		if (run.length > 1) {
			const key = run[0]!.sessionId
			const expanded = options.expanded.has(key)
			const tiers = tiersOf(run)
			items.push({ kind: "quiet", key, count: run.length, summary: summarize(tiers), tiers, expanded })
			if (expanded) for (const session of run) items.push({ kind: "session", session, lowSignal: true })
		}
		run = []
	}

	for (const session of sessions) {
		const lowSignal = isLowSignal(session, options.nowMs)
		if (options.collapse && lowSignal) {
			run.push(session)
			continue
		}
		flush()
		items.push({ kind: "session", session, lowSignal })
	}
	flush()
	return items
}
