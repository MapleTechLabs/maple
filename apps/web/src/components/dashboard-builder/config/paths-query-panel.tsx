import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { cn } from "@maple/ui/lib/utils"
import { PATHS_MAX_BRANCHES, PATHS_MAX_DEPTH } from "@maple/query-model"

import { FUNNEL_KEY_BY_OPTIONS, FUNNEL_WINDOW_OPTIONS } from "@/components/funnels/definition"
import { FunnelStepBuilder } from "@/components/funnels/funnel-step-builder"
import { useFunnelSuggestions, type FunnelSuggestions } from "@/components/funnels/use-funnel-suggestions"
import { AddOnToggleBar, QueryPanelShell } from "@/components/dashboard-builder/config/query-panel-shell"
import { WhereClauseEditor } from "@/components/query-builder/where-clause-editor"
import { parseProductEventsFilterClause } from "@/lib/query-builder/funnel-filters"
import type { PathsAddOnKey, PathsWidgetDraft } from "@/lib/query-builder/widget-builder-shared"

// The paths widget's query panel. Same chrome as the funnel's, with a
// different body: one anchor (the step builder, held to a single step), the
// direction and depth, and Count by / Within / Include / Exclude as add-ons.
// There is no source select to speak of — paths read product events only —
// so the shell shows it fixed.

const ADD_ONS: ReadonlyArray<{ key: PathsAddOnKey; label: string }> = [
	{ key: "keyBy", label: "Count by" },
	{ key: "window", label: "Within" },
	{ key: "include", label: "Include" },
	{ key: "exclude", label: "Exclude" },
]

const DEPTHS = Array.from({ length: PATHS_MAX_DEPTH }, (_, i) => i + 1)
const BRANCHES = [3, 4, 6, PATHS_MAX_BRANCHES]

interface PathsQueryPanelViewProps {
	paths: PathsWidgetDraft
	onUpdate: (updater: (paths: PathsWidgetDraft) => PathsWidgetDraft) => void
	suggestions: FunnelSuggestions
}

interface PathsQueryPanelProps extends Omit<PathsQueryPanelViewProps, "suggestions"> {
	suggestionWindow: { startTime: string; endTime: string } | undefined
}

export function PathsQueryPanel({ suggestionWindow, ...props }: PathsQueryPanelProps) {
	const suggestions = useFunnelSuggestions(suggestionWindow)
	return <PathsQueryPanelView {...props} suggestions={suggestions} />
}

