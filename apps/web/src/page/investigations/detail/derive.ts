import type { V2Investigation } from "@maple/domain/http/v2"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { type Elapsed, splitDuration } from "@maple/web-data/investigations/display"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { Option } from "effect"
import type { Model, OverviewRow } from "./model"

export const investigationOf = (model: Model): Option.Option<V2Investigation> =>
	model.sync._tag === "Ready" ? Option.some(model.sync.investigation) : Option.none()

export type Tab = "overview" | "evidence" | "chat" | "transcript"
export const tabOf = (model: Model): Tab => model.search.tab ?? "overview"

/** `breadcrumbLabel`: the first line, clamped to 64 characters. */
export const breadcrumbLabel = (title: string): string => {
	const line = (title.split("\n")[0] ?? "").trim()
	return line.length > 64 ? `${line.slice(0, 63).trimEnd()}…` : line
}

/** `servicesTouched`: every service the evidence touched, the scope as fallback. */
export const servicesTouched = (investigation: V2Investigation): ReadonlyArray<string> => {
	const seen = new Set<string>()
	;(investigation.report?.evidence ?? []).forEach((evidence) =>
		evidence.relatedServices.forEach((service) => {
			const name = service.trim()
			if (name) seen.add(name)
		}),
	)
	if (seen.size === 0) {
		const scope = investigation.snapshot.scope?.trim()
		if (scope && !scope.includes(" ")) seen.add(scope)
	}
	return [...seen]
}

/** `elapsedBetween`: the run's elapsed time. */
export const elapsedBetween = (from: string, to: string | null): Elapsed | null => {
	if (!to) return null
	const start = toEpochMs(from)
	const end = toEpochMs(to)
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
	return splitDuration(end - start)
}

const BUCKETS = 32

export interface SignalWindow {
	readonly startTime: string
	readonly endTime: string
	readonly bucketSeconds: number
	readonly label: string | null
}

/** `resolveWindow`: the incident's window, or the run's; both ends real instants. */
export const signalWindowOf = (investigation: V2Investigation): SignalWindow | null => {
	const { snapshot } = investigation
	const startMs = toEpochMs(snapshot.incidentStartedAt ?? investigation.created_at)
	const endAt =
		snapshot.incidentEndedAt ??
		investigation.diagnosed_at ??
		(investigation.status === "investigating" ? null : investigation.updated_at)
	if (!endAt) return null
	const endMs = toEpochMs(endAt)
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null
	const seconds = (endMs - startMs) / 1000
	return {
		startTime: formatWarehouseDateTime(startMs),
		endTime: formatWarehouseDateTime(endMs),
		bucketSeconds: Math.max(1, Math.round(seconds / BUCKETS)),
		label: seconds >= 60 ? `${Math.round(seconds / 60)}m window` : `${Math.round(seconds)}s window`,
	}
}

/** `resolveService`: the one service the signals card can speak for. */
/** The overview is per service and environment; the busiest row for the service is the incident's. */
export const busiestRowOf = (rows: ReadonlyArray<OverviewRow>, service: string): OverviewRow | null =>
	rows
		.filter((row) => row.serviceName === service)
		.toSorted((left, right) => right.spanCount - left.spanCount)[0] ?? null

export const signalServiceOf = (investigation: V2Investigation): string | null => {
	const named = investigation.snapshot.serviceName?.trim()
	if (named) return named
	return servicesTouched(investigation)[0] ?? null
}

/** Where a trace chip sits; the tooltip trigger ids must stay unique across both. */
export type ChipPlace = "sheet" | "evidence" | "card"

export const traceTipId = (place: ChipPlace, traceId: string): string => `trace-tip-${place}-${traceId}`

/** Every trace chip trigger the page can render, and the trace each one names. */
export const traceTips = (investigation: V2Investigation): ReadonlyMap<string, string> =>
	new Map(
		(investigation.report?.evidence ?? []).flatMap((evidence) =>
			evidence.traceIds.flatMap((traceId) =>
				(["sheet", "evidence", "card"] as const).map(
					(place) => [traceTipId(place, traceId), traceId] as const,
				),
			),
		),
	)

/** `openActionIndex`: only a real non-negative integer opens the panel. */
export const openActionIndexOf = (model: Model): number | null => {
	const action = model.search.action
	return typeof action === "number" && Number.isInteger(action) && action >= 0 ? action : null
}
