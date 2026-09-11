import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@maple/ui/components/ui/select"
import { cn } from "@maple/ui/lib/utils"

import {
	OVERVIEW_DIMENSIONS,
	compareEnabled,
	failingOnly,
	overviewFilterPatch,
	selectedDimensionValue,
	type AgentOverviewSearch,
	type OverviewFacetOption,
	type OverviewFacets,
} from "@/lib/agent-sessions/overview-search"
import { formatOverviewCount } from "@/lib/agent-sessions/overview-analytics"

/** Base UI selects need a real value for "no filter"; this never reaches the URL. */
const ALL = "__all__"

export interface OverviewFilterToolbarProps {
	search: AgentOverviewSearch
	facets: OverviewFacets
	onSearchChange: (patch: Partial<AgentOverviewSearch>) => void
	/** Names the comparison the toggle turns on, e.g. `7d`. */
	windowLabel: string
	waiting?: boolean
}

/**
 * Which sessions the board is about.
 *
 * Six dimensions, one value each: this page is read by narrowing to one thing
 * at a time, and every control is the same 30px pill so a control drawn in the
 * primary tint reads as "this is narrowing the page" at a glance.
 */
export function OverviewFilterToolbar({
	search,
	facets,
	onSearchChange,
	windowLabel,
	waiting = false,
}: OverviewFilterToolbarProps) {
	const failing = failingOnly(search)
	const compare = compareEnabled(search)
	return (
		<div
			className={cn(
				"flex flex-wrap items-center gap-2 border-b border-border px-6 py-3 transition-opacity",
				waiting && "opacity-60",
			)}
		>
			{OVERVIEW_DIMENSIONS.map((dimension) => (
				<FacetSelect
					key={dimension}
					label={dimension}
					value={selectedDimensionValue(search, dimension)}
					options={facets[dimension]}
					onChange={(value) => onSearchChange(overviewFilterPatch(dimension, value))}
				/>
			))}

			<button
				type="button"
				aria-pressed={failing}
				onClick={() => onSearchChange({ hasErrors: failing ? undefined : true })}
				className={cn(
					"inline-flex h-[30px] items-center gap-1.5 rounded-md border px-2.5 font-mono text-xs transition-colors",
					failing
						? "border-[var(--severity-error)]/50 bg-[var(--severity-error)]/10 text-foreground"
						: "border-border bg-card text-muted-foreground hover:text-foreground",
				)}
			>
				<span
					aria-hidden
					className={cn(
						"size-[5px] rounded-full",
						failing ? "bg-[var(--severity-error)]" : "bg-[var(--severity-error)]/40",
					)}
				/>
				Failing only
			</button>

			<button
				type="button"
				aria-pressed={compare}
				// On is the default, so only the off state reaches the URL.
				onClick={() => onSearchChange({ compare: compare ? false : undefined })}
				className={cn(
					"inline-flex h-[30px] items-center rounded-md border px-2.5 font-mono text-xs transition-colors",
					compare
						? "border-primary/40 bg-primary/10 text-primary"
						: "border-border bg-card text-muted-foreground hover:text-foreground",
				)}
			>
				compare prev {windowLabel}
			</button>
		</div>
	)
}

function FacetSelect({
	label,
	value,
	options,
	onChange,
}: {
	label: string
	value: string | undefined
	options: ReadonlyArray<OverviewFacetOption>
	onChange: (value: string | undefined) => void
}) {
	const set = value !== undefined
	return (
		<Select
			value={value ?? ALL}
			onValueChange={(next) => onChange(next === ALL ? undefined : next)}
			// A dimension the window reported nothing for cannot be chosen from,
			// and a select that opens onto one row reads as broken.
			disabled={options.length === 0}
		>
			<SelectTrigger
				size="sm"
				aria-label={label}
				className={cn(
					"h-[30px] gap-2 rounded-md px-2.5 font-mono text-xs",
					set
						? "border-primary/40 bg-primary/10 text-primary [&_svg]:text-primary"
						: "bg-card text-foreground",
				)}
			>
				<SelectValue>
					<span className={cn("text-[11px]", set ? "text-primary/70" : "text-muted-foreground")}>
						{label}
					</span>{" "}
					{value ?? "All"}
				</SelectValue>
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={ALL}>All</SelectItem>
				{options.map((option) => (
					<SelectItem key={option.name} value={option.name}>
						{option.name}
						<span className="ml-2 text-[11px] tabular-nums text-muted-foreground">
							{formatOverviewCount(option.count)}
						</span>
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	)
}
