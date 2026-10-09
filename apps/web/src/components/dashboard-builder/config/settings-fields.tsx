import { createContext, use, type ReactNode } from "react"

import { eyebrowVariants } from "@maple/ui/components/ui/eyebrow"
import { Field, FieldLabel } from "@maple/ui/components/ui/field"
import { IconButton } from "@maple/ui/components/ui/icon-button"
import { XmarkIcon } from "@/components/icons"
import { Checkbox } from "@maple/ui/components/ui/checkbox"
import { Input } from "@maple/ui/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Textarea } from "@maple/ui/components/ui/textarea"
import { SegmentedSelect, type SegmentedOption } from "@/components/common/segmented-select"
import { cn } from "@maple/ui/lib/utils"
import {
	DEFAULT_HEATMAP_COLOR_SCALE,
	HEATMAP_COLOR_SCALES,
	WIDGET_UNITS,
	type HeatmapColorScale,
} from "@maple/domain/http"
import type { ValueUnit } from "@/components/dashboard-builder/types"
import { TimeRangePicker } from "@/components/time-range-picker/time-range-picker"
import { useDashboardTimeRange } from "@/components/dashboard-builder/dashboard-providers"
import { resolveTimeRange } from "@/atoms/dashboard-time-range-atoms"
import { WidgetBuilderForm } from "@/atoms/widget-query-builder-atoms"
import { useAtom } from "@/lib/effect-atom"
import { PANEL_TYPES, fromPanelType, toPanelType } from "@/lib/query-builder/panel-types"
import { reconcileFunnelSource } from "@/components/dashboard-builder/config/funnel-source"
import {
	STAT_AGGREGATES,
	toSeriesFieldOptions,
	type QueryBuilderWidgetState,
	type StatAggregate,
} from "@/lib/query-builder/widget-builder-shared"

// The settings rail's vocabulary.
//
// Each field reads and writes the builder state through context, so a panel
// type's settings panel is a list of the fields it offers rather than a slice of
// one form gated on `isStat && …`. The rail used to be a single 592-line
// component behind seven `isX` booleans and two `showX` booleans, where adding a
// widget type meant threading a tenth flag through every section.

export type LegendPosition = "bottom" | "right" | "hidden"

/** Raw SQL mode hides settings that are built from query-builder state. */
type SourceMode = "builder" | "rawSql"

const SourceModeContext = createContext<SourceMode>("builder")

export function SettingsSourceMode({ mode, children }: { mode: SourceMode; children: ReactNode }) {
	return <SourceModeContext value={mode}>{children}</SourceModeContext>
}

/**
 * Reads the builder form atom directly rather than going through
 * `useWidgetBuilder`. That hook depends on the widget-type registry (for
 * validation), and the registry's config panels are built from these fields — so
 * routing through it would make the module graph circular.
 */
function useSettings() {
	const [state, setState] = useAtom(WidgetBuilderForm.use())
	return {
		state,
		seriesFieldOptions: toSeriesFieldOptions(state),
		sourceMode: use(SourceModeContext),
		set: (updates: Partial<QueryBuilderWidgetState>) =>
			setState((current) => reconcileFunnelSource({ ...current, ...updates })),
	}
}

// The eyebrow caption, restated at `sm:` because FieldLabel sets its own size there.
const RAIL_LABEL_CLASS = cn(eyebrowVariants({ variant: "label" }), "sm:text-2xs sm:leading-normal")

/** Dense rail setting: an eyebrow caption labelling a segmented control, select or input. */
function RailSetting({ label, children }: { label: string; children: ReactNode }) {
	return (
		<Field className="items-stretch gap-1.5">
			<FieldLabel className={RAIL_LABEL_CLASS}>{label}</FieldLabel>
			{children}
		</Field>
	)
}

/** The rail's full-width segmented control: equal-width segments in small type. */
function Segments<T extends string>({
	options,
	value,
	onSelect,
	className,
}: {
	options: ReadonlyArray<SegmentedOption<T>>
	value: T
	onSelect: (next: T) => void
	className?: string
}) {
	return (
		<SegmentedSelect
			options={options}
			value={value}
			onChange={onSelect}
			size="sm"
			className={cn("w-full *:flex-1 *:text-xs", className)}
		/>
	)
}

