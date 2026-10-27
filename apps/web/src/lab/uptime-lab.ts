import { OrgId } from "@maple/domain"
import { Effect, Schema } from "effect"
import { AsyncData, Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../charts/chart"
import { LoadChartRuntime } from "../charts/chart-runtime"
import { ResolveThemeColors } from "../charts/theme-colors"
import * as Keyed from "../data/keyed"
import { isoMs } from "../page/alerts/shared/time"
import type { PageContext } from "../page/contract"
import { Message } from "../page/alerts/uptime-monitor/message"
import {
	type CheckPoint,
	type CheckSample,
	type CheckStats,
	Model,
	type PhasePoint,
} from "../page/alerts/uptime-monitor/model"
import { update as pageUpdate } from "../page/alerts/uptime-monitor/update"
import {
	CHART_TOKENS,
	checksScatterPanel,
	phaseBreakdownPanel,
	responseTimePanel,
} from "../page/alerts/uptime-monitor/view-panels"
import type { Resources } from "../platform/resources"

// `/lab/uptime`: the HTTP monitor page's three charts over a fixture shaped like production checks
// (checks from 14 hours ago, TTFB carrying the time, transfer near 0, one failure).

export { Message, Model }

const LAB_CONTEXT: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_lab_uptime"),
	pinnedNamespace: null,
	timeZone: "UTC",
}

const NOW_MS = Date.UTC(2026, 9, 27, 13, 30)
/** The page's bucket width per window: 24 hours read as 15-minute buckets, an hour as 1-minute ones. */
const WINDOWS = {
	"1h": { windowMs: 3_600_000, bucketMs: 60_000 },
	"24h": { windowMs: 86_400_000, bucketMs: 900_000 },
} as const
type LabWindow = keyof typeof WINDOWS
const CHECK_EVERY_MS = 100_000
/** Checks only started recording phases (and, here, running) 10 hours into the window. */
const FIRST_CHECK_MS = NOW_MS - 14 * 3_600_000
const FAILED_AT_MS = FIRST_CHECK_MS + 50 * 60_000

/** A seeded generator, so the lab draws the same checks on every load. */
const jitter = (seed: number): number => {
	const x = Math.sin(seed * 12.9898) * 43758.5453
	return x - Math.floor(x)
}

const sampleAt = (atMs: number, index: number): CheckSample => {
	const failed = atMs === FAILED_AT_MS
	const spike = index % 97 === 0 ? 3 : 1
	const phases = {
		dnsMs: 4 + jitter(index) * 11,
		connectMs: 3 + jitter(index + 0.1) * 6,
		tlsMs: 6 + jitter(index + 0.2) * 9,
		ttfbMs: (70 + jitter(index + 0.3) * 120) * spike,
		transferMs: index % 13 === 0 ? jitter(index + 0.4) * 2 : 0,
	}
	const total = Object.values(phases).reduce((sum, ms) => sum + ms, 0)
	return {
		at: new Date(atMs).toISOString(),
		durationMs: failed ? 2_400 : total + 1,
		ok: !failed,
		statusCode: failed ? null : 200,
		traceId: `lab-${index}`,
		phases: failed ? null : phases,
	}
}

const quantile = (sorted: ReadonlyArray<number>, q: number): number =>
	sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))] ?? 0

const mean = (values: ReadonlyArray<number>): number =>
	values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length

