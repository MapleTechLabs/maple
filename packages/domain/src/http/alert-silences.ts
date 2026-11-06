import { Array as Arr, Schema } from "effect"
import { AlertRuleId, AlertSilenceId, IsoDateTimeString, UserId } from "../primitives"
import { HttpTaggedError } from "./error-policy"
import { UNGROUPED_GROUP_KEY, type AlertGroupBy } from "./alerts"

/** Longest a silence may run, so a forgotten one cannot mute a rule for good. */
export const MAX_ALERT_SILENCE_DURATION_MS = 30 * 24 * 60 * 60_000
export const MAX_ALERT_SILENCE_MATCHER_VALUES = 50
export const MAX_ALERT_SILENCE_REASON_LENGTH = 500

const MatcherValue = Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed(), Schema.isMaxLength(200))
const matcherList = <S extends Schema.Top>(item: S) =>
	Schema.optionalKey(Schema.Array(item).check(Schema.isMaxLength(MAX_ALERT_SILENCE_MATCHER_VALUES)))

/**
 * Which rules a silence quiets. Fields AND together, values inside a field OR.
 * Services and environments match only when they cover the rule's whole scope
 * (or the incident's group), so a silence on one service never hides another.
 */
export const AlertSilenceMatchers = Schema.Struct({
	ruleIds: matcherList(AlertRuleId),
	tags: matcherList(MatcherValue),
	services: matcherList(MatcherValue),
	environments: matcherList(MatcherValue),
})
	.check(
		Schema.makeFilter(
			(matchers) =>
				(matchers.ruleIds?.length ?? 0) +
					(matchers.tags?.length ?? 0) +
					(matchers.services?.length ?? 0) +
					(matchers.environments?.length ?? 0) >
					0 || "A silence needs at least one rule, tag, service or environment",
		),
	)
	.annotate({ identifier: "@maple/AlertSilenceMatchers", title: "Alert Silence Matchers" })
export type AlertSilenceMatchers = Schema.Schema.Type<typeof AlertSilenceMatchers>

export const AlertSilenceStatus = Schema.Literals(["scheduled", "active", "ended"]).annotate({
	identifier: "@maple/AlertSilenceStatus",
	title: "Alert Silence Status",
})
export type AlertSilenceStatus = Schema.Schema.Type<typeof AlertSilenceStatus>

export const AlertSilenceReason = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isTrimmed(),
	Schema.isMaxLength(MAX_ALERT_SILENCE_REASON_LENGTH),
)

export class AlertSilenceDocument extends Schema.Class<AlertSilenceDocument>("AlertSilenceDocument")({
	id: AlertSilenceId,
	reason: Schema.String,
	matchers: AlertSilenceMatchers,
	status: AlertSilenceStatus,
	startsAt: IsoDateTimeString,
	endsAt: IsoDateTimeString,
	createdBy: UserId,
	createdAt: IsoDateTimeString,
	updatedAt: IsoDateTimeString,
}) {}

export class AlertSilencesListResponse extends Schema.Class<AlertSilencesListResponse>(
	"AlertSilencesListResponse",
)({
	silences: Schema.Array(AlertSilenceDocument),
}) {}

/** A new silence. `startsAt` defaults to now. */
export class AlertSilenceCreateRequest extends Schema.Class<AlertSilenceCreateRequest>(
	"AlertSilenceCreateRequest",
)({
	reason: AlertSilenceReason,
	matchers: AlertSilenceMatchers,
	startsAt: Schema.optionalKey(IsoDateTimeString),
	endsAt: IsoDateTimeString,
}) {}

export class AlertSilenceUpdateRequest extends Schema.Class<AlertSilenceUpdateRequest>(
	"AlertSilenceUpdateRequest",
)({
	reason: Schema.optionalKey(AlertSilenceReason),
	matchers: Schema.optionalKey(AlertSilenceMatchers),
	startsAt: Schema.optionalKey(IsoDateTimeString),
	endsAt: Schema.optionalKey(IsoDateTimeString),
}) {}

export class AlertSilenceNotFoundError extends HttpTaggedError<AlertSilenceNotFoundError>()(
	"@maple/http/errors/AlertSilenceNotFoundError",
	{ message: Schema.String, silenceId: AlertSilenceId },
	{
		status: 404,
		code: "alert_silence_not_found",
		title: "Alert silence not found",
		message: "No such alert silence.",
		param: "id",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}

export const alertSilenceStatusAt = (
	window: { readonly startsAtMs: number; readonly endsAtMs: number },
	nowMs: number,
): AlertSilenceStatus =>
	nowMs < window.startsAtMs ? "scheduled" : nowMs < window.endsAtMs ? "active" : "ended"

/** The parts of a rule and incident group a silence is matched against. */
export interface AlertSilenceTarget {
	readonly ruleId: AlertRuleId
	readonly tags: ReadonlyArray<string>
	readonly serviceNames: ReadonlyArray<string>
	readonly environments: ReadonlyArray<string>
	readonly groupBy: AlertGroupBy | null
	/** The incident's group; null or `__total__` for an ungrouped rule. */
	readonly groupKey: string | null
}

const groupedBy = (target: AlertSilenceTarget, dimension: string): string | null =>
	target.groupKey !== null &&
	target.groupKey !== UNGROUPED_GROUP_KEY &&
	target.groupBy !== null &&
	target.groupBy.length === 1 &&
	target.groupBy[0] === dimension
		? target.groupKey
		: null

/**
 * The services an incident covers: its group when the rule groups by service
 * (or keys a multi-service rule by service), else the rule's scope. Empty means
 * every service, which no service list covers.
 */
const scopedServices = (target: AlertSilenceTarget): ReadonlyArray<string> => {
	const group = groupedBy(target, "service.name")
	if (group !== null) return [group]
	if (
		target.groupKey !== null &&
		target.groupKey !== UNGROUPED_GROUP_KEY &&
		target.serviceNames.includes(target.groupKey)
	)
		return [target.groupKey]
	return target.serviceNames
}

const scopedEnvironments = (target: AlertSilenceTarget): ReadonlyArray<string> => {
	const group = groupedBy(target, "deployment.environment")
	return group !== null ? [group] : target.environments
}

const covers = (silenced: ReadonlyArray<string> | undefined, scope: ReadonlyArray<string>): boolean =>
	silenced === undefined ||
	silenced.length === 0 ||
	(scope.length > 0 && Arr.every(scope, (value) => silenced.includes(value)))

export const alertSilenceMatches = (matchers: AlertSilenceMatchers, target: AlertSilenceTarget): boolean =>
	(matchers.ruleIds === undefined ||
		matchers.ruleIds.length === 0 ||
		matchers.ruleIds.includes(target.ruleId)) &&
	(matchers.tags === undefined ||
		matchers.tags.length === 0 ||
		Arr.some(target.tags, (tag) => matchers.tags?.includes(tag) === true)) &&
	covers(matchers.services, scopedServices(target)) &&
	covers(matchers.environments, scopedEnvironments(target))
