import type { V2ScrapeTarget, V2ScrapeTargetCheck } from "@maple/domain/http/v2"
import { EMPTY_VALUE, formatDuration, formatNumber } from "@maple/ui/lib/format"
import { diagnoseScrapeError } from "../../lib/scrape-error-diagnosis"
import { formatTimestampInTimezone } from "@maple/web-data/lib/timezone-format"
import { Option, Schema, Array as Arr, Record as Rec } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { heading } from "@maple/views/ui/heading"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { button } from "@maple/views/ui/button"
import { badge } from "@maple/views/ui/display"
import { emptyMessage } from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { keyValue, keyValueList } from "@maple/views/ui/key-value"
import { panel } from "@maple/views/ui/panel"
import { skeletonList } from "@maple/views/ui/skeleton"
import { statusDot } from "@maple/views/ui/status-dot"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "@maple/views/ui/table"
import { relativeTime } from "../kit/relative-time"
import { Message } from "./message"
import type { Model } from "./model"
import { hostnameOf } from "./prometheus"
import { AUTH_TYPE_LABELS, type ScheduledStatus, toneBadge } from "./view-prometheus"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack, hstackClass } from "@maple/views/ui/stack"
import { tooltipTrigger } from "@maple/views/ui/tooltip-host"

// `ScrapeTargetDetails`, `MetricBox` and `ScrapeTargetChecksTable`.

type H = HtmlBuilder<Message>

const durationOf = (value: number | null) => (value === null ? EMPTY_VALUE : formatDuration(value * 1000))
const countOf = (value: number | null) => (value === null ? EMPTY_VALUE : formatNumber(Math.round(value)))

/** `scheduledStatusFromChecks` (only its label and tone are drawn here). */
const statusFromChecks = (
	target: V2ScrapeTarget,
	latest: V2ScrapeTargetCheck | null,
	isLoading: boolean,
	isUnavailable: boolean,
): ScheduledStatus => {
	if (!target.enabled) return { label: "Disabled", detail: "", tone: "neutral" }
	if (isLoading) return { label: "Checking", detail: "", tone: "neutral" }
	if (isUnavailable) return { label: "Unavailable", detail: "", tone: "neutral" }
	if (latest === null) return { label: "No checks", detail: "", tone: "warn" }
	return latest.success
		? { label: "Up", detail: "", tone: "ok" }
		: { label: "Down", detail: "", tone: "crit" }
}

const decodeLabels = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)
const isString = Schema.is(Schema.String)

/** `labelEntries`: the string labels of `labels_json`, an empty list when it does not parse. */
const labelEntries = (labelsJson: string | null): ReadonlyArray<readonly [string, string]> => {
	if (labelsJson === null || labelsJson === "") return []
	return Option.match(decodeLabels(labelsJson), {
		onNone: () => [],
		onSome: (parsed) =>
			Arr.flatMap(Rec.toEntries(parsed), ([key, value]) =>
				isString(value) ? [[key, value] as const] : [],
			),
	})
}

const metricBox = (h: H, label: string, value: string): Html =>
	panel(h, { tone: "background", className: "px-3 py-2" }, [
		eyebrow(h, { as: "div" }, [label]),
		h.div([h.Class("mt-1 font-mono text-sm")], [value]),
	])

const checksTable = (
	h: H,
	model: Model,
	checks: ReadonlyArray<V2ScrapeTargetCheck>,
	timeZone: string,
): Html =>
	AsyncData.match(model.prometheusCard.checks.data, {
		onIdle: () => skeletonList(h, { rows: 3, gap: "2" }),
		onLoading: () => skeletonList(h, { rows: 3, gap: "2" }),
		onFailure: (failure) =>
			errorState(h, { failure, title: "Couldn't load scheduled checks", variant: "row" }),
		onStale: ({ error }) =>
			errorState(h, { failure: error, title: "Couldn't load scheduled checks", variant: "row" }),
		onRefreshing: () => checksRows(h, checks, timeZone),
		onSuccess: () => checksRows(h, checks, timeZone),
	})

