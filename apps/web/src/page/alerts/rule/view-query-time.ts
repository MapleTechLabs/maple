import type { AlertCheckDocument, AlertRuleDocument } from "@maple/domain/http"
import { alertQueryLimits, alertRuleIntervalMinutes } from "@maple/query-engine/datetime"
import { TONE_FILL, type Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { formatQuerySeconds as seconds } from "@maple/web-data/alerts/query-time"
import { card } from "../../../ui/card"
import { eyebrow } from "../../../ui/eyebrow"
import type { Message } from "./message"

// A raw SQL rule's query time per check against its limit, so a slow query shows before it times out.

type H = HtmlBuilder<Message>

const BAR_CAP = 60

interface CheckTime {
	readonly timestamp: string
	readonly durationMs: number
	readonly isFailure: boolean
}

/**
 * One bar per timed check, newest 60: a grouped rule records every group under the same
 * check time, and checks from before query times were recorded carry 0.
 */
export const checkTimesOf = (checks: ReadonlyArray<AlertCheckDocument>): ReadonlyArray<CheckTime> =>
	Arr.reverse(
		Arr.take(
			Object.values(Arr.groupBy(checks, (check) => check.timestamp))
				.map((group) => ({
					timestamp: group[0].timestamp,
					durationMs: Math.max(...group.map((check) => check.evaluationDurationMs)),
					isFailure: group.some((check) => check.status === "error"),
				}))
				.filter((time) => time.durationMs > 0),
			BAR_CAP,
		),
	)


export const queryTimeCard = (h: H, rule: AlertRuleDocument, checks: ReadonlyArray<AlertCheckDocument>): Html | null => {
	// Checks keep the signal they ran with, so a rule switched to SQL charts only its SQL checks.
	const times = checkTimesOf(checks.filter((check) => check.signalType === "raw_query"))
	if (rule.signalType !== "raw_query" || times.length === 0) return null
	const interval = alertRuleIntervalMinutes(rule)
	const limitMs = alertQueryLimits(interval).timeSeconds * 1000
	// The limit before a slowdown, which the failures that caused it ran under.
	const unslowedLimitMs =
		rule.slowedIntervalMinutes === null
			? null
			: alertQueryLimits(alertRuleIntervalMinutes({ ...rule, slowedIntervalMinutes: null })).timeSeconds * 1000
	const earlierLimitMs = unslowedLimitMs !== null && unslowedLimitMs < limitMs ? unslowedLimitMs : null
	const scaleMs = Math.max(limitMs * 1.25, ...times.map((time) => time.durationMs))
	const slowest = Math.max(...times.map((time) => time.durationMs))
	const toneOf = (time: CheckTime): Tone =>
		time.isFailure ? "crit" : time.durationMs > limitMs * 0.8 ? "warn" : "neutral"
	return card(
		h,
		[
			h.div(
				[h.Class("flex flex-wrap items-baseline justify-between gap-2")],
				[
					eyebrow(h, { as: "h2", className: "mb-0" }, ["Query time per check"]),
					h.span(
						[h.Class("text-xs text-muted-foreground tabular-nums")],
						[
							`Slowest ${seconds(slowest)} · limit ${seconds(limitMs)} at every ${interval === 1 ? "minute" : `${interval} min`}${earlierLimitMs === null ? "" : `, ${seconds(earlierLimitMs)} before the slowdown`}`,
						],
					),
				],
			),
			h.div(
				[h.Class("relative flex h-20 items-end gap-px"), h.DataAttribute("testid", "query-time-bars")],
				[
					...times.map((time) =>
						h.div(
							[
								h.Class(cn("min-w-[3px] flex-1 rounded-t-sm", TONE_FILL[toneOf(time)])),
								h.Style({ height: `${Math.max((time.durationMs / scaleMs) * 100, 2)}%` }),
								h.Title(`${seconds(time.durationMs)}${time.isFailure ? ", failed" : ""}`),
							],
							[],
						),
					),
					h.div(
						[
							h.Class("pointer-events-none absolute inset-x-0 border-t border-dashed border-severity-error/60"),
							h.Style({ bottom: `${(limitMs / scaleMs) * 100}%` }),
						],
						[],
					),
					...(earlierLimitMs === null
						? []
						: [
								h.div(
									[
										h.Class("pointer-events-none absolute inset-x-0 border-t border-dotted border-muted-foreground/50"),
										h.Style({ bottom: `${(earlierLimitMs / scaleMs) * 100}%` }),
									],
									[],
								),
							]),
				],
			),
			...(rule.slowedIntervalMinutes === null
				? []
				: [
						h.p(
							[h.Class("text-xs text-severity-warn")],
							[
								`Slowed to every ${rule.slowedIntervalMinutes} min after 3 checks in a row hit their limit. Editing the rule resets this.`,
							],
						),
					]),
		],
		"gap-3 p-4",
	)
}
