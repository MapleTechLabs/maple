import {
	alertSilenceMatches,
	type AlertRuleDocument,
	type AlertSilenceId,
	type AlertSilenceMatchers,
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

/** The org's silences, latest ending first (one page; an org holds at most 200 open ones). */
export const listSilences = Effect.gen(function* () {
	const client = yield* MapleApiV2Client
	const response = yield* client.alertSilences.list({ query: { limit: 100 } })
	return response.data
}).pipe(Effect.mapError(toLoadFailure))

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

const byEnd = Order.mapInput(Order.Number, endsAtMs)

/** The silence in force over a rule (and one incident group of it) at `nowMs`; the soonest-ending wins. */
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
			byEnd,
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

/** The matchers that silence one rule, or just one service group of a rule grouped by service. */
export const matchersForRule = (
	rule: Pick<AlertRuleDocument, "id" | "groupBy">,
	groupKey: string | null,
): V2AlertSilenceMatchers =>
	groupKey !== null &&
	rule.groupBy !== null &&
	rule.groupBy.length === 1 &&
	rule.groupBy[0] === "service.name"
		? { rule_ids: [rule.id], services: [groupKey] }
		: { rule_ids: [rule.id] }
