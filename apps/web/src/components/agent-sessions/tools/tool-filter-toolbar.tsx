import { ToolbarSearch } from "@maple/ui/components/toolbar"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Switch } from "@maple/ui/components/ui/switch"
import { cn } from "@maple/ui/lib/utils"

/** One option in the service / env selects, with the sessions behind it. */
export interface ToolFilterOption {
	readonly name: string
	readonly count: number
}

/** Base UI selects need a real value for "no filter"; this is it, and it never reaches the URL. */
const ALL = "__all__"

interface ToolFilterToolbarProps {
	query: string
	onSearch: (value: string | undefined) => void
	service: string | undefined
	serviceOptions: ReadonlyArray<ToolFilterOption>
	onServiceChange: (value: string | undefined) => void
	env: string | undefined
	envOptions: ReadonlyArray<ToolFilterOption>
	onEnvChange: (value: string | undefined) => void
	failingOnly: boolean
	onToggleFailingOnly: () => void
	waiting?: boolean
}

/**
 * Which calls the page is about: a tool-name search, the service and
 * environment they ran in, and the one-switch triage filter.
 *
 * Deliberately no model select. Model is a *scope*, not a filter — it is picked
 * from the Models table, where its call volume and error rate are visible
 * beside it, and it shows up in the scope row as a removable chip. A second
 * place to set the same param would be two controls that can disagree.
 */
export function ToolFilterToolbar({
	query,
	onSearch,
	service,
	serviceOptions,
	onServiceChange,
	env,
	envOptions,
	onEnvChange,
	failingOnly,
	onToggleFailingOnly,
	waiting = false,
}: ToolFilterToolbarProps) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-3">
			<ToolbarSearch
				query={query}
				onSearch={onSearch}
				placeholder="Tool name…"
				className="w-full sm:max-w-xs"
			/>

			<div
				className={cn(
					"flex flex-wrap items-center gap-3 transition-opacity",
					waiting && "opacity-60",
				)}
			>
				<FacetSelect
					label="Service"
					allLabel="All services"
					value={service}
					options={serviceOptions}
					onChange={onServiceChange}
				/>
				<FacetSelect
					label="Environment"
					allLabel="All environments"
					value={env}
					options={envOptions}
					onChange={onEnvChange}
				/>

				{/* A switch rather than a chip, for the reason the sessions list gives:
				    it is a filter that is on or off, and a destructive-toned chip reads
				    as a warning about the page rather than a control over it. */}
				<label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium">
					<Switch
						checked={failingOnly}
						onCheckedChange={onToggleFailingOnly}
						className="[--thumb-size:--spacing(3.5)] data-checked:bg-destructive"
					/>
					Failing only
				</label>
			</div>
		</div>
	)
}

function FacetSelect({
	label,
	allLabel,
	value,
	options,
	onChange,
}: {
	label: string
	/** What the trigger and the first row read when nothing is picked. */
	allLabel: string
	value: string | undefined
	options: ReadonlyArray<ToolFilterOption>
	onChange: (value: string | undefined) => void
}) {
	return (
		<Select
			value={value ?? ALL}
			onValueChange={(next) => onChange(next === ALL ? undefined : next)}
			// A dimension the window reported nothing for cannot be chosen from,
			// and a select that opens onto one row reads as broken.
			disabled={options.length === 0}
		>
			<SelectTrigger size="sm" className="h-7 min-w-28 text-xs" aria-label={label}>
				{/* The sentinel is a Base UI implementation detail; rendered children
				    are what keeps it off the trigger. */}
				<SelectValue>{value ?? allLabel}</SelectValue>
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={ALL}>{allLabel}</SelectItem>
				{options.map((option) => (
					<SelectItem key={option.name} value={option.name}>
						{option.name}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	)
}
