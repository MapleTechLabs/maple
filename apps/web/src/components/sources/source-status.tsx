import type { V2Source } from "@maple/domain/http/v2"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"

/**
 * What the badge shows. Mirrors the planned `health.status` values so the badge can switch
 * to the API's health object without changing its callers.
 */
export type SourceStatus = "pending" | "healthy" | "stale" | "failing" | "paused" | "disconnected" | "expired"

export interface SourceStatusValue {
	readonly status: SourceStatus
	readonly lastDataAt: string | null
}

/** Derived until the API sends `health`: lifecycle from `status`, then whether data ever arrived. */
export const sourceStatus = (source: V2Source): SourceStatusValue => ({
	status:
		source.status === "paused"
			? "paused"
			: source.status === "expired"
				? "expired"
				: source.last_used_at === null
					? "pending"
					: "healthy",
	lastDataAt: source.last_used_at,
})

const TONE = {
	pending: "neutral",
	healthy: "ok",
	stale: "warn",
	failing: "crit",
	paused: "warn",
	disconnected: "crit",
	expired: "neutral",
} as const satisfies Record<SourceStatus, "neutral" | "ok" | "warn" | "crit">

const LABEL = {
	pending: "Waiting for data",
	healthy: "Receiving",
	stale: "No recent data",
	failing: "Failing",
	paused: "Paused",
	disconnected: "Disconnected",
	expired: "Expired",
} satisfies Record<SourceStatus, string>

export const sourceStatusLabel = (status: SourceStatus) => LABEL[status]

export function SourceStatusBadge({
	value,
	now = Date.now(),
	showTime = true,
	className,
}: {
	value: SourceStatusValue
	now?: number
	/** Appends the relative time of the last data to "Receiving". */
	showTime?: boolean
	className?: string
}) {
	const withTime = showTime && value.status === "healthy" && value.lastDataAt !== null
	return (
		<span className={cn("inline-flex min-w-0 items-center gap-2 text-sm", className)}>
			<StatusDot tone={TONE[value.status]} size="lg" />
			<span className="truncate">
				{LABEL[value.status]}
				{withTime && value.lastDataAt !== null ? (
					<span className="text-muted-foreground">
						{" "}
						· {formatRelativeTime(value.lastDataAt, now)}
					</span>
				) : null}
			</span>
		</span>
	)
}
