/**
 * Fixture documents for `/lab/alerts`, a pure function of `nowMs`. Every
 * document is decoded through its real domain schema, so the fixture cannot
 * drift from the wire format, and the overview runs through `deriveOverview`.
 */
import { Schema } from "effect"

import {
	AlertDeliveryEventDocument,
	AlertDestinationDocument,
	AlertIncidentDocument,
	AlertRuleDocument,
	AlertRulePreviewResponse,
	type AlertDestinationType,
	type AlertSeverity,
	type AlertSignalType,
} from "@maple/domain/http"
import { V2Investigation } from "@maple/domain/http/v2"

import type { AlertRuleStateRow } from "@maple/web-data/collections/alerts"
import { type AlertsOverviewReady, deriveOverview } from "@maple/web-data/alerts/overview"
import { VERDICT_LAB_CASES } from "./verdict-fixture"

const decodeRule = Schema.decodeUnknownSync(AlertRuleDocument)
const decodeIncident = Schema.decodeUnknownSync(AlertIncidentDocument)
const decodeDestination = Schema.decodeUnknownSync(AlertDestinationDocument)
const decodeDelivery = Schema.decodeUnknownSync(AlertDeliveryEventDocument)
const decodePreview = Schema.decodeUnknownSync(AlertRulePreviewResponse)
const decodeInvestigation = Schema.decodeUnknownSync(Schema.toType(V2Investigation))

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const ORG = "org_lab_alerts"

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

/* Destinations ---------------------------------------------------------------------------- */

const DEST = {
	discord: uuid(101),
	pagerduty: uuid(102),
	email: uuid(103),
	bridge: uuid(104),
	legacy: uuid(105),
} as const

const destinationsAt = (nowMs: number): AlertDestinationDocument[] => {
	const iso = (ms: number) => new Date(ms).toISOString()
	const base = {
		enabled: true,
		channelLabel: null,
		memberUserIds: null,
		lastTestedAt: iso(nowMs - 9 * DAY),
		lastTestError: null,
		consecutiveFailures: 0,
		lastFailureAt: null,
		disabledAt: null,
		disabledReason: null,
		createdAt: iso(nowMs - 120 * DAY),
		updatedAt: iso(nowMs - 9 * DAY),
	}
	return [
		decodeDestination({
			...base,
			id: DEST.discord,
			name: "#alerts",
			type: "discord",
			summary: "Discord webhook · maple-eng/#alerts",
			channelLabel: "#alerts",
		}),
		decodeDestination({
			...base,
			id: DEST.pagerduty,
			name: "PagerDuty Platform on-call",
			type: "pagerduty",
			summary: "Routing key ••••7f3a · Platform service",
		}),
		decodeDestination({
			...base,
			id: DEST.email,
			name: "data-oncall",
			type: "email",
			summary: "data-oncall@maple.dev",
		}),
		decodeDestination({
			...base,
			id: DEST.bridge,
			name: "status-bridge",
			type: "webhook",
			summary: "POST https://status.maple.dev/hooks/alerts",
			lastFailureAt: iso(nowMs - 22 * MIN),
		}),
		decodeDestination({
			...base,
			id: DEST.legacy,
			name: "Legacy ops webhook",
			type: "webhook",
			summary: "POST https://ops-legacy.internal/alert",
			enabled: false,
			consecutiveFailures: 12,
			lastFailureAt: iso(nowMs - 3 * DAY),
			disabledAt: iso(nowMs - 3 * DAY),
			disabledReason: "HTTP 410 Gone on 12 consecutive attempts",
			lastTestError: "HTTP 410 Gone",
		}),
	]
}

/* Rules ----------------------------------------------------------------------------------- */

const RULE = {
	errorRate: uuid(201),
	slowApi: uuid(202),
	ingestSilent: uuid(203),
	scraper: uuid(204),
	errorTick: uuid(205),
	checkoutDrop: uuid(206),
	pgPermission: uuid(207),
	alertingP99: uuid(208),
	walBacklog: uuid(209),
	tinybirdMirror: uuid(210),
	apdex: uuid(211),
} as const