const checksRows = (h: H, checks: ReadonlyArray<V2ScrapeTargetCheck>, timeZone: string): Html =>
	checks.length === 0
		? emptyMessage(h, { className: "rounded-md border bg-background/35 px-3 py-6" }, [
				"The first scrape runs shortly after you save. Use Test to check the endpoint now.",
			])
		: panel(h, { tone: "background" }, [
				table(h, { size: "sm" }, [
					tableHeader(h, [
						tableRow(h, [
							tableHead(h, ["Time"], "w-full pl-3"),
							tableHead(h, ["State"], "w-16"),
							tableHead(h, ["Duration"], "w-16"),
							tableHead(h, ["Samples"], "w-20 pr-3"),
						]),
					]),
					tableBody(
						h,
						Arr.map(checks, (check) =>
							tableRow(h, [
								tableCell(
									h,
									[
										typography(h, { mono: true, truncate: true, as: "div" }, [
											formatTimestampInTimezone(check.timestamp, { timeZone }),
										]),
										...(check.message !== null && check.message !== ""
											? [
													h.div(
														[
															h.DataAttribute("base-ui-tooltip-trigger", ""),
															h.Class(
																"text-muted-foreground mt-0.5 cursor-default truncate",
															),
															h.DataAttribute("slot", "tooltip-trigger"),
															h.Tabindex(0),
															...tooltipTrigger(h, check.message),
														],
														[check.message],
													),
												]
											: []),
									],
									"max-w-0 min-w-[100px] pl-3",
								),
								tableCell(h, [
									hstack(h, { gap: "1.5", as: "span" }, [
										check.success
											? icon(h, "CircleCheckIcon", {
													size: 12,
													className: "text-severity-info",
												})
											: icon(h, "CircleXmarkIcon", {
													size: 12,
													className: "text-severity-error",
												}),
										h.span([], [check.success ? "up" : "down"]),
									]),
								]),
								tableCell(h, [durationOf(check.duration_seconds)], "font-mono"),
								tableCell(h, [countOf(check.samples_scraped)], "pr-3 font-mono"),
							]),
						),
					),
				]),
			])

