import { Effect, Schema } from "effect"
import { AlertRuleNotFoundError } from "@maple/domain/http"
import { V2AlertRulePreviewParams } from "@maple/domain/http/v2"
import { AlertRuleId } from "@maple/domain/primitives"
import type { Dataset, EndpointHandler, SyncedRow } from "../../dataset.ts"
import { MINUTE } from "../../identity.ts"
import { epochMs, iso, noise, num, str, strings } from "./synthetic.ts"

/**
 * Alert checks live in the warehouse's `alert_checks` table and previews run the scheduler's
 * evaluator; neither exists in the fixture, so both are synthesized from one pure signal model
 * that agrees with the seeded rule states: payment p95 breaching since the 3.5.0 rollout.
 */

const GROUP = "__total__"
const isPreview = Schema.is(V2AlertRulePreviewParams)
const INCIDENT_AGE_MS = 110 * MINUTE

interface RuleCondition {
	readonly signal: string
	readonly services: ReadonlyArray<string>
	readonly threshold: number
	readonly comparator: string
	readonly windowMinutes: number
}

const observed = (dataset: Dataset, rule: RuleCondition, bucketMs: number): number | null => {
	if (dataset.telemetry.traces.length === 0) return null
	const jitter = noise(`${rule.signal}:${rule.services.join(",")}`, bucketMs)
	const incident = bucketMs >= epochMs(dataset.now) - INCIDENT_AGE_MS
	if (rule.signal === "p95_latency" && rule.services.includes("payment-svc"))
		return Math.round(incident ? 1700 + jitter * 260 : 390 + jitter * 80)
	if (rule.signal === "p99_latency") return Math.round(820 + jitter * 220)
	if (rule.signal.includes("latency")) return Math.round(240 + jitter * 90)
	if (rule.signal === "error_rate") return Math.round((0.3 + jitter * 0.7) * 100) / 100
	return Math.round(rule.threshold * (0.3 + jitter * 0.3) * 100) / 100
}

const breaches = (rule: RuleCondition, value: number) =>
	rule.comparator === "lt" || rule.comparator === "lte" ? value < rule.threshold : value > rule.threshold

const samplesAt = (rule: RuleCondition, bucketMs: number) =>
	280 + Math.round(noise(`samples:${rule.signal}`, bucketMs) * 70)

const conditionOfRow = (row: SyncedRow): RuleCondition => ({
	signal: str(row, "signal_type") ?? "error_rate",
	services: strings(row, "service_names_json"),
	threshold: num(row, "threshold") ?? 0,
	comparator: str(row, "comparator") ?? "gt",
	windowMinutes: num(row, "window_minutes") ?? 5,
})

const ruleRow = (dataset: Dataset, id: string | undefined) =>
	(dataset.synced.alert_rules ?? []).find((row) => row.id === id)

const notFound = (id: string | undefined) =>
	new AlertRuleNotFoundError({ message: "Alert rule not found", ruleId: AlertRuleId.make(id ?? "") })

/** Window ends on the rule's grid in `[since, until]`, newest first. */
const windowEnds = (rule: RuleCondition, sinceMs: number, untilMs: number) => {
	const windowMs = rule.windowMinutes * MINUTE
	const last = Math.floor(untilMs / windowMs) * windowMs
	const count = Math.max(0, Math.floor((last - sinceMs) / windowMs) + 1)
	return Array.from({ length: Math.min(count, 2000) }, (_, index) => last - index * windowMs)
}

const check = (dataset: Dataset, rule: RuleCondition, endMs: number) => {
	const value = observed(dataset, rule, endMs)
	const breached = value !== null && breaches(rule, value)
	const incidentStart = epochMs(dataset.now) - INCIDENT_AGE_MS
	const breachRun = breached ? Math.floor((endMs - incidentStart) / (rule.windowMinutes * MINUTE)) + 1 : 0
	return {
		object: "alert_check",
		timestamp: iso(endMs + 4_000),
		group_key: GROUP,
		status: value === null ? "skipped" : breached ? "breached" : "healthy",
		skip_reason: value === null ? "no_data" : null,
		signal_type: rule.signal,
		comparator: rule.comparator,
		threshold: rule.threshold,
		threshold_upper: null,
		observed_value: value,
		sample_count: value === null ? 0 : samplesAt(rule, endMs),
		window_minutes: rule.windowMinutes,
		window_start: iso(endMs - rule.windowMinutes * MINUTE),
		window_end: iso(endMs),
		consecutive_breaches: breachRun,
		consecutive_healthy: breached ? 0 : 40,
		incident_id: null,
		// One tier per rule here, so a breach is at the rule's warning tier.
		level: breached ? "warning" : null,
		incident_transition: !breached
			? "none"
			: breachRun === 2
				? "opened"
				: breachRun > 2
					? "continued"
					: "none",
		evaluation_duration_ms: 180 + Math.round(noise("eval", endMs) * 240),
		error_message: null,
		error_category: null,
	}
}

const checks: EndpointHandler = ({ dataset, params, query }) => {
	const id = str(params, "id")
	const row = ruleRow(dataset, id)
	if (row === undefined) return Effect.fail(notFound(id))
	const rule = conditionOfRow(row)
	const nowMs = epochMs(dataset.now)
	const limit = num(query, "limit") ?? 20
	const until = Math.min(nowMs, epochMs(str(query, "until") ?? dataset.now))
	const since = epochMs(str(query, "since") ?? iso(nowMs - 24 * 60 * MINUTE))
	const status = str(query, "status")
	const rows = windowEnds(rule, since, until - 4_000)
		.map((endMs) => check(dataset, rule, endMs))
		.filter((entry) => status === undefined || entry.status === status)
	return Effect.succeed({
		object: "list",
		data: rows.slice(0, limit),
		has_more: rows.length > limit,
		next_cursor: null,
	})
}

