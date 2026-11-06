import {
	alertSilenceMatches,
	type AlertRuleDocument,
	type AlertSilenceId,
	type AlertSilenceMatchers,
	UNGROUPED_GROUP_KEY,
} from "@maple/domain/http"
import type {
	V2AlertSilence,
	V2AlertSilenceCreateParams,
	V2AlertSilenceMatchers,
} from "@maple/domain/http/v2"
import { Effect, Option, Order, Array as Arr } from "effect"
import { formatDateInTimezone, formatTimeInTimezone } from "@maple/web-data/lib/timezone-format"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { isoMs } from "./time"

// Alert silences: the reads and writes the hub, rule and incident pages share, and how a page
// tells which silence covers a rule or an incident.

const listByStatus = (status?: V2AlertSilence["status"]) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		const response = yield* client.alertSilences.list({
			query: status === undefined ? { limit: 100 } : { status, limit: 100 },
		})
		return response.data
	})

/** The hub's list: active and scheduled in full, plus the most recently ended. */
export const listSilences = Effect.all(
	[listByStatus("active"), listByStatus("scheduled"), listByStatus("ended")],
	{ concurrency: "unbounded" },
).pipe(
	Effect.mapBoth({
		onSuccess: ([active, scheduled, ended]) => [...active, ...scheduled, ...ended],
		onFailure: toLoadFailure,
	}),
)

/** What a rule or incident page needs for its badge: only the silences in force. */
export const listActiveSilences = listByStatus("active").pipe(Effect.mapError(toLoadFailure))

export const createSilence = (payload: V2AlertSilenceCreateParams) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.alertSilences.create({ payload })
	}).pipe(Effect.mapError(toLoadFailure))

export const endSilence = (id: AlertSilenceId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.alertSilences.end({ params: { id } })
	}).pipe(Effect.mapError(toLoadFailure))

export const startsAtMs = (silence: V2AlertSilence): number => isoMs(silence.starts_at)
export const endsAtMs = (silence: V2AlertSilence): number => isoMs(silence.ends_at)

/** "15:00" today, "Nov 7, 09:00" on another day, in the viewer's zone. */
export const formatSilenceTime = (ms: number, nowMs: number, timeZone: string): string => {
	const time = formatTimeInTimezone(ms, { timeZone, withSeconds: false })
	return formatDateInTimezone(ms, { timeZone }) === formatDateInTimezone(nowMs, { timeZone })
		? time
		: `${formatDateInTimezone(ms, { timeZone, withYear: false })}, ${time}`
}

/** Where a silence stands at `nowMs`, from its window rather than the status it was read with. */
export const silenceStatusAt = (silence: V2AlertSilence, nowMs: number): V2AlertSilence["status"] =>
	nowMs < startsAtMs(silence) ? "scheduled" : nowMs < endsAtMs(silence) ? "active" : "ended"

const toDomainMatchers = (matchers: V2AlertSilenceMatchers): AlertSilenceMatchers => ({
	...(matchers.rule_ids === undefined ? undefined : { ruleIds: matchers.rule_ids }),
	...(matchers.tags === undefined ? undefined : { tags: matchers.tags }),
	...(matchers.services === undefined ? undefined : { services: matchers.services }),
	...(matchers.environments === undefined ? undefined : { environments: matchers.environments }),
})

const byLatestEnd = Order.flip(Order.mapInput(Order.Number, endsAtMs))

/**
 * The silence in force over a rule (and one incident group of it) at `nowMs`. The latest-ending
 * one wins: notifications resume only when every matching silence has ended.
 */
export const activeSilenceFor = (
	silences: ReadonlyArray<V2AlertSilence>,
	rule: Pick<AlertRuleDocument, "id" | "tags" | "serviceNames" | "environments" | "groupBy">,
	groupKey: string | null,
	nowMs: number,
): Option.Option<V2AlertSilence> =>
	Arr.head(
		Arr.sort(
			Arr.filter(
				silences,
				(silence) =>
					silenceStatusAt(silence, nowMs) === "active" &&
					alertSilenceMatches(toDomainMatchers(silence.matchers), {
						ruleId: rule.id,
						tags: rule.tags,
						serviceNames: rule.serviceNames,
						environments: rule.environments,
						groupBy: rule.groupBy,
						groupKey,
					}),
			),
			byLatestEnd,
		),
	)

/** "service checkout · tag db": what a silence covers, for a list row. Rule ids read as their names. */
export const silenceScopeParts = (
	matchers: V2AlertSilenceMatchers,
	ruleName: (id: string) => string,
): ReadonlyArray<string> => [
	...Arr.map(matchers.rule_ids ?? [], (id) => `rule ${ruleName(id)}`),
	...Arr.map(matchers.services ?? [], (service) => `service ${service}`),
	...Arr.map(matchers.environments ?? [], (environment) => `env ${environment}`),
	...Arr.map(matchers.tags ?? [], (tag) => `tag ${tag}`),
]

const groupedBy = (rule: Pick<AlertRuleDocument, "groupBy">, dimension: string): boolean =>
	rule.groupBy !== null && rule.groupBy.length === 1 && rule.groupBy[0] === dimension

/**
 * The matchers that silence one rule, or just one incident group of it: a service group (grouped
 * by service, or a multi-service rule keyed by service) or an environment group, as the server reads them.
 */
export const matchersForRule = (
	rule: Pick<AlertRuleDocument, "id" | "groupBy" | "serviceNames">,
	groupKey: string | null,
): V2AlertSilenceMatchers => {
	if (groupKey === null || groupKey === UNGROUPED_GROUP_KEY) return { rule_ids: [rule.id] }
	if (groupedBy(rule, "service.name") || rule.serviceNames.includes(groupKey))
		return { rule_ids: [rule.id], services: [groupKey] }
	if (groupedBy(rule, "deployment.environment")) return { rule_ids: [rule.id], environments: [groupKey] }
	return { rule_ids: [rule.id] }
}
