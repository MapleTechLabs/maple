import type React from "react"
import { Link } from "@tanstack/react-router"
import { Button } from "@maple/ui/components/ui/button"
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@maple/ui/components/ui/empty"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { DocsLink, EmptyActions } from "@/components/common/docs-link"
import type { DocsPage } from "@/lib/docs"
import {
	ChartLineIcon,
	ClockIcon,
	ConnectionIcon,
	EyeIcon,
	FileIcon,
	SlidersIcon,
	NetworkNodesIcon,
} from "@/components/icons"
import { useSignalPresence, type SignalPresence, type TelemetrySignalKind } from "@/hooks/use-signal-presence"

/**
 * The one empty state every list view should use.
 *
 * "No traces found" is the wrong sentence in three different situations, and until now the product
 * said it in all of them. This resolves which one the user is actually in and says the matching
 * thing:
 *
 *   filtered   — their filters excluded everything. Offer to clear them.
 *   absent     — they have never wired this signal up. Tell them how.
 *   present    — it is wired up and this window is quiet. Say when the last one arrived.
 *   unknown    — we could not read presence. Say nothing beyond the fact, and offer no advice:
 *                telling someone to install an SDK they already installed is worse than silence.
 *
 * Adding this to a page should be one line. Everything page-specific lives in SIGNAL_COPY below, so
 * a caller picks a signal rather than writing copy — which is what keeps thirty empty states
 * consistent instead of thirty people each inventing a sentence.
 */

interface SignalCopy {
	/** Plural noun for the thing the page lists: "traces", "log lines". */
	readonly noun: string
	readonly icon: React.ComponentType<{ size?: number; className?: string }>
	/** What the page is for, in one sentence. Shown whether or not the signal is set up. */
	readonly purpose: string
	/** What the user has to do, phrased as the thing they are missing. */
	readonly source: string
	/** Action label for the setup CTA. */
	readonly action: string
	/** How to start sending the signal. */
	readonly setupDocs: DocsPage
	/** How to use the page once data arrives. */
	readonly guideDocs: DocsPage
}

export const SIGNAL_COPY = {
	traces: {
		noun: "traces",
		icon: NetworkNodesIcon,
		purpose: "Traces show each request's path through your services, with timing for every step.",
		source: "They come from an OpenTelemetry SDK in your app, exporting to Maple's endpoint.",
		action: "Set up tracing",
		setupDocs: "instrumentation",
		guideDocs: "traces",
	},
	logs: {
		noun: "logs",
		icon: FileIcon,
		purpose: "Logs are searchable here and linked to the trace that wrote them.",
		source: "They come from an OTLP log bridge under your existing logger. Logging to stdout alone never reaches Maple.",
		action: "Set up logging",
		setupDocs: "instrumentation",
		guideDocs: "logs",
	},
	metrics: {
		noun: "metrics",
		icon: ChartLineIcon,
		purpose: "Metrics chart the counters, gauges and histograms your services and hosts report.",
		source: "They come from an OpenTelemetry metric reader, a Prometheus scrape target, or the Maple infrastructure agent.",
		action: "Set up metrics",
		setupDocs: "instrumentation",
		guideDocs: "metrics",
	},
	sessions: {
		noun: "sessions",
		icon: EyeIcon,
		purpose: "Session replay shows what a user saw and did, next to the requests their browser made.",
		source: "Sessions come from the browser SDK. Install @maple-dev/browser and call MapleBrowser.init().",
		action: "Set up session replay",
		setupDocs: "browserSdk",
		guideDocs: "sessionReplay",
	},
	product_events: {
		noun: "events",
		icon: ConnectionIcon,
		purpose: "Product events record what users do in your app, for funnels and web analytics.",
		source: "They come from track() calls in the browser SDK.",
		action: "Set up product analytics",
		setupDocs: "productEventsApi",
		guideDocs: "webAnalytics",
	},
} satisfies Record<TelemetrySignalKind, SignalCopy>

