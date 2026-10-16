import {
	useDeferredValue,
	useMemo,
	useState,
	type Dispatch,
	type ReactNode,
	type SetStateAction,
} from "react"

import type { AlertSignalType } from "@maple/domain/http"
import { rawAlertSampleCountWarning } from "@maple/domain/raw-sql"
import { Button } from "@maple/ui/components/ui/button"
import { Card } from "@maple/ui/components/ui/card"
import { InlineCode } from "@maple/ui/components/ui/inline-code"
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
	InputGroupText,
} from "@maple/ui/components/ui/input-group"
import { RadioGroupPrimitive, RadioPrimitive } from "@maple/ui/components/ui/radio-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { cn } from "@maple/ui/lib/utils"

import { EnvironmentCombobox, ServiceCombobox } from "@/components/alerts/service-combobox"
import {
	ArrowTrendUpIcon,
	CircleCheckIcon,
	CircleXmarkIcon,
	ClockIcon,
	PulseIcon,
	type IconComponent,
} from "@/components/icons"
import { SegmentedSelect } from "@/components/common/segmented-select"
import { QueryPanel } from "@/components/dashboard-builder/config/query-panel"
import { RawSqlEditorPanel } from "@/components/dashboard-builder/config/raw-sql-editor-panel"
import { GroupByMultiSelect } from "@/components/query-builder/group-by-multi-select"
import type { AutocompleteValuesContextType } from "@/hooks/use-autocomplete-values"
import { RAW_QUERY_REDUCER_LABELS, type RuleFormState } from "@/lib/alerts/form-utils"
import { signalTypeToKind, switchSignalKind, type SignalKind } from "@/lib/alerts/rule-modes"
import { Result, useAtomValue } from "@/lib/effect-atom"
import {
	resetAggregationForMetricType,
	resetQueryForDataSource,
	type QueryBuilderDataSource,
	type QueryBuilderQueryDraft,
} from "@maple/query-engine/query-builder"
import { disabledResultAtom } from "@/lib/services/atoms/disabled-result-atom"
import { listMetricsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"

interface RuleQuerySectionProps {
	form: RuleFormState
	onChange: Dispatch<SetStateAction<RuleFormState>>
	autocompleteValues: AutocompleteValuesContextType
	serviceNameOptions: string[]
	environmentOptions: string[]
}

const KIND_OPTIONS: ReadonlyArray<{ value: SignalKind; label: string }> = [
	{ value: "builtin", label: "Built-in" },
	{ value: "builder_query", label: "Query builder" },
	{ value: "raw_query", label: "SQL" },
]

const KIND_HINT = {
	builtin: "Five common signals on root spans. Switching modes carries the filters over.",
	builder_query: "Same builder as dashboards. Switching to Built-in keeps what it can express.",
	raw_query: "ClickHouse SQL, replayed per evaluation window.",
} satisfies Record<SignalKind, string>

const BUILTIN_SIGNALS: ReadonlyArray<{
	value: AlertSignalType
	label: string
	hint: string
	icon: IconComponent
}> = [
	{ value: "error_rate", label: "Error rate", hint: "failed / all", icon: CircleXmarkIcon },
	{ value: "p95_latency", label: "P95", hint: "latency", icon: ClockIcon },
	{ value: "p99_latency", label: "P99", hint: "tail latency", icon: ArrowTrendUpIcon },
	{ value: "apdex", label: "Apdex", hint: "satisfaction", icon: CircleCheckIcon },
	{ value: "throughput", label: "Throughput", hint: "requests / window", icon: PulseIcon },
]

/**
 * The rule's query, in one of three modes over the same draft: Built-in is a
 * form for the canned trace signals, Query builder is the dashboard
 * `QueryPanel`, SQL is the raw editor. Switching carries filters and keeps the
 * threshold's meaning (`switchSignalKind`).
 */
export function RuleQuerySection(props: RuleQuerySectionProps) {
	const { form, onChange } = props
	const kind = signalTypeToKind(form.signalType)
	// Set by the switch itself (an event), cleared by the next one.
	const [notice, setNotice] = useState<string | null>(null)

	const setKind = (next: SignalKind) => {
		const moved = switchSignalKind(form, next)
		setNotice(moved.notice)
		onChange(moved.form)
	}

	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-center gap-3">
				<SegmentedSelect<SignalKind>
					options={KIND_OPTIONS}
					value={kind}
					onChange={setKind}
					aria-label="Query mode"
					size="sm"
				/>
				<p className="min-w-0 flex-1 text-xs text-muted-foreground">{notice ?? KIND_HINT[kind]}</p>
			</div>
			{kind === "builtin" && (
				<BuiltinQueryForm {...props} onOpenBuilder={() => setKind("builder_query")} />
			)}
			{kind === "builder_query" && <AlertQueryPanel {...props} />}
			{kind === "raw_query" && <RawQueryEditor form={form} onChange={onChange} />}
		</div>
	)
}

/* -------------------------------------------------------------------------- */
/*  Built-in                                                                  */
/* -------------------------------------------------------------------------- */