function CheckboxRow({
	id,
	label,
	checked,
	disabled,
	onChange,
}: {
	id: string
	label: string
	checked: boolean
	disabled?: boolean
	onChange: (checked: boolean) => void
}) {
	return (
		<Field className="flex-row items-center gap-2">
			<Checkbox
				id={id}
				checked={checked}
				disabled={disabled}
				onCheckedChange={(next) => onChange(next === true)}
			/>
			<FieldLabel htmlFor={id} className="font-normal text-xs text-muted-foreground sm:text-xs">
				{label}
			</FieldLabel>
		</Field>
	)
}

const Divider = () => <div className="h-px bg-border" />

function Name() {
	const { state, set } = useSettings()
	return (
		<RailSetting label="Name">
			<Input
				value={state.title}
				onChange={(event) => set({ title: event.target.value })}
				placeholder="Untitled widget"
			/>
		</RailSetting>
	)
}

function Description() {
	const { state, set } = useSettings()
	return (
		<RailSetting label="Description">
			<Textarea
				value={state.description}
				onChange={(event) => set({ description: event.target.value })}
				placeholder="Add a description..."
				rows={2}
			/>
		</RailSetting>
	)
}

function TypePicker() {
	const { state, set } = useSettings()
	const panelType = toPanelType(state.visualization, state.chartId)
	return (
		<RailSetting label="Type">
			{/* Three columns, not four: "Histogram" overflows a quarter of the
			    272px rail and collides with its neighbour. */}
			<SegmentedSelect
				options={PANEL_TYPES}
				value={panelType}
				onChange={(next) => set(fromPanelType(next, state.chartId))}
				size="sm"
				aria-label="Panel type"
				className="grid w-full grid-cols-3 *:text-xs"
			/>
		</RailSetting>
	)
}

/** Bar and area charts choose between grouped/overlapping series and stacked. */
function Stacked() {
	const { state, set } = useSettings()
	const panelType = toPanelType(state.visualization, state.chartId)
	return (
		<RailSetting label="Layout">
			<Segments
				value={state.stacked ? "stacked" : "separate"}
				onSelect={(next) => set({ stacked: next === "stacked" })}
				options={[
					{ value: "separate", label: panelType === "bar" ? "Grouped" : "Overlapping" },
					{ value: "stacked", label: "Stacked" },
				]}
			/>
		</RailSetting>
	)
}

function Curve() {
	const { state, set } = useSettings()
	return (
		<RailSetting label="Curve">
			<Segments
				value={state.curveType}
				onSelect={(curveType) => set({ curveType })}
				options={[
					{ value: "linear", label: "Linear" },
					{ value: "monotone", label: "Smooth" },
				]}
			/>
		</RailSetting>
	)
}

/**
 * Point dots on line/area series. Auto is Grafana's rule: isolated points (a
 * single non-zero bucket a line cannot draw) always get a dot; every point does
 * only when the series is sparse enough for the dots not to touch.
 */
function Points() {
	const { state, set } = useSettings()
	return (
		<RailSetting label="Points">
			<Segments
				value={state.pointsMode}
				onSelect={(pointsMode) => set({ pointsMode })}
				options={[
					{ value: "auto", label: "Auto" },
					{ value: "always", label: "Always" },
					{ value: "never", label: "Never" },
				]}
			/>
		</RailSetting>
	)
}

const titleCase = (value: string) => value[0]!.toUpperCase() + value.slice(1)

/** The ramp itself, so picking a palette is a visual choice rather than a word. */
function RampSwatch({ scale }: { scale: HeatmapColorScale }) {
	return (
		<span className="flex shrink-0 gap-px">
			{[0, 1, 2, 3, 4].map((stop) => (
				<span
					key={stop}
					className="size-2 rounded-xs"
					style={{ backgroundColor: `var(--heatmap-${scale}-${stop})` }}
				/>
			))}
		</span>
	)
}