interface RuleSpec {
	readonly id: string
	readonly name: string
	readonly signalType: AlertSignalType
	readonly threshold: number
	readonly comparator?: "gt" | "lt"
	readonly severity: AlertSeverity
	readonly tags: ReadonlyArray<string>
	readonly services: ReadonlyArray<string>
	readonly destinations: ReadonlyArray<string>
	readonly grouped?: boolean
	readonly enabled?: boolean
	readonly minSamples?: number
	readonly error?: string
	readonly lastEvaluatedAgoMs?: number
	readonly updatedAgoDays: number
}

const RULE_SPECS: ReadonlyArray<RuleSpec> = [
	{
		id: RULE.errorRate,
		name: "High error rate",
		signalType: "error_rate",
		threshold: 0.05,
		severity: "critical",
		tags: ["platform"],
		services: [],
		destinations: [DEST.discord, DEST.pagerduty, DEST.bridge],
		grouped: true,
		updatedAgoDays: 4,
	},
	{
		id: RULE.slowApi,
		name: "Slow API",
		signalType: "p95_latency",
		threshold: 1500,
		severity: "warning",
		tags: ["api"],
		services: ["maple-api"],
		destinations: [DEST.discord],
		grouped: true,
		updatedAgoDays: 12,
	},
	{
		id: RULE.ingestSilent,
		name: "Ingest gateway silent",
		signalType: "throughput",
		threshold: 50,
		comparator: "lt",
		severity: "critical",
		tags: ["ingest"],
		services: ["maple-ingest"],
		destinations: [DEST.pagerduty],
		updatedAgoDays: 20,
	},
	{
		id: RULE.scraper,
		name: "Scraper PlanetScale timeout",
		signalType: "error_rate",
		threshold: 0.02,
		severity: "warning",
		tags: ["data"],
		services: ["maple-scraper"],
		destinations: [DEST.email],
		error: "unknown column ScrapeTarget",
		updatedAgoDays: 2,
	},
	{
		id: RULE.errorTick,
		name: "Error tick cursor lagging",
		signalType: "p99_latency",
		threshold: 60_000,
		severity: "warning",
		tags: ["platform"],
		services: ["maple-alerting"],
		destinations: [DEST.discord],
		lastEvaluatedAgoMs: 2 * DAY,
		updatedAgoDays: 30,
	},
	{
		id: RULE.checkoutDrop,
		name: "Checkout throughput drop",
		signalType: "throughput",
		threshold: 20,
		comparator: "lt",
		severity: "warning",
		tags: ["api"],
		services: ["maple-api"],
		destinations: [DEST.discord],
		minSamples: 200,
		updatedAgoDays: 6,
	},
	{
		id: RULE.pgPermission,
		name: "Postgres permission denied",
		signalType: "error_rate",
		threshold: 0.001,
		severity: "critical",
		tags: ["data"],
		services: ["maple-api"],
		destinations: [],
		updatedAgoDays: 1,
	},
	{
		id: RULE.alertingP99,
		name: "Alerting worker p99",
		signalType: "p99_latency",
		threshold: 4000,
		severity: "warning",
		tags: ["platform"],
		services: ["maple-alerting"],
		destinations: [DEST.discord],
		updatedAgoDays: 15,
	},
	{
		id: RULE.walBacklog,
		name: "Ingest WAL backlog",
		signalType: "p95_latency",
		threshold: 2500,
		severity: "critical",
		tags: ["ingest"],
		services: ["maple-ingest"],
		destinations: [DEST.pagerduty, DEST.email],
		updatedAgoDays: 8,
	},
	{
		id: RULE.tinybirdMirror,
		name: "Warehouse mirror lag",
		signalType: "p95_latency",
		threshold: 30_000,
		severity: "warning",
		tags: [],
		services: ["maple-ingest"],
		destinations: [DEST.legacy],
		enabled: false,
		updatedAgoDays: 3,
	},
	{
		id: RULE.apdex,
		name: "Web apdex",
		signalType: "apdex",
		threshold: 0.85,
		comparator: "lt",
		severity: "warning",
		tags: [],
		services: ["maple-web"],
		destinations: [DEST.discord],
		updatedAgoDays: 40,
	},
]

