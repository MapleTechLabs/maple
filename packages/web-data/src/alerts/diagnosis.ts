import type {
	AlertCheckDocument,
	AlertDeliveryEventDocument,
	AlertDestinationDocument,
	AlertIncidentDocument,
	AlertRuleDocument,
} from "@maple/domain/http"
import {
	alertQueryLimits,
	alertRuleIntervalMinutes,
	nextSlowerAlertInterval,
} from "@maple/query-engine/datetime"
import { ALERT_EVALUATION_INTERVALS, AlertEvaluationErrorKind } from "@maple/domain/http"
import { Option, Schema, Array as Arr, String as Str } from "effect"
import { formatRelativeFrom } from "@maple/ui/lib/time-format"
import { countLabel } from "@maple/ui/lib/format"
import type { AlertRuleStateRow } from "../collections/alerts"
import { comparatorLabels, formatSignalValue } from "./form-utils"
import { staleThresholdMs } from "./rule-status"
import { formatTimestampInTimezone } from "../lib/timezone-format"

const evaluationCadence = (rule: AlertRuleDocument): string => {
	const minutes = alertRuleIntervalMinutes(rule)
	return minutes === 1 ? "every minute" : `every ${minutes} minutes`
}

const decodeErrorKind = Schema.decodeUnknownOption(AlertEvaluationErrorKind)

/**
 * The interval a slowed rule ran at just before its latest slowdown: the step the scheduler
 * took to reach the slowed interval, from the rule's own interval or an earlier slowdown.
 * The limit the failures hit picks the step; when two steps could, the one slowdown is likelier.
 */
export const intervalBeforeSlowdown = (
	rule: AlertRuleDocument,
	kind: AlertEvaluationErrorKind | null = rule.lastEvaluationErrorKind,
): number => {
	const base = alertRuleIntervalMinutes({
		windowMinutes: rule.windowMinutes,
		evaluationIntervalMinutes: rule.evaluationIntervalMinutes,
		slowedIntervalMinutes: null,
	})
	const slowed = rule.slowedIntervalMinutes
	if (slowed === null) return base
	const exceeded: ReadonlyArray<"time" | "memory"> =
		kind === "query_too_slow"
			? ["time"]
			: kind === "query_too_much_memory"
				? ["memory"]
				: ["time", "memory"]
	const steps = [
		base,
		...Arr.filter(ALERT_EVALUATION_INTERVALS, (minutes) => minutes > base && minutes < slowed),
	]
	return Option.getOrElse(
		Arr.findFirst(steps, (from) =>
			Arr.some(
				exceeded,
				(limit) => nextSlowerAlertInterval(from, rule.windowMinutes, limit) === slowed,
			),
		),
		() => base,
	)
}

/** What a failing query's kind means for its author, in plain words. */
const formatMemory = (bytes: number): string =>
	bytes >= 1_000_000_000 ? `${bytes / 1_000_000_000} GB` : `${bytes / 1_000_000} MB`

const queryFailureCause = (
	kind: AlertEvaluationErrorKind | null,
	isRawSql: boolean,
	intervalMinutes: number,
	limitSeconds: number,
): { readonly summary: string; readonly evidence: ReadonlyArray<string> } => {
	const every = intervalMinutes === 1 ? "every minute" : `every ${intervalMinutes} min`
	if (kind === "query_too_slow" && !isRawSql) {
		return { summary: "The rule's query is timing out", evidence: [] }
	}
	if (kind === "query_too_slow") {
		return {
			summary: `The query takes longer than the ${limitSeconds} s a check allows`,
			evidence: [
				`Checked ${every}, which allows ${limitSeconds} s per check. Rules checked every 5 min get 15 s, every 10 min or more 25 s.`,
				"Narrow the query (a service filter, a structured attribute instead of a Body match) or check less often.",
			],
		}
	}
	if (kind === "query_too_much_memory") {
		return {
			summary: "The query needs more memory than a check allows",
			evidence: [
				`Checked ${every}, which allows ${formatMemory(alertQueryLimits(intervalMinutes).memoryBytes)} per check. Rules checked every 5 or 10 min get 512 MB, every 15 min or more 1 GB.`,
				"Narrow the query or group by fewer values.",
			],
		}
	}
	if (kind === "invalid_query") {
		return { summary: "The rule's query is invalid", evidence: [] }
	}
	return { summary: "The rule's query is failing", evidence: [] }
}

