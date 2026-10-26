import { cn } from "@maple/ui/lib/utils"
import { formatAlertTime } from "@maple/web-data/alerts/form-utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as CopyButton from "../../../ui/copy-button"
import { copyableField } from "../../../ui/copyable-field"
import { eyebrow } from "../../../ui/eyebrow"
import { panel, panelHeader } from "../../../ui/panel"
import { traceHref, uptimeTracesHref, UPTIME_SERVICE } from "../shared/uptime-commands"
import {
	formatEvery,
	formatMs,
	formatShare,
	p95,
	type UptimeMonitor,
	uptimeShare,
} from "../shared/uptime-derive"
import { Message } from "./message"
import type { Model } from "./model"
import { uptimePanelBody } from "../shared/uptime-view"

// The monitor page's panels: response time, the checks list and the side panels.

type H = HtmlBuilder<Message>

const CHECK_ROWS = 15

/** A key/value row in a side panel. */
const fact = (h: H, label: string, value: Html | string, valueClass?: string): Html =>
	h.div(
		[h.Class("flex items-baseline justify-between gap-3 px-4 py-2.5 text-sm")],
		[
			h.span([h.Class("shrink-0 whitespace-nowrap text-muted-foreground")], [label]),
			h.span([h.Class(cn("min-w-0 break-words text-right tabular-nums", valueClass))], [value]),
		],
	)

/** One bar per recent check, height by duration; failed checks in the destructive colour. */
export const responseTimePanel = (h: H, monitor: UptimeMonitor): Html => {
	const recent = monitor.state.recent
	const max = Math.max(1, ...recent.map((check) => check.duration_ms ?? 0))
	return panel(h, {}, [
		panelHeader(h, {
			title: "Response time",
			action: h.span(
				[h.Class("text-xs text-muted-foreground tabular-nums")],
				[`p95 over the last ${recent.length} checks: ${formatMs(p95(recent))}`],
			),
		}),
		uptimePanelBody(h, [
			recent.length === 0
				? h.p(
						[h.Class("py-8 text-center text-sm text-muted-foreground")],
						["No checks yet. The first one runs shortly."],
					)
				: h.div(
						[
							h.Role("img"),
							h.AriaLabel(`Response time of the last ${recent.length} checks`),
							h.Class("flex h-36 items-end justify-end gap-0.5"),
						],
						recent.map((check, index) =>
							h.span(
								[
									h.Key(`${check.at}-${index}`),
									h.Title(`${formatMs(check.duration_ms)}${check.ok ? "" : ", failed"}`),
									h.Class(
										cn(
											"min-w-0 max-w-4 flex-1 rounded-t-[1px]",
											check.ok ? "bg-severity-info/80" : "bg-destructive",
										),
									),
									h.Style({
										// No recorded duration is the minimum sliver, never the tallest bar.
										height: `${Math.max(4, ((check.duration_ms ?? 0) / max) * 100)}%`,
									}),
								],
								[],
							),
						),
					),
		]),
	])
}

type CheckRow = Readonly<{
	at: string
	ok: boolean
	statusCode: number | null
	durationMs: number | null
	result: string
	traceId: string | null
}>

/** Newest first: the last check carries the status, error and trace; the rest only pass or fail. */
const checkRows = (monitor: UptimeMonitor): ReadonlyArray<CheckRow> => {
	const last = monitor.state.last_check
	const recent = [...monitor.state.recent].reverse()
	return recent.slice(0, CHECK_ROWS).map((check): CheckRow =>
		last !== null && last.at === check.at
			? {
					at: last.at,
					ok: last.ok,
					statusCode: last.status_code,
					durationMs: last.duration_ms,
					result: last.ok ? "OK" : (last.error ?? "Failed"),
					traceId: last.trace_id,
				}
			: {
					at: check.at,
					ok: check.ok,
					statusCode: null,
					durationMs: check.duration_ms,
					result: check.ok ? "OK" : "Failed",
					traceId: null,
				},
	)
}

