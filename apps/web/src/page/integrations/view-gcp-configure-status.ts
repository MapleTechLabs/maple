import type { V2GcpConnector } from "@maple/domain/http/v2"
import { cn } from "@maple/ui/lib/utils"
import {
	GCP_LOG_STATUS,
	GCP_METRICS_STATUS,
	gcpLogState,
	gcpMetricsState,
	gcpSetupRunning,
} from "../../components/integrations/gcp-connector-state"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "../../ui/icon"
import { spinner } from "../../ui/spinner"
import { statusDot } from "../../ui/status-dot"
import { CAPABILITIES, CAPABILITY_IDS, DOCS } from "./gcp-configure-copy"
import type { ApplyOpened, SetupMethod } from "./gcp-configure-schema"
import type { Message } from "./message"
import { externalLink } from "./view-gcp-configure-parts"
import { SMALL } from "./view-gcp-parts"

// `RunStatus` (what Maple has heard from the script) and `Applied` (the confirmed run).

type H = HtmlBuilder<Message>
type RowState = "pending" | "running" | "done"

const rowMarker = (h: H, state: RowState): Html =>
	state === "done"
		? icon(h, "CircleCheckIcon", { size: 14, className: "text-severity-info" })
		: state === "running"
			? spinner(h, "size-3.5 text-muted-foreground")
			: h.span([
					h.AriaHidden(true),
					h.Class("size-3.5 rounded-full border border-dashed border-muted-foreground/60"),
				])

const overdueHelp = (h: H): Html =>
	h.div(
		[h.Class("flex flex-col gap-2 pl-6 text-xs/5")],
		[
			h.ul(
				[h.Class("flex list-disc flex-col gap-1.5 pl-4 text-pretty text-muted-foreground")],
				[
					h.li(
						[],
						[
							h.span([h.Class("font-medium text-foreground")], ["Stopped with an error?"]),
							" Fix what it names and paste it again. It continues where it stopped.",
						],
					),
					h.li(
						[],
						[
							h.span([h.Class("font-medium text-foreground")], ["Wrong ID?"]),
							" Disconnect this connection and connect the right one. An ID can't be changed.",
						],
					),
				],
			),
			h.p([], [externalLink(h, `${DOCS}#troubleshooting`, "Troubleshooting")]),
		],
	)

/** How a setup without the script is confirmed: by the first data, as no run reports it. */
const CONFIRMED_BY = {
	logs: { done: "Confirmed: logs arrive", waiting: "Confirmed by the first log Maple receives" },
	metrics: {
		done: "Confirmed: metrics are read",
		waiting: "Confirmed by the first metrics read, within 5 minutes",
	},
} as const