export type DiagnosisStageStatus = "pass" | "fail" | "warn" | "unknown"

export interface DiagnosisStage {
	readonly id: "enabled" | "evaluated" | "query" | "data" | "threshold" | "incident" | "notification"
	readonly label: string
	readonly status: DiagnosisStageStatus
	/** One human sentence — the header verdict uses the first failing stage's summary. */
	readonly summary: string
	/** Supporting detail lines, shown when the stage is expanded. */
	readonly evidence: ReadonlyArray<string>
	readonly action?: { readonly label: string; readonly kind: "enable" | "edit" | "destinations" }
}

export interface DiagnosisInput {
	readonly rule: AlertRuleDocument
	/** Live per-group states; may be empty on non-Electric builds. */
	readonly states: ReadonlyArray<AlertRuleStateRow>
	/** Recorded checks in the page window, newest first (the listRuleChecks order). */
	readonly checks: ReadonlyArray<AlertCheckDocument>
	readonly openIncidents: ReadonlyArray<AlertIncidentDocument>
	/** All org destinations — resolved against rule.destinationIds internally. */
	readonly destinations: ReadonlyArray<AlertDestinationDocument>
	/** Delivery events pre-filtered to this rule, newest first. */
	readonly deliveryEvents: ReadonlyArray<AlertDeliveryEventDocument>
	readonly now: number
	readonly timeZone: string
	/** Grouped rules: diagnose one group; defaults to the worst one. */
	readonly selectedGroupKey?: string
}

const relative = (now: number, thenMs: number): string => formatRelativeFrom(thenMs, now)

const parseMs = (value: string | null | undefined): number | null => {
	if (value == null) return null
	const ms = new Date(value).getTime()
	return Number.isFinite(ms) ? ms : null
}

/**
 * Walk the evaluation pipeline and report where it breaks — the direct answer
 * to "why isn't this alert firing / why is it failing". Stages are ordered the
 * way the scheduler works: enabled → evaluated → query → data → threshold →
 * incident → notification. Pure so it can be unit-tested exhaustively.
 */
