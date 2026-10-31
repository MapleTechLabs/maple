import type { ActorDocument } from "@maple/domain/http"
import { formatCountdown } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import { DateTime, Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "../../../ui/eyebrow"
import { panel } from "../../../ui/panel"
import { statusDot } from "../../../ui/status-dot"
import { actorChip } from "../kit/actor"

// The lease HUD: the countdown ring beside who holds the lease.

const DANGER_MS = 60_000
const RING_SIZE = 36
const RING_RADIUS = 14
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
const CENTER = String(RING_SIZE / 2)

const isoMs = (iso: string): number | null =>
	Option.getOrNull(Option.map(DateTime.make(iso), DateTime.toEpochMillis))

const ringCircle = <M>(h: HtmlBuilder<M>, attributes: ReadonlyArray<readonly [string, string]>): Html =>
	h.circle([
		h.Attribute("cx", CENTER),
		h.Attribute("cy", CENTER),
		h.Attribute("r", String(RING_RADIUS)),
		...attributes.map(([name, value]) => h.Attribute(name, value)),
	])

export const leaseHud = <M>(
	h: HtmlBuilder<M>,
	lease: Readonly<{ leaseHolder: ActorDocument; leaseExpiresAt: string; claimedAt: string | null }>,
	nowMs: number,
): Html | null => {
	const expiresMs = isoMs(lease.leaseExpiresAt)
	if (expiresMs === null) return null
	const claimedMs = lease.claimedAt === null ? null : isoMs(lease.claimedAt)
	const remainingMs = Math.max(0, expiresMs - nowMs)
	const durationMs =
		claimedMs !== null && expiresMs > claimedMs
			? expiresMs - claimedMs
			: Math.max(remainingMs, 15 * 60_000)
	const progress = durationMs > 0 ? Math.min(1, remainingMs / durationMs) : 0
	const isDanger = remainingMs > 0 && remainingMs < DANGER_MS
	const isExpired = remainingMs === 0
	const ringColor = isExpired
		? "var(--muted-foreground)"
		: isDanger
			? "var(--severity-error)"
			: "var(--primary)"
	const size = String(RING_SIZE)
	return panel(
		h,
		{
			className: cn(
				"flex-row items-center gap-3 border-border-subtle bg-card/50 px-3 py-2.5",
				isDanger && "border-severity-error-a4",
			),
		},
		[
			h.div(
				[
					h.Class("relative shrink-0"),
					h.Style({ width: `${RING_SIZE}px`, height: `${RING_SIZE}px` }),
				],
				[
					h.svg(
						[
							h.Attribute("width", size),
							h.Attribute("height", size),
							h.Attribute("viewBox", `0 0 ${size} ${size}`),
							h.Attribute("aria-hidden", "true"),
						],
						[
							ringCircle(h, [
								["stroke", "var(--border)"],
								["stroke-width", "3"],
								["fill", "none"],
							]),
							ringCircle(h, [
								["stroke", ringColor],
								["stroke-width", "3"],
								["fill", "none"],
								["stroke-linecap", "round"],
								["stroke-dasharray", String(RING_CIRCUMFERENCE)],
								["stroke-dashoffset", String(RING_CIRCUMFERENCE * (1 - progress))],
								["transform", `rotate(-90 ${CENTER} ${CENTER})`],
								["style", "transition: stroke-dashoffset 0.5s linear, stroke 0.3s;"],
							]),
						],
					),
				],
			),
			h.div(
				[h.Class("flex min-w-0 flex-1 flex-col gap-1")],
				[
					h.div(
						[h.Class("flex items-baseline justify-between gap-3")],
						[
							eyebrow(h, { className: "flex items-center gap-2" }, [
								statusDot(h, { tone: isExpired ? "neutral" : isDanger ? "crit" : "live" }),
								isExpired ? "Lease expired" : "Active lease",
							]),
							h.span(
								[
									h.Class(
										cn(
											"font-mono text-base font-semibold tabular-nums leading-none",
											isExpired
												? "text-muted-foreground"
												: isDanger
													? "text-severity-error"
													: "text-foreground",
										),
									),
								],
								[formatCountdown(remainingMs)],
							),
						],
					),
					h.div(
						[h.Class("flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground")],
						[
							h.span([h.Class("shrink-0")], ["held by"]),
							actorChip(h, lease.leaseHolder, "min-w-0"),
						],
					),
				],
			),
		],
	)
}
