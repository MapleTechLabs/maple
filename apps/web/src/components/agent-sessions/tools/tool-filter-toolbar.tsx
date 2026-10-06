import type { ReactNode } from "react"

import { TONE_FILL } from "@maple/ui/lib/tone"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { ToolbarSearch } from "@maple/ui/components/toolbar"
import { cn } from "@maple/ui/lib/utils"

import { FacetSelect } from "@/components/common/facet-select"

/** One option in the service / env selects, with the sessions behind it. */
export interface ToolFilterOption {
	readonly name: string
	readonly count: number
}

interface ToolFilterToolbarProps {
	/** The tool-name search. Absent on the tool detail page, which is one tool. */
	nameSearch?: { query: string; onSearch: (value: string | undefined) => void }
	service: string | undefined
	serviceOptions: ReadonlyArray<ToolFilterOption>
	onServiceChange: (value: string | undefined) => void
	model: string | undefined
	modelOptions: ReadonlyArray<ToolFilterOption>
	onModelChange: (value: string | undefined) => void
	env: string | undefined
	envOptions: ReadonlyArray<ToolFilterOption>
	onEnvChange: (value: string | undefined) => void
	failingOnly: boolean
	onToggleFailingOnly: () => void
	waiting?: boolean
	/** Trailing controls, right-aligned after the filters: the overview's
	 *  time-range picker and Reload, where the Sessions list's toolbar ends in its own Reload. */
	actions?: ReactNode
}

/**
 * Which calls the page is about: a tool-name search (overview only), the
 * service and environment they ran in, and the one-chip triage filter.
 *
 * Model is one of the three selects rather than a table of its own: the page
 * is about tools, and "which model ran them" is a lens on that list, not a
 * second list to rank. It still shows up in the scope band as a removable chip,
 * because the band is where everything narrowing the page is stated at once.
 *
 * Every control is the same 30px pill, and a control with a value set is drawn
 * in the primary tint so the toolbar reads as "what is narrowing this page" at
 * a glance.
 */
export function ToolFilterToolbar({
	nameSearch,
	service,
	serviceOptions,
	onServiceChange,
	model,
	modelOptions,
	onModelChange,
	env,
	envOptions,
	onEnvChange,
	failingOnly,
	onToggleFailingOnly,
	waiting = false,
	actions,
}: ToolFilterToolbarProps) {
	return (
		<div className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-3">
			{nameSearch ? (
				<ToolbarSearch
					query={nameSearch.query}
					onSearch={nameSearch.onSearch}
					placeholder="Tool name…"
					className="w-full font-mono sm:w-[260px]"
				/>
			) : null}

			<div
				aria-busy={waiting || undefined}
				className={cn("flex flex-wrap items-center gap-2", refreshingClass(waiting))}
			>
				<FacetSelect
					label="service"
					value={service}
					options={serviceOptions}
					onChange={onServiceChange}
				/>
				<FacetSelect label="model" value={model} options={modelOptions} onChange={onModelChange} />
				<FacetSelect label="env" value={env} options={envOptions} onChange={onEnvChange} />

				<button
					type="button"
					aria-pressed={failingOnly}
					onClick={onToggleFailingOnly}
					className={cn(
						"inline-flex h-[30px] items-center gap-1.5 rounded-md border px-2.5 font-mono text-xs transition-colors",
						failingOnly
							? "border-severity-error/50 bg-severity-error/10 text-foreground"
							: "border-border bg-card text-muted-foreground hover:text-foreground",
					)}
				>
					<span
						aria-hidden
						className={cn(
							"size-[5px] rounded-full",
							failingOnly ? TONE_FILL.crit : "bg-severity-error/40",
						)}
					/>
					Failing only
				</button>
			</div>

			{actions ? <div className="ml-auto">{actions}</div> : null}
		</div>
	)
}