const ruleFrom = (spec: RuleSpec, nowMs: number): AlertRuleDocument => {
	const iso = (ms: number) => new Date(ms).toISOString()
	return decodeRule({
		id: spec.id,
		name: spec.name,
		notes: null,
		notificationTemplate: null,
		enabled: spec.enabled ?? true,
		severity: spec.severity,
		serviceNames: spec.services,
		excludeServiceNames: [],
		environments: ["production"],
		tags: spec.tags,
		groupBy: spec.grouped ? ["service.name"] : null,
		signalType: spec.signalType,
		comparator: spec.comparator ?? "gt",
		threshold: spec.threshold,
		thresholdUpper: null,
		windowMinutes: 5,
		minimumSampleCount: spec.minSamples ?? 0,
		consecutiveBreachesRequired: 2,
		breachesOutOf: null,
		evaluationIntervalMinutes: null,
		thresholds: [
			{
				severity: spec.severity,
				value: spec.threshold,
				upper: null,
				recoveryValue: null,
				destinationIds: [],
			},
		],
		consecutiveHealthyRequired: 2,
		renotifyIntervalMinutes: 15,
		apdexThresholdMs: spec.signalType === "apdex" ? 500 : null,
		queryBuilderDraft: null,
		rawQuerySql: null,
		rawQueryReducer: null,
		destinationIds: spec.destinations,
		noDataBehavior: "skip",
		lastEvaluationError: spec.error ?? null,
		lastEvaluatedAt: iso(nowMs - (spec.lastEvaluatedAgoMs ?? MIN)),
		lastScheduledAt: iso(nowMs - (spec.lastEvaluatedAgoMs ?? MIN)),
		createdAt: iso(nowMs - 90 * DAY),
		updatedAt: iso(nowMs - spec.updatedAgoDays * DAY),
		createdBy: "user_lab",
		updatedBy: "user_lab",
	})
}

/* States ---------------------------------------------------------------------------------- */

const state = (
	nowMs: number,
	ruleId: string,
	groupKey: string,
	status: "breached" | "healthy" | "skipped",
	value: number | null,
	opts: { agoMs?: number; error?: string; samples?: number } = {},
): AlertRuleStateRow => {
	const at = new Date(nowMs - (opts.agoMs ?? MIN)).toISOString()
	return {
		org_id: ORG,
		rule_id: ruleId,
		group_key: groupKey,
		consecutive_breaches: status === "breached" ? 6 : 0,
		consecutive_healthy: status === "healthy" ? 30 : 0,
		last_status: status,
		last_value: value,
		last_sample_count: opts.samples ?? 4_200,
		last_evaluated_at: at,
		last_error: opts.error ?? null,
		updated_at: at,
	}
}

const statesAt = (nowMs: number): AlertRuleStateRow[] => [
	state(nowMs, RULE.errorRate, "maple-chat", "breached", 0.084, { samples: 6_750 }),
	state(nowMs, RULE.errorRate, "maple-api", "healthy", 0.012),
	state(nowMs, RULE.errorRate, "maple-ingest", "healthy", 0.004),
	state(nowMs, RULE.errorRate, "maple-alerting", "healthy", 0.001),
	state(nowMs, RULE.errorRate, "maple-web", "healthy", 0),
	state(nowMs, RULE.slowApi, "maple-api", "breached", 1920),
	state(nowMs, RULE.ingestSilent, "__total__", "skipped", null, { samples: 0 }),
	state(nowMs, RULE.scraper, "__total__", "healthy", null, { error: "unknown column ScrapeTarget" }),
	state(nowMs, RULE.errorTick, "__total__", "healthy", 8_400, { agoMs: 2 * DAY }),
	state(nowMs, RULE.checkoutDrop, "__total__", "skipped", null, { samples: 37 }),
	state(nowMs, RULE.pgPermission, "__total__", "healthy", 0),
	state(nowMs, RULE.alertingP99, "__total__", "healthy", 1_840),
	state(nowMs, RULE.walBacklog, "__total__", "healthy", 640),
	state(nowMs, RULE.apdex, "__total__", "healthy", 0.94),
]