const SUMMARY_BUCKETS = 96

const checksSummary: EndpointHandler = ({ dataset, params, query }) => {
	const id = str(params, "id")
	const row = ruleRow(dataset, id)
	if (row === undefined) return Effect.fail(notFound(id))
	const rule = conditionOfRow(row)
	const until = Math.min(epochMs(dataset.now), epochMs(str(query, "until") ?? dataset.now))
	const since = epochMs(str(query, "since") ?? iso(until - 24 * 60 * MINUTE))
	const windowMs = rule.windowMinutes * MINUTE
	const bucketMs = Math.max(windowMs, Math.ceil((until - since) / SUMMARY_BUCKETS / windowMs) * windowMs)
	const all = windowEnds(rule, since, until - 4_000).map((endMs) => check(dataset, rule, endMs))
	const first = Math.floor(since / bucketMs) * bucketMs
	const points = Array.from(
		{ length: Math.ceil((until - first) / bucketMs) },
		(_, index) => first + index * bucketMs,
	).flatMap((start) => {
		const inBucket = all.filter(
			(entry) => epochMs(entry.window_end) >= start && epochMs(entry.window_end) < start + bucketMs,
		)
		if (inBucket.length === 0) return []
		const count = (status: string) => inBucket.filter((entry) => entry.status === status).length
		const values = inBucket.flatMap((entry) =>
			entry.observed_value === null ? [] : [entry.observed_value],
		)
		return [
			{
				bucket: iso(start),
				group_key: GROUP,
				total_count: inBucket.length,
				breached_count: count("breached"),
				healthy_count: count("healthy"),
				skipped_count: count("skipped"),
				error_count: 0,
				transition_count: inBucket.filter((entry) => entry.incident_transition === "opened").length,
				observed_value: values.length === 0 ? null : Math.max(...values),
				threshold: rule.threshold,
			},
		]
	})
	const total = (status: string) => all.filter((entry) => entry.status === status).length
	return Effect.succeed({
		object: "alert_check.summary",
		bucket_seconds: bucketMs / 1000,
		top_group_keys: [GROUP],
		totals: {
			total: all.length,
			breached: total("breached"),
			healthy: total("healthy"),
			skipped: total("skipped"),
			error: 0,
			transitions: all.filter((entry) => entry.incident_transition === "opened").length,
		},
		points,
	})
}

const MAX_PREVIEW_BUCKETS = 1500

/** The evaluator's grid: epoch-aligned windows, capped at 1500, plus no trailing partial bucket. */
const preview: EndpointHandler = ({ dataset, payload }) => {
	const draft = isPreview(payload) ? payload.rule : undefined
	const rule: RuleCondition = {
		signal: str(draft, "signal_type") ?? "error_rate",
		services: strings(draft, "service_names"),
		threshold: num(draft, "threshold") ?? 0,
		comparator: str(draft, "comparator") ?? "gt",
		windowMinutes: num(draft, "window_minutes") ?? 5,
	}
	const windowMs = rule.windowMinutes * MINUTE
	const endMs =
		Math.floor(
			Math.min(epochMs(str(payload, "end_time") ?? dataset.now), epochMs(dataset.now)) / windowMs,
		) * windowMs
	const startMs = Math.max(
		Math.floor(epochMs(str(payload, "start_time") ?? dataset.now) / windowMs) * windowMs,
		endMs - MAX_PREVIEW_BUCKETS * windowMs,
	)
	const buckets = Array.from(
		{ length: Math.max(0, (endMs - startMs) / windowMs) },
		(_, index) => startMs + (index + 1) * windowMs,
	)
	const points = buckets.map((bucket) => {
		const value = observed(dataset, rule, bucket)
		return value === null
			? { bucket: iso(bucket), value: null, sample_count: 0, status: "skipped", skip_reason: "no_data" }
			: {
					bucket: iso(bucket),
					value,
					sample_count: samplesAt(rule, bucket),
					status: breaches(rule, value) ? "breached" : "healthy",
				}
	})
	const firing = points.filter((point) => point.status === "breached")
	const [firstFiring] = firing.slice(1)
	const lastFiring = firing.at(-1)
	return Effect.succeed({
		object: "alert_rule.preview",
		bucket_seconds: windowMs / 1000,
		window_minutes: rule.windowMinutes,
		threshold: rule.threshold,
		threshold_upper: null,
		thresholds: [
			{
				severity: "warning",
				value: rule.threshold,
				upper: null,
				recovery_value: null,
				destination_ids: [],
			},
		],
		comparator: rule.comparator,
		truncated_to_start: null,
		series: [{ group_key: GROUP, points }],
		would_fire:
			firstFiring === undefined || lastFiring === undefined
				? []
				: [
						{
							group_key: GROUP,
							start: firstFiring.bucket,
							end: lastFiring.bucket,
							severity: "warning",
						},
					],
	})
}

export const alertEndpoints = {
	"alertRules.checks": checks,
	"alertRules.checksSummary": checksSummary,
	"alertRules.preview": preview,
	// The linked Slack workspace's channels, for a `chat` destination's picker.
	"chatIntegration.destinations": () =>
		Effect.succeed({
			object: "chat_workspace.destination_list",
			destinations: [
				{ id: "C0PARITYINC", name: "incidents", private: false },
				{ id: "C0PARITYOPS", name: "ops-alerts", private: true },
			],
		}),
	// `chatIntegration.connectors` is answered by the integrations area.
} satisfies Readonly<Record<string, EndpointHandler>>