/** `ScrapeTargetDetails`: the selected target's header, diagnosis, scheduled scrape, target and history. */
export const targetDetails = (h: H, model: Model, target: V2ScrapeTarget, timeZone: string): Html => {
	const card = model.prometheusCard
	const data = card.checks.data
	const checks = AsyncData.isSuccess(data) || AsyncData.isRefreshing(data) ? data.data : []
	const latest = checks[0] ?? null
	const status = statusFromChecks(
		target,
		latest,
		AsyncData.isIdle(data) || AsyncData.isLoading(data),
		AsyncData.isFailure(data) || AsyncData.isStale(data),
	)
	const labels = labelEntries(target.labels_json)
	const failureMessage = latest !== null && !latest.success ? latest.message : target.last_scrape_error
	const diagnosis = diagnoseScrapeError(failureMessage, target.target_type)
	const isManaged = target.managed_by !== null
	const formatDate = (value: string) => formatTimestampInTimezone(value, { timeZone })
	return panel(h, {}, [
		h.div(
			[h.Class("space-y-3 border-b p-4")],
			[
				h.div(
					[h.Class("flex items-start justify-between gap-3")],
					[
						h.div(
							[h.Class("min-w-0")],
							[
								hstack(h, { gap: "2" }, [
									statusDot(h, { tone: status.tone, size: "lg" }),
									heading(
										h,
										{
											level: 3,
											variant: "section",
											className: "truncate",
											attributes: [h.Title(target.name)],
										},
										[target.name],
									),
								]),
								h.p(
									[
										h.Class(
											"text-muted-foreground mt-1 line-clamp-2 break-all font-mono text-xs",
										),
										h.Title(target.url),
									],
									[target.url],
								),
							],
						),
						badge(h, { variant: toneBadge(status.tone) }, [status.label]),
					],
				),
				hstack(h, { gap: "2", wrap: true }, [
					button(
						h,
						{
							variant: "outline",
							size: "sm",
							isLoading: card.probing.includes(target.id),
							attributes: [h.OnClick(Message.ClickedProbe({ id: target.id }))],
						},
						[icon(h, "BoltIcon"), "Test"],
					),
					button(
						h,
						{
							variant: "outline",
							size: "sm",
							isDisabled: isManaged,
							attributes: [h.OnClick(Message.ClickedEditTarget({ id: target.id }))],
						},
						[icon(h, "PencilIcon"), "Edit"],
					),
					button(
						h,
						{
							variant: "ghost",
							size: "sm",
							isDisabled: card.toggling.includes(target.id),
							attributes: [h.OnClick(Message.ClickedToggleTarget({ id: target.id }))],
						},
						[target.enabled ? "Disable" : "Enable"],
					),
					button(
						h,
						{
							variant: "ghost",
							size: "sm",
							className: "text-destructive",
							isDisabled: isManaged,
							attributes: [h.OnClick(Message.ClickedDeleteTarget({ id: target.id }))],
						},
						[icon(h, "TrashIcon"), "Delete scrape target"],
					),
				]),
			],
		),
		h.div(
			[h.Class("space-y-5 p-4")],
			[
				...(diagnosis === null
					? []
					: [
							alert(h, { variant: diagnosis.severity }, [
								icon(h, "CircleWarningIcon", { size: 16 }),
								alertTitle(h, [diagnosis.title]),
								alertDescription(h, [
									h.p([], [diagnosis.summary]),
									h.div(
										[h.Class("space-y-1")],
										[
											typography(h, { tone: "foreground", weight: "medium", as: "p" }, [
												"How to fix",
											]),
											h.ul(
												[h.Class("list-disc space-y-0.5 pl-4")],
												Arr.map(diagnosis.fixes, (fix) => h.li([], [fix])),
											),
										],
									),
									...(failureMessage !== null && failureMessage !== ""
										? [
												typography(
													h,
													{ size: "2xs", tone: "subtle", mono: true, as: "p" },
													[failureMessage],
												),
											]
										: []),
								]),
							]),
						]),
				h.section(
					[h.Class("space-y-2")],
					[
						sectionTitle(h, "PulseIcon", "Scheduled scrape"),
						h.div(
							[h.Class("grid grid-cols-2 gap-2 text-xs")],
							[
								metricBox(h, "Interval", `${target.scrape_interval_seconds}s`),
								metricBox(
									h,
									"Duration",
									latest === null ? EMPTY_VALUE : durationOf(latest.duration_seconds),
								),
								metricBox(
									h,
									"Samples",
									latest === null ? EMPTY_VALUE : countOf(latest.samples_scraped),
								),
								metricBox(
									h,
									"Post relabel",
									latest === null
										? EMPTY_VALUE
										: countOf(latest.samples_post_metric_relabeling),
								),
							],
						),
					],
				),
				h.section(
					[h.Class("space-y-2")],
					[
						sectionTitle(h, "ExternalLinkIcon", "Target"),
						keyValueList(
							h,
							{ divided: true, className: "rounded-md border bg-background/35 px-3" },
							[
								keyValue(h, { label: "Service" }, [target.service_name ?? target.name]),
								keyValue(h, { label: "Instance" }, [hostnameOf(target.url)]),
								keyValue(h, { label: "Auth" }, [AUTH_TYPE_LABELS[target.auth_type]]),
								keyValue(h, { label: "Target ID", mono: true }, [target.id]),
								keyValue(h, { label: "Created" }, [formatDate(target.created_at)]),
								keyValue(h, { label: "Updated" }, [formatDate(target.updated_at)]),
							],
						),
						...(labels.length > 0
							? [
									h.div(
										[h.Class("flex flex-wrap gap-1.5 pt-1")],
										Arr.map(labels, ([key, value]) =>
											badge(h, { variant: "outline", className: "max-w-full" }, [
												typography(h, { mono: true, truncate: true }, [
													key,
													"=",
													value,
												]),
											]),
										),
									),
								]
							: []),
					],
				),
				h.section(
					[h.Class("space-y-2")],
					[
						hstack(h, { gap: "3", justify: "between" }, [
							sectionTitle(h, "HistoryIcon", "Check history"),
							...(latest === null
								? []
								: [
										relativeTime(h, {
											value: latest.timestamp,
											nowMs: model.nowMs,
											timeZone,
											prefix: "Latest",
											className: typographyClass({ size: "xs", tone: "muted" }),
										}),
									]),
						]),
						checksTable(h, model, checks, timeZone),
					],
				),
			],
		),
	])
}

const sectionTitle = (h: H, iconName: "PulseIcon" | "ExternalLinkIcon" | "HistoryIcon", text: string): Html =>
	eyebrow(h, { variant: "label", className: hstackClass({ gap: "2" }), as: "div" }, [
		icon(h, iconName, { size: 14 }),
		text,
	])
