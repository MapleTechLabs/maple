import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { cn } from "@maple/ui/lib/utils"

import { CheckIcon } from "@/components/icons"
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

/** Every control on the row is the same pill, so a lit one reads as a narrowing. */
const PILL = "inline-flex h-[30px] items-center rounded-md border px-2.5 font-mono text-xs"
const PILL_SET = "border-primary/40 bg-primary/10 text-primary"
const PILL_IDLE = "border-border bg-card text-muted-foreground hover:text-foreground"

export interface OverviewFilterToolbarProps {
	search: AgentOverviewSearch
	facets: OverviewFacets
	onSearchChange: (patch: Partial<AgentOverviewSearch>) => void
	/** Names the comparison the toggle turns on, e.g. `7d`. */
	windowLabel: string
	/** The facets read failed, so the selects have no options to offer. Said in
	 *  a line rather than a panel: nothing else on the page depends on it. */
	facetsUnavailable?: boolean
	waiting?: boolean
}

/**
 * Which sessions the board is about.
 *
 * Six dimensions, one value each: this page is read by narrowing to one thing
 * at a time, and every control is the same 30px pill so a control drawn in the
 * primary tint reads as "this is narrowing the page" at a glance. The two
 * switches sit apart from the dimensions because they are not dimensions — one
 * is a predicate on sessions, the other changes what the page compares against.
 */
export function OverviewFilterToolbar({
	search,
	facets,
	onSearchChange,
	windowLabel,
	facetsUnavailable = false,
	waiting = false,
}: OverviewFilterToolbarProps) {
	const failing = failingOnly(search)
	const compare = compareEnabled(search)
	return (
		<div
			className={cn(
				"flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-6 py-3 transition-opacity",
				waiting && "opacity-60",
			)}
		>
			<div className="flex flex-wrap items-center gap-2">
				{OVERVIEW_DIMENSIONS.map((dimension) => (
					<FacetSelect
						key={dimension}
						label={dimension}
						value={selectedDimensionValue(search, dimension)}
						options={facets[dimension]}
						onChange={(value) => onSearchChange(overviewFilterPatch(dimension, value))}
					/>
				))}
				{facetsUnavailable ? (
					<span className="font-mono text-[11px] text-muted-foreground/70">
						Filter options unavailable
					</span>
				) : null}
			</div>

			<div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
				<button
					type="button"
					aria-pressed={failing}
					onClick={() => onSearchChange({ hasErrors: failing ? undefined : true })}
					className={cn(
						PILL,
						"gap-1.5 transition-colors",
						failing
							? "border-[var(--severity-error)]/50 bg-[var(--severity-error)]/10 text-foreground"
							: PILL_IDLE,
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
					className={cn(PILL, "gap-1.5 transition-colors", compare ? PILL_SET : PILL_IDLE)}
				>
					{compare ? <CheckIcon size={12} aria-hidden /> : null}
					compare prev {windowLabel}
				</button>
			</div>
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
			// Base UI reports a cleared selection as `null`, which means what the
			// `ALL` row means: no filter.
			onValueChange={(next) => onChange(next === ALL ? undefined : (next ?? undefined))}
			// A dimension the window reported nothing for cannot be chosen from,
			// and a select that opens onto one row reads as broken — unless it is
			// the one holding the filter, which has to stay clearable however the
			// options read went.
			disabled={options.length === 0 && !set}
		>
			<SelectTrigger
				size="sm"
				aria-label={label}
				className={cn(
					"h-[30px] gap-2 rounded-md px-2.5 font-mono text-xs",
					set ? cn(PILL_SET, "[&_svg]:text-primary") : "bg-card text-foreground",
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
