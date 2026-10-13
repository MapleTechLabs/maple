import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { Panel } from "@maple/ui/components/ui/panel"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import * as React from "react"
import type { ActorDocument } from "@maple/domain/http"
import { formatCountdown } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import { normalizeTimestampInput } from "@/lib/timezone-format"
import { ActorChip } from "./actor-chip"

interface LeaseHudProps {
	leaseExpiresAt: string
	claimedAt: string | null
	leaseHolder: ActorDocument
	className?: string
}

const DANGER_MS = 60_000
const RING_SIZE = 36
const RING_RADIUS = 14
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

export function LeaseHud({ leaseExpiresAt, claimedAt, leaseHolder, className }: LeaseHudProps) {
	const [now, setNow] = React.useState(() => Date.now())

	React.useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(id)
	}, [])

	const expiresMs = Date.parse(normalizeTimestampInput(leaseExpiresAt))
	const claimedMs = claimedAt ? Date.parse(normalizeTimestampInput(claimedAt)) : null
	if (!Number.isFinite(expiresMs)) return null

	const remainingMs = Math.max(0, expiresMs - now)
	const durationMs =
		claimedMs && Number.isFinite(claimedMs) && expiresMs > claimedMs
			? expiresMs - claimedMs
			: Math.max(remainingMs, 15 * 60_000)
	const progress = durationMs > 0 ? Math.min(1, remainingMs / durationMs) : 0
	const danger = remainingMs > 0 && remainingMs < DANGER_MS
	const expired = remainingMs === 0

	const dashOffset = RING_CIRCUMFERENCE * (1 - progress)

	const ringColor = expired
		? "var(--muted-foreground)"
		: danger
			? "var(--severity-error)"
			: "var(--primary)"

	return (
		<Panel
			className={cn(
				"flex-row items-center gap-3 border-border/60 bg-card/50 px-3 py-2.5",
				danger && "border-severity-error/40",
				className,
			)}
		>
			<div className="relative shrink-0" style={{ width: RING_SIZE, height: RING_SIZE }}>
				<svg
					width={RING_SIZE}
					height={RING_SIZE}
					viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
					aria-hidden
				>
					<circle
						cx={RING_SIZE / 2}
						cy={RING_SIZE / 2}
						r={RING_RADIUS}
						stroke="var(--border)"
						strokeWidth={3}
						fill="none"
					/>
					<circle
						cx={RING_SIZE / 2}
						cy={RING_SIZE / 2}
						r={RING_RADIUS}
						stroke={ringColor}
						strokeWidth={3}
						fill="none"
						strokeLinecap="round"
						strokeDasharray={RING_CIRCUMFERENCE}
						strokeDashoffset={dashOffset}
						transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
						style={{ transition: "stroke-dashoffset 0.5s linear, stroke 0.3s" }}
					/>
				</svg>
			</div>
			{/* Two lines beside the ring, not three things in a row: the rail is
			    ~256px wide, and label + countdown + holder side by side wrapped the
			    label into the holder. */}
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<div className="flex items-baseline justify-between gap-3">
					<Eyebrow className="flex items-center gap-2">
						<StatusDot tone={expired ? "neutral" : danger ? "crit" : "live"} />
						{expired ? "Lease expired" : "Active lease"}
					</Eyebrow>
					<span
						className={cn(
							"font-mono text-base font-semibold tabular-nums leading-none",
							expired
								? "text-muted-foreground"
								: danger
									? "text-severity-error"
									: "text-foreground",
						)}
					>
						{formatCountdown(remainingMs)}
					</span>
				</div>
				<div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
					<span className="shrink-0">held by</span>
					<ActorChip actor={leaseHolder} className="min-w-0" />
				</div>
			</div>
		</Panel>
	)
}