function HeatmapColors() {
	const { state, set } = useSettings()
	// An unset palette shows the ramp the chart actually renders, not a second
	// default — ticking it is a no-op, so no Apply repaints an untouched widget.
	const colorScale = state.heatmapColorScale ?? DEFAULT_HEATMAP_COLOR_SCALE
	return (
		<>
			<RailSetting label="Color scale">
				<Select
					items={Object.fromEntries(HEATMAP_COLOR_SCALES.map((scale) => [scale, titleCase(scale)]))}
					value={colorScale}
					onValueChange={(value) => set({ heatmapColorScale: value as HeatmapColorScale })}
				>
					<SelectTrigger className="w-full">
						<span className="flex items-center gap-2">
							<RampSwatch scale={colorScale} />
							<SelectValue />
						</span>
					</SelectTrigger>
					<SelectContent>
						{HEATMAP_COLOR_SCALES.map((scale) => (
							<SelectItem key={scale} value={scale}>
								<span className="flex items-center gap-2">
									<RampSwatch scale={scale} />
									{titleCase(scale)}
								</span>
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</RailSetting>
			<RailSetting label="Color scaling">
				<Segments
					value={state.heatmapScaleType}
					onSelect={(heatmapScaleType) => set({ heatmapScaleType })}
					options={[
						{ value: "linear", label: "Linear" },
						{ value: "log", label: "Log" },
					]}
				/>
			</RailSetting>
		</>
	)
}

// The four `duration_*` tokens collapse into one "Duration" entry with a
// separate scale select below, so this list is the shared catalog minus those,
// plus the grouping affordance. Everything else is derived, so a token added to
// `WIDGET_UNITS` appears here without an edit.
const UNIT_OPTIONS: Array<{ value: string; label: string }> = [
	...WIDGET_UNITS.filter((unit) => !unit.token.startsWith("duration_")).map((unit) => ({
		value: unit.token,
		label: unit.label,
	})),
	{ value: "duration", label: "Duration" },
]

const DURATION_SCALE_OPTIONS = [
	{ value: "duration_ns" as ValueUnit, label: "ns" },
	{ value: "duration_us" as ValueUnit, label: "us" },
	{ value: "duration_ms" as ValueUnit, label: "ms" },
	{ value: "duration_s" as ValueUnit, label: "s" },
]

const isDurationUnit = (value: string) => value.startsWith("duration_")

/** Charts label this "Y-Axis Unit"; scalar widgets just "Unit". */
function Unit({ label = "Unit" }: { label?: string }) {
	const { state, set } = useSettings()
	const isDuration = isDurationUnit(state.unit)
	return (
		<RailSetting label={label}>
			<Select
				items={UNIT_OPTIONS}
				value={isDuration ? "duration" : state.unit}
				onValueChange={(value) =>
					set({ unit: value === "duration" ? "duration_ms" : (value as ValueUnit) })
				}
			>
				<SelectTrigger className="w-full">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{UNIT_OPTIONS.map((option) => (
						<SelectItem key={option.value} value={option.value}>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{isDuration && (
				<Segments
					value={state.unit}
					onSelect={(unit) => set({ unit })}
					options={DURATION_SCALE_OPTIONS}
				/>
			)}
		</RailSetting>
	)
}

/**
 * `seriesStats` is the Min/Max/Mean/Last table, which only time-series legends
 * render — a categorical legend (pie) has one value per row and nothing to
 * reduce over time, so those panels pass `seriesStats={false}`.
 */
function Legend({ seriesStats = true }: { seriesStats?: boolean }) {
	const { state, set } = useSettings()
	return (
		<RailSetting label="Legend">
			<Segments
				value={state.legendPosition}
				onSelect={(legendPosition) => set({ legendPosition })}
				options={[
					{ value: "bottom", label: "Bottom" },
					{ value: "right", label: "Right" },
					{ value: "hidden", label: "Hidden" },
				]}
			/>
			{seriesStats && (
				<div className="pt-0.5">
					<CheckboxRow
						id="qb-series-stats"
						label="Show Min/Max/Mean/Last stats"
						checked={state.seriesStatsEnabled}
						onChange={(checked) =>
							// Stats live inside the legend, so enabling them with the legend
							// hidden would have no visible effect — turn the legend on
							// (bottom) in the same change.
							set(
								checked && state.legendPosition === "hidden"
									? { seriesStatsEnabled: true, legendPosition: "bottom" }
									: { seriesStatsEnabled: checked },
							)
						}
					/>
				</div>
			)}
		</RailSetting>
	)
}

/** How the timeseries a stat or gauge reads is reduced to one number. */
function ScalarReduction() {
	const { state, seriesFieldOptions, set } = useSettings()
	// A widget whose queries changed can hold a value field that no longer
	// exists; fall back to the first series so the select is never blank.
	const valueField =
		seriesFieldOptions.length > 0 &&
		(!state.statValueField || !seriesFieldOptions.includes(state.statValueField))
			? seriesFieldOptions[0]
			: state.statValueField

	return (
		<>
			<RailSetting label="Aggregate">
				<Select
					items={Object.fromEntries(STAT_AGGREGATES.map((value) => [value, value]))}
					value={state.statAggregate}
					onValueChange={(value) => set({ statAggregate: value as StatAggregate })}
				>
					<SelectTrigger className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{STAT_AGGREGATES.map((value) => (
							<SelectItem key={value} value={value}>
								{value}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</RailSetting>
			<RailSetting label="Value Field">
				<Select
					value={valueField || seriesFieldOptions[0]}
					onValueChange={(value) => set({ statValueField: value ?? "" })}
				>
					<SelectTrigger className="w-full">
						<SelectValue placeholder="Select series" />
					</SelectTrigger>
					<SelectContent>
						{seriesFieldOptions.map((field) => (
							<SelectItem key={field} value={field}>
								{field}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</RailSetting>
		</>
	)
}

function GaugeRange() {
	const { state, set } = useSettings()
	return (
		<div className="grid grid-cols-2 gap-2">
			<RailSetting label="Min">
				<Input
					type="number"
					value={state.gaugeMin}
					onChange={(event) => set({ gaugeMin: event.target.value })}
					placeholder="0"
				/>
			</RailSetting>
			<RailSetting label="Max">
				<Input
					type="number"
					value={state.gaugeMax}
					onChange={(event) => set({ gaugeMax: event.target.value })}
					placeholder="100"
				/>
			</RailSetting>
		</div>
	)
}

/**
 * The sparkline embeds a second data source built from the query-builder state,
 * so in Raw SQL mode it would fetch the placeholder queries rather than the
 * user's SQL. Offer it only where it can be honest.
 */
function Sparkline() {
	const { state, sourceMode, set } = useSettings()
	if (sourceMode !== "builder") return null
	return (
		<CheckboxRow
			id="qb-sparkline"
			label="Show sparkline"
			checked={state.sparklineEnabled}
			onChange={(sparklineEnabled) => set({ sparklineEnabled })}
		/>
	)
}

function Thresholds() {
	const { state, set } = useSettings()
	const thresholds = state.thresholds
	const replace = (next: typeof thresholds) => set({ thresholds: next })

	return (
		<RailSetting label="Thresholds">
			<div className="flex flex-col gap-1.5">
				{thresholds.map((threshold, index) => (
					// eslint-disable-next-line react/no-array-index-key -- thresholds have no stable id
					<div key={index} className="flex items-center gap-1.5">
						<input
							type="color"
							value={threshold.color.startsWith("#") ? threshold.color : "#ef4444"}
							onChange={(event) =>
								replace(
									thresholds.map((current, i) =>
										i === index ? { ...current, color: event.target.value } : current,
									),
								)
							}
							className="h-8 w-8 shrink-0 cursor-pointer rounded border bg-transparent p-0.5"
							aria-label="Threshold color"
						/>
						<Input
							type="number"
							value={String(threshold.value)}
							onChange={(event) => {
								const parsed = Number(event.target.value)
								replace(
									thresholds.map((current, i) =>
										i === index
											? { ...current, value: Number.isFinite(parsed) ? parsed : 0 }
											: current,
									),
								)
							}}
							className="h-8"
						/>
						<IconButton
							variant="outline"
							size="icon"
							label="Remove threshold"
							onClick={() => replace(thresholds.filter((_, i) => i !== index))}
							className="text-muted-foreground hover:text-foreground"
						>
							<XmarkIcon size={14} />
						</IconButton>
					</div>
				))}
				<button
					type="button"
					onClick={() => replace([...thresholds, { value: 0, color: "#ef4444" }])}
					className="h-8 rounded-md border border-dashed text-xs text-muted-foreground transition-colors hover:text-foreground"
				>
					+ Add threshold
				</button>
			</div>
		</RailSetting>
	)
}

function RowLimit() {
	const { state, set } = useSettings()
	return (
		<RailSetting label="Row Limit">
			<Input
				value={state.tableLimit}
				onChange={(event) => set({ tableLimit: event.target.value })}
				placeholder="50"
				type="number"
				min={1}
			/>
		</RailSetting>
	)
}

/**
 * Settings shared by every query-driven panel type. Lists and notes don't run a
 * query-builder query, so they omit this block entirely.
 */
function QueryOptions() {
	const { state, set } = useSettings()
	return (
		<>
			<Divider />
			<RailSetting label="Comparison">
				<Select
					items={{ none: "None", previous_period: "Previous period" }}
					value={state.comparisonMode}
					onValueChange={(value) =>
						set({ comparisonMode: value === "previous_period" ? "previous_period" : "none" })
					}
				>
					<SelectTrigger className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="none">None</SelectItem>
						<SelectItem value="previous_period">Previous period</SelectItem>
					</SelectContent>
				</Select>
			</RailSetting>
			<Divider />
			<div className="flex flex-col gap-3">
				<CheckboxRow
					id="qb-percent-change"
					label="% change"
					checked={state.includePercentChange}
					disabled={state.comparisonMode === "none"}
					onChange={(includePercentChange) => set({ includePercentChange })}
				/>
			</div>
		</>
	)
}

/**
 * Pins the widget to a window of its own instead of the dashboard's — the
 * "Active in the last 30 minutes" tile on a board scoped to the last 7 days.
 * Notes never query, so they don't offer it.
 *
 * A relative override ("30m") rebases against "now" on every dashboard refresh,
 * exactly like the board's own relative range; an absolute one stays put.
 */
function WidgetTimeRange() {
	const { state, set } = useSettings()
	const {
		state: { resolvedTimeRange: dashboardResolved },
	} = useDashboardTimeRange()

	if (state.visualization === "markdown") return null

	const override = state.timeRange
	const resolved = override ? resolveTimeRange(override) : null

	return (
		<RailSetting label="Time range">
			<div className="space-y-1.5">
				<Segments
					value={override ? "custom" : "dashboard"}
					onSelect={(next) =>
						set({
							// Seed a new override from whatever the board is showing, so the
							// tile doesn't jump to some unrelated window the moment you
							// detach it.
							timeRange:
								next === "dashboard"
									? null
									: dashboardResolved
										? {
												type: "absolute",
												startTime: dashboardResolved.startTime,
												endTime: dashboardResolved.endTime,
											}
										: { type: "relative", value: "1h" },
						})
					}
					options={[
						{ value: "dashboard", label: "Dashboard" },
						{ value: "custom", label: "Custom" },
					]}
				/>
				{override && (
					<TimeRangePicker
						startTime={resolved?.startTime}
						endTime={resolved?.endTime}
						presetValue={override.type === "relative" ? override.value : undefined}
						onChange={(range) => {
							if (!range.startTime || !range.endTime) return
							set({
								timeRange: range.presetValue
									? { type: "relative", value: range.presetValue }
									: {
											type: "absolute",
											startTime: range.startTime,
											endTime: range.endTime,
										},
							})
						}}
					/>
				)}
			</div>
		</RailSetting>
	)
}

/**
 * The funnel chart's percentage labels: Auto (share of step 1), Conversion
 * (adds the step-to-step rate), Off. Three states because
 * `display.funnel.showStepPercent` is a tri-state — unset keeps the
 * long-standing default, and a widget saved before the control existed must
 * keep rendering as it did.
 */
function FunnelStepPercent() {
	const { state, set } = useSettings()
	const value = state.funnel.showStepPercent
	return (
		<RailSetting label="Step labels">
			<Segments
				value={value === undefined ? "auto" : value ? "conversion" : "off"}
				onSelect={(next) =>
					set({
						funnel: {
							...state.funnel,
							showStepPercent: next === "auto" ? undefined : next === "conversion",
						},
					})
				}
				options={[
					{ value: "auto", label: "Auto" },
					{ value: "conversion", label: "Conversion" },
					{ value: "off", label: "Off" },
				]}
			/>
		</RailSetting>
	)
}

/** Bars, or the step-by-step drop-off view with timing and leavers. */
function FunnelVariant() {
	const { state, set } = useSettings()
	return (
		<RailSetting label="View">
			<Segments
				value={state.funnel.variant}
				onSelect={(variant) => set({ funnel: { ...state.funnel, variant } })}
				options={[
					{ value: "bars", label: "Bars" },
					{ value: "dropoff", label: "Drop-off" },
				]}
			/>
		</RailSetting>
	)
}

/**
 * The rail's field vocabulary. A panel type's `ConfigPanel` composes these; none
 * of them takes the widget state as a prop.
 */
export const WidgetSettings = {
	FunnelStepPercent,
	FunnelVariant,
	Divider,
	Name,
	Description,
	TimeRange: WidgetTimeRange,
	TypePicker,
	Stacked,
	Curve,
	Points,
	HeatmapColors,
	Unit,
	Legend,
	ScalarReduction,
	GaugeRange,
	Sparkline,
	Thresholds,
	RowLimit,
	QueryOptions,
}
