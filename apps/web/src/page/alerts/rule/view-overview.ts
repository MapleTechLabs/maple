import type { AlertRuleDocument } from "@maple/domain/http"
import { formatSql } from "../../../lib/sql-format"
import { tokenizeSql } from "../../../lib/sql-highlight"
import { cn } from "@maple/ui/lib/utils"
import { SIGNAL_SOURCE_LABEL } from "@maple/web-data/alerts/chart-series"
import { comparatorLabels, formatSignalValue, ruleToFormState, signalLabels } from "@maple/web-data/alerts/form-utils"
import { Array as Arr, Option } from "effect"
import { AsyncData } from "foldkit"
import type { LoadFailure } from "../../../data/load-failure"
import type { Html, HtmlBuilder } from "foldkit/html"
import { isChartRuntimeReady } from "../../../charts/chart-runtime"
import { button } from "../../../ui/button"
import { card, cardPanel } from "../../../ui/card"
import { badge } from "../../../ui/display"
import { errorState } from "../../../ui/error-state"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { keyValue, keyValueList } from "../../../ui/key-value"
import { panel } from "../../../ui/panel"
import { segmentedSelect } from "../../../ui/segmented-select"
import { skeleton } from "../../../ui/skeleton"
import { alertStatusBadge } from "../shared/badges"
import { previewIssue, previewStateOf } from "../shared/preview"
import { ruleChart } from "../shared/rule-chart"
import {
	chartChecksOf,
	checksPageOf,
	destinationsOf,
	formatBucketSpan,
	payloadOf,
	rangeLabelOf,
	ruleDeliveriesOf,
	ruleIncidentsOf,
	timelineRangeOf,
} from "./derive"
import { Message } from "./message"
import type { Model, SignalSource } from "./model"
import { checksPanel } from "./view-checks"
import { diagnosisPanel } from "./view-diagnosis"
import { queryTimeCard } from "./view-query-time"
import { sectionHeading } from "../../kit/section-heading"

// The rule detail's Overview tab.

type H = HtmlBuilder<Message>

const SIGNAL_SOURCE_DESCRIPTION = new Map<SignalSource, string>([
	["preview", "The rule's query, replayed now over the selected window."],
	["checks", "What the evaluator actually observed and stored, one point per check."],
])

/** `tierCondition`: one tier's condition, e.g. "> 2.00% (recovers < 1.50%)". */
const tierCondition = (rule: AlertRuleDocument, tier: AlertRuleDocument["thresholds"][number]): string => {
	const value = (n: number) => formatSignalValue(rule.signalType, n)
	const bound = tier.upper === null ? value(tier.value) : `${value(tier.value)} – ${value(tier.upper)}`
	const healthy = rule.comparator === "gt" || rule.comparator === "gte" ? "<" : ">"
	const recovery = tier.recoveryValue === null ? "" : ` (recovers ${healthy} ${value(tier.recoveryValue)})`
	return `${comparatorLabels[rule.comparator]} ${bound}${recovery}`
}

const configRow = (h: H, label: string, children: ReadonlyArray<Html | string>, isWide = false): Html =>
	keyValue(h, { label, wrap: true, className: cn("items-center", isWide && "sm:col-span-2") }, children)

const badgeList = (h: H, values: ReadonlyArray<string>, className: string): Html =>
	h.div(
		[h.Class("flex flex-wrap gap-1 justify-end")],
		values.map((value) => badge(h, { variant: "outline", className }, [value])),
	)