function BuiltinQueryForm({
	form,
	onChange,
	autocompleteValues,
	serviceNameOptions,
	environmentOptions,
	onOpenBuilder,
}: RuleQuerySectionProps & { onOpenBuilder: () => void }) {
	const hasServices = form.serviceNames.length > 0
	return (
		<Card className="gap-0 overflow-hidden p-0">
			<RadioGroupPrimitive
				value={form.signalType}
				onValueChange={(value: AlertSignalType) => onChange((c) => ({ ...c, signalType: value }))}
				aria-label="Built-in signal"
				className="grid grid-cols-2 border-b sm:grid-cols-5"
			>
				{BUILTIN_SIGNALS.map((signal) => (
					<RadioPrimitive.Root
						key={signal.value}
						value={signal.value}
						className={cn(
							"group flex cursor-pointer flex-col items-start gap-0.5 border-b-2 border-transparent px-3 py-2.5 text-left",
							"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
							"data-[checked]:border-primary data-[checked]:bg-muted/40",
							"[&:not([data-checked])]:hover:bg-muted/20",
						)}
					>
						<span className="flex items-center gap-1.5 text-sm font-medium">
							<signal.icon size={14} className="shrink-0 text-muted-foreground group-data-[checked]:text-primary" />
							{signal.label}
						</span>
						<span className="pl-5 text-2xs text-muted-foreground">{signal.hint}</span>
					</RadioPrimitive.Root>
				))}
			</RadioGroupPrimitive>

			<div className="space-y-2 p-3">
				<BuiltinRow label="Services" htmlFor="rule-services">
					<ServiceCombobox
						id="rule-services"
						serviceNames={form.serviceNames}
						options={serviceNameOptions}
						onChange={(values) =>
							onChange((c) => ({
								...c,
								serviceNames: values,
								// Each named service is already its own group, and exclude only
								// narrows "all services".
								groupBy: values.length > 0 ? [] : c.groupBy,
								excludeServiceNames: values.length > 0 ? [] : c.excludeServiceNames,
							}))
						}
						placeholder={hasServices ? "Add service..." : "All services"}
					/>
				</BuiltinRow>
				<BuiltinRow label="Environment" htmlFor="rule-environments">
					<EnvironmentCombobox
						id="rule-environments"
						environments={form.environments}
						options={environmentOptions}
						onChange={(values) => onChange((c) => ({ ...c, environments: values }))}
					/>
				</BuiltinRow>
				<BuiltinRow
					label="Split by"
					htmlFor="rule-group-by"
					hint={hasServices ? "Each selected service is already its own group." : undefined}
				>
					<GroupByMultiSelect
						id="rule-group-by"
						dataSource="traces"
						value={form.groupBy}
						onChange={(values) => onChange((c) => ({ ...c, groupBy: values }))}
						attributeKeys={autocompleteValues.traces?.attributeKeys}
						placeholder="service.name"
						className="w-full"
						disabled={hasServices}
					/>
				</BuiltinRow>
				<BuiltinRow label="Exclude" htmlFor="rule-exclude">
					<ServiceCombobox
						id="rule-exclude"
						serviceNames={form.excludeServiceNames}
						options={serviceNameOptions}
						onChange={(values) => onChange((c) => ({ ...c, excludeServiceNames: values }))}
						disabled={hasServices}
						placeholder={hasServices ? "Only applies to all services" : "Skip these services"}
					/>
				</BuiltinRow>
				{form.signalType === "apdex" && (
					<BuiltinRow label="Apdex target" htmlFor="apdex-threshold">
						<InputGroup className="w-40">
							<InputGroupInput
								id="apdex-threshold"
								type="number"
								inputMode="numeric"
								value={form.apdexThresholdMs}
								onChange={(e) =>
									onChange((c) => ({ ...c, apdexThresholdMs: e.target.value }))
								}
								controlClassName="font-mono tabular-nums"
							/>
							<InputGroupAddon align="inline-end">
								<InputGroupText>ms</InputGroupText>
							</InputGroupAddon>
						</InputGroup>
					</BuiltinRow>
				)}
			</div>

			<div className="flex flex-wrap items-center justify-between gap-2 border-t border-dashed px-3 py-2 text-xs text-muted-foreground">
				<span>
					Measured on root spans. A service that records failures on child spans and returns success
					from its entry point stays healthy here.
				</span>
				<Button type="button" variant="link" size="xs" onClick={onOpenBuilder}>
					Open in query builder
				</Button>
			</div>
		</Card>
	)
}

function BuiltinRow({
	label,
	htmlFor,
	hint,
	children,
}: {
	label: string
	htmlFor: string
	hint?: string
	children: ReactNode
}) {
	return (
		<div className="grid items-start gap-1 sm:grid-cols-[120px_minmax(0,1fr)] sm:gap-3">
			<label htmlFor={htmlFor} className="pt-2 text-sm text-muted-foreground">
				{label}
			</label>
			<div className="min-w-0 space-y-1">
				{children}
				{hint && <p className="text-2xs text-muted-foreground">{hint}</p>}
			</div>
		</div>
	)
}

/* -------------------------------------------------------------------------- */
/*  Query builder                                                             */
/* -------------------------------------------------------------------------- */