function Segmented<T extends string | number>({
	options,
	value,
	onSelect,
	ariaLabel,
}: {
	options: ReadonlyArray<{ value: T; label: string }>
	value: T
	onSelect: (next: T) => void
	ariaLabel: string
}) {
	return (
		<div className="flex h-8 rounded-md border bg-muted/40 p-0.5" role="group" aria-label={ariaLabel}>
			{options.map((option) => (
				<button
					key={String(option.value)}
					type="button"
					onClick={() => onSelect(option.value)}
					aria-pressed={value === option.value}
					className={cn(
						"rounded-sm px-2.5 text-xs transition-colors",
						value === option.value
							? "bg-background text-foreground shadow-sm"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					{option.label}
				</button>
			))}
		</div>
	)
}

export function PathsQueryPanelView({ paths, onUpdate, suggestions }: PathsQueryPanelViewProps) {
	const filterParse = parseProductEventsFilterClause(paths.filterClause)
	const filterError = filterParse.ok ? null : filterParse.error

	const toggleAddOn = (key: PathsAddOnKey) =>
		onUpdate((current) => {
			const next = !current.addOns[key]
			const addOns = { ...current.addOns, [key]: next }
			if (next) return { ...current, addOns }
			// Off puts the value back to its default, so the bar reads as "what is set".
			switch (key) {
				case "keyBy":
					return { ...current, addOns, keyBy: "person" }
				case "window":
					return { ...current, addOns, windowSeconds: 24 * 3600 }
				case "include":
					return { ...current, addOns, include: "all" }
				case "exclude":
					return { ...current, addOns, excludeText: "" }
			}
		})

	const hasAnyAddOn = Object.values(paths.addOns).some(Boolean)

	return (
		<QueryPanelShell
			name="A"
			index={0}
			source="product_events"
			sourceOptions={["product_events"]}
			onSourceChange={() => {}}
			headerActions={
				<Button variant="ghost" size="xs" disabled>
					Remove
				</Button>
			}
		>
			{/* Anchor + direction */}
			<div className="space-y-1.5">
				<div className="flex items-center gap-2">
					<span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
						Paths
					</span>
					<Segmented
						ariaLabel="Direction"
						value={paths.direction}
						options={[
							{ value: "after", label: "After" },
							{ value: "before", label: "Before" },
						]}
						onSelect={(direction) => onUpdate((current) => ({ ...current, direction }))}
					/>
					<span className="font-mono text-[10px] text-muted-foreground">
						{paths.direction === "after"
							? "what people did next, from the first time they hit the anchor"
							: "how people got there, back from the last time they hit the anchor"}
					</span>
				</div>
				<FunnelStepBuilder
					steps={[paths.anchor]}
					onChange={(steps) => {
						const [anchor] = steps
						if (anchor && anchor.kind !== "session")
							onUpdate((current) => ({ ...current, anchor }))
					}}
					eventNames={suggestions.eventNames}
					pagePaths={suggestions.pagePaths}
					pageStepHost
					maxSteps={1}
					compact
				/>
			</div>

			{/* Depth + branches */}
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
				<div className="flex items-center gap-2">
					<span className="w-16 shrink-0 text-[11px] text-muted-foreground">Steps</span>
					<Segmented
						ariaLabel="Steps"
						value={paths.depth}
						options={DEPTHS.map((value) => ({ value, label: String(value) }))}
						onSelect={(depth) => onUpdate((current) => ({ ...current, depth }))}
					/>
				</div>
				<div className="flex items-center gap-2">
					<span className="shrink-0 text-[11px] text-muted-foreground">Branches</span>
					<Segmented
						ariaLabel="Branches per step"
						value={paths.branches}
						options={BRANCHES.map((value) => ({ value, label: String(value) }))}
						onSelect={(branches) => onUpdate((current) => ({ ...current, branches }))}
					/>
					<span className="text-[11px] text-muted-foreground">
						named per step, the rest fold into Other
					</span>
				</div>
			</div>

			{/* Population filter */}
			<div className="space-y-1">
				<div className="flex items-start gap-2">
					<span className="w-16 shrink-0 pt-2 text-[11px] text-muted-foreground">Where</span>
					<WhereClauseEditor
						className="flex-1"
						rows={1}
						value={paths.filterClause}
						dataSource="traces"
						autocompleteScope="product_events"
						values={{ productEventFacets: suggestions.facets }}
						onChange={(filterClause) => onUpdate((current) => ({ ...current, filterClause }))}
						placeholder='country = "DE" AND utm.source = "twitter"'
						textareaClassName="min-h-[32px] resize-y text-xs"
						ariaLabel="Paths population filter"
					/>
				</div>
				<p className="pl-18 text-[11px] text-muted-foreground">
					{filterError ? (
						<span className="text-destructive">{filterError}</span>
					) : (
						"Only persons with a session matching these dimensions take part."
					)}
				</p>
			</div>

			<AddOnToggleBar items={ADD_ONS} active={paths.addOns} onToggle={toggleAddOn} />

			{hasAnyAddOn && (
				<div className="space-y-2 pt-1">
					{paths.addOns.keyBy && (
						<div className="flex items-center gap-2">
							<span className="w-16 shrink-0 text-[11px] text-muted-foreground">Count by</span>
							<Select
								items={Object.fromEntries(
									FUNNEL_KEY_BY_OPTIONS.map((option) => [option.value, option.label]),
								)}
								value={paths.keyBy}
								onValueChange={(value) => {
									const option = FUNNEL_KEY_BY_OPTIONS.find(
										(candidate) => candidate.value === value,
									)
									if (option) onUpdate((current) => ({ ...current, keyBy: option.value }))
								}}
							>
								<SelectTrigger className="h-8 w-[220px] text-xs" aria-label="Count by">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{FUNNEL_KEY_BY_OPTIONS.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											<span className="flex flex-col">
												<span>{option.label}</span>
												<span className="text-[10px] text-muted-foreground">
													{option.description}
												</span>
											</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					)}

					{paths.addOns.window && (
						<div className="flex items-center gap-2">
							<span className="w-16 shrink-0 text-[11px] text-muted-foreground">Within</span>
							<Select
								items={Object.fromEntries(
									FUNNEL_WINDOW_OPTIONS.map((option) => [
										String(option.value),
										option.label,
									]),
								)}
								value={String(paths.windowSeconds)}
								onValueChange={(value) => {
									const seconds = Number(value)
									if (Number.isFinite(seconds) && seconds > 0)
										onUpdate((current) => ({ ...current, windowSeconds: seconds }))
								}}
							>
								<SelectTrigger className="h-8 w-[160px] text-xs" aria-label="Window">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{FUNNEL_WINDOW_OPTIONS.map((option) => (
										<SelectItem key={option.value} value={String(option.value)}>
											{option.label}
										</SelectItem>
									))}
									{FUNNEL_WINDOW_OPTIONS.every(
										(option) => option.value !== paths.windowSeconds,
									) ? (
										<SelectItem value={String(paths.windowSeconds)}>
											{paths.windowSeconds}s
										</SelectItem>
									) : null}
								</SelectContent>
							</Select>
							<span className="text-[11px] text-muted-foreground">of the anchor</span>
						</div>
					)}

					{paths.addOns.include && (
						<div className="flex items-center gap-2">
							<span className="w-16 shrink-0 text-[11px] text-muted-foreground">Include</span>
							<Segmented
								ariaLabel="Include"
								value={paths.include}
								options={[
									{ value: "all", label: "Events + pages" },
									{ value: "events", label: "Events" },
									{ value: "pages", label: "Pages" },
								]}
								onSelect={(include) => onUpdate((current) => ({ ...current, include }))}
							/>
						</div>
					)}

					{paths.addOns.exclude && (
						<div className="flex items-center gap-2">
							<span className="w-16 shrink-0 text-[11px] text-muted-foreground">Exclude</span>
							<Input
								size="sm"
								value={paths.excludeText}
								onChange={(event) =>
									onUpdate((current) => ({ ...current, excludeText: event.target.value }))
								}
								placeholder="heartbeat, /, /health"
								aria-label="Excluded names"
								className="w-[320px] font-mono text-xs"
							/>
							<span className="text-[11px] text-muted-foreground">
								event names or page paths, comma-separated, dropped before sequencing
							</span>
						</div>
					)}
				</div>
			)}
		</QueryPanelShell>
	)
}
