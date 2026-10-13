import { getServiceColor } from "../lib/colors"
import { cn } from "../lib/utils"

/**
 * Small color blob identifying a service. The color is deterministic from the
 * service name (see getServiceColor), so a service is recognizable by the same
 * color everywhere in the product. Decorative only — the adjacent service name
 * remains the accessible label. `size="sm"` is the inline-with-text-xs size.
 */
export function ServiceDot({
	serviceName,
	size = "default",
	className,
}: {
	serviceName: string
	size?: "sm" | "default"
	className?: string
}) {
	return (
		<span
			aria-hidden
			className={cn(
				"shrink-0 rounded-[35%] [corner-shape:squircle]",
				size === "sm" ? "size-1.5" : "size-2",
				className,
			)}
			style={{ backgroundColor: getServiceColor(serviceName) }}
		/>
	)
}