type MetricRow = {
	metricName: string
	metricType: string
	serviceName: string
	isMonotonic: boolean
}

function useAlertMetricSelectionOptions(query: QueryBuilderQueryDraft) {
	const [metricSearch, setMetricSearch] = useState("")
	const deferredMetricSearch = useDeferredValue(metricSearch)
	const metricsResult = useAtomValue(
		query.dataSource === "metrics"
			? listMetricsResultAtom({ data: { limit: 100, search: deferredMetricSearch || undefined } })
			: disabledResultAtom(),
	)

	const metricRows = useMemo(
		(): MetricRow[] =>
			Result.builder(metricsResult)
				.onSuccess((response) => (response as { data: MetricRow[] }).data)
				.orElse(() => []),
		[metricsResult],
	)

	const metricSelectionOptions = useMemo(() => {
		const seen = new Set<string>()
		const options: Array<{ value: string; label: string; isMonotonic: boolean }> = []
		for (const row of metricRows) {
			if (
				row.metricType !== "sum" &&
				row.metricType !== "gauge" &&
				row.metricType !== "histogram" &&
				row.metricType !== "exponential_histogram"
			) {
				continue
			}
			const value = `${row.metricName}::${row.metricType}`
			if (seen.has(value)) continue
			seen.add(value)
			options.push({
				value,
				label: `${row.metricName} (${row.metricType})`,
				isMonotonic: row.isMonotonic,
			})
		}
		return options
	}, [metricRows])

	return { metricSelectionOptions, setMetricSearch }
}

function AlertQueryPanel({ form, onChange, autocompleteValues }: RuleQuerySectionProps) {
	const query = form.queryBuilderDraft
	const { metricSelectionOptions, setMetricSearch } = useAlertMetricSelectionOptions(query)

	const updateQuery = (updater: (query: QueryBuilderQueryDraft) => QueryBuilderQueryDraft) => {
		onChange((current) => ({
			...current,
			queryBuilderDraft: updater(current.queryBuilderDraft),
		}))
	}

	return (
		<div className="space-y-1.5">
			<QueryPanel
				query={query}
				index={0}
				canRemove={false}
				metricSelectionOptions={metricSelectionOptions}
				onMetricSearch={setMetricSearch}
				autocompleteValues={autocompleteValues}
				onUpdate={updateQuery}
				onAggregationChange={(aggregation) => updateQuery((current) => ({ ...current, aggregation }))}
				onMetricSelectionChange={(selection) =>
					updateQuery((current) =>
						current.dataSource === "metrics"
							? {
									...current,
									metricName: selection.metricName,
									metricType: selection.metricType,
									isMonotonic: selection.isMonotonic,
									aggregation: resetAggregationForMetricType(
										current.aggregation,
										selection.metricType,
										selection.isMonotonic,
									),
								}
							: current,
					)
				}
				onClone={() => {}}
				onRemove={() => {}}
				onDataSourceChange={(dataSource: QueryBuilderDataSource) =>
					updateQuery((current) => resetQueryForDataSource(current, dataSource))
				}
				showHeaderActions={false}
				showVisibilityToggle={false}
			/>
			<p className="text-xs text-muted-foreground">
				Each group is checked on its own and gets its own incident.
			</p>
		</div>
	)
}

/* -------------------------------------------------------------------------- */
/*  SQL                                                                       */
/* -------------------------------------------------------------------------- */

function RawQueryEditor({
	form,
	onChange,
}: {
	form: RuleFormState
	onChange: Dispatch<SetStateAction<RuleFormState>>
}) {
	const sampleWarning = rawAlertSampleCountWarning(form.rawQuerySql, Number(form.minimumSampleCount) || 0)
	return (
		<div className="space-y-2">
			<RawSqlEditorPanel
				draft={{ sql: form.rawQuerySql, granularitySeconds: null }}
				onDraftChange={(draft) => onChange((current) => ({ ...current, rawQuerySql: draft.sql }))}
				showBucketControl={false}
				targetLabel="alert rule"
			/>
			<div className="flex flex-wrap items-center gap-3">
				<label htmlFor="rule-raw-reducer" className="text-sm text-muted-foreground">
					Reduce each window by
				</label>
				<Select
					items={RAW_QUERY_REDUCER_LABELS}
					value={form.rawQueryReducer}
					onValueChange={(value) => value && onChange((c) => ({ ...c, rawQueryReducer: value }))}
				>
					<SelectTrigger id="rule-raw-reducer" className="h-8 w-40">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{Object.entries(RAW_QUERY_REDUCER_LABELS).map(([value, label]) => (
							<SelectItem key={value} value={value}>
								{label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<p className="min-w-0 flex-1 text-xs text-muted-foreground">
					Return a numeric <InlineCode>value</InlineCode>. Optional: <InlineCode>group</InlineCode>{" "}
					to split, <InlineCode>samples</InlineCode> for the count Min samples sums. No rows is a
					no-data check.
				</p>
			</div>
			{sampleWarning && <p className="text-xs text-severity-warn">{sampleWarning}</p>}
		</div>
	)
}