const configuration = (h: H, rule: AlertRuleDocument): Html =>
	h.div(
		[h.Class("space-y-3")],
		[
			sectionHeading(h, { title: "Configuration" }),
			card(h, [
				cardPanel(
					h,
					[
						keyValueList(h, { className: "grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2" }, [
							...(rule.notes
								? [
										h.div(
											[h.Class("flex flex-col gap-1 sm:col-span-2")],
											[
												h.dt([h.Class("text-muted-foreground")], ["Notes"]),
												h.dd([h.Class("whitespace-pre-wrap text-foreground")], [rule.notes]),
											],
										),
									]
								: []),
							configRow(h, "Signal", [h.span([h.Class("font-medium")], [signalLabels[rule.signalType]])]),
							configRow(h, "Scope", [
								rule.serviceNames?.length > 0
									? badgeList(h, rule.serviceNames, "text-xs")
									: h.div(
											[h.Class("flex flex-wrap gap-1 justify-end")],
											[
												h.span(
													[h.Class("font-mono font-medium")],
													[
														rule.groupBy && rule.groupBy.length > 0
															? `all (per ${rule.groupBy.join(" · ")})`
															: "all",
													],
												),
											],
										),
							]),
							configRow(h, "Environments", [
								rule.environments?.length > 0
									? badgeList(h, rule.environments, "text-xs")
									: h.div(
											[h.Class("flex flex-wrap gap-1 justify-end")],
											[h.span([h.Class("font-mono font-medium")], ["all"])],
										),
							]),
							...(rule.excludeServiceNames?.length > 0
								? [configRow(h, "Excluded", [badgeList(h, rule.excludeServiceNames, "text-xs line-through")])]
								: []),
							...rule.thresholds.map((tier) =>
								configRow(h, tier.severity === "critical" ? "Critical" : "Warning", [
									h.span(
										[h.Class("font-mono font-medium")],
										[tierCondition(rule, tier), " / ", String(rule.windowMinutes), "min"],
									),
								]),
							),
							configRow(h, "Breaches to fire", [
								h.span(
									[h.Class("font-medium tabular-nums")],
									[
										rule.breachesOutOf === null
											? `${rule.consecutiveBreachesRequired} in a row`
											: `${rule.consecutiveBreachesRequired} of last ${rule.breachesOutOf}`,
									],
								),
							]),
							configRow(h, "Healthy to resolve", [
								h.span([h.Class("font-medium tabular-nums")], [String(rule.consecutiveHealthyRequired)]),
							]),
							configRow(h, "Min samples", [
								h.span([h.Class("font-medium tabular-nums")], [String(rule.minimumSampleCount)]),
							]),
							configRow(h, "Renotify interval", [
								h.span([h.Class("font-medium")], [String(rule.renotifyIntervalMinutes), "min"]),
							]),
							...(rule.signalType === "builder_query" && rule.queryBuilderDraft
								? [
										configRow(h, "Data source", [
											h.span([h.Class("font-mono font-medium capitalize")], [rule.queryBuilderDraft.dataSource ?? ""]),
										]),
										configRow(h, "Aggregation", [
											h.span([h.Class("font-mono font-medium")], [rule.queryBuilderDraft.aggregation ?? ""]),
										]),
										...(rule.queryBuilderDraft.whereClause
											? [
													configRow(
														h,
														"Where",
														[h.span([h.Class("font-mono font-medium text-right")], [rule.queryBuilderDraft.whereClause])],
														true,
													),
												]
											: []),
									]
								: []),
							...(rule.signalType === "raw_query" && rule.rawQuerySql
								? [
										h.div(
											[h.Class("flex flex-col gap-1.5 sm:col-span-2")],
											[
												h.dt([h.Class("text-muted-foreground")], ["Raw SQL"]),
												h.dd(
													[],
													[
														h.pre(
															[
																h.Class(
																	"overflow-x-auto whitespace-pre rounded-md border bg-muted/30 px-3 py-2.5 font-mono text-xs leading-relaxed",
																),
															],
															[
																h.code(
																	[],
																	tokenizeSql(formatSql(rule.rawQuerySql)).map((token) =>
																		h.span([h.Key(String(token.start)), ...(token.className === undefined ? [] : [h.Class(token.className)])], [token.text]),
																	),
																),
															],
														),
													],
												),
											],
										),
									]
								: []),
							configRow(h, "Destinations", [
								h.span([h.Class("font-medium")], [String(rule.destinationIds.length), " configured"]),
							]),
							configRow(h, "Status", [
								alertStatusBadge(h, rule.enabled ? "ok" : "disabled", {
									label: rule.enabled ? "Enabled" : "Disabled",
								}),
							]),
						]),
					],
					"p-5",
				),
			]),
		],
	)

/** `Result.builder(checksResult).onError(...)`: the checks read's failure, if any. */
const checksFailureOf = (model: Model): Option.Option<LoadFailure> =>
	AsyncData.match(model.checks.data, {
		onIdle: () => Option.none(),
		onLoading: () => Option.none(),
		onRefreshing: () => Option.none(),
		onSuccess: () => Option.none(),
		onStale: ({ error }) => Option.some(error),
		onFailure: (error) => Option.some(error),
	})

