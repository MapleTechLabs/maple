import { useState, type Dispatch, type SetStateAction } from "react"
import type {
	AlertComparator,
	AlertMetricAggregation,
	AlertMetricType,
	AlertSeverity,
	AlertSignalType,
} from "@maple/domain/http"

import { Card } from "@maple/ui/components/ui/card"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@maple/ui/components/ui/select"
import { cn } from "@maple/ui/utils"

import { AlertSegmentedSelect } from "@/components/alerts/alert-segmented-select"
import { SqlCodeEditor } from "@/components/alerts/sql-code-editor"
import { WhereClauseEditor } from "@/components/query-builder/where-clause-editor"
import {
	ChartLineIcon,
	ChevronDownIcon,
	CirclePercentageIcon,
	FireIcon,
	PulseIcon,
} from "@/components/icons"
import {
	comparatorLabels,
	isRangeComparator,
	metricAggregationLabels,
	metricTypeLabels,
	RAW_QUERY_REDUCER_LABELS,
	type RuleFormState,
} from "@/lib/alerts/form-utils"
import { AGGREGATIONS_BY_SOURCE } from "@/lib/query-builder/model"

interface SignalAndThresholdSectionProps {
	form: RuleFormState
	onChange: Dispatch<SetStateAction<RuleFormState>>
}

/* Eight signal types is too many for a single segmented bar — they wrap and
   every option looks equally weighted even though four of them are "I want a
   common metric" and the other four are "I'll define my own". We split the
   choice into two tiers:
     - Tier 1 (always visible): the *kind* of signal — built-in, custom metric,
       query builder, or raw SQL.
     - Tier 2 (only when "built-in" is active): which of the five canned
       metrics to watch.
   The mapping back to `AlertSignalType` happens in `signalTypeToKind` and the
   default-on-kind-switch logic in `setKind`. */
type SignalKind = "builtin" | "metric" | "builder_query" | "raw_query"

function signalTypeToKind(signalType: AlertSignalType): SignalKind {
	if (signalType === "metric") return "metric"
	if (signalType === "builder_query") return "builder_query"
	if (signalType === "raw_query") return "raw_query"
	return "builtin"
}

const SIGNAL_KIND_OPTIONS: ReadonlyArray<{ value: SignalKind; label: string }> = [
	{ value: "builtin", label: "Built-in" },
	{ value: "metric", label: "Metric" },
	{ value: "builder_query", label: "Query" },
	{ value: "raw_query", label: "Raw SQL" },
]

/* The "built-in" tier-2 row: 5 small chips with icons. Icons are deliberately
   reused from the templates overlay so the picker visually rhymes with the
   first-touch flow. */
const BUILTIN_SIGNAL_OPTIONS: ReadonlyArray<{
	value: AlertSignalType
	label: string
	icon: (props: { size?: number; className?: string }) => React.ReactNode
}> = [
	{ value: "error_rate", label: "Error rate", icon: FireIcon },
	{ value: "p95_latency", label: "P95", icon: ChartLineIcon },
	{ value: "p99_latency", label: "P99", icon: ChartLineIcon },
	{ value: "apdex", label: "Apdex", icon: CirclePercentageIcon },
	{ value: "throughput", label: "Throughput", icon: PulseIcon },
]

const COMPARATOR_OPTIONS: ReadonlyArray<{ value: AlertComparator; label: string }> = (
	Object.keys(comparatorLabels) as AlertComparator[]
).map((value) => ({ value, label: comparatorLabels[value] }))

/* Severity is rendered with branded color (amber / destructive-red) instead of
   the default neutral segmented toggle, because severity is the one field on
   the page that should *feel* like its outcome. */
