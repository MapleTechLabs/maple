import { Effect, Schema } from "effect"
import { IngestFreshnessOutput } from "@maple/domain/mcp-outputs"
import { CH, parseWarehouseDateTime, warehouseDateTime } from "@maple/query-engine"
import { WarehouseExecutor } from "@maple/query-engine/observability"
import type { McpToolRegistrar } from "./types"
import { warehouseToMcpHandlers } from "../lib/map-warehouse-error"
import { withTenantExecutor, CurrentMcpTenant } from "../lib/query-warehouse"
import { MCP_DISCOVERY_MAX_HOURS } from "../lib/time"
import { formatNumber } from "../lib/format"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const TOOL = "ingest_freshness"
const WINDOW = P.timeWindow({ defaultHours: 7 * 24, maxHours: MCP_DISCOVERY_MAX_HOURS })

/** Trailing slice read for exact timestamps; older activity comes from the hourly usage rollup. */
const PROBE_MS = 3_600_000
/** A newest event older than this, but inside the probe, reads as delayed. */
const RECEIVING_MAX_LAG_SECONDS = 600

const SIGNALS = ["traces", "logs", "metrics"] as const
type Signal = (typeof SIGNALS)[number]
type Row = (typeof IngestFreshnessOutput.Type)["signals"][number]

const presenceRowSchema = Schema.Struct({
	signal: Schema.String,
	count: CH.CHNumber,
	firstSeen: Schema.String,
	lastSeen: Schema.String,
})

const formatLag = (seconds: number): string =>
	seconds < 120
		? `${seconds}s`
		: seconds < 7200
			? `${Math.round(seconds / 60)}m`
			: `${Math.round(seconds / 3600)}h`

const STATUS_TEXT = {
	receiving: "receiving",
	delayed: "delayed",
	stalled: "STALLED",
	none: "none in window",
} satisfies Record<Row["status"], string>

export const freshnessRow = (
	signal: Signal,
	endMs: number,
	probe: { readonly count: number; readonly lastSeen: string } | undefined,
	history: { readonly count: number; readonly lastSeen: string } | undefined,
): Row => {
	const windowCount = history?.count ?? 0
	const lastHourWithData = history !== undefined && history.count > 0 ? history.lastSeen : undefined
	const probeMs =
		probe !== undefined && probe.count > 0 ? parseWarehouseDateTime(probe.lastSeen) : Number.NaN
	if (probe !== undefined && Number.isFinite(probeMs)) {
		const lagSeconds = Math.max(0, Math.round((endMs - probeMs) / 1000))
		return {
			signal,
			status: lagSeconds <= RECEIVING_MAX_LAG_SECONDS ? "receiving" : "delayed",
			lastSeen: probe.lastSeen,
			lagSeconds,
			...(lastHourWithData === undefined ? undefined : { lastHourWithData }),
			windowCount,
		}
	}
	return lastHourWithData === undefined
		? { signal, status: "none", windowCount }
		: { signal, status: "stalled", lastHourWithData, windowCount }
}

export function registerIngestFreshnessTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "Ingest Freshness",
		description:
			"Newest received timestamp per signal (traces, logs, metrics) for the whole org, with the lag behind end_time and the last hour that had data. Use it before reading silence as an outage: one service gone quiet while its signals keep arriving is the service, every signal stalled at once is ingest. Timestamps in the last hour of the window are exact for logs and metrics and minute-grained for traces; older activity is hour-grained.",
		parameters: Schema.Struct({ ...WINDOW.fields }),
		output: IngestFreshnessOutput,
		hints: { readOnly: true },
		phrases: ["Checking ingest freshness"],
		handler: Effect.fn("McpTool.ingestFreshness")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, TOOL)
			const endMs = parseWarehouseDateTime(et)
			const probeStart = warehouseDateTime(Math.max(parseWarehouseDateTime(st), endMs - PROBE_MS))
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })

			const [rollupProbe, logsProbe, history] = yield* withTenantExecutor(
				Effect.gen(function* () {
					const executor = yield* WarehouseExecutor
					const probeParams = { orgId: executor.orgId, startTime: probeStart, endTime: et }
					const rollupQuery = CH.compileUnion(CH.ingestFreshnessQuery(), probeParams, {
						rowSchema: CH.ingestFreshnessRowSchema,
					})
					const logsQuery = CH.compile(CH.logsFreshnessQuery(), probeParams, {
						rowSchema: CH.ingestFreshnessRowSchema,
					})
					const historyQuery = CH.compileUnion(
						CH.signalPresenceQuery(),
						{ orgId: executor.orgId, startTime: st, endTime: et },
						{ rowSchema: presenceRowSchema },
					)
					return yield* Effect.all(
						[
							executor.compiledQuery(rollupQuery, {
								profile: "list",
								context: "ingestFreshness",
							}),
							executor.compiledQuery(logsQuery, { profile: "list", context: "logsFreshness" }),
							executor.compiledQuery(historyQuery, {
								profile: "list",
								context: "signalPresence",
							}),
						],
						{ concurrency: 3 },
					)
				}),
			).pipe(Effect.catchTags(warehouseToMcpHandlers(TOOL)))
			const probe = [...rollupProbe, ...logsProbe]

			return {
				timeRange: { start: st, end: et },
				probeWindow: { start: probeStart, end: et },
				signals: SIGNALS.map((signal) =>
					freshnessRow(
						signal,
						endMs,
						probe.find((row) => row.signal === signal),
						history.find((row) => row.signal === signal),
					),
				),
			}
		}),
		render: (output) => {
			const stalled = output.signals.filter((s) => s.status === "stalled")
			const live = output.signals.filter((s) => s.status === "receiving" || s.status === "delayed")
			return {
				title: "Ingest Freshness",
				scope: [
					["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
					["Exact timestamps from", output.probeWindow.start],
				],
				blocks: [
					doc.table(
						[
							"Signal",
							"Status",
							"Last received",
							"Lag",
							"Last hour with data",
							"Events in window",
						],
						output.signals.map((s) => [
							s.signal,
							STATUS_TEXT[s.status],
							s.lastSeen ?? "",
							s.lagSeconds === undefined ? "" : formatLag(s.lagSeconds),
							s.lastHourWithData ?? "",
							formatNumber(s.windowCount),
						]),
					),
					...(stalled.length > 0 && live.length === 0
						? [
								doc.text(
									"Every signal that was arriving has stopped: suspect ingest or the exporters, not one service.",
								),
							]
						: stalled.length > 0
							? [
									doc.text(
										`${stalled.map((s) => s.signal).join(", ")} stopped while ${live.map((s) => s.signal).join(", ")} kept arriving: check that signal's exporter.`,
									),
								]
							: []),
				],
				next: [doc.next("list_services", {}, "see which services are still reporting")],
			}
		},
	})
}
