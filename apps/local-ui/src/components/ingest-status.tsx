// Header status pill: is the local server up, and is telemetry arriving? Uses
// the server's own last-ingest time (arrival, any signal), so a metrics-only
// app reads as live and a replayed old trace does not.

import type { ReactNode } from "react"
import { formatRelativeFrom } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import { TONE_BORDER, TONE_SOFT, type Tone } from "@maple/ui/lib/tone"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import {
	MISSES_BEFORE_DOWN,
	useLocalServerStatus,
	type LocalServerState,
} from "../hooks/use-local-server-status"
import { localServerPort } from "../lib/constants"

/**
 * Data newer than this reads as live. Wider than the default metric export
 * interval (60s), so a metrics-only app does not flap between states.
 */
const FRESH_MS = 90_000

type IngestTone = "live" | "idle" | "warn" | "down"

interface PillState {
	readonly tone: IngestTone
	readonly label: string
	readonly title: string
}

export function describeStatus(data: LocalServerState | undefined, port: string): PillState {
	if (!data) return { tone: "idle", label: "Connecting", title: `Looking for Maple Local on port ${port}` }
	const last = data.lastIngestAtMs
	const lastLabel = last === null ? null : formatRelativeFrom(last, data.checkedAtMs)
	switch (data.reachability) {
		case "refused":
			return data.misses >= MISSES_BEFORE_DOWN || !data.hasConnected
				? {
						tone: "down",
						label: "Offline",
						title: `Nothing is answering on port ${port}. Is maple start running?`,
					}
				: {
						tone: "warn",
						label: "Reconnecting",
						title: `Maple Local on port ${port} stopped answering`,
					}
		case "rejected":
			return {
				tone: "down",
				label: `Refused (${data.rejection?.status ?? "4xx"})`,
				title: data.rejection?.detail || "Maple Local refused this page",
			}
		case "failing":
			return {
				tone: "warn",
				label: "Server error",
				title: data.rejection?.detail || `Maple Local answered ${data.rejection?.status ?? "5xx"}`,
			}
		case "busy":
			return {
				tone: "warn",
				label: "Busy",
				title: "Maple Local is running a slow query and will answer when it finishes",
			}
		case "connected":
			if (last !== null && data.checkedAtMs - last < FRESH_MS) {
				return { tone: "live", label: "Receiving", title: `Last telemetry arrived ${lastLabel}` }
			}
			if (lastLabel !== null) {
				return {
					tone: "idle",
					label: `Last data ${lastLabel}`,
					title: `Connected on port ${port}. Nothing new has arrived since ${lastLabel}.`,
				}
			}
			return {
				tone: "idle",
				label: "Waiting for data",
				title: data.legacy
					? `Connected on port ${port}. No spans or logs in the last 10 minutes.`
					: `Connected on port ${port}. Nothing has been sent since the server started.`,
			}
	}
}

export function IngestStatus() {
	const { data } = useLocalServerStatus()
	const state = describeStatus(data, localServerPort())
	return (
		<span
			title={state.title}
			className={cn(
				"inline-flex min-w-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium tabular-nums",
				TONE_SOFT[STATUS_TONE[state.tone]],
				TONE_BORDER[STATUS_TONE[state.tone]],
			)}
		>
			<Dot tone={state.tone} />
			<span className="truncate">{state.label}</span>
			<span className="sr-only">. {state.title}</span>
		</span>
	)
}

const STATUS_TONE = {
	live: "ok",
	idle: "neutral",
	warn: "warn",
	down: "crit",
} satisfies Record<IngestTone, Tone>

function Dot({ tone }: { tone: IngestTone }): ReactNode {
	return <StatusDot tone={STATUS_TONE[tone]} />
}
