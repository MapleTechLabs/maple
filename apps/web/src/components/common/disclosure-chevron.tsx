import { cn } from "@maple/ui/lib/utils"
import { ChevronDownIcon, ChevronRightIcon } from "@/components/icons"

/**
 * The rotating chevron on an expandable row. `right` points right and turns down when open;
 * `down` points down and flips up when open.
 */
export function DisclosureChevron({
	open,
	direction = "right",
	size,
	className,
}: {
	open: boolean
	direction?: "right" | "down"
	size?: number
	className?: string
}) {
	const Icon = direction === "right" ? ChevronRightIcon : ChevronDownIcon
	const rotated = direction === "right" ? "rotate-90" : "rotate-180"
	return (
		<Icon
			size={size}
			aria-hidden
			className={cn("shrink-0 transition-transform", open && rotated, className)}
		/>
	)
}
