import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { cn } from "@maple/ui/lib/utils"

/**
 * Canonical section heading: an `Eyebrow` rendered as an `<h2>` whose `id` is meant
 * to be referenced by an `aria-labelledby` on the group it heads. Pass
 * `className="mb-0"` when it sits inline (e.g. in a flex row beside an action).
 */
export function SectionHeader({ id, label, className }: { id?: string; label: string; className?: string }) {
	return (
		<Eyebrow as="h2" id={id} className={cn("mb-3 block", className)}>
			{label}
		</Eyebrow>
	)
}
