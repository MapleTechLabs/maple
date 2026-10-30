import type { V2ScrapeTarget, V2ScrapeTargetCheck } from "@maple/domain/http/v2"
import { EMPTY_VALUE, formatDuration, formatNumber } from "@maple/ui/lib/format"
import { diagnoseScrapeError } from "../../lib/scrape-error-diagnosis"
import { formatTimestampInTimezone } from "@maple/web-data/lib/timezone-format"
import { Option, Schema } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "../../ui/alert"
import { button } from "../../ui/button"
import { badge } from "../../ui/display"
import { emptyMessage } from "../../ui/empty"
import { errorState } from "../../ui/error-state"
import { eyebrow } from "../../ui/eyebrow"
import { icon } from "../../ui/icon"
import { keyValue, keyValueList } from "../../ui/key-value"
import { panel } from "../../ui/panel"
import { skeletonList } from "../../ui/skeleton"
import { statusDot } from "../../ui/status-dot"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../ui/table"
import { relativeTime } from "../kit/relative-time"
import { Message } from "./message"
import type { Model } from "./model"
import { hostnameOf } from "./prometheus"
import { AUTH_TYPE_LABELS, type ScheduledStatus, toneBadge } from "./view-prometheus"

// `ScrapeTargetDetails`, `MetricBox` and `ScrapeTargetChecksTable`.
// TODO(tooltip): a check's message renders its trigger; the full-message popup is the overlay port's.

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
			Object.entries(parsed).flatMap(([key, value]) =>
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
						checks.map((check) =>
							tableRow(h, [
								tableCell(
									h,
									[
										h.div(
											[h.Class("truncate font-mono")],
											[formatTimestampInTimezone(check.timestamp, { timeZone })],
										),
										...(check.message !== null && check.message !== ""
											? [
													h.div(
														[
															h.DataAttribute("base-ui-tooltip-trigger", ""),
															h.Class(
																"text-muted-foreground mt-0.5 cursor-default truncate",
															),
															h.DataAttribute("slot", "tooltip-trigger"),
														],
														[check.message],
													),
												]
											: []),
									],
									"max-w-0 min-w-[100px] pl-3",
								),
								tableCell(h, [
									h.span(
										[h.Class("flex items-center gap-1.5")],
										[
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
										],
									),
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
								h.div(
									[h.Class("flex items-center gap-2")],
									[
										statusDot(h, { tone: status.tone, size: "lg" }),
										h.h3(
											[h.Class("truncate text-sm font-semibold"), h.Title(target.name)],
											[target.name],
										),
									],
								),
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
				h.div(
					[h.Class("flex flex-wrap items-center gap-2")],
					[
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
							[icon(h, "TrashIcon"), "Delete"],
						),
					],
				),
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
											h.p([h.Class("font-medium text-foreground")], ["How to fix"]),
											h.ul(
												[h.Class("list-disc space-y-0.5 pl-4")],
												diagnosis.fixes.map((fix) => h.li([], [fix])),
											),
										],
									),
									...(failureMessage !== null && failureMessage !== ""
										? [
												h.p(
													[h.Class("font-mono text-2xs text-foreground-subtle")],
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
										labels.map(([key, value]) =>
											badge(h, { variant: "outline", className: "max-w-full" }, [
												h.span([h.Class("truncate font-mono")], [key, "=", value]),
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
						h.div(
							[h.Class("flex items-center justify-between gap-3")],
							[
								sectionTitle(h, "HistoryIcon", "Check history"),
								...(latest === null
									? []
									: [
											relativeTime(h, {
												value: latest.timestamp,
												nowMs: model.nowMs,
												timeZone,
												prefix: "Latest",
												className: "text-muted-foreground text-xs",
											}),
										]),
							],
						),
						checksTable(h, model, checks, timeZone),
					],
				),
			],
		),
	])
}

const sectionTitle = (h: H, iconName: "PulseIcon" | "ExternalLinkIcon" | "HistoryIcon", text: string): Html =>
	eyebrow(h, { variant: "label", className: "flex items-center gap-2", as: "div" }, [
		icon(h, iconName, { size: 14 }),
		text,
	])
