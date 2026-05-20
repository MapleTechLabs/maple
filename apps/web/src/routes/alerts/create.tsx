import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Result, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { effectRoute } from "@effect-router/core"
import { Exit, Schema } from "effect"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import {
	AlertDestinationDocument,
	AlertRuleDocument,
} from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { DetailsSection } from "@/components/alerts/details-section"
import { NotificationsSection } from "@/components/alerts/notifications-section"
import { RuleActionBar } from "@/components/alerts/rule-action-bar"
import { RuleLiveChartHero } from "@/components/alerts/rule-live-chart-hero"
import { RuleTemplatesOverlay } from "@/components/alerts/rule-templates-overlay"
import { ScopeSection } from "@/components/alerts/scope-section"
import { SignalAndThresholdSection } from "@/components/alerts/signal-and-threshold-section"
import { useAlertRuleChart } from "@/hooks/use-alert-rule-chart"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import {
	AutocompleteValuesProvider,
	useAutocompleteValuesContext,
} from "@/hooks/use-autocomplete-values"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import {
	buildRuleRequest,
	buildRuleTestRequest,
	defaultRuleForm,
	getExitErrorMessage,
	isRangeComparator,
	isRulePreviewReady,
	ruleToFormState,
	signalLabels,
	type RuleFormState,
} from "@/lib/alerts/form-utils"
import { applyTemplate } from "@/lib/alerts/templates"

const AlertCreateSearch = Schema.Struct({
	serviceName: Schema.optional(Schema.String),
	ruleId: Schema.optional(Schema.String),
	/** Set by the "Create alert" action on a dashboard chart widget. */
	dashboardId: Schema.optional(Schema.String),
	widgetId: Schema.optional(Schema.String),
})

/**
 * Convert a dashboard chart widget's data source into a prefilled alert form.
 * `custom_query_builder_*` widgets become `builder_query` alerts; `raw_sql_chart`
 * widgets become `raw_query` alerts. Returns null when the widget is not a
 * query-driven chart.
 */
function widgetToRuleForm(
	widget: {
		id: string
		visualization: string
		dataSource?: { endpoint?: string; params?: unknown }
		display?: { title?: string }
	},
	base: RuleFormState,
): RuleFormState | null {
	const endpoint = widget.dataSource?.endpoint
	const params = (widget.dataSource?.params ?? {}) as Record<string, unknown>
	const name = widget.display?.title ? `Alert — ${widget.display.title}` : "Alert from chart"

	if (endpoint === "raw_sql_chart") {
		const sql = typeof params.sql === "string" ? params.sql : ""
		return { ...base, name, signalType: "raw_query", rawQuerySql: sql }
	}

	if (
		endpoint === "custom_query_builder_timeseries" ||
		endpoint === "custom_query_builder_breakdown" ||
		endpoint === "custom_query_builder_list"
	) {
		const queries = Array.isArray(params.queries) ? params.queries : []
		const query = (queries[0] ?? {}) as Record<string, unknown>
		const dataSource =
			query.dataSource === "logs" || query.dataSource === "metrics" ? query.dataSource : "traces"
		return {
			...base,
			name,
			signalType: "builder_query",
			queryDataSource: dataSource,
			queryAggregation: typeof query.aggregation === "string" ? query.aggregation : "count",
			queryWhereClause: typeof query.whereClause === "string" ? query.whereClause : "",
			groupBy: Array.isArray(query.groupBy)
				? query.groupBy.filter((g): g is string => typeof g === "string" && g !== "none")
				: [],
			metricName: typeof query.metricName === "string" ? query.metricName : base.metricName,
			metricType:
				query.metricType === "sum" ||
				query.metricType === "gauge" ||
				query.metricType === "histogram" ||
				query.metricType === "exponential_histogram"
					? query.metricType
					: base.metricType,
		}
	}

	return null
}

export const Route = effectRoute(createFileRoute("/alerts/create"))({
	component: AlertCreatePageWrapper,
	validateSearch: Schema.toStandardSchemaV1(AlertCreateSearch),
})

function AlertCreatePageWrapper() {
	const { startTime, endTime } = useEffectiveTimeRange(undefined, undefined, "24h")
	return (
		<AutocompleteValuesProvider startTime={startTime} endTime={endTime}>
			<AlertCreatePage />
		</AutocompleteValuesProvider>
	)
}