/* Incidents ------------------------------------------------------------------------------- */

const INCIDENT = {
	chat: uuid(301),
	slowApi: uuid(302),
	ingest: uuid(303),
} as const

interface IncidentSpec {
	readonly id: string
	readonly ruleId: string
	readonly groupKey: string | null
	/** Start and end as offsets back from now; a null end leaves the incident open. */
	readonly startAgo: number
	readonly endAgo: number | null
	readonly value: number
	readonly held?: boolean
}

const OPEN_INCIDENTS: ReadonlyArray<IncidentSpec> = [
	{
		id: INCIDENT.chat,
		ruleId: RULE.errorRate,
		groupKey: "maple-chat",
		startAgo: 23 * MIN,
		endAgo: null,
		value: 0.084,
	},
	{
		id: INCIDENT.slowApi,
		ruleId: RULE.slowApi,
		groupKey: "maple-api",
		startAgo: 41 * MIN,
		endAgo: null,
		value: 1920,
	},
	{
		id: INCIDENT.ingest,
		ruleId: RULE.ingestSilent,
		groupKey: null,
		startAgo: 72 * MIN,
		endAgo: null,
		value: 3,
		held: true,
	},
]

/** Resolved history: four in the last day (seven with the open ones), the rest across the week. */
const RESOLVED_INCIDENTS: ReadonlyArray<IncidentSpec> = [
	{
		id: uuid(311),
		ruleId: RULE.errorRate,
		groupKey: "maple-api",
		startAgo: 19 * HOUR,
		endAgo: 18.4 * HOUR,
		value: 0.061,
	},
	{
		id: uuid(312),
		ruleId: RULE.errorRate,
		groupKey: "maple-chat",
		startAgo: 7 * HOUR,
		endAgo: 6.2 * HOUR,
		value: 0.072,
	},
	{
		id: uuid(313),
		ruleId: RULE.slowApi,
		groupKey: "maple-api",
		startAgo: 13 * HOUR,
		endAgo: 12.1 * HOUR,
		value: 1710,
	},
	{
		id: uuid(314),
		ruleId: RULE.walBacklog,
		groupKey: null,
		startAgo: 10 * HOUR,
		endAgo: 9.7 * HOUR,
		value: 3100,
	},
	{
		id: uuid(321),
		ruleId: RULE.errorRate,
		groupKey: "maple-ingest",
		startAgo: 2.3 * DAY,
		endAgo: 2.25 * DAY,
		value: 0.058,
	},
	{
		id: uuid(322),
		ruleId: RULE.slowApi,
		groupKey: "maple-api",
		startAgo: 3.1 * DAY,
		endAgo: 3 * DAY,
		value: 1640,
	},
	{
		id: uuid(323),
		ruleId: RULE.slowApi,
		groupKey: "maple-api",
		startAgo: 5.4 * DAY,
		endAgo: 5.3 * DAY,
		value: 2050,
	},
	{
		id: uuid(324),
		ruleId: RULE.walBacklog,
		groupKey: null,
		startAgo: 4.2 * DAY,
		endAgo: 4.1 * DAY,
		value: 2900,
	},
	{
		id: uuid(325),
		ruleId: RULE.alertingP99,
		groupKey: null,
		startAgo: 6.2 * DAY,
		endAgo: 6.1 * DAY,
		value: 4800,
	},
	{
		id: uuid(326),
		ruleId: RULE.ingestSilent,
		groupKey: null,
		startAgo: 1.8 * DAY,
		endAgo: 1.75 * DAY,
		value: 0,
	},
	{
		id: uuid(327),
		ruleId: RULE.tinybirdMirror,
		groupKey: null,
		startAgo: 4.6 * DAY,
		endAgo: 3.9 * DAY,
		value: 48_000,
	},
	{
		id: uuid(328),
		ruleId: RULE.apdex,
		groupKey: null,
		startAgo: 6.6 * DAY,
		endAgo: 6.55 * DAY,
		value: 0.79,
	},
]

