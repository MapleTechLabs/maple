import { type DocsPage, docsUrl } from "../../lib/docs"
import type { Html, HtmlBuilder } from "foldkit/html"
import { linkButton } from "@maple/views/ui/button"
import { icon } from "@maple/views/ui/icon"
import { docsLink as kitDocsLink } from "@maple/views/ui/docs-link"
import type { PresenceState, TelemetrySignalKind } from "@maple/views/data/signal-presence"
import { emptyActions, signalEmptyState as sharedSignalEmptyState } from "@maple/views/ui/signal-empty-state"

// The dashboard's copy for `SignalEmptyState`: where each signal comes from, and the setup
// page and guides it links. Presence comes from the page's Model.

type SignalSetup = Readonly<{ source: string; action: string; setupDocs: DocsPage; guideDocs: DocsPage }>

const SIGNAL_SETUP = {
	traces: {
		source: "Send spans from an OpenTelemetry SDK in your app.",
		action: "Set up tracing",
		setupDocs: "instrumentation",
		guideDocs: "traces",
	},
	logs: {
		source: "Add an OpenTelemetry log exporter to the logger you already use; stdout alone doesn't reach Maple.",
		action: "Set up logging",
		setupDocs: "instrumentation",
		guideDocs: "logs",
	},
	metrics: {
		source: "Send them from an OpenTelemetry metric reader, a Prometheus scrape, or the Maple agent.",
		action: "Set up metrics",
		setupDocs: "instrumentation",
		guideDocs: "metrics",
	},
	sessions: {
		source: "Add the Maple browser SDK to your site.",
		action: "Set up session replay",
		setupDocs: "browserSdk",
		guideDocs: "sessionReplay",
	},
	product_events: {
		source: "Send them with track() from the Maple browser SDK.",
		action: "Set up product analytics",
		setupDocs: "productEventsApi",
		guideDocs: "webAnalytics",
	},
} satisfies Record<TelemetrySignalKind, SignalSetup>

/** `DocsLink`. */
export const docsLink = <M>(h: HtmlBuilder<M>, page: DocsPage, label = "Read the docs"): Html =>
	kitDocsLink(h, docsUrl(page), label)

export type SignalEmptyStateOptions<M> = Readonly<{
	signal: TelemetrySignalKind
	presence: PresenceState
	nowMs: number
	/** The page's zone, for the last-seen time's card. */
	timeZone: string
	noun?: string
	/** The setup button's label in place of the signal's. */
	action?: string
	/** The page's own sentence in place of the signal's, and its guide. */
	purpose?: string
	guideDocs?: DocsPage
	/** The setup guide the absent state links in place of the signal's. */
	setupDocs?: DocsPage
	isFiltered?: boolean
	/** `onClearFilters`: the Message the "Clear filters" button sends. */
	onClearFilters?: M
	onWidenRange?: M
	/** Page detail under the description (Traces' excluded-values hint); `null` renders nothing. */
	detail?: Html | null
	className?: string
}>

/** The shared `SignalEmptyState` with the dashboard's on-ramp: the ingestion settings and a setup guide. */
export const signalEmptyState = <M>(h: HtmlBuilder<M>, options: SignalEmptyStateOptions<M>): Html => {
	const setup = SIGNAL_SETUP[options.signal]
	return sharedSignalEmptyState(h, {
		...options,
		onramp: {
			source: [setup.source],
			content: [
				emptyActions(h, [
					linkButton(h, { size: "sm", className: "gap-2", href: "/settings?tab=ingestion" }, [
						icon(h, "ConnectionIcon"),
						options.action ?? setup.action,
					]),
					docsLink(h, options.setupDocs ?? setup.setupDocs, "Setup guide"),
				]),
			],
		},
		guide: docsLink(h, options.guideDocs ?? setup.guideDocs),
	})
}
