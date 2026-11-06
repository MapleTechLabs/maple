/** Pieces the SLO MCP tools share: rows, burn summaries, SLI parsing, lookup and errors. */
import { Effect, Option, Order, Schema, Array as Arr, String as Str } from "effect"
import type { SloConfigRow, SloStatusRow } from "@maple/domain/mcp-outputs"
import { decodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import {
	SLO_LATENCY_THRESHOLDS_MS,
	SloLatencyThresholdMs,
	SloWindowDays,
	type OrgId,
} from "@maple/domain/primitives"
import { SLO_BURN_TIERS, tierBreached, type SloBurnWindow, type SloSli } from "@maple/domain/slo"
import type { SloNotFoundError, SloPersistenceError, SloValidationError } from "@maple/domain/http"
import { SlosService, type SloRecord, type SloStatus } from "@maple/backend/services/slos/SlosService"
import { sloRuleName } from "@maple/backend/services/slos/slo-alert-rule"
import { McpInvalidInputError, McpQueryError } from "../tools/types"
import { doc, type NextCall } from "./tool-doc"

export const SLI_KINDS = ["availability", "latency"] as const

const LADDER = Arr.join(Arr.map(SLO_LATENCY_THRESHOLDS_MS, String), ", ")

const iso = (ms: number) => new Date(ms).toISOString()

/** `5m`, `30m`, `1h`, `6h`. */
export const windowLabel = (minutes: number): string =>
	minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`

export const toSloConfigRow = (slo: SloRecord): typeof SloConfigRow.Type => ({
	id: slo.id,
	name: slo.name,
	description: slo.description,
	serviceName: slo.serviceName,
	environments: [...slo.environments],
	sliKind: slo.sli._tag,
	latencyThresholdMs: slo.sli._tag === "latency" ? slo.sli.thresholdMs : null,
	targetPercent: slo.targetPercent,
	windowDays: slo.windowDays,
	alerting: {
		enabled: slo.alerting.enabled,
		alertRuleId: slo.alertRuleId,
		criticalDestinationIds: [...slo.alerting.criticalDestinationIds],
		warningDestinationIds: [...slo.alerting.warningDestinationIds],
	},
	createdAt: iso(slo.createdAt),
	updatedAt: iso(slo.updatedAt),
})

/** The highest alert tier the windows breach, critical before warning. */
export const burningTier = (windows: ReadonlyArray<SloBurnWindow>): "critical" | "warning" | null =>
	Option.match(
		Arr.findFirst(SLO_BURN_TIERS, (tier) => tierBreached(tier, windows)),
		{ onNone: () => null, onSome: (tier) => tier.severity },
	)

/** The fastest-burning window; the first one on a tie. */
export const worstWindow = (windows: ReadonlyArray<SloBurnWindow>): SloBurnWindow | undefined =>
	Arr.sort(windows, Order.flip(Order.mapInput(Order.Number, (window: SloBurnWindow) => window.burnRate)))[0]

export const toSloStatusRow = (status: SloStatus): typeof SloStatusRow.Type => ({
	asOf: iso(status.asOfMs),
	total: status.total,
	good: status.good,
	sli: status.sli,
	budgetRemaining: status.budgetRemaining,
	burnWindows: Arr.map(status.burnWindows, (window) => ({
		window: windowLabel(window.windowMinutes),
		windowMinutes: window.windowMinutes,
		total: window.total,
		good: window.good,
		burnRate: window.burnRate,
	})),
	tiers: Arr.map(SLO_BURN_TIERS, (tier) => ({
		severity: tier.severity,
		factor: tier.factor,
		longWindow: windowLabel(tier.longWindowMinutes),
		shortWindow: windowLabel(tier.shortWindowMinutes),
		breached: tierBreached(tier, status.burnWindows),
	})),
})

export const percent = (ratio: number | null, digits = 3): string =>
	ratio === null ? "-" : `${Number((ratio * 100).toFixed(digits))}%`

export const burn = (rate: number | null): string => (rate === null ? "-" : `${rate.toFixed(2)}x`)

export const sliSummary = (row: typeof SloConfigRow.Type): string =>
	row.sliKind === "latency" ? `latency under ${row.latencyThresholdMs ?? "?"} ms` : "availability"

const invalid = (message: string, parameter: string) => new McpInvalidInputError({ message, parameter })

/** The SLI from flat tool parameters; `threshold_ms` only for latency, from the rollup ladder. */
export const buildSli = (
	kind: (typeof SLI_KINDS)[number],
	thresholdMs: number | undefined,
): Effect.Effect<SloSli, McpInvalidInputError> => {
	if (kind === "availability") {
		return thresholdMs === undefined
			? Effect.succeed({ _tag: "availability" })
			: Effect.fail(invalid("threshold_ms applies to a latency SLI, not availability.", "threshold_ms"))
	}
	if (thresholdMs === undefined) {
		return Effect.fail(invalid(`A latency SLI needs threshold_ms, one of ${LADDER}.`, "threshold_ms"))
	}
	return Schema.decodeUnknownEffect(SloLatencyThresholdMs)(thresholdMs).pipe(
		Effect.mapBoth({
			onSuccess: (ms): SloSli => ({ _tag: "latency", thresholdMs: ms }),
			onFailure: () =>
				invalid(
					`threshold_ms must be one of ${LADDER} (the latency buckets Maple counts spans in).`,
					"threshold_ms",
				),
		}),
	)
}

export const decodeWindowDays = (raw: number | undefined) =>
	raw === undefined
		? Effect.undefined
		: Schema.decodeUnknownEffect(SloWindowDays)(raw).pipe(
				Effect.mapError(() => invalid("window_days must be 7, 28 or 30.", "window_days")),
			)

type SloServiceError = SloNotFoundError | SloValidationError | SloPersistenceError

/** The service's failures as the model reads them: bad input to fix, or an outage. */
export const toMcpSloError = (tool: string) => (error: SloServiceError) => {
	switch (error._tag) {
		case "@maple/http/errors/SloValidationError":
			return new McpInvalidInputError({ message: error.message })
		case "@maple/http/errors/SloNotFoundError":
			return new McpInvalidInputError({
				message: "No such SLO. list_slos lists them.",
				parameter: "slo",
			})
		case "@maple/http/errors/SloPersistenceError":
			return new McpQueryError({
				message: `${error._tag}: ${error.message}`,
				pipeName: tool,
				cause: error,
			})
	}
}

/** An SLO by its id, REST id (`slo_…`) or exact name; names are unique per org. */
export const resolveSlo = Effect.fnUntraced(function* (tool: string, orgId: OrgId, ref: string) {
	const service = yield* SlosService
	const slos = yield* service.list(orgId).pipe(Effect.mapError(toMcpSloError(tool)))
	const trimmed = Str.trim(ref)
	const id = decodePublicId(PublicIdPrefixes.slo, trimmed) ?? trimmed
	const found = Arr.findFirst(slos, (slo) => slo.id === id || slo.name === trimmed)
	if (Option.isNone(found)) {
		return yield* new McpInvalidInputError({
			message: `No SLO named "${ref}". list_slos lists them.`,
			parameter: "slo",
		})
	}
	return found.value
})

const SLO_RULE_PREFIX = sloRuleName("")

/**
 * For burn-rate incidents: the SLOs behind them (their rules are hidden from list_alert_rules),
 * named from the rule name, else the SLO list.
 */
export const sloIncidentNext = (
	incidents: ReadonlyArray<{ readonly signalType: string; readonly ruleName: string }>,
): ReadonlyArray<NextCall> => {
	const burning = Arr.filter(incidents, (incident) => incident.signalType === "slo_burn_rate")
	if (burning.length === 0) return []
	const names = Arr.dedupe(
		Arr.flatMap(burning, (incident) =>
			Str.startsWith(SLO_RULE_PREFIX)(incident.ruleName)
				? [Str.slice(SLO_RULE_PREFIX.length)(incident.ruleName)]
				: [],
		),
	)
	return names.length === 0
		? [doc.next("list_slos", {}, "the SLOs behind these burn-rate incidents")]
		: Arr.map(names.slice(0, 3), (name) =>
				doc.next("inspect_slo", { slo: name }, `the burn windows of SLO "${name}"`),
			)
}

/** Every incident is a burn-rate one, so list_alert_rules (which hides their rules) cannot help. */
export const onlySloIncidents = (incidents: ReadonlyArray<{ readonly signalType: string }>): boolean =>
	incidents.length > 0 && Arr.every(incidents, (incident) => incident.signalType === "slo_burn_rate")
