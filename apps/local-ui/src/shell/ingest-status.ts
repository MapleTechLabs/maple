import { formatRelativeFrom } from "@maple/ui/lib/time-format"
import { TONE_BORDER, TONE_SOFT, type Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { statusDot } from "@maple/web/ui/status-dot"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { MISSES_BEFORE_DOWN, type ServerState } from "../server/state"

// The ingest status: is the server up, and is telemetry arriving?

/** Newer than this reads as live: wider than the default metric export interval (60 s). */
const FRESH_MS = 90_000

type IngestTone = "live" | "idle" | "warn" | "down"

interface PillState {
	readonly tone: IngestTone
	readonly label: string
	readonly title: string
}

const STATUS_TONE = { live: "ok", idle: "neutral", warn: "warn", down: "crit" } satisfies Record<
	IngestTone,
	Tone
>

/** `describeStatus`: the label and tone for one status. */
export const describeStatus = (maybeState: Option.Option<ServerState>, port: string): PillState => {
	if (Option.isNone(maybeState))
		return { tone: "idle", label: "Connecting", title: `Looking for Maple Local on port ${port}` }
	const data = maybeState.value
	const last = data.lastIngestAtMs
	const lastLabel = last === null ? null : formatRelativeFrom(last, data.checkedAtMs)
	if (data.reachability === "refused")
		return data.misses >= MISSES_BEFORE_DOWN || !data.hasConnected
			? {
					tone: "down",
					label: "Offline",
					title: `Nothing is answering on port ${port}. Is maple start running?`,
				}
			: { tone: "warn", label: "Reconnecting", title: `Maple Local on port ${port} stopped answering` }
	if (data.reachability === "rejected")
		return {
			tone: "down",
			label: `Refused (${data.rejection?.status ?? "4xx"})`,
			title: data.rejection?.detail || "Maple Local refused this page",
		}
	if (data.reachability === "failing")
		return {
			tone: "warn",
			label: "Server error",
			title: data.rejection?.detail || `Maple Local answered ${data.rejection?.status ?? "5xx"}`,
		}
	if (data.reachability === "busy")
		return {
			tone: "warn",
			label: "Busy",
			title: "Maple Local is running a slow query and will answer when it finishes",
		}
	if (last !== null && data.checkedAtMs - last < FRESH_MS)
		return { tone: "live", label: "Receiving", title: `Last telemetry arrived ${lastLabel}` }
	if (lastLabel !== null)
		return {
			tone: "idle",
			label: `Last data ${lastLabel}`,
			title: `Connected on port ${port}. Nothing new has arrived since ${lastLabel}.`,
		}
	return {
		tone: "idle",
		label: "Waiting for data",
		title: data.legacy
			? `Connected on port ${port}. No spans or logs in the last 10 minutes.`
			: `Connected on port ${port}. Nothing has been sent since the server started.`,
	}
}

export const ingestStatus = <M>(
	h: HtmlBuilder<M>,
	maybeState: Option.Option<ServerState>,
	port: string,
): Html => {
	const state = describeStatus(maybeState, port)
	return h.span(
		[
			h.Title(state.title),
			h.Class(
				cn(
					"inline-flex min-w-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium tabular-nums group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0",
					TONE_SOFT[STATUS_TONE[state.tone]],
					TONE_BORDER[STATUS_TONE[state.tone]],
				),
			),
		],
		[
			statusDot(h, { tone: STATUS_TONE[state.tone] }),
			h.span([h.Class("truncate group-data-[collapsible=icon]:sr-only")], [state.label]),
			h.span([h.Class("sr-only")], [". ", state.title]),
		],
	)
}
