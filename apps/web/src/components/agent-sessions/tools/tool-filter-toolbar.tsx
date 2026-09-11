import { ToolbarSearch } from "@maple/ui/components/toolbar"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
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
	model: string | undefined
	modelOptions: ReadonlyArray<ToolFilterOption>
	onModelChange: (value: string | undefined) => void
	env: string | undefined
	envOptions: ReadonlyArray<ToolFilterOption>
	onEnvChange: (value: string | undefined) => void
	failingOnly: boolean
	onToggleFailingOnly: () => void
	waiting?: boolean
}

/**
 * Which calls the page is about: a tool-name search, the service and
 * environment they ran in, and the one-chip triage filter.
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
	query,
	onSearch,
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
}: ToolFilterToolbarProps) {
	return (
		<div className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-3">
			<ToolbarSearch
				query={query}
				onSearch={onSearch}
				placeholder="Tool name…"
				className="w-full font-mono sm:w-[260px]"
			/>

			<div
				className={cn(
					"flex flex-wrap items-center gap-2 transition-opacity",
					waiting && "opacity-60",
				)}
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
							? "border-[var(--severity-error)]/50 bg-[var(--severity-error)]/10 text-foreground"
							: "border-border bg-card text-muted-foreground hover:text-foreground",
					)}
				>
					<span
						aria-hidden
						className={cn(
							"size-[5px] rounded-full",
							failingOnly ? "bg-[var(--severity-error)]" : "bg-[var(--severity-error)]/40",
						)}
					/>
					Failing only
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
	/** The dimension, drawn small beside the value: `service All`. */
	label: string
	value: string | undefined
	options: ReadonlyArray<ToolFilterOption>
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
				{/* The sentinel is a Base UI implementation detail; rendered children
				    are what keeps it off the trigger. */}
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
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	)
}
