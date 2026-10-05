import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import type { V2Investigation } from "@maple/domain/http/v2"

/**
 * One line of context so the detail tabs never lose the thread. Evidence and
 * Hypotheses are both arguments *about* the cause, and reading either without
 * the cause in view means scrolling back to Overview to remember what is being
 * argued.
 *
 * Square on the left for the same reason the verdict card is — it carries the
 * same accent rule.
 */
export function CauseRecap({ investigation }: { investigation: V2Investigation }) {
	const cause = investigation.report?.suspectedCause?.trim()
	if (!cause) return null

	return (
		<div className="flex shrink-0 items-baseline gap-3 overflow-hidden rounded-r-xl border bg-card py-3 pl-0 pr-5">
			<span aria-hidden className="h-full w-[3px] shrink-0 self-stretch bg-primary" />
			<Eyebrow className="shrink-0 pl-4 text-primary">Cause</Eyebrow>
			<p className="min-w-0 flex-1 text-sm text-foreground">{cause}</p>
		</div>
	)
}
