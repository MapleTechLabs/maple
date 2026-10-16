import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { cn } from "@maple/ui/lib/utils"
import type { KeyActivity } from "./shared"

/** Dot for live and idle keys, a hollow ring while waiting, two bars while paused. */
export function KeyStatusMark({ activity, large = false }: { activity: KeyActivity; large?: boolean }) {
	if (activity === "paused") {
		return (
			<span
				aria-hidden
				className={cn("flex shrink-0 justify-center gap-px", large ? "size-3" : "size-2")}
			>
				<span className="bg-severity-warn h-full w-[35%] rounded-[1px]" />
				<span className="bg-severity-warn h-full w-[35%] rounded-[1px]" />
			</span>
		)
	}
	if (activity === "waiting" || activity === "expired") {
		return (
			<span
				aria-hidden
				className={cn(
					"shrink-0 rounded-full border-[1.5px]",
					large ? "size-3 border-2" : "size-2",
					activity === "waiting" ? "border-severity-warn" : "border-muted-foreground",
				)}
			/>
		)
	}
	return (
		<StatusDot
			tone={activity === "live" ? "ok" : "neutral"}
			size="lg"
			className={large ? "size-3" : undefined}
		/>
	)
}