function AlertCreatePage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const destinationsQueryAtom = MapleApiAtomClient.query("alerts", "listDestinations", {
		reactivityKeys: ["alertDestinations"],
	})
	const rulesQueryAtom = MapleApiAtomClient.query("alerts", "listRules", {
		reactivityKeys: ["alertRules"],
	})
	const dashboardsQueryAtom = MapleApiAtomClient.query("dashboards", "list", {
		reactivityKeys: ["dashboards"],
	})
	const destinationsResult = useAtomValue(destinationsQueryAtom)
	const rulesResult = useAtomValue(rulesQueryAtom)
	const dashboardsResult = useAtomValue(dashboardsQueryAtom)

	const createRule = useAtomSet(MapleApiAtomClient.mutation("alerts", "createRule"), {
		mode: "promiseExit",
	})
	const updateRule = useAtomSet(MapleApiAtomClient.mutation("alerts", "updateRule"), {
		mode: "promiseExit",
	})
	const testRule = useAtomSet(MapleApiAtomClient.mutation("alerts", "testRule"), {
		mode: "promiseExit",
	})

	const autocompleteValues = useAutocompleteValuesContext()
	const serviceNameOptions = autocompleteValues.traces.services ?? []

	const destinations = Result.builder(destinationsResult)
		.onSuccess((response) => [...response.destinations] as AlertDestinationDocument[])
		.orElse(() => [])

	const rules = Result.builder(rulesResult)
		.onSuccess((response) => [...response.rules] as AlertRuleDocument[])
		.orElse(() => [])

	const editingRule = useMemo(() => {
		if (!search.ruleId) return null
		return rules.find((r) => r.id === search.ruleId) ?? null
	}, [search.ruleId, rules])

	const [ruleForm, setRuleForm] = useState<RuleFormState>(() => defaultRuleForm(search.serviceName))
	const [savingRule, setSavingRule] = useState(false)
	const [previewingRule, setPreviewingRule] = useState(false)
	const [sendingTestNotification, setSendingTestNotification] = useState(false)
	const [previewResult, setPreviewResult] = useState<{
		status: "breached" | "healthy" | "skipped"
		value: number | null
		sampleCount: number
		reason: string
	} | null>(null)
	const [initialized, setInitialized] = useState(false)

	// First-touch template picker: shown only when this is a fresh new-rule
	// entry with no pre-fills. Driven by sync `search` so it never flickers
	// open during async edit loads.
	const [templatesOpen, setTemplatesOpen] = useState(
		() =>
			!search.ruleId &&
			!search.serviceName &&
			!search.dashboardId &&
			!search.widgetId,
	)

	useEffect(() => {
		if (initialized) return
		if (editingRule) {
			setRuleForm(ruleToFormState(editingRule))
			setInitialized(true)
			return
		}
		if (search.dashboardId && search.widgetId) {
			const dashboard = Result.builder(dashboardsResult)
				.onSuccess((response) =>
					response.dashboards.find((d) => d.id === search.dashboardId),
				)
				.orElse(() => undefined)
			const widget = dashboard?.widgets.find((w) => w.id === search.widgetId)
			if (widget) {
				setRuleForm((current) => widgetToRuleForm(widget, current) ?? current)
				setInitialized(true)
			}
		}
	}, [editingRule, initialized, search.dashboardId, search.widgetId, dashboardsResult])

	const { chartData, chartLoading } = useAlertRuleChart(ruleForm)

	const validationIssues = useMemo(
		() => deriveValidationIssues(ruleForm, destinations),
		[ruleForm, destinations],
	)

	const suggestedName = useMemo(() => makeSuggestedName(ruleForm), [ruleForm])

	async function handleSave() {
		setSavingRule(true)
		const payload = buildRuleRequest(ruleForm)
		const result = editingRule
			? await updateRule({
					params: { ruleId: editingRule.id },
					payload,
					reactivityKeys: ["alertRules"],
				})
			: await createRule({ payload, reactivityKeys: ["alertRules"] })

		if (Exit.isSuccess(result)) {
			toast.success(editingRule ? "Rule updated" : "Rule created")
			navigate({ to: "/alerts", search: { tab: "rules" } })
		} else {
			toast.error(getExitErrorMessage(result, "Failed to save rule"))
		}
		setSavingRule(false)
	}

	async function runTest(sendNotification: boolean) {
		if (!isRulePreviewReady(ruleForm)) {
			toast.error("Complete the rule name and threshold before testing")
			return
		}
		const setLoading = sendNotification ? setSendingTestNotification : setPreviewingRule
		setLoading(true)
		const result = await testRule({
			payload: buildRuleTestRequest(ruleForm, sendNotification),
			reactivityKeys: ["alertDeliveryEvents"],
		})
		if (Exit.isSuccess(result)) {
			setPreviewResult(result.value)
			toast.success(
				sendNotification
					? "Preview ran and sent a test notification"
					: "Preview updated",
			)
		} else {
			toast.error(getExitErrorMessage(result, "Failed to preview rule"))
		}
		setLoading(false)
	}

	const pageTitle = editingRule ? "Edit alert rule" : "Create alert rule"

	return (
		<DashboardLayout
			breadcrumbs={[
				{ label: "Alert Rules", href: "/alerts?tab=rules" },
				{ label: editingRule ? "Edit Rule" : "New Rule" },
			]}
			titleContent={
				<div className="flex items-center gap-2">
					<h1 className="font-display text-3xl font-semibold leading-[1.1] tracking-tight truncate">
						{pageTitle}
					</h1>
					<Badge variant="secondary" className="text-xs font-medium">
						Beta
					</Badge>
				</div>
			}
		>
			<div className="mx-auto w-full max-w-[1100px] space-y-4">
				<RuleLiveChartHero
					form={ruleForm}
					chartData={chartData}
					chartLoading={chartLoading}
					onTestRule={() => runTest(false)}
					testing={previewingRule}
					previewResult={previewResult}
				/>
				{/* Two-column grid below the hero. The signal/threshold panel is the
				    dense one and takes the wider column; scope + notifications +
				    details stack in the narrower one. Single column on smaller
				    screens where horizontal real estate runs out. */}
				<div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
					<SignalAndThresholdSection form={ruleForm} onChange={setRuleForm} />
					<div className="space-y-4">
						<ScopeSection
							form={ruleForm}
							onChange={setRuleForm}
							serviceNameOptions={serviceNameOptions}
							autocompleteValues={autocompleteValues}
						/>
						<NotificationsSection
							form={ruleForm}
							onChange={setRuleForm}
							destinations={destinations}
							onSendTest={() => runTest(true)}
							testing={sendingTestNotification}
						/>
						<DetailsSection
							form={ruleForm}
							onChange={setRuleForm}
							suggestedName={suggestedName}
						/>
					</div>
				</div>
			</div>

			<RuleActionBar
				editing={!!editingRule}
				saving={savingRule}
				validationIssues={validationIssues}
				onCancel={() => navigate({ to: "/alerts", search: { tab: "rules" } })}
				onSave={handleSave}
				onShowTemplates={editingRule ? undefined : () => setTemplatesOpen(true)}
				cancelSlot={
					<Button
						type="button"
						variant="outline"
						render={<Link to="/alerts" search={{ tab: "rules" }} />}
					>
						Cancel
					</Button>
				}
			/>

			<RuleTemplatesOverlay
				open={templatesOpen}
				onOpenChange={setTemplatesOpen}
				onPick={(template) => {
					setRuleForm((current) => applyTemplate(template, current))
					setTemplatesOpen(false)
				}}
				onStartBlank={() => setTemplatesOpen(false)}
			/>
		</DashboardLayout>
	)
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Surface every fillable-but-blocking gap so the sticky bar can tell the user
 * what's missing in plain language. Superset of `isRulePreviewReady` — that
 * helper still gates the Test Rule path; this one gates the Save path.
 */
