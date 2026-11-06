import type { AlertCheckDocument, AlertRuleDocument } from "@maple/domain/http"
import { alertQueryLimits, alertRuleIntervalMinutes } from "@maple/query-engine/datetime"
import { TONE_FILL, type Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { Array as Arr, Record as Rec } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { intervalBeforeSlowdown } from "@maple/web-data/alerts/diagnosis"
import { formatQuerySeconds as seconds } from "@maple/web-data/alerts/query-time"
import { formatTimestampInTimezone } from "@maple/web-data/lib/timezone-format"
import { card } from "@maple/views/ui/card"
import { eyebrow } from "@maple/views/ui/eyebrow"
import type { Message } from "./message"
import { typography } from "@maple/views/ui/typography"

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
			Arr.filter(
				Arr.map(Rec.values(Arr.groupBy(checks, (check) => check.timestamp)), (group) => ({
					timestamp: group[0].timestamp,
					durationMs: Math.max(...Arr.map(group, (check) => check.evaluationDurationMs)),
					isFailure: Arr.some(group, (check) => check.status === "error"),
				})),
				(time) => time.durationMs > 0,
			),
			BAR_CAP,
		),
	)

export const queryTimeCard = (
	h: H,
	rule: AlertRuleDocument,
	checks: ReadonlyArray<AlertCheckDocument>,
	timeZone: string,
): Html | null => {
	// Checks keep the signal they ran with, so a rule switched to SQL charts only its SQL checks.
	const times = checkTimesOf(Arr.filter(checks, (check) => check.signalType === "raw_query"))
	if (rule.signalType !== "raw_query" || times.length === 0) return null
	const interval = alertRuleIntervalMinutes(rule)
	const limitMs = alertQueryLimits(interval).timeSeconds * 1000
	// The limit before a slowdown, which the failures that caused it ran under.
	const unslowedLimitMs =
		rule.slowedIntervalMinutes === null
			? null
			: alertQueryLimits(intervalBeforeSlowdown(rule)).timeSeconds * 1000
	const earlierLimitMs = unslowedLimitMs !== null && unslowedLimitMs < limitMs ? unslowedLimitMs : null
	const scaleMs = Math.max(limitMs * 1.25, ...Arr.map(times, (time) => time.durationMs))
	const slowest = Math.max(...Arr.map(times, (time) => time.durationMs))
	const toneOf = (time: CheckTime): Tone =>
		time.isFailure ? "crit" : time.durationMs > limitMs * 0.8 ? "warn" : "neutral"
	return card(
		h,
		[
			h.div(
				[h.Class("flex flex-wrap items-baseline justify-between gap-2")],
				[
					eyebrow(h, { as: "h2", className: "mb-0" }, ["Query time per check"]),
					typography(h, { size: "xs", tone: "muted", numeric: true }, [
						`Slowest ${seconds(slowest)} · limit ${seconds(limitMs)} at every ${interval === 1 ? "minute" : `${interval} min`}${earlierLimitMs === null ? "" : `, ${seconds(earlierLimitMs)} before the slowdown`}`,
					]),
				],
			),
			h.div(
				[
					h.Class("relative flex h-20 items-end gap-px"),
					h.DataAttribute("testid", "query-time-bars"),
					h.AriaHidden(true),
				],
				[
					...Arr.map(times, (time) =>
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
							h.Class(
								"pointer-events-none absolute inset-x-0 border-t border-dashed border-severity-error/60",
							),
							h.Style({ bottom: `${(limitMs / scaleMs) * 100}%` }),
						],
						[],
					),
					...(earlierLimitMs === null
						? []
						: [
								h.div(
									[
										h.Class(
											"pointer-events-none absolute inset-x-0 border-t border-dotted border-foreground-subtle",
										),
										h.Style({ bottom: `${(earlierLimitMs / scaleMs) * 100}%` }),
									],
									[],
								),
							]),
				],
			),
			// The bars are hover-only, so screen readers get each check as text.
			h.ul(
				[h.Class("sr-only"), h.AriaLabel("Query time per check")],
				Arr.map(times, (time) =>
					h.li(
						[],
						[
							`${formatTimestampInTimezone(time.timestamp, { timeZone })}: ${seconds(time.durationMs)}${time.isFailure ? ", failed" : ""}`,
						],
					),
				),
			),
			...(rule.slowedIntervalMinutes === null
				? []
				: [
						typography(h, { size: "xs", tone: "warning", as: "p" }, [
							`Slowed to every ${rule.slowedIntervalMinutes} min after 3 checks in a row hit their limit. Editing the rule resets this.`,
						]),
					]),
		],
		"gap-3 p-4",
	)
}
