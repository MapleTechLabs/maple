// The empty state every list uses. "No traces" means three different things:
// filters excluded everything, this window is quiet, or nothing was ever sent.
// Each gets its own sentence; the last one is the on-ramp.

import type { ComponentType, ReactNode } from "react"
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@maple/ui/components/ui/empty"
import { Button } from "@maple/ui/components/ui/button"
import {
	ClockIcon,
	CodeIcon,
	EyeIcon,
	FilterIcon,
	NetworkNodesIcon,
	PulseIcon,
} from "@maple/ui/components/icons"
import { formatRelativeFrom } from "@maple/ui/lib/time-format"
import { useSignalPresence, type TelemetrySignal } from "../hooks/use-signal-presence"
import { resolveRange, WIDEST_RANGE } from "../lib/time"
import { ConnectGuide } from "./connect-guide"

interface SignalCopy {
	readonly noun: string
	readonly icon: ComponentType<{ className?: string }>
	/** What produces this signal, phrased as the thing that is missing. */
	readonly source: ReactNode
}

const SIGNAL_COPY = {
	traces: {
		noun: "traces",
		icon: NetworkNodesIcon,
		source: "Traces come from an OpenTelemetry SDK in your app, exporting to this endpoint.",
	},
	logs: {
		noun: "logs",
		icon: CodeIcon,
		source: "Logs come from an OTLP log bridge under your logger. Printing to stdout alone never reaches Maple.",
	},
	metrics: {
		noun: "metrics",
		icon: PulseIcon,
		source: "Metrics come from an OpenTelemetry metric reader exporting to this endpoint.",
	},
	sessions: {
		noun: "sessions",
		icon: EyeIcon,
		source: (
			<>
				Sessions come from the browser SDK: install{" "}
				<code className="rounded bg-muted px-1 font-mono text-[0.85em]">@maple-dev/browser</code> and
				call{" "}
				<code className="rounded bg-muted px-1 font-mono text-[0.85em]">MapleBrowser.init()</code>{" "}
				with this endpoint.
			</>
		),
	},
} satisfies Record<TelemetrySignal, SignalCopy>

export interface SignalEmptyStateProps {
	readonly signal: TelemetrySignal
	/** Override the noun when the page lists something narrower than the signal ("services"). */
	readonly noun?: string
	/** Filters or a search are narrowing the view: the most specific reason wins. */
	readonly filtered?: boolean
	readonly onClearFilters?: () => void
	/** The selected range key; "widen" is offered while it is not already the widest. */
	readonly range: string
	readonly onWidenRange?: () => void
	/** Page-specific evidence under the description, like the active drill-down. */
	readonly detail?: ReactNode
}

export function SignalEmptyState({
	signal,
	noun,
	filtered = false,
	onClearFilters,
	range,
	onWidenRange,
	detail,
}: SignalEmptyStateProps) {
	const presence = useSignalPresence(signal)
	const copy = SIGNAL_COPY[signal]
	const subject = noun ?? copy.noun
	const canWiden = onWidenRange !== undefined && range !== WIDEST_RANGE

	if (filtered) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<FilterIcon />
					</EmptyMedia>
					<EmptyTitle>No {subject} match these filters</EmptyTitle>
					<EmptyDescription>
						Nothing in the {resolveRange(range).label} window matched. Clear the filters
						{canWiden ? " or widen the range" : ""} to see more.
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					{detail}
					<div className="flex flex-wrap items-center justify-center gap-2">
						{onClearFilters ? (
							<Button variant="outline" size="sm" onClick={onClearFilters}>
								Clear filters
							</Button>
						) : null}
						{canWiden ? (
							<Button variant="ghost" size="sm" onClick={onWidenRange}>
								Widen to 30 days
							</Button>
						) : null}
					</div>
				</EmptyContent>
			</Empty>
		)
	}

	if (presence.status === "absent") {
		const Icon = copy.icon
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<Icon />
					</EmptyMedia>
					<EmptyTitle>No {subject} yet</EmptyTitle>
					<EmptyDescription>{copy.source}</EmptyDescription>
				</EmptyHeader>
				<EmptyContent className="w-full max-w-md">
					{detail}
					<ConnectGuide />
				</EmptyContent>
			</Empty>
		)
	}

	if (presence.status === "present") {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<ClockIcon />
					</EmptyMedia>
					<EmptyTitle>No {subject} in this time range</EmptyTitle>
					<EmptyDescription>
						{/* The timestamp describes the signal, so it uses the signal's noun. */}
						{presence.lastSeenMs === null
							? `Maple has ${copy.noun}, just none in the selected window.`
							: `Maple last received ${copy.noun} ${formatRelativeFrom(presence.lastSeenMs)}.`}
					</EmptyDescription>
				</EmptyHeader>
				{detail !== undefined || canWiden ? (
					<EmptyContent>
						{detail}
						{canWiden ? (
							<Button variant="outline" size="sm" onClick={onWidenRange}>
								Widen to 30 days
							</Button>
						) : null}
					</EmptyContent>
				) : null}
			</Empty>
		)
	}

	// Presence unknown (loading or unreadable): state the fact, give no advice.
	return (
		<Empty className="h-full">
			<EmptyHeader>
				<EmptyTitle>No {subject} found</EmptyTitle>
			</EmptyHeader>
			{detail !== undefined ? <EmptyContent>{detail}</EmptyContent> : null}
		</Empty>
	)
}