const fixtureStats = (window: LabWindow): CheckStats => {
	const { windowMs, bucketMs: stepMs } = WINDOWS[window]
	const startMs = NOW_MS - windowMs
	const checkCount = Math.floor((NOW_MS - FIRST_CHECK_MS) / CHECK_EVERY_MS)
	const samples = Array.from({ length: checkCount }, (_, index) =>
		sampleAt(FIRST_CHECK_MS + index * CHECK_EVERY_MS, index),
	).filter((sample) => isoMs(sample.at) >= startMs)
	const buckets = Array.from({ length: windowMs / stepMs }, (_, index) => startMs + index * stepMs)
	const inBucket = (bucketMs: number) =>
		samples.filter((sample) => {
			const at = isoMs(sample.at)
			return at >= bucketMs && at < bucketMs + stepMs
		})
	// Like the warehouse (`trimSparseLeadingBuckets`), the points start at the first bucket with a check.
	const firstCheckMs = samples[0] === undefined ? startMs : isoMs(samples[0].at)
	const points = buckets.flatMap((bucketMs): ReadonlyArray<CheckPoint> => {
		const checks = inBucket(bucketMs)
		const sorted = checks.map((sample) => sample.durationMs).toSorted((a, b) => a - b)
		if (bucketMs + stepMs <= firstCheckMs) return []
		return [
			{
				bucket: new Date(bucketMs).toISOString(),
				errorRate:
					checks.length === 0 ? 0 : checks.filter((sample) => !sample.ok).length / checks.length,
				p50LatencyMs: quantile(sorted, 0.5),
				p95LatencyMs: quantile(sorted, 0.95),
				p99LatencyMs: quantile(sorted, 0.99),
				totalCount: checks.length,
				partial: bucketMs + stepMs > NOW_MS,
			},
		]
	})
	const phases = buckets.flatMap((bucketMs): ReadonlyArray<PhasePoint> => {
		const timed = inBucket(bucketMs).flatMap((sample) => (sample.phases === null ? [] : [sample.phases]))
		return timed.length === 0
			? []
			: [
					{
						bucket: new Date(bucketMs).toISOString(),
						timedChecks: timed.length,
						dnsMs: mean(timed.map((phase) => phase.dnsMs)),
						connectMs: mean(timed.map((phase) => phase.connectMs)),
						tlsMs: mean(timed.map((phase) => phase.tlsMs)),
						ttfbMs: mean(timed.map((phase) => phase.ttfbMs)),
						transferMs: mean(timed.map((phase) => phase.transferMs)),
					},
				]
	})
	const sorted = samples.map((sample) => sample.durationMs).toSorted((a, b) => a - b)
	return {
		window,
		points,
		samples,
		samplesTruncated: false,
		samplesFailed: false,
		windowStartMs: startMs,
		windowEndMs: NOW_MS,
		checks: samples.length,
		failures: samples.filter((sample) => !sample.ok).length,
		p50Ms: quantile(sorted, 0.5),
		p95Ms: quantile(sorted, 0.95),
		p99Ms: quantile(sorted, 0.99),
		phases,
		phasesFailed: false,
	}
}

export const Flags = Schema.Struct({ timeZone: Schema.String })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.sync(() => ({
	timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
}))

type Return = Update.Return<Model, Message, Resources>

/** The page's own reads and writes are dropped: the fixture is all the data there is. */
const withoutReads = (commands: ReadonlyArray<Command.Command<Message, never, Resources>> | undefined) =>
	(commands ?? []).filter((command) => !/^(Fetch|Toggle|Check)Uptime/.test(command.name))

export const init = (_flags: Flags): Return => ({
	model: {
		rawMonitorId: "lab",
		monitorId: null,
		nowMs: NOW_MS,
		monitor: Keyed.idle(),
		destinations: null,
		incidents: null,
		isAdmin: false,
		isToggling: false,
		isChecking: false,
		copies: {},
		window: "24h",
		stats: { key: null, data: AsyncData.Success({ data: fixtureStats("24h") }) },
		hoveredCheck: null,
		chart: Chart.init(),
		phaseChart: Chart.init(),
		chartRuntime: { _tag: "Loading" },
		themeColors: null,
	},
	commands: [
		Command.mapMessage(LoadChartRuntime(), (message) =>
			message._tag === "CompletedLoadChartRuntime"
				? Message.CompletedLoadChartRuntime()
				: Message.FailedLoadChartRuntime({ reason: message.reason }),
		),
	],
})

export const update = (model: Model, message: Message): Return => {
	// The window switch swaps the fixture instead of re-reading; it covers an hour and a day.
	if (message._tag === "PickedWindow")
		return message.window === "7d"
			? { model }
			: {
					model: {
						...model,
						window: message.window,
						hoveredCheck: null,
						stats: { key: null, data: AsyncData.Success({ data: fixtureStats(message.window) }) },
					},
				}
	const next = pageUpdate(model, message, LAB_CONTEXT)
	return { model: next.model, commands: withoutReads(next.commands) }
}

export const view = (model: Model, h: HtmlBuilder<Message>): Html => {
	const timeZone = "UTC"
	const context =
		model.themeColors !== null && model.chartRuntime._tag === "Ready"
			? { theme: model.themeColors, timeZone, nowMs: NOW_MS }
			: null
	return h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: CHART_TOKENS }))],
		[
			h.div(
				[h.Class("grid gap-4 overflow-y-auto p-6 lg:grid-cols-[minmax(0,1fr)_320px]")],
				[
					h.div(
						[h.Class("flex min-w-0 flex-col gap-4")],
						[
							responseTimePanel(h, model, context),
							phaseBreakdownPanel(h, model, context),
							...[checksScatterPanel(h, model, timeZone)].flatMap((panel) =>
								panel === null ? [] : [panel],
							),
						],
					),
				],
			),
		],
	)
}