const incidentFrom = (spec: IncidentSpec, rule: AlertRuleDocument, nowMs: number): AlertIncidentDocument => {
	const iso = (ms: number) => new Date(ms).toISOString()
	const open = spec.endAgo === null
	return decodeIncident({
		id: spec.id,
		ruleId: rule.id,
		ruleName: rule.name,
		groupKey: spec.groupKey,
		signalType: rule.signalType,
		severity: rule.severity,
		status: open ? "open" : "resolved",
		comparator: rule.comparator,
		threshold: rule.threshold,
		thresholdUpper: rule.thresholdUpper,
		peakSeverity: null,
		firstTriggeredAt: iso(nowMs - spec.startAgo),
		lastTriggeredAt: iso(nowMs - (spec.held ? 58 * MIN : (spec.endAgo ?? 0) + MIN)),
		resolvedAt: open ? null : iso(nowMs - (spec.endAgo ?? 0)),
		lastObservedValue: spec.value,
		lastSampleCount: spec.held ? 12 : 6_750,
		dedupeKey: `${rule.id}:${spec.groupKey ?? "__total__"}`,
		lastDeliveredEventType: open ? "renotify" : "resolve",
		lastNotifiedAt: iso(nowMs - (open ? 8 * MIN : (spec.endAgo ?? 0))),
		holdReason: spec.held ? "volume_collapsed" : null,
		heldSince: spec.held ? iso(nowMs - 58 * MIN) : null,
		errorIssueId: null,
	})
}

/* Deliveries ------------------------------------------------------------------------------ */

type DestKey = keyof typeof DEST

const DESTINATION_META = {
	discord: { name: "#alerts", type: "discord" },
	pagerduty: { name: "PagerDuty Platform on-call", type: "pagerduty" },
	email: { name: "data-oncall", type: "email" },
	bridge: { name: "status-bridge", type: "webhook" },
	legacy: { name: "Legacy ops webhook", type: "webhook" },
} as const satisfies Record<DestKey, { name: string; type: AlertDestinationType }>

interface DeliverySpec {
	readonly destination: DestKey
	readonly ruleId: string
	readonly incidentId: string | null
	readonly eventType: "trigger" | "resolve" | "renotify"
	readonly atMs: number
	readonly failed?: { code: number; message: string }
	readonly attempt?: number
}

const deliveryFrom = (spec: DeliverySpec, n: number): AlertDeliveryEventDocument => {
	const meta = DESTINATION_META[spec.destination]
	const destinationId = DEST[spec.destination]
	const at = new Date(spec.atMs).toISOString()
	return decodeDelivery({
		id: uuid(5000 + n),
		incidentId: spec.incidentId,
		ruleId: spec.ruleId,
		destinationId,
		destinationName: meta.name,
		destinationType: meta.type,
		deliveryKey: `${spec.incidentId ?? spec.ruleId}:${spec.eventType}:${destinationId}`,
		eventType: spec.eventType,
		attemptNumber: spec.attempt ?? 1,
		status: spec.failed ? "failed" : "success",
		scheduledAt: at,
		attemptedAt: at,
		providerMessage: spec.failed ? null : "Delivered",
		providerReference: null,
		responseCode: spec.failed ? spec.failed.code : 200,
		errorMessage: spec.failed ? spec.failed.message : null,
	})
}