export interface SignalEmptyStateProps {
	/** Which signal this view is built on. Drives every piece of copy. */
	readonly signal: TelemetrySignalKind
	/** Override the plural noun when the page lists something narrower than the signal. */
	readonly noun?: string
	/** True when filters or a search term are narrowing the view — the most specific reason wins. */
	readonly filtered?: boolean
	readonly onClearFilters?: () => void
	/** Offered alongside "this window is quiet", when the page can widen its own range. */
	readonly onWidenRange?: () => void
	/**
	 * Page-specific detail rendered under the description — the excluded-value chips on Traces, for
	 * instance. Keep it to evidence the generic copy cannot carry; anything reusable belongs in
	 * SIGNAL_COPY instead, or thirty pages drift apart again.
	 */
	readonly detail?: React.ReactNode
	/**
	 * For pages built on a signal but about something narrower (errors, the service map, agent
	 * sessions): what this page is for, and which docs explain it. Setup advice stays the signal's.
	 */
	readonly purpose?: string
	readonly guideDocs?: DocsPage
	readonly className?: string
}

/** The whole component, minus the data fetch. Split out so it can be rendered against a known
 * presence — by its own tests, and by the component lab — without standing up an API client. */
export function SignalEmptyStateView({
	signal,
	presence,
	noun,
	filtered = false,
	onClearFilters,
	onWidenRange,
	detail,
	purpose,
	guideDocs,
	className,
}: SignalEmptyStateProps & { readonly presence: SignalPresence }): React.ReactElement {
	const copy = SIGNAL_COPY[signal]
	const subject = noun ?? copy.noun
	const pagePurpose = purpose ?? copy.purpose
	const guide = guideDocs ?? copy.guideDocs

	// Filters first: the user narrowed this themselves, so that is the explanation they are looking
	// for — even on an org that has never sent the signal, where the setup advice is also true but
	// answers a question they did not ask.
	if (filtered) {
		return (
			<Empty className={className}>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<SlidersIcon />
					</EmptyMedia>
					<EmptyTitle>No {subject} match these filters</EmptyTitle>
					<EmptyDescription>
						Everything in this time range was excluded by the current filters.
					</EmptyDescription>
				</EmptyHeader>
				{(detail !== undefined || onClearFilters !== undefined) && (
					<EmptyContent>
						{detail}
						{onClearFilters !== undefined && (
							<Button variant="outline" size="sm" onClick={onClearFilters}>
								Clear filters
							</Button>
						)}
					</EmptyContent>
				)}
			</Empty>
		)
	}

	if (presence.status === "absent") {
		const Icon = copy.icon
		return (
			<Empty className={className}>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<Icon />
					</EmptyMedia>
					<EmptyTitle>No {subject} yet</EmptyTitle>
					<EmptyDescription>
						{pagePurpose} {copy.source}
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					{detail}
					<EmptyActions>
						<Button
							size="sm"
							className="gap-2"
							render={<Link to="/settings" search={{ tab: "ingestion" }} />}
						>
							<ConnectionIcon size={14} />
							{copy.action}
						</Button>
						<DocsLink page={copy.setupDocs}>Setup guide</DocsLink>
						{guide !== copy.setupDocs && <DocsLink page={guide} />}
					</EmptyActions>
				</EmptyContent>
			</Empty>
		)
	}

	if (presence.status === "present") {
		return (
			<Empty className={className}>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<ClockIcon />
					</EmptyMedia>
					<EmptyTitle>No {subject} in this time range</EmptyTitle>
					<EmptyDescription>
						{/* Phrased against the signal's own noun, never the page's override: on
						    Services the page lists services but the timestamp describes traces, and
						    "your most recent service arrived" is nonsense. */}
						{presence.lastSeen === null
							? `Maple is receiving ${copy.noun}, just none in the selected window.`
							: `Maple last received ${copy.noun} ${formatRelativeTime(presence.lastSeen)}. Widen the range to see them.`}
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					{detail}
					<EmptyActions>
						{onWidenRange !== undefined && (
							<Button variant="outline" size="sm" onClick={onWidenRange}>
								Widen time range
							</Button>
						)}
						<DocsLink page={guide} />
					</EmptyActions>
				</EmptyContent>
			</Empty>
		)
	}

	// Presence unreadable, or still loading. State the fact and stop.
	return (
		<Empty className={className}>
			<EmptyHeader>
				<EmptyTitle>No {subject} found</EmptyTitle>
				<EmptyDescription>{pagePurpose}</EmptyDescription>
			</EmptyHeader>
			<EmptyContent>
				{detail}
				<DocsLink page={guide} />
			</EmptyContent>
		</Empty>
	)
}

export function SignalEmptyState(props: SignalEmptyStateProps): React.ReactElement {
	return <SignalEmptyStateView {...props} presence={useSignalPresence(props.signal)} />
}