const CHECK_GRID = "grid grid-cols-[90px_64px_90px_minmax(0,1fr)_80px] items-center gap-3"

export const checksPanel = (h: H, monitor: UptimeMonitor, timeZone: string): Html => {
	const rows = checkRows(monitor)
	return panel(h, {}, [
		panelHeader(h, {
			title: "Checks",
			action: h.a(
				[h.Href(uptimeTracesHref()), h.Class("text-xs text-primary hover:underline")],
				["View all checks in Traces"],
			),
		}),
		h.p(
			[h.Class("px-4 pb-2 text-xs text-muted-foreground")],
			[`Each check is a span in the ${UPTIME_SERVICE} service.`],
		),
		h.div(
			[h.Class(cn(CHECK_GRID, "border-y px-4 py-2"))],
			[
				eyebrow(h, {}, ["Time"]),
				eyebrow(h, {}, ["Status"]),
				eyebrow(h, {}, ["Duration"]),
				eyebrow(h, {}, ["Result"]),
				eyebrow(h, { className: "text-right" }, ["Trace"]),
			],
		),
		rows.length === 0
			? h.p([h.Class("px-4 py-6 text-sm text-muted-foreground")], ["No checks yet."])
			: h.ul(
					[h.Class("divide-y")],
					rows.map((row, index) =>
						h.li(
							[h.Key(`${row.at}-${index}`), h.Class(cn(CHECK_GRID, "px-4 py-2 text-sm"))],
							[
								h.span(
									[h.Class("font-mono text-xs text-muted-foreground")],
									[formatAlertTime(row.at, timeZone)],
								),
								h.span(
									[
										h.Class(
											cn(
												"font-mono text-xs",
												row.ok ? "text-success" : "text-destructive",
											),
										),
									],
									[
										row.statusCode === null
											? row.ok
												? "Pass"
												: "Fail"
											: String(row.statusCode),
									],
								),
								h.span(
									[h.Class("font-mono text-xs tabular-nums")],
									[formatMs(row.durationMs)],
								),
								h.span([h.Class("truncate text-xs text-muted-foreground")], [row.result]),
								row.traceId === null
									? h.span([h.Class("text-right text-xs text-muted-foreground")], ["–"])
									: h.a(
											[
												h.Href(traceHref(row.traceId)),
												h.Class(
													"text-right font-mono text-xs text-primary hover:underline",
												),
											],
											[`${row.traceId.slice(0, 4)}…${row.traceId.slice(-4)}`],
										),
							],
						),
					),
				),
	])
}

/** "every 1d, 30m grace", or the cron line and its time zone. */
const heartbeatExpectation = (config: Extract<UptimeMonitor["config"], { type: "heartbeat" }>): string => {
	const schedule =
		config.schedule.type === "interval"
			? `every ${formatEvery(config.schedule.seconds)}`
			: `cron ${config.schedule.expression} (${config.schedule.timezone})`
	return `${schedule}, ${formatEvery(config.grace_seconds)} grace`
}

export const lastCheckPanel = (h: H, monitor: UptimeMonitor): Html => {
	const last = monitor.state.last_check
	const result =
		last === null
			? "No check yet"
			: last.status_code !== null
				? String(last.status_code)
				: last.ok
					? "Passed"
					: "Failed"
	const config = monitor.config
	const isHeartbeat = config.type === "heartbeat"
	return panel(h, { className: "divide-y" }, [
		panelHeader(h, { title: "Last check" }),
		fact(h, "Result", result, last !== null && !last.ok ? "text-destructive" : undefined),
		...(isHeartbeat ? [] : [fact(h, "Duration", formatMs(last?.duration_ms ?? null))]),
		fact(h, "Probe", isHeartbeat ? "Your job" : "Ashburn, US"),
		config.type === "heartbeat"
			? fact(h, "Expected", heartbeatExpectation(config))
			: fact(
					h,
					"Down after",
					`${monitor.failures_to_down} failed ${monitor.failures_to_down === 1 ? "check" : "checks in a row"}`,
				),
		...(last === null || last.ok || last.error === null
			? []
			: [h.p([h.Class("px-4 py-2.5 text-sm text-destructive")], [last.error])]),
	])
}