/** The critical maple-chat incident's own delivery story. */
const chatIncidentDeliveries = (nowMs: number): DeliverySpec[] => {
	const opened = nowMs - 23 * MIN
	const base = { ruleId: RULE.errorRate, incidentId: INCIDENT.chat }
	return [
		{ ...base, destination: "discord", eventType: "trigger", atMs: opened + 20_000 },
		{ ...base, destination: "pagerduty", eventType: "trigger", atMs: opened + 22_000 },
		{
			...base,
			destination: "bridge",
			eventType: "trigger",
			atMs: opened + 24_000,
			failed: { code: 502, message: "HTTP 502 Bad Gateway" },
		},
		{ ...base, destination: "bridge", eventType: "trigger", atMs: opened + 84_000, attempt: 2 },
		{ ...base, destination: "discord", eventType: "renotify", atMs: opened + 15 * MIN + 20_000 },
		{ ...base, destination: "pagerduty", eventType: "renotify", atMs: opened + 15 * MIN + 22_000 },
	]
}

const allDeliveries = (nowMs: number): AlertDeliveryEventDocument[] => {
	const specs = chatIncidentDeliveries(nowMs)
	const history: ReadonlyArray<[DestKey, string, number]> = [
		["discord", RULE.slowApi, 41 * MIN],
		["pagerduty", RULE.ingestSilent, 72 * MIN],
		["discord", RULE.errorRate, 7 * HOUR],
		["pagerduty", RULE.errorRate, 7 * HOUR],
		["bridge", RULE.errorRate, 7 * HOUR],
		["pagerduty", RULE.walBacklog, 10 * HOUR],
		["email", RULE.walBacklog, 10 * HOUR],
		["discord", RULE.slowApi, 13 * HOUR],
		["discord", RULE.errorRate, 19 * HOUR],
		["pagerduty", RULE.errorRate, 19 * HOUR],
		["bridge", RULE.errorRate, 19 * HOUR],
		["email", RULE.walBacklog, 4.2 * DAY],
		["email", RULE.scraper, 5 * DAY],
		["discord", RULE.alertingP99, 6.2 * DAY],
	]
	const routine = history.map(([destination, ruleId, ago]): DeliverySpec => ({
		destination,
		ruleId,
		incidentId: null,
		eventType: "trigger",
		atMs: nowMs - ago,
	}))
	// The legacy webhook failed until Maple auto-disabled it.
	const legacy = Array.from({ length: 8 }, (_, i): DeliverySpec => ({
		destination: "legacy",
		ruleId: RULE.tinybirdMirror,
		incidentId: null,
		eventType: i === 0 ? "trigger" : "renotify",
		atMs: nowMs - 4.6 * DAY + i * 2 * HOUR,
		failed: { code: 410, message: "HTTP 410 Gone" },
	}))
	return [...specs, ...routine, ...legacy]
		.toSorted((a, b) => b.atMs - a.atMs)
		.map((spec, i) => deliveryFrom(spec, i))
}

/* Incident page --------------------------------------------------------------------------- */

const chatPreview = (nowMs: number, range: { start: number; end: number }): AlertRulePreviewResponse => {
	const opened = nowMs - 23 * MIN
	const buckets = Math.floor((range.end - range.start) / MIN)
	const points = Array.from({ length: buckets }, (_, i) => {
		const t = range.start + i * MIN
		const wobble = Math.sin(i * 1.7) * 0.003 + Math.cos(i * 0.6) * 0.002
		const value =
			t < opened - 4 * MIN
				? 0.009 + wobble
				: t < opened
					? 0.03 + (i % 3) * 0.008
					: 0.074 + wobble * 3 + (t > opened + 15 * MIN ? 0.006 : 0)
		return {
			bucket: new Date(t).toISOString(),
			value,
			sampleCount: 260 + (i % 7) * 12,
			status: value > 0.05 ? "breached" : "healthy",
			provisional: i === buckets - 1,
		}
	})
	return decodePreview({
		bucketSeconds: 60,
		windowMinutes: 5,
		threshold: 0.05,
		thresholdUpper: null,
		thresholds: [
			{ severity: "warning", value: 0.05, upper: null, recoveryValue: null, destinationIds: [] },
		],
		comparator: "gt",
		truncatedToStart: null,
		series: [{ groupKey: "maple-chat", points }],
		wouldFire: [],
	})
}

