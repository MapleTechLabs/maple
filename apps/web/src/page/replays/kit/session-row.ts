import { SessionTag } from "@maple/domain/query-engine"
import { isSessionLive } from "@maple/ui/lib/replay-format"
import { noiseTierOf, SESSION_TAG_LABELS } from "../../../components/replays/session-tags"
import { Schema } from "effect"

/** A session list row, the list's view of `replayListItemFromV2`. */
export const SessionRow = Schema.Struct({
	sessionId: Schema.String,
	startTime: Schema.String,
	durationMs: Schema.NullOr(Schema.Number),
	status: Schema.String,
	lastActivityAt: Schema.NullOr(Schema.String),
	userId: Schema.NullOr(Schema.String),
	userName: Schema.String,
	userEmail: Schema.String,
	groupId: Schema.String,
	groupName: Schema.String,
	urlInitial: Schema.String,
	browserName: Schema.String,
	osName: Schema.String,
	deviceType: Schema.String,
	country: Schema.String,
	serviceName: Schema.String,
	pageViews: Schema.Number,
	clickCount: Schema.Number,
	errorCount: Schema.Number,
	traceCount: Schema.Number,
	recorded: Schema.String,
	tags: Schema.Array(SessionTag),
})
export type SessionRow = typeof SessionRow.Type

export type SessionListItem =
	| { readonly kind: "session"; readonly session: SessionRow; readonly lowSignal: boolean }
	| {
			readonly kind: "quiet"
			readonly key: string
			readonly count: number
			readonly summary: string
			readonly tiers: ReadonlyArray<{ readonly tag: SessionTag; readonly count: number }>
			readonly expanded: boolean
	  }

// A finished session with no errors, tagged as noise.
export const isLowSignal = (session: SessionRow, nowMs: number): boolean =>
	noiseTierOf(session.tags) !== undefined && session.errorCount === 0 && !isSessionLive(session, nowMs)

const tiersOf = (sessions: ReadonlyArray<SessionRow>) => {
	const counts = new Map<SessionTag, number>()
	sessions.forEach((session) => {
		const tier = noiseTierOf(session.tags)
		if (tier !== undefined) counts.set(tier, (counts.get(tier) ?? 0) + 1)
	})
	return [...counts].sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count }))
}

const summarize = (tiers: ReadonlyArray<{ readonly tag: SessionTag; readonly count: number }>) =>
	tiers
		.map(({ tag, count }) => `${count} ${SESSION_TAG_LABELS[tag].toLowerCase()}${count === 1 ? "" : "s"}`)
		.join(" · ")

const runItems = (
	run: ReadonlyArray<SessionRow>,
	expanded: ReadonlyArray<string>,
): ReadonlyArray<SessionListItem> => {
	const [first] = run
	if (first === undefined) return []
	if (run.length === 1) return [{ kind: "session", session: first, lowSignal: true }]
	const isExpanded = expanded.includes(first.sessionId)
	const tiers = tiersOf(run)
	return [
		{
			kind: "quiet",
			key: first.sessionId,
			count: run.length,
			summary: summarize(tiers),
			tiers,
			expanded: isExpanded,
		},
		...(isExpanded
			? run.map((session): SessionListItem => ({ kind: "session", session, lowSignal: true }))
			: []),
	]
}

/** `sessionListItems`: runs of two or more adjacent low-signal sessions fold into one row. */
export const sessionListItems = (
	sessions: ReadonlyArray<SessionRow>,
	options: { readonly collapse: boolean; readonly expanded: ReadonlyArray<string>; readonly nowMs: number },
): ReadonlyArray<SessionListItem> => {
	const folded = sessions.reduce<{ items: ReadonlyArray<SessionListItem>; run: ReadonlyArray<SessionRow> }>(
		(state, session) => {
			const lowSignal = isLowSignal(session, options.nowMs)
			if (options.collapse && lowSignal) return { items: state.items, run: [...state.run, session] }
			return {
				items: [
					...state.items,
					...runItems(state.run, options.expanded),
					{ kind: "session", session, lowSignal },
				],
				run: [],
			}
		},
		{ items: [], run: [] },
	)
	return [...folded.items, ...runItems(folded.run, options.expanded)]
}