/** A row per capability set up or removed, ticked as the script reports or, without it, as data arrives. */
export const runStatus = (
	h: H,
	connector: V2GcpConnector,
	options: Readonly<{ opened: ApplyOpened; overdue: boolean; nowMs: number; method: SetupMethod }>,
): Html => {
	const byScript = options.method === "script"
	const overdue = options.overdue && byScript
	// A row ticks on a report made since the step opened, not on what an earlier run left in place.
	const reported = connector.setup_reported_at !== options.opened.seen
	const running = gcpSetupRunning(connector, options.nowMs)
	const metricsState = gcpMetricsState(connector, options.nowMs)
	const rows = CAPABILITY_IDS.flatMap((capability) => {
		const { title, flag, run } = CAPABILITIES[capability]
		const wanted = connector[flag]
		const applied =
			capability === "logs" ? connector.applied_logs_enabled : connector.applied_metrics_enabled
		if (!wanted && applied !== true) return []
		const confirmed = applied === wanted
		const state: RowState =
			confirmed && (reported || !byScript) ? "done" : running || !byScript ? "running" : "pending"
		// The poller's failure, once past the grant's grace: what a setup without the script can be told.
		const error =
			!byScript && capability === "metrics" && metricsState.kind === "failing"
				? metricsState.error
				: null
		const detail = byScript
			? wanted
				? run.on
				: run.off
			: !wanted
				? "Waiting for you to confirm the removal"
				: (error ?? CONFIRMED_BY[capability][confirmed ? "done" : "waiting"])
		return [{ capability, title, detail, state, error }]
	})
	const done = rows.filter((row) => row.state === "done").length
	const reporting = done > 0 || running
	return h.div(
		[
			h.Role("status"),
			h.Class(
				cn(
					// On a phone a long error would squeeze the steps above out of view: it scrolls instead.
					"flex max-h-[40svh] shrink-0 flex-col gap-3 overflow-y-auto border-t px-6 py-4 sm:max-h-none",
					overdue && "bg-severity-warn/6",
				),
			),
		],
		[
			h.div(
				[h.Class("flex items-center gap-2.5")],
				[
					overdue
						? icon(h, "AlertWarningIcon", { size: 14, className: "shrink-0 text-severity-warn" })
						: done === rows.length
							? icon(h, "CircleCheckIcon", {
									size: 14,
									className: "shrink-0 text-severity-info",
								})
							: spinner(h, "size-3.5 shrink-0 text-severity-debug"),
					h.p(
						[h.Class(cn("text-sm font-medium", overdue && "text-severity-warn"))],
						[
							!byScript
								? done === rows.length
									? "Confirmed by the first data"
									: "Waiting for Google Cloud"
								: overdue
									? "No report from the script yet"
									: reporting
										? "The script is reporting back"
										: "Waiting for the script to report back",
						],
					),
					h.span(
						[h.Class("ml-auto shrink-0 font-mono text-xs text-muted-foreground")],
						[
							reporting
								? `${done} of ${rows.length} ${byScript ? "done" : "confirmed"}`
								: "updates on its own",
						],
					),
				],
			),
			overdue
				? overdueHelp(h)
				: h.ul(
						[h.Class("flex flex-col gap-1.5 pl-6")],
						rows.map((row) =>
							h.li(
								[
									h.Class(
										"grid grid-cols-[auto_1fr] items-center gap-x-2.5 text-xs/5 sm:grid-cols-[auto_10rem_1fr]",
									),
								],
								[
									rowMarker(h, row.state),
									h.span([h.Class("text-foreground")], [row.title]),
									h.span(
										[
											h.Class(
												cn(
													"col-start-2 text-pretty sm:col-start-auto",
													row.error === null
														? "text-muted-foreground"
														: "text-severity-error",
												),
											),
										],
										[row.detail],
									),
								],
							),
						),
					),
		],
	)
}

/** The run confirmed: what each capability is doing now, so the first data is seen landing. */
export const applied = (h: H, connector: V2GcpConnector, created: boolean, nowMs: number): Html => {
	const log = gcpLogState(connector, nowMs)
	const metrics = gcpMetricsState(connector, nowMs)
	const rows = [
		...(log.kind === "off"
			? []
			: [
					{
						title: "Logs",
						status: GCP_LOG_STATUS[log.kind],
						detail: log.kind === "waiting" ? "First entries within about 10 minutes" : null,
					},
				]),
		...(metrics.kind === "off"
			? []
			: [
					{
						title: "Metrics",
						status: GCP_METRICS_STATUS[metrics.kind],
						detail: metrics.kind === "waiting" ? "First read within about 10 minutes" : null,
					},
				]),
	]
	return h.div(
		[h.Class("flex flex-col items-center gap-5 py-2 text-center")],
		[
			h.span(
				[
					h.Class(
						"flex size-12 items-center justify-center rounded-full bg-severity-info/12 text-severity-info",
					),
				],
				[icon(h, "CheckIcon", { size: 20 })],
			),
			h.div(
				[h.Class("flex flex-col gap-1")],
				[
					h.h3(
						[h.Class("text-base font-medium")],
						created
							? [h.span([h.Class("font-mono")], [connector.scope_id]), " is connected"]
							: ["Google Cloud matches this configuration"],
					),
					h.p([h.Class(SMALL)], ["The script finished. Data shows up in Maple on its own."]),
				],
			),
			h.ul(
				[h.Class("w-full divide-y divide-border-subtle rounded-md border text-left")],
				rows.map((row) =>
					h.li(
						[h.Class("flex items-center gap-3 px-4 py-2.5")],
						[
							h.span([h.Class("w-16 shrink-0 text-sm font-medium")], [row.title]),
							h.span(
								[h.Class("min-w-0 flex-1 text-xs/5 text-muted-foreground")],
								row.detail === null ? [] : [row.detail],
							),
							h.span(
								[h.Class("flex shrink-0 items-center gap-1.5 text-xs/5")],
								[statusDot(h, { tone: row.status.tone }), row.status.label],
							),
						],
					),
				),
			),
		],
	)
}
