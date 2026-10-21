import { formatPercent } from "@maple/ui/lib/format"
import type { Tone } from "@maple/ui/lib/tone"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"
import type { SupabaseProjectRow } from "./model"

// One verdict per project, shared by the overview, the project page and the integration card.

/** A peak at or over this share of its limit marks the project degraded. */
export const SATURATION = 0.9
/** A 5xx share at or over this, once the window has `MIN_REQUESTS`, marks the project degraded. */
export const ERROR_RATE_LIMIT = 0.05
const MIN_REQUESTS = 20

/** Supabase's lifecycle status: running, paused, or a transitional or failed state to name. */
export type Lifecycle =
	| { readonly _tag: "Running" }
	| { readonly _tag: "Paused" }
	| { readonly _tag: "Other"; readonly label: string; readonly tone: "warn" | "crit" }

/** `COMING_UP` reads "Coming up". */
const sentenceCase = (status: string): string => {
	const sentence = status
		.toLowerCase()
		.split("_")
		.filter((word) => word !== "")
		.join(" ")
	return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}

export const lifecycleOf = (status: string): Lifecycle => {
	if (status === "ACTIVE_HEALTHY") return { _tag: "Running" }
	if (status === "INACTIVE" || status === "PAUSING") return { _tag: "Paused" }
	if (status === "ACTIVE_UNHEALTHY") return { _tag: "Other", label: "Unhealthy", tone: "crit" }
	return { _tag: "Other", label: sentenceCase(status), tone: status.endsWith("_FAILED") ? "crit" : "warn" }
}

export type ProjectHealth =
	| { readonly _tag: "Healthy" }
	| { readonly _tag: "Degraded"; readonly reason: string }
	| { readonly _tag: "Paused" }
	| { readonly _tag: "Lifecycle"; readonly label: string; readonly tone: "warn" | "crit" }

/** Why a running project is degraded, worst signal first; `null` when nothing crosses a limit. */
export const degradedReason = (row: SupabaseProjectRow): string | null => {
	const limit = row.maxConnections
	if (limit !== null && row.connectionsMax >= limit * SATURATION) return "near its connection limit"
	if (row.requests >= MIN_REQUESTS && row.errors5xx / row.requests >= ERROR_RATE_LIMIT)
		return `${formatPercent(row.errors5xx / row.requests)} of API requests fail with 5xx`
	if (row.cpuMax >= SATURATION) return `CPU peaked at ${formatPercent(row.cpuMax)}`
	if (row.memoryMax >= SATURATION) return `memory peaked at ${formatPercent(row.memoryMax)}`
	if (row.diskUsedMax >= SATURATION) return `disk ${formatPercent(row.diskUsedMax)} full`
	return null
}

/**
 * An unknown connection limit skips that rule. Paused when Supabase says so; a transitional or failed lifecycle as Supabase names it; degraded
 * when a running project's window crosses a limit (`degradedReason`); else healthy.
 */
export const projectHealth = (status: string | null, row: SupabaseProjectRow | null): ProjectHealth => {
	const lifecycle: Lifecycle = status === null ? { _tag: "Running" } : lifecycleOf(status)
	if (lifecycle._tag === "Paused") return { _tag: "Paused" }
	if (lifecycle._tag === "Other") return { _tag: "Lifecycle", label: lifecycle.label, tone: lifecycle.tone }
	const reason = row === null ? null : degradedReason(row)
	return reason === null ? { _tag: "Healthy" } : { _tag: "Degraded", reason }
}

/** The one-line why for a project that is not healthy, `null` for a healthy one. */
export const healthReason = (name: string, health: ProjectHealth): string | null => {
	switch (health._tag) {
		case "Healthy":
			return null
		case "Degraded":
			return `${name} ${health.reason}`
		case "Paused":
			return `${name} is paused`
		case "Lifecycle":
			return `${name} is ${health.label.toLowerCase()}`
	}
}

const pillOf = (
	health: ProjectHealth,
): Readonly<{ label: string; variant: "ok" | "warn" | "crit" | "muted" }> => {
	switch (health._tag) {
		case "Healthy":
			return { label: "Healthy", variant: "ok" }
		case "Degraded":
			return { label: "Degraded", variant: "warn" }
		case "Paused":
			return { label: "Paused", variant: "muted" }
		case "Lifecycle":
			return { label: health.label, variant: health.tone }
	}
}

export const healthPill = <M>(h: HtmlBuilder<M>, health: ProjectHealth): Html => {
	const pill = pillOf(health)
	return badge(
		h,
		{
			variant: pill.variant,
			className: "shrink-0",
			attributes: health._tag === "Degraded" ? [h.Title(health.reason)] : [],
		},
		[pill.label],
	)
}

/** What Maple collects for a project: "Metrics · Logs", one of them, or "Off". */
export const collectingLabel = (project: {
	readonly metricsEnabled: boolean
	readonly logsEnabled: boolean
}): string => {
	const parts = [...(project.metricsEnabled ? ["Metrics"] : []), ...(project.logsEnabled ? ["Logs"] : [])]
	return parts.length === 0 ? "Off" : parts.join(" · ")
}

/** An OTLP severity number as the issue lists read it: 13 WARN, 17 ERROR, 21 FATAL. */
export const severityOf = (severityNumber: number): Readonly<{ label: string; tone: Tone }> =>
	severityNumber >= 21
		? { label: "FATAL", tone: "crit" }
		: severityNumber >= 17
			? { label: "ERROR", tone: "crit" }
			: { label: "WARN", tone: "warn" }

/** `postgres_logs` reads "postgres", `edge_logs` "edge". */
export const logSourceLabel = (source: string): string => source.replace(/_logs$/, "")
