// Why a product-event count is empty when the events exist: they lack the identity counted by
// (a billing webhook's event carries the account and no user). The tools that count by a key read
// the events' identity coverage when they come back empty, and say which key would work.
import { Effect, Option, Array as Arr, String as Str } from "effect"
import { parseWarehouseDateTime, warehouseDateTime } from "@maple/query-engine"
import type { FunnelKeyBy, FunnelStep } from "@maple/query-model"
import {
	productEventsFunnelCoverage,
	type ProductEventsFunnelCoverageOutput,
} from "@maple/query-engine/observability"
import { orFallback } from "./fallback"
import { formatNumber } from "./format"
import { withTenantExecutor } from "./query-warehouse"
import { SESSION_RETENTION_HOURS } from "./time"

/** The identity a key reads off an event, as a notice names it. */
const KEY_BY_IDENTITY = {
	person: "a user id or a visitor id",
	visitor: "a visitor id",
	user: "a user id",
	group: "a group id",
	session: "a session id",
} satisfies Record<FunnelKeyBy, string>

/** How many of a step's events carry the identity `keyBy` counts by. */
const carried = (row: ProductEventsFunnelCoverageOutput, keyBy: FunnelKeyBy): number => {
	switch (keyBy) {
		case "person":
			return row.withPerson
		case "visitor":
			return row.withVisitor
		case "user":
			return row.withUser
		case "group":
			return row.withGroup
		case "session":
			return row.withSession
	}
}

/** Keys to suggest, most useful first: the default, then the one that follows account-level events. */
const KEY_BY_PREFERENCE: ReadonlyArray<FunnelKeyBy> = ["person", "group", "user", "visitor", "session"]

export interface IdentityNote<K extends FunnelKeyBy = FunnelKeyBy> {
	readonly note: string
	/** The key every event read does carry, when there is one. */
	readonly keyBy?: K
}

/**
 * One sentence per event that cannot be counted by `keyBy`, then the key all of them do carry.
 * `subjects[i]` names row `i + 1` in the note: `Step 2 (plan_started)` for a funnel, the event
 * alone for a tool that reads one. `candidates` are the keys the tool can count by.
 */
export const identityNoteFor = <K extends FunnelKeyBy>(
	coverage: ReadonlyArray<ProductEventsFunnelCoverageOutput>,
	keyBy: K,
	subjects: ReadonlyArray<string>,
	candidates: ReadonlyArray<K>,
): IdentityNote<K> | undefined => {
	// A session step matches no event row; it says nothing about the events' identity.
	const matched = Arr.filter(coverage, (row) => row.events > 0)
	const uncounted = Arr.filter(matched, (row) => carried(row, keyBy) === 0)
	if (uncounted.length === 0) return undefined
	const fitting = Arr.findFirst(
		Arr.filter(KEY_BY_PREFERENCE, (candidate): candidate is K => Arr.contains(candidates, candidate)),
		(candidate) => candidate !== keyBy && Arr.every(matched, (row) => carried(row, candidate) > 0),
	)
	const these = matched.length > 1 ? "Every step's events carry" : "Those events carry"
	const note = Arr.join(
		[
			...Arr.map(
				uncounted,
				(row) =>
					`${subjects[row.step - 1] ?? "It"} matched ${formatNumber(row.events)} ${row.events === 1 ? "event" : "events"}, but none carries ${KEY_BY_IDENTITY[keyBy]}, so it cannot be counted by ${keyBy}: the 0 is missing identity, not something nobody did.`,
			),
			Option.match(fitting, {
				onNone: () =>
					"No single key is on all of these events; send the same user id or group id with each of them.",
				onSome: (candidate) =>
					`${these} ${KEY_BY_IDENTITY[candidate]}: run it again with key_by="${candidate}".`,
			}),
		],
		" ",
	)
	return Option.match(fitting, {
		onNone: () => ({ note }),
		onSome: (candidate) => ({ note, keyBy: candidate }),
	})
}

/** `Sessions are kept 30 days` once a window that reads them starts before that. */
export const sessionRetentionNote = (
	startTime: string,
	nowMs: number,
	readsSessions: boolean,
): string | undefined => {
	const kept = nowMs - SESSION_RETENTION_HOURS * 3_600_000
	return readsSessions && parseWarehouseDateTime(startTime) < kept
		? `Sessions are kept 30 days: session steps, filters and dimensions see nothing before ${warehouseDateTime(kept)}, so the earlier part of this window reads as having none.`
		: undefined
}

/** A step with no event name or page path matches nothing a caller meant. */
export const isBlankStep = (step: Extract<FunnelStep, { kind: "event" | "page" }>): boolean =>
	Str.trim(step.kind === "event" ? step.eventName : step.pagePath) === ""

/**
 * The note for tools that count one event: read its coverage and say whether `keyBy` can count
 * it. A failed read is no note, never a failed tool.
 */
export const eventIdentityNote = <K extends FunnelKeyBy>(input: {
	readonly step: Extract<FunnelStep, { kind: "event" | "page" }>
	readonly label: string
	readonly keyBy: K
	readonly candidates: ReadonlyArray<K>
	readonly startTime: string
	readonly endTime: string
}) =>
	withTenantExecutor(
		productEventsFunnelCoverage({
			steps: [input.step],
			keyBy: input.keyBy,
			windowSeconds: 86_400,
			startTime: input.startTime,
			endTime: input.endTime,
		}),
	).pipe(
		Effect.map((coverage) => identityNoteFor(coverage, input.keyBy, [input.label], input.candidates)),
		orFallback("event identity coverage", () => undefined),
	)