export const availabilityPanel = (h: H, monitor: UptimeMonitor): Html => {
	const share = uptimeShare(monitor.state.recent)
	return panel(h, {}, [
		panelHeader(h, { title: "Availability" }),
		uptimePanelBody(h, [
			h.p(
				[
					h.Class(
						cn(
							"font-mono text-2xl tabular-nums",
							share !== null && share < 1 ? "text-severity-warn" : undefined,
						),
					),
				],
				[formatShare(share)],
			),
			h.p(
				[h.Class("mt-1 text-xs text-muted-foreground")],
				[`Over the last ${monitor.state.recent.length} checks`],
			),
		]),
	])
}

export const setupPanel = (h: H, model: Model, monitor: UptimeMonitor, serviceHref: string | null): Html => {
	const count = monitor.destination_ids.length
	// `null` until destinations sync: the count, rather than calling every one unavailable.
	const destinations = model.destinations
	const notifies =
		count === 0
			? "Nobody yet. The incident still opens in the inbox."
			: destinations === null
				? `${count} ${count === 1 ? "destination" : "destinations"}`
				: monitor.destination_ids
						.map(
							(id) =>
								destinations.find((row) => row.id === id)?.name ?? "Unavailable destination",
						)
						.join(", ")
	return panel(h, { className: "divide-y" }, [
		panelHeader(h, { title: "Setup" }),
		h.div(
			[h.Class("px-4 py-3")],
			[eyebrow(h, {}, ["Notifies"]), h.p([h.Class("mt-1 text-sm")], [notifies])],
		),
		h.div(
			[h.Class("px-4 py-3")],
			[
				eyebrow(h, {}, ["Service"]),
				h.p(
					[h.Class("mt-1 text-sm")],
					[
						serviceHref === null || monitor.service_name === null
							? "Not linked to a service"
							: h.a(
									[h.Href(serviceHref), h.Class("text-primary hover:underline")],
									[monitor.service_name],
								),
					],
				),
			],
		),
	])
}

const snippet = (h: H, model: Model, id: string, label: string, value: string): Html =>
	copyableField(h, {
		id: `uptime-snippet-${id}`,
		label,
		value,
		copy: model.copies[id] ?? CopyButton.init(),
		toCopyMessage: (message) => Message.GotCopyMessage({ id, message }),
	})

/** The ping URL and the lines a job adds: success, failure, and a crontab entry. */
export const heartbeatPanel = (h: H, model: Model, pingUrl: string): Html =>
	panel(h, {}, [
		panelHeader(h, { title: "Ping URL" }),
		uptimePanelBody(h, [
			h.p(
				[h.Class("mb-3 text-sm text-muted-foreground")],
				["Send a GET or POST here when the job succeeds. Add /fail to report a failure right away."],
			),
			h.div(
				[h.Class("flex flex-col gap-3")],
				[
					snippet(h, model, "url", "Ping URL", pingUrl),
					snippet(
						h,
						model,
						"success",
						"After the job succeeds",
						`curl -fsS -m 10 --retry 3 ${pingUrl}`,
					),
					snippet(
						h,
						model,
						"fail",
						"When the job fails",
						`curl -fsS -m 10 --retry 3 ${pingUrl}/fail`,
					),
					snippet(
						h,
						model,
						"crontab",
						"Crontab",
						`0 2 * * * /path/to/job.sh && curl -fsS -m 10 ${pingUrl} || curl -fsS -m 10 ${pingUrl}/fail`,
					),
				],
			),
		]),
	])
