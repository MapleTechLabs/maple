import { cn } from "@maple/ui/lib/utils"

import { MagnifierIcon, XmarkIcon } from "@/components/icons"

/** The 24px mono filter field that sits in Cloudflare section headers and panel toolbars. */
export function CompactFilterInput({
	value,
	onChange,
	placeholder,
	label,
	className,
}: {
	value: string
	onChange: (value: string) => void
	placeholder: string
	label: string
	className?: string
}) {
	return (
		<label
			className={cn(
				"flex h-6 items-center gap-1.5 rounded-sm border border-border/70 bg-background/60 px-2 transition-colors focus-within:border-ring",
				className,
			)}
		>
			<MagnifierIcon size={11} className="shrink-0 text-muted-foreground" />
			<input
				type="search"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				placeholder={placeholder}
				aria-label={label}
				className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
			/>
			{value ? (
				<button
					type="button"
					onClick={() => onChange("")}
					aria-label="Clear filter"
					className="shrink-0 rounded-xs p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-1 focus-visible:outline-ring"
				>
					<XmarkIcon size={9} />
				</button>
			) : null}
		</label>
	)
}