function deriveValidationIssues(
	form: RuleFormState,
	destinations: AlertDestinationDocument[],
): string[] {
	const issues: string[] = []
	if (form.name.trim().length === 0) issues.push("Rule name")
	if (!Number.isFinite(Number(form.threshold))) issues.push("Threshold")
	if (
		isRangeComparator(form.comparator) &&
		!Number.isFinite(Number(form.thresholdUpper))
	) {
		issues.push("Upper threshold")
	}
	if (form.signalType === "metric" && form.metricName.trim().length === 0) {
		issues.push("Metric name")
	}
	if (
		form.signalType === "builder_query" &&
		form.queryDataSource === "metrics" &&
		form.metricName.trim().length === 0
	) {
		issues.push("Metric name")
	}
	if (form.signalType === "raw_query") {
		const sql = form.rawQuerySql.trim()
		if (sql.length === 0) {
			issues.push("SQL query")
		} else if (!form.rawQuerySql.includes("$__orgFilter")) {
			issues.push("$__orgFilter in SQL")
		}
	}
	if (destinations.length === 0) {
		issues.push("A notification destination")
	} else if (form.destinationIds.length === 0) {
		issues.push("At least one destination")
	}
	return issues
}

/**
 * Produce a sensible default name from the form's signal + scope so the user
 * doesn't have to invent one from scratch. Returns null when the user has
 * already typed a name (so the "Suggest" affordance hides).
 */
function makeSuggestedName(form: RuleFormState): string | null {
	if (form.name.trim().length > 0) return null
	const base = signalLabels[form.signalType]
	const scope =
		form.serviceNames.length === 1
			? form.serviceNames[0]!
			: form.serviceNames.length > 1
				? `${form.serviceNames.length} services`
				: form.groupBy.length > 0
					? `per ${form.groupBy.join(" · ")}`
					: null
	return scope ? `${base} — ${scope}` : base
}
