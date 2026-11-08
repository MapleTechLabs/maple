import type { V2Investigation } from "@maple/domain/http/v2"
import { formatDuration } from "@maple/ui/lib/format"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { type Elapsed, splitDuration } from "@maple/web-data/investigations/display"
import type { HandoffInput } from "@maple/web-data/investigations/agent-handoff"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { AppRoute, hrefOf } from "../../../route"
import { Option, Array as Arr, String as Str, Order } from "effect"
import type { Model, OverviewRow } from "./model"

export const investigationOf = (model: Model): Option.Option<V2Investigation> =>
	model.sync._tag === "Ready" ? Option.some(model.sync.investigation) : Option.none()

/** What the "Fix in Claude Code" prompt is built from; `focus` narrows it to one proposed action. */
export const handoffInputOf = (
	model: Model,
	investigation: V2Investigation,
	focus: string | null = null,
): HandoffInput => ({
	investigation,
	investigationUrl: `${model.handoff.origin}${hrefOf(AppRoute.Investigation({ id: model.id, search: {} }))}`,
	// The commit's own repository beats the org's only one: it is where the cause was found.
	repo: investigation.report?.suspectCommit?.repo ?? model.handoff.repo,
	focus,
})

export type Tab = "overview" | "evidence" | "chat" | "transcript"
export const tabOf = (model: Model): Tab => model.search.tab ?? "overview"

/** `breadcrumbLabel`: the first line, clamped to 64 characters. */
export const breadcrumbLabel = (title: string): string => {
	const line = Str.trim(Str.split("\n")(title)[0] ?? "")
	return line.length > 64 ? `${Str.trimEnd(Str.slice(0, 63)(line))}…` : line
}

/** `servicesTouched`: every service the evidence touched, the scope as fallback. */
export const servicesTouched = (investigation: V2Investigation): ReadonlyArray<string> => {
	const seen = new Set<string>()
	Arr.forEach(investigation.report?.evidence ?? [], (evidence) =>
		Arr.forEach(evidence.relatedServices, (service) => {
			const name = Str.trim(service)
			if (name) seen.add(name)
		}),
	)
	if (seen.size === 0) {
		const scope = Option.filter(
			Option.map(Option.fromNullishOr(investigation.snapshot.scope), Str.trim),
			(value) => value !== "" && !Str.includes(" ")(value),
		)
		if (Option.isSome(scope)) seen.add(scope.value)
	}
	return [...seen]
}

/** `elapsedBetween`: the run's elapsed time; from a minute up, the shared "4m 12s" form. */
export const elapsedBetween = (from: string, to: string | null): Elapsed | null => {
	if (!to) return null
	const start = toEpochMs(from)
	const end = toEpochMs(to)
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
	const ms = end - start
	return ms < 60_000 ? splitDuration(ms) : { value: formatDuration(ms), unit: "" }
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
	Option.getOrNull(
		Arr.head(
			Arr.sort(
				Arr.filter(rows, (row) => row.serviceName === service),
				Order.flip(Order.mapInput(Order.Number, (row: OverviewRow) => row.spanCount)),
			),
		),
	)

export const signalServiceOf = (investigation: V2Investigation): string | null => {
	const named = Option.filter(
		Option.map(Option.fromNullishOr(investigation.snapshot.serviceName), Str.trim),
		(value) => value !== "",
	)
	if (Option.isSome(named)) return named.value
	return servicesTouched(investigation)[0] ?? null
}

/** Where a trace chip sits; the tooltip trigger ids must stay unique across both. */
export type ChipPlace = "sheet" | "evidence" | "card"

export const traceTipId = (place: ChipPlace, traceId: string): string => `trace-tip-${place}-${traceId}`

/** Every trace chip trigger the page can render, and the trace each one names. */
export const traceTips = (investigation: V2Investigation): ReadonlyMap<string, string> =>
	new Map(
		Arr.flatMap(investigation.report?.evidence ?? [], (evidence) =>
			Arr.flatMap(evidence.traceIds, (traceId) =>
				Arr.map(
					["sheet", "evidence", "card"] as const,
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
