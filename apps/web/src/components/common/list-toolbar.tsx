import { Tabs, TabsList, TabsTab } from "@maple/ui/components/ui/tabs"

interface ListToolbarTab<T extends string> {
	value: T
	label: string
	count?: number
}

export interface ListToolbarProps<T extends string> {
	tabs: ReadonlyArray<ListToolbarTab<T>>
	active: T
	onChange: (value: T) => void
	/** What the tabs filter, for the tablist's accessible name. */
	label: string
	totalCount?: number
	/** Singular/plural noun for the count readout. */
	countNoun?: readonly [string, string]
	/** Replaces the computed count readout when the page can't state a total. */
	countLabel?: React.ReactNode
	/** Extra controls rendered right-aligned, before the count readout. */
	trailing?: React.ReactNode
}

export function ListToolbar<T extends string>({
	tabs,
	active,
	onChange,
	label,
	totalCount,
	countNoun = ["item", "items"],
	countLabel,
	trailing,
}: ListToolbarProps<T>) {
	return (
		<div className="flex flex-wrap items-center gap-2 gap-y-1.5 border-b border-border/60 px-2 py-1.5">
			<Tabs
				value={active}
				onValueChange={(value) => {
					const next = tabs.find((tab) => tab.value === value)
					if (next) onChange(next.value)
				}}
			>
				<TabsList aria-label={label}>
					{tabs.map((tab) => (
						<TabsTab
							key={tab.value}
							value={tab.value}
							className="group/tab h-7 grow-0 px-2.5 text-xs sm:h-7 sm:text-xs"
						>
							{tab.label}
							{tab.count !== undefined ? (
								<span className="text-muted-foreground/70 tabular-nums group-data-active/tab:text-muted-foreground">
									{tab.count}
								</span>
							) : null}
						</TabsTab>
					))}
				</TabsList>
			</Tabs>
			<div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
				{trailing}
				{countLabel !== undefined ? (
					<span className="text-xs text-muted-foreground tabular-nums">{countLabel}</span>
				) : totalCount !== undefined ? (
					<span className="text-xs text-muted-foreground tabular-nums">
						{totalCount} {totalCount === 1 ? countNoun[0] : countNoun[1]}
					</span>
				) : null}
			</div>
		</div>
	)
}