export function buildDiagnosis(input: DiagnosisInput): DiagnosisStage[] {
	const { rule, checks, openIncidents, destinations, deliveryEvents, now, timeZone } = input

	// Scope per-group evidence to the selected group (or the whole set when
	// ungrouped / unselected).
	const states =
		input.selectedGroupKey != null
			? Arr.filter(input.states, (s) => s.group_key === input.selectedGroupKey)
			: input.states
	const groupChecks =
		input.selectedGroupKey != null
			? Arr.filter(checks, (c) => c.groupKey === input.selectedGroupKey || c.status === "error")
			: checks

	const stages: DiagnosisStage[] = []

	/* 1 — Enabled */
	stages.push(
		rule.enabled
			? {
					id: "enabled",
					label: "Rule enabled",
					status: "pass",
					summary: "Rule is enabled",
					evidence: [],
				}
			: {
					id: "enabled",
					label: "Rule enabled",
					status: "fail",
					summary: "Rule is disabled — it will never evaluate or fire",
					evidence: [],
					action: { label: "Enable rule", kind: "enable" },
				},
	)

	/* 2 — Evaluated recently */
	const stateEvaluatedAt = Arr.reduce(
		Arr.filter(
			Arr.map(states, (s) => parseMs(s.last_evaluated_at)),
			(ms): ms is number => ms != null,
		),
		null,
		(max: number | null, ms) => (max == null || ms > max ? ms : max),
	)
	const evaluatedAt = stateEvaluatedAt ?? parseMs(rule.lastEvaluatedAt)
	const scheduledAt = parseMs(rule.lastScheduledAt)
	if (evaluatedAt == null && scheduledAt == null) {
		stages.push({
			id: "evaluated",
			label: "Evaluated recently",
			status: rule.enabled ? "fail" : "unknown",
			summary: "Never evaluated — the scheduler has not picked this rule up yet",
			evidence: ["New rules are evaluated within about a minute of being enabled."],
		})
	} else if (evaluatedAt == null && scheduledAt != null) {
		// Scheduled is not evaluated. Presenting the schedule timestamp as "last
		// evaluated" let a worker that claimed the rule and crashed before its
		// first evaluation read as a passing stage — and, with every later stage
		// unknown, as "Rule is healthy".
		stages.push({
			id: "evaluated",
			label: "Evaluated recently",
			status: "warn",
			summary: `Scheduled ${relative(now, scheduledAt)} but no evaluation has completed yet`,
			evidence: [
				`Last scheduled: ${formatTimestampInTimezone(scheduledAt, { timeZone, withYear: true })}`,
			],
		})
	} else if (evaluatedAt != null) {
		const stale = now - evaluatedAt > staleThresholdMs(rule)
		stages.push({
			id: "evaluated",
			label: "Evaluated recently",
			status: stale ? "warn" : "pass",
			summary: stale
				? `Last evaluated ${relative(now, evaluatedAt)}, expected ${evaluationCadence(rule)}`
				: `Last evaluated ${relative(now, evaluatedAt)}`,
			evidence: Arr.filter(
				[
					`Last evaluation: ${formatTimestampInTimezone(evaluatedAt, { timeZone, withYear: true })}`,
					scheduledAt != null
						? `Last scheduled: ${formatTimestampInTimezone(scheduledAt, { timeZone, withYear: true })}`
						: null,
				],
				(line): line is string => line != null,
			),
		})
	}

	/* 3 — Query succeeded */
	const errorState = Arr.findFirst(states, (s) => s.last_error != null)
	const errorMessage = Option.match(errorState, {
		onNone: () => rule.lastEvaluationError,
		onSome: (state) => state.last_error ?? rule.lastEvaluationError,
	})
	// The kind of the same error as the message: the state's own, else the rule document's.
	const errorKind = Option.match(errorState, {
		onNone: () => rule.lastEvaluationErrorKind,
		onSome: (state) => Option.getOrNull(decodeErrorKind(state.last_error_kind)),
	})
	const errorChecks = Arr.filter(checks, (c) => c.status === "error")
	// An error from before a slowdown ran under the interval the rule had then, not the slowed one.
	const errorAt = parseMs(
		Option.match(errorState, {
			onNone: () => rule.lastEvaluatedAt,
			onSome: (state) => state.last_evaluated_at ?? rule.lastEvaluatedAt,
		}),
	)
	const slowedAt = parseMs(rule.slowedAt)
	const isErrorBeforeSlowdown = slowedAt != null && errorAt != null && errorAt <= slowedAt
	const intervalMinutes = isErrorBeforeSlowdown
		? intervalBeforeSlowdown(rule, errorKind)
		: alertRuleIntervalMinutes(rule)
	const limitSeconds = alertQueryLimits(intervalMinutes).timeSeconds
	const slowedLine =
		rule.slowedIntervalMinutes !== null && rule.slowedAt !== null
			? `Slowed to every ${rule.slowedIntervalMinutes} min on ${formatTimestampInTimezone(parseMs(rule.slowedAt) ?? now, { timeZone, withYear: true })} after 3 checks in a row hit their limit. Editing the rule resets this.`
			: null
	if (errorMessage != null) {
		const cause = queryFailureCause(
			errorKind,
			rule.signalType === "raw_query",
			intervalMinutes,
			limitSeconds,
		)
		stages.push({
			id: "query",
			label: "Query succeeded",
			status: "fail",
			summary: cause.summary,
			evidence: [
				...cause.evidence,
				...(slowedLine !== null ? [slowedLine] : []),
				errorMessage,
				...(errorChecks[0]?.errorCategory != null
					? [`Category: ${errorChecks[0].errorCategory}`]
					: []),
				...(evaluatedAt != null ? [`Last attempt ${relative(now, evaluatedAt)}`] : []),
			],
			action: { label: "Edit rule", kind: "edit" },
		})
	} else if (slowedLine !== null) {
		stages.push({
			id: "query",
			label: "Query succeeded",
			status: "warn",
			summary: `Slowed to every ${rule.slowedIntervalMinutes} min because its query kept hitting its limit`,
			evidence: [
				slowedLine,
				"Make the query cheaper, or pick this interval yourself, before you edit the rule.",
			],
			action: { label: "Edit rule", kind: "edit" },
		})
	} else if (errorChecks.length > 0) {
		stages.push({
			id: "query",
			label: "Query succeeded",
			status: "warn",
			summary: `${countLabel(errorChecks.length, "failed evaluation")} in this window (recovered since)`,
			evidence: errorChecks[0]?.errorMessage != null ? [errorChecks[0].errorMessage] : [],
		})
	} else {
		stages.push({
			id: "query",
			label: "Query succeeded",
			status: evaluatedAt != null ? "pass" : "unknown",
			summary: evaluatedAt != null ? "Query is running cleanly" : "No evaluations yet",
			evidence: [],
		})
	}

	/* 4 — Data found */
	const latestState = states[0] ?? null
	const latestCheck = Option.getOrNull(Arr.findFirst(groupChecks, (c) => c.status !== "error"))
	const sampleCount = latestState?.last_sample_count ?? latestCheck?.sampleCount ?? null
	const skippedChecks = Arr.filter(groupChecks, (c) => c.status === "skipped").length
	const observableChecks = Arr.filter(groupChecks, (c) => c.status !== "error").length
	const noDataExplainer =
		rule.noDataBehavior === "zero"
			? "No-data windows are treated as 0 (they still evaluate)."
			: rule.noDataBehavior === "alert"
				? "No-data windows count as breaches."
				: "No-data windows are skipped (they never breach). Turn on alerting when there is no data to hear about it."
	// Checks recorded before skip reasons existed carry none and count as neither.
	const belowMinChecks = Arr.filter(groupChecks, (c) => c.skipReason === "below_min_samples").length
	const noDataChecks = Arr.filter(groupChecks, (c) => c.skipReason === "no_data").length
	if (observableChecks > 0 && skippedChecks === observableChecks) {
		stages.push({
			id: "data",
			label: "Data found",
			status: "fail",
			summary:
				belowMinChecks > 0 && noDataChecks === 0
					? "Every check in this window was skipped: fewer samples than the minimum"
					: "Every check in this window was skipped: no matching data",
			evidence: Arr.filter(
				[
					`${skippedChecks} of ${observableChecks} checks skipped`,
					noDataChecks > 0 ? `${noDataChecks} had no data (the query matched nothing)` : null,
					belowMinChecks > 0 ? `${belowMinChecks} were below the minimum sample count` : null,
					rule.minimumSampleCount > 0
						? `Minimum sample count: ${rule.minimumSampleCount} — windows below it are skipped`
						: null,
					noDataExplainer,
					"Check the rule's service scope and filters against what is actually ingesting.",
				],
				(line): line is string => line != null,
			),
			action: { label: "Edit rule", kind: "edit" },
		})
	} else {
		const latestSkipped =
			latestState?.last_status === "skipped" ||
			(latestState == null && latestCheck?.status === "skipped")
		stages.push({
			id: "data",
			label: "Data found",
			status: latestSkipped ? "warn" : sampleCount != null ? "pass" : "unknown",
			summary: latestSkipped
				? "The most recent check was skipped (not enough data)"
				: sampleCount != null
					? `${sampleCount} samples in the last window`
					: "No sample data yet",
			evidence: Arr.filter(
				[
					skippedChecks > 0 ? `${skippedChecks} skipped checks in this window` : null,
					rule.minimumSampleCount > 0 ? `Minimum sample count: ${rule.minimumSampleCount}` : null,
					noDataExplainer,
				],
				(line): line is string => line != null,
			),
		})
	}

	/* 5 — Threshold compared */
	const lastValue = latestState?.last_value ?? latestCheck?.observedValue ?? null
	const thresholdText = `${comparatorLabels[rule.comparator]} ${formatSignalValue(rule.signalType, rule.threshold)}${rule.thresholdUpper != null ? ` and ${formatSignalValue(rule.signalType, rule.thresholdUpper)}` : ""}`
	const consecutiveBreaches = latestState?.consecutive_breaches ?? latestCheck?.consecutiveBreaches ?? 0
	const breaching =
		latestState?.last_status === "breached" || (latestState == null && latestCheck?.status === "breached")
	if (lastValue == null) {
		stages.push({
			id: "threshold",
			label: "Threshold compared",
			status: "unknown",
			summary: "No observed value yet",
			evidence: [`Fires when the value is ${thresholdText}`],
		})
	} else if (breaching) {
		const needed = rule.consecutiveBreachesRequired
		stages.push({
			id: "threshold",
			label: "Threshold compared",
			status: "warn",
			summary:
				consecutiveBreaches >= needed
					? `Breaching — ${formatSignalValue(rule.signalType, lastValue)} is ${thresholdText}`
					: `Breaching — ${Math.min(consecutiveBreaches, needed)} of ${needed} consecutive breaches needed to fire`,
			evidence: [
				`Last value: ${formatSignalValue(rule.signalType, lastValue)} (fires when ${thresholdText})`,
				`Consecutive breaches: ${consecutiveBreaches} / ${needed}`,
			],
		})
	} else {
		stages.push({
			id: "threshold",
			label: "Threshold compared",
			status: "pass",
			summary: `Within threshold — last value ${formatSignalValue(rule.signalType, lastValue)}`,
			evidence: [
				`Fires when the value is ${thresholdText} for ${rule.consecutiveBreachesRequired} consecutive checks`,
			],
		})
	}

	/* 6 — Incident opened */
	const groupIncidents =
		input.selectedGroupKey != null
			? Arr.filter(openIncidents, (i) => i.groupKey === input.selectedGroupKey || i.groupKey == null)
			: openIncidents
	const first = groupIncidents[0]
	if (first !== undefined) {
		stages.push({
			id: "incident",
			label: "Incident opened",
			status: "warn",
			summary:
				groupIncidents.length === 1
					? `1 open incident since ${relative(now, new Date(first.firstTriggeredAt).getTime())}`
					: `${groupIncidents.length} open incidents`,
			evidence: Arr.map(
				groupIncidents.slice(0, 5),
				(i) =>
					`${i.groupKey ?? "all"} — opened ${relative(now, new Date(i.firstTriggeredAt).getTime())}`,
			),
		})
	} else {
		stages.push({
			id: "incident",
			label: "Incident opened",
			status: "pass",
			summary: `No open incident — the condition has not been met ${rule.consecutiveBreachesRequired} consecutive times`,
			evidence: [],
		})
	}

	/* 7 — Notification delivered */
	if (rule.destinationIds.length === 0) {
		stages.push({
			id: "notification",
			label: "Notification delivered",
			status: rule.enabled ? "fail" : "warn",
			summary: "No destinations — this rule fires into the void",
			evidence: ["Add a Slack/PagerDuty/webhook destination so incidents actually reach someone."],
			action: { label: "Configure destinations", kind: "destinations" },
		})
	} else {
		const destinationById = new Map(Arr.map(destinations, (d) => [d.id as string, d]))
		const evidence: string[] = []
		let failures = 0
		let deliveries = 0
		for (const destinationId of rule.destinationIds) {
			const destination = destinationById.get(destinationId)
			const name = destination?.name ?? "Unknown destination"
			const latest = Option.getOrNull(
				Arr.findFirst(deliveryEvents, (e) => e.destinationId === destinationId),
			)
			if (destination != null && !destination.enabled) {
				evidence.push(`${name}: destination disabled`)
				failures += 1
			} else if (latest == null) {
				evidence.push(`${name}: no deliveries yet`)
			} else if (latest.status === "failed") {
				failures += 1
				evidence.push(
					`${name}: last delivery failed${latest.responseCode != null ? ` (HTTP ${latest.responseCode})` : ""}${latest.errorMessage != null ? ` — ${latest.errorMessage}` : ""}`,
				)
			} else if (latest.status === "success") {
				deliveries += 1
				evidence.push(
					Str.trim(
						`${name}: delivered ${latest.attemptedAt != null ? relative(now, new Date(latest.attemptedAt).getTime()) : ""}`,
					),
				)
			} else {
				evidence.push(`${name}: ${latest.status}`)
			}
		}
		stages.push({
			id: "notification",
			label: "Notification delivered",
			status: failures > 0 ? "fail" : deliveries > 0 ? "pass" : "unknown",
			summary:
				failures > 0
					? `${failures} destination${failures === 1 ? " is" : "s are"} failing`
					: deliveries > 0
						? "Notifications are delivering"
						: "No notifications sent yet",
			evidence,
			...(failures > 0
				? { action: { label: "Review destinations", kind: "destinations" as const } }
				: undefined),
		})
	}

	return stages
}

/** The verdict line for the panel header: the first failing/warning stage's summary. */
export function diagnosisVerdict(stages: ReadonlyArray<DiagnosisStage>): {
	readonly status: DiagnosisStageStatus
	readonly summary: string
} {
	const firstFail = Arr.findFirst(stages, (s) => s.status === "fail")
	if (Option.isSome(firstFail)) return { status: "fail", summary: firstFail.value.summary }
	const firstWarn = Arr.findFirst(stages, (s) => s.status === "warn")
	if (Option.isSome(firstWarn)) return { status: "warn", summary: firstWarn.value.summary }
	return { status: "pass", summary: "All stages passing" }
}