const SEVERITY_OPTIONS: ReadonlyArray<{
	value: AlertSeverity
	label: string
	selectedClass: string
	dotClass: string
}> = [
	{
		value: "warning",
		label: "Warning",
		selectedClass:
			"border-severity-warn/60 bg-severity-warn/10 text-severity-warn hover:bg-severity-warn/15 focus-visible:ring-severity-warn/40",
		dotClass: "bg-severity-warn shadow-[0_0_0_2px_color-mix(in_oklch,var(--severity-warn)_25%,transparent)]",
	},
	{
		value: "critical",
		label: "Critical",
		selectedClass:
			"border-destructive/60 bg-destructive/10 text-destructive hover:bg-destructive/15 focus-visible:ring-destructive/40",
		dotClass: "bg-destructive shadow-[0_0_0_2px_color-mix(in_oklch,var(--destructive)_25%,transparent)]",
	},
]

export function SignalAndThresholdSection({ form, onChange }: SignalAndThresholdSectionProps) {
	const rangeMode = isRangeComparator(form.comparator)
	const [advancedOpen, setAdvancedOpen] = useState(false)

	const kind = signalTypeToKind(form.signalType)

	/* Switching tier-1 has to seed a valid signalType for the new kind.
	   Built-in defaults to error_rate; the other three map 1:1 since
	   AlertSignalType already has matching string values. */
	function setKind(next: SignalKind) {
		if (next === kind) return
		onChange((c) => ({
			...c,
			signalType:
				next === "builtin"
					? "error_rate"
					: (next as Exclude<SignalKind, "builtin"> &
							AlertSignalType),
		}))
	}

	return (
		<Card className="p-4">
			<SectionLabel>Signal &amp; threshold</SectionLabel>

			<div className="mt-3 space-y-4">
				{/* Tier 1: signal kind. Always visible. */}
				<AlertSegmentedSelect<SignalKind>
					options={SIGNAL_KIND_OPTIONS}
					value={kind}
					onChange={setKind}
					aria-label="Signal kind"
					size="sm"
				/>

				{/* Tier 2: only for built-ins. Icon chips, single short row. */}
				{kind === "builtin" && (
					<BuiltinSignalChips
						value={form.signalType}
						onChange={(value) => onChange((c) => ({ ...c, signalType: value }))}
					/>
				)}

				<SignalSubConfig form={form} onChange={onChange} />

				{/* Threshold row — comparator + value(s). Upper threshold stays mounted but
				    disabled outside range mode so the grid never reflows. */}
				<div className="grid gap-3 sm:grid-cols-[120px_1fr_1fr]">
					<div className="space-y-1.5">
						<Label htmlFor="rule-comparator" className="text-xs">
							Condition
						</Label>
						<Select
							items={comparatorLabels}
							value={form.comparator}
							onValueChange={(value) =>
								onChange((c) => ({ ...c, comparator: value as AlertComparator }))
							}
						>
							<SelectTrigger id="rule-comparator" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{COMPARATOR_OPTIONS.map((opt) => (
									<SelectItem key={opt.value} value={opt.value}>
										{opt.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="rule-threshold" className="text-xs">
							{rangeMode ? "Lower" : "Threshold"}
						</Label>
						<Input
							id="rule-threshold"
							type="number"
							inputMode="decimal"
							value={form.threshold}
							onChange={(e) => onChange((c) => ({ ...c, threshold: e.target.value }))}
							className="font-mono"
							placeholder="0"
						/>
					</div>
					<div className="space-y-1.5">
						<Label
							htmlFor="rule-threshold-upper"
							className={cn(
								"text-xs",
								!rangeMode && "text-muted-foreground/60",
							)}
						>
							Upper
						</Label>
						<Input
							id="rule-threshold-upper"
							type="number"
							inputMode="decimal"
							value={form.thresholdUpper}
							onChange={(e) =>
								onChange((c) => ({ ...c, thresholdUpper: e.target.value }))
							}
							disabled={!rangeMode}
							className="font-mono"
							placeholder={rangeMode ? "0" : "—"}
						/>
					</div>
				</div>

				{/* Severity inline — branded pills, not neutral toggle. */}
				<div className="flex items-center justify-between gap-3">
					<Label className="text-xs">Severity</Label>
					<SeverityToggle
						value={form.severity}
						onChange={(value) => onChange((c) => ({ ...c, severity: value }))}
					/>
				</div>

				{/* Advanced timing — collapsed by default. Most users never tune these. */}
				<div className="border-t pt-3">
					<button
						type="button"
						onClick={() => setAdvancedOpen((o) => !o)}
						className="flex w-full items-center justify-between gap-2 text-left text-xs text-muted-foreground hover:text-foreground"
						aria-expanded={advancedOpen}
					>
						<span className="font-medium uppercase tracking-wide">
							Evaluation timing
						</span>
						<span className="flex items-center gap-1.5">
							<span className="font-mono">
								{form.windowMinutes}min · {form.consecutiveBreachesRequired}× ·
								renotify {form.renotifyIntervalMinutes}min
							</span>
							<ChevronDownIcon
								size={12}
								className={cn(
									"transition-transform",
									advancedOpen && "rotate-180",
								)}
							/>
						</span>
					</button>
					{advancedOpen && (
						<div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
							<NumericField
								id="rule-window-minutes"
								label="Window (min)"
								hint="Aggregate window each check."
								value={form.windowMinutes}
								onChange={(value) =>
									onChange((c) => ({ ...c, windowMinutes: value }))
								}
							/>
							<NumericField
								id="rule-consecutive-breaches"
								label="Breaches to fire"
								hint="Consecutive breaches required."
								value={form.consecutiveBreachesRequired}
								onChange={(value) =>
									onChange((c) => ({
										...c,
										consecutiveBreachesRequired: value,
									}))
								}
							/>
							<NumericField
								id="rule-minimum-samples"
								label="Min samples"
								hint="Skip below this count."
								value={form.minimumSampleCount}
								onChange={(value) =>
									onChange((c) => ({ ...c, minimumSampleCount: value }))
								}
							/>
							<NumericField
								id="rule-renotify"
								label="Renotify (min)"
								hint="Repeat cadence."
								value={form.renotifyIntervalMinutes}
								onChange={(value) =>
									onChange((c) => ({
										...c,
										renotifyIntervalMinutes: value,
									}))
								}
							/>
						</div>
					)}
				</div>
			</div>
		</Card>
	)
}

/**
 * Tier-2 picker for the five built-in signals. Renders as small icon chips
 * inside a subtly tinted rail so the visual relationship to the tier-1 bar
 * above reads as "drill-in", not "another peer choice".
 */
function BuiltinSignalChips({
	value,
	onChange,
}: {
	value: AlertSignalType
	onChange: (next: AlertSignalType) => void
}) {
	return (
		<div
			role="radiogroup"
			aria-label="Built-in signal"
			className="-mt-1 flex flex-wrap items-center gap-1 rounded-md border border-dashed border-border/60 bg-muted/20 p-1"
		>
			{BUILTIN_SIGNAL_OPTIONS.map((opt) => {
				const selected = value === opt.value
				const Icon = opt.icon
				return (
					<button
						key={opt.value}
						type="button"
						role="radio"
						aria-checked={selected}
						onClick={() => onChange(opt.value)}
						className={cn(
							"inline-flex h-7 items-center gap-1.5 rounded-sm border border-transparent px-2 text-xs font-medium",
							"transition-[background-color,border-color,color] duration-150",
							"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
							selected
								? "border-primary/40 bg-primary/10 text-foreground"
								: "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
						)}
					>
						<Icon
							size={12}
							className={cn(
								"transition-colors",
								selected ? "text-primary" : "text-muted-foreground/70",
							)}
						/>
						{opt.label}
					</button>
				)
			})}
		</div>
	)
}

/**
 * Inline severity picker — two pills side by side that adopt the severity's
 * brand color when selected (amber for warning, red for critical). Designed
 * to be the most visually deliberate control on the form, since severity is
 * the one knob that actually changes who hears about a breach.
 */
function SeverityToggle({
	value,
	onChange,
}: {
	value: AlertSeverity
	onChange: (next: AlertSeverity) => void
}) {
	return (
		<div
			role="radiogroup"
			aria-label="Severity"
			className="inline-flex items-center gap-1 rounded-md bg-muted/30 p-0.5"
		>
			{SEVERITY_OPTIONS.map((opt) => {
				const selected = value === opt.value
				return (
					<button
						key={opt.value}
						type="button"
						role="radio"
						aria-checked={selected}
						onClick={() => onChange(opt.value)}
						className={cn(
							"inline-flex h-7 items-center gap-1.5 rounded-[5px] border border-transparent px-2.5 text-xs font-medium",
							"transition-[background-color,border-color,color] duration-150",
							"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
							selected
								? opt.selectedClass
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						<span
							aria-hidden
							className={cn(
								"size-1.5 rounded-full transition-shadow",
								selected ? opt.dotClass : "bg-muted-foreground/40",
							)}
						/>
						{opt.label}
					</button>
				)
			})}
		</div>
	)
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
	return (
		<h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
			{children}
		</h3>
	)
}

function NumericField({
	id,
	label,
	hint,
	value,
	onChange,
}: {
	id: string
	label: string
	hint?: string
	value: string
	onChange: (value: string) => void
}) {
	return (
		<div className="space-y-1">
			<Label htmlFor={id} className="text-xs">
				{label}
			</Label>
			<Input
				id={id}
				type="number"
				inputMode="numeric"
				min={0}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className="font-mono"
			/>
			{hint && <p className="text-muted-foreground text-[10px] leading-tight">{hint}</p>}
		</div>
	)
}

/* -------------------------------------------------------------------------- */
/*  Signal-specific sub-config                                                */
/* -------------------------------------------------------------------------- */

function SignalSubConfig({ form, onChange }: SignalAndThresholdSectionProps) {
	switch (form.signalType) {
		case "metric":
			return (
				<div className="grid gap-3 sm:grid-cols-[1fr_140px_140px]">
					<div className="space-y-1.5">
						<Label htmlFor="metric-name" className="text-xs">
							Metric name
						</Label>
						<Input
							id="metric-name"
							value={form.metricName}
							onChange={(e) =>
								onChange((c) => ({ ...c, metricName: e.target.value }))
							}
							placeholder="http.server.duration"
							className="font-mono"
						/>
					</div>
					<div className="space-y-1.5">
						<Label className="text-xs">Type</Label>
						<Select
							items={metricTypeLabels}
							value={form.metricType}
							onValueChange={(value) =>
								onChange((c) => ({ ...c, metricType: value as AlertMetricType }))
							}
						>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{Object.entries(metricTypeLabels).map(([val, label]) => (
									<SelectItem key={val} value={val}>
										{label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="space-y-1.5">
						<Label className="text-xs">Aggregate</Label>
						<Select
							items={metricAggregationLabels}
							value={form.metricAggregation}
							onValueChange={(value) =>
								onChange((c) => ({
									...c,
									metricAggregation: value as AlertMetricAggregation,
								}))
							}
						>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{Object.entries(metricAggregationLabels).map(([val, label]) => (
									<SelectItem key={val} value={val}>
										{label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				</div>
			)

		case "apdex":
			return (
				<div className="flex items-end gap-3">
					<div className="space-y-1.5">
						<Label htmlFor="apdex-threshold" className="text-xs">
							Apdex target (ms)
						</Label>
						<Input
							id="apdex-threshold"
							type="number"
							value={form.apdexThresholdMs}
							onChange={(e) =>
								onChange((c) => ({ ...c, apdexThresholdMs: e.target.value }))
							}
							className="w-[180px] font-mono"
						/>
					</div>
					<p className="text-muted-foreground pb-2 text-xs">
						Requests under this duration count as fully satisfied.
					</p>
				</div>
			)

		case "builder_query":
			return (
				<div className="space-y-3">
					<div className="grid gap-3 sm:grid-cols-[auto_1fr]">
						<div className="space-y-1.5">
							<Label className="text-xs">Source</Label>
							<AlertSegmentedSelect<"traces" | "logs" | "metrics">
								options={[
									{ value: "traces", label: "Traces" },
									{ value: "logs", label: "Logs" },
									{ value: "metrics", label: "Metrics" },
								]}
								value={form.queryDataSource}
								onChange={(ds) =>
									onChange((c) => ({
										...c,
										queryDataSource: ds,
										queryAggregation:
											AGGREGATIONS_BY_SOURCE[ds][0].value,
									}))
								}
								aria-label="Query data source"
								size="sm"
							/>
						</div>
						<div className="space-y-1.5">
							<Label className="text-xs">Aggregate</Label>
							<Select
								items={AGGREGATIONS_BY_SOURCE[form.queryDataSource]}
								value={form.queryAggregation}
								onValueChange={(value) =>
									value &&
									onChange((c) => ({ ...c, queryAggregation: value }))
								}
							>
								<SelectTrigger className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{AGGREGATIONS_BY_SOURCE[form.queryDataSource].map((agg) => (
										<SelectItem key={agg.value} value={agg.value}>
											{agg.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>

					{form.queryDataSource === "metrics" && (
						<div className="grid gap-3 sm:grid-cols-[1fr_140px]">
							<div className="space-y-1.5">
								<Label htmlFor="query-metric-name" className="text-xs">
									Metric name
								</Label>
								<Input
									id="query-metric-name"
									value={form.metricName}
									onChange={(e) =>
										onChange((c) => ({
											...c,
											metricName: e.target.value,
										}))
									}
									placeholder="http.server.duration"
									className="font-mono"
								/>
							</div>
							<div className="space-y-1.5">
								<Label className="text-xs">Type</Label>
								<Select
									items={metricTypeLabels}
									value={form.metricType}
									onValueChange={(value) =>
										onChange((c) => ({
											...c,
											metricType: value as AlertMetricType,
										}))
									}
								>
									<SelectTrigger className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{Object.entries(metricTypeLabels).map(([val, label]) => (
											<SelectItem key={val} value={val}>
												{label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						</div>
					)}

					<div className="space-y-1.5">
						<Label className="text-xs">Where</Label>
						<WhereClauseEditor
							dataSource={form.queryDataSource}
							value={form.queryWhereClause}
							onChange={(value) =>
								onChange((c) => ({ ...c, queryWhereClause: value }))
							}
							rows={2}
							placeholder='service.name = "payments" AND has_error = true'
						/>
					</div>
				</div>
			)

		case "raw_query":
			return (
				<div className="space-y-3">
					<div className="space-y-1.5">
						<Label htmlFor="raw-query-sql" className="text-xs">
							ClickHouse SQL
						</Label>
						<SqlCodeEditor
							id="raw-query-sql"
							value={form.rawQuerySql}
							onChange={(value) =>
								onChange((c) => ({ ...c, rawQuerySql: value }))
							}
						/>
						<p className="text-muted-foreground text-[10px] leading-tight">
							Return a numeric <code>value</code> column. Must reference{" "}
							<code>$__orgFilter</code>.
						</p>
					</div>
					<div className="flex items-end gap-3">
						<div className="space-y-1.5">
							<Label className="text-xs">Reduce buckets by</Label>
							<Select
								items={RAW_QUERY_REDUCER_LABELS}
								value={form.rawQueryReducer}
								onValueChange={(value) =>
									value &&
									onChange((c) => ({
										...c,
										rawQueryReducer:
											value as RuleFormState["rawQueryReducer"],
									}))
								}
							>
								<SelectTrigger className="w-[180px]">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{Object.entries(RAW_QUERY_REDUCER_LABELS).map(
										([val, label]) => (
											<SelectItem key={val} value={val}>
												{label}
											</SelectItem>
										),
									)}
								</SelectContent>
							</Select>
						</div>
					</div>
				</div>
			)

		default:
			return null
	}
}