const chatInvestigation = (nowMs: number): V2Investigation => {
	const base = VERDICT_LAB_CASES[0]!.investigation
	const opened = nowMs - 23 * MIN
	const iso = (ms: number) => new Date(ms).toISOString()
	return decodeInvestigation({
		...base,
		subject: { type: "incident", incident_kind: "alert", incident_id: INCIDENT.chat, issue_id: null },
		created_at: iso(opened + MIN),
		started_at: iso(opened + MIN),
		diagnosed_at: iso(opened + 5 * MIN),
		updated_at: iso(opened + 5 * MIN),
		report: {
			...base.report,
			headline:
				"412 of 6,750 /chat/stream requests fail with TimeoutError from maple-ai after deploy 4f2c1a",
		},
	})
}

/* Assembly -------------------------------------------------------------------------------- */

export interface AlertsLabFixture {
	readonly overview: AlertsOverviewReady
	readonly quiet: AlertsOverviewReady
	readonly destinations: ReadonlyArray<AlertDestinationDocument>
	readonly deliveries: ReadonlyArray<AlertDeliveryEventDocument>
	readonly incident: {
		readonly incident: AlertIncidentDocument
		readonly rule: AlertRuleDocument
		readonly ruleIncidents: ReadonlyArray<AlertIncidentDocument>
		readonly states: ReadonlyArray<AlertRuleStateRow>
		readonly preview: AlertRulePreviewResponse
		readonly range: { start: number; end: number }
		readonly deliveries: ReadonlyArray<AlertDeliveryEventDocument>
		readonly investigation: V2Investigation
	}
}

export function buildAlertsLabFixture(nowMs: number): AlertsLabFixture {
	const rules = RULE_SPECS.map((spec) => ruleFrom(spec, nowMs))
	const ruleById = new Map<string, AlertRuleDocument>(rules.map((rule) => [rule.id, rule]))
	const incidentsOf = (specs: ReadonlyArray<IncidentSpec>) =>
		specs.flatMap((spec) => {
			const rule = ruleById.get(spec.ruleId)
			return rule === undefined ? [] : [incidentFrom(spec, rule, nowMs)]
		})
	const incidents = incidentsOf([...OPEN_INCIDENTS, ...RESOLVED_INCIDENTS])
	const states = statesAt(nowMs)
	const deliveries = allDeliveries(nowMs)
	const overview = deriveOverview({ rules, incidents, states, deliveryEvents: deliveries, now: nowMs })

	// Quiet inbox: the open incidents resolved and two blind spots fixed, leaving two.
	const fixed = new Set<string>([RULE.errorTick, RULE.pgPermission, RULE.ingestSilent])
	const quietIncidents = incidentsOf([
		...OPEN_INCIDENTS.map((spec) => ({
			...spec,
			startAgo: spec.startAgo + 3 * HOUR,
			endAgo: 2 * HOUR,
			held: false,
		})),
		...RESOLVED_INCIDENTS,
	])
	const quiet = deriveOverview({
		rules: rules.filter((rule) => rule.id !== RULE.errorTick && rule.id !== RULE.pgPermission),
		incidents: quietIncidents,
		states: states.filter((row) => row.last_status !== "breached" && !fixed.has(row.rule_id)),
		deliveryEvents: deliveries,
		now: nowMs,
	})

	const chatRule = ruleById.get(RULE.errorRate) ?? rules[0]!
	const chat = incidents.find((incident) => incident.id === INCIDENT.chat) ?? incidents[0]!
	const opened = Date.parse(chat.firstTriggeredAt)
	const range = { start: opened - 30 * MIN, end: nowMs }

	return {
		overview,
		quiet,
		destinations: destinationsAt(nowMs),
		deliveries,
		incident: {
			incident: chat,
			rule: chatRule,
			ruleIncidents: incidents.filter((incident) => incident.ruleId === chatRule.id),
			states: states.filter((row) => row.rule_id === chatRule.id),
			preview: chatPreview(nowMs, range),
			range,
			deliveries: deliveries.filter((event) => event.incidentId === INCIDENT.chat),
			investigation: chatInvestigation(nowMs),
		},
	}
}