export const overviewTab = (h: H, model: Model, rule: AlertRuleDocument, timeZone: string): Html => {
	const ruleIncidents = ruleIncidentsOf(model)
	const openIncidents = ruleIncidents.filter((i) => i.status === "open")
	const page = checksPageOf(model)
	const checks = page?.checks ?? []
	const chartChecks = chartChecksOf(rule, page)
	const payload = payloadOf(model, rule)
	const preview = previewStateOf(model.preview, payload._tag === "Some", previewIssue(ruleToFormState(rule)))
	const isPreviewAvailable = (preview.preview?.series ?? []).some((s) => s.points.some((p) => p.value != null))
	const isChecksAvailable = chartChecks.some((c) => c.observedValue != null)
	const rangeLabel = rangeLabelOf(model)
	const railCoverage = `60 buckets · covers all of ${rangeLabel.toLowerCase()}${
		page != null ? ` · ${formatBucketSpan(page.summary.bucketSeconds)} each` : ""
	}`
	const overviewIncident = ruleIncidents.find((i) => i.status === "open") ?? ruleIncidents[0] ?? null
	const isChartReady = model.themeColors !== null && isChartRuntimeReady(model.chartRuntime)
	const isChecksLoading = AsyncData.isIdle(model.checks.data) || AsyncData.isLoading(model.checks.data)

	return h.div(
		[h.Class("space-y-6")],
		[
			diagnosisPanel(h, model, {
				rule,
				states: (model.states ?? []).filter((row) => row.rule_id === rule.id),
				checks,
				openIncidents,
				destinations: destinationsOf(model),
				deliveryEvents: ruleDeliveriesOf(model),
				now: model.nowMs,
				timeZone,
			}),
			...Arr.fromNullishOr(queryTimeCard(h, rule, checks)),
			h.div(
				[h.Class("space-y-3")],
				[
					h.div(
						[h.Class("flex flex-wrap items-end justify-between gap-x-4 gap-y-2")],
						[
							h.div(
								[h.Class("space-y-1")],
								[
									eyebrow(h, { as: "h2", className: "mb-0 block" }, [
										`${signalLabels[rule.signalType]}: ${rangeLabel}`,
									]),
									h.p(
										[h.Class("text-muted-foreground text-xs")],
										[SIGNAL_SOURCE_DESCRIPTION.get(model.signalSource) ?? ""],
									),
								],
							),
							segmentedSelect(h, {
								options: [
									{ value: "preview" as const, label: SIGNAL_SOURCE_LABEL.preview, isDisabled: !isPreviewAvailable },
									{ value: "checks" as const, label: SIGNAL_SOURCE_LABEL.checks, isDisabled: !isChecksAvailable },
								],
								value: model.signalSource,
								onChange: (source) => Message.ClickedSignalSource({ source }),
								size: "sm",
								ariaLabel: "Chart data source",
							}),
						],
					),
					ruleChart(h, {
						chartId: "alert-rule-chart",
						chart: model.chart,
						toChartMessage: (message) => Message.GotChartMessage({ message }),
						colors: model.themeColors ?? {},
						timeZone,
						preview: preview.preview,
						checks: chartChecks,
						incidents: ruleIncidents,
						threshold: rule.threshold,
						thresholdUpper: rule.thresholdUpper,
						criticalThreshold: rule.thresholds[1]?.value ?? null,
						comparator: rule.comparator,
						signalType: rule.signalType,
						window: timelineRangeOf(model),
						source: model.signalSource,
						railCoverage,
						selectedBucket: model.selectedBucket?.index ?? null,
						onSelectBucket: (index) => Message.ClickedRailBucket({ index }),
						isLoading:
							preview.isLoading || !isChartReady || (rule.signalType === "raw_query" && isChecksLoading),
						error: preview.error,
					}),
				],
			),
			model.incidents === null
				? skeleton(h, "h-40 w-full")
				: overviewIncident === null
					? h.empty
					: panel(h, { className: "flex-row items-center justify-between gap-4 px-4 py-3" }, [
							h.div(
								[h.Class("min-w-0")],
								[
									eyebrow(h, { variant: "label", as: "p" }, ["Investigation"]),
									h.p(
										[h.Class("truncate text-sm")],
										["Review the latest incident in a durable evidence workspace."],
									),
								],
							),
							button(
								h,
								{
									size: "sm",
									attributes: [h.OnClick(Message.ClickedOpenInvestigation({ incidentId: overviewIncident.id }))],
								},
								[icon(h, "ChatBubbleSparkleIcon"), "Open investigation"],
							),
						]),
			configuration(h, rule),
			Option.match(checksFailureOf(model), {
				onSome: (failure) =>
					h.div(
						[h.Class("space-y-4")],
						[
							sectionHeading(h, { title: "Checks" }),
							errorState(h, { failure, title: "Failed to load checks", onRetry: Message.ClickedReload() }),
						],
					),
				onNone: () => checksPanel(h, model, { rule, page, isLoading: isChecksLoading, timeZone }),
			}),
		],
	)
}
