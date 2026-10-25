import { cn } from "@maple/ui/lib/utils"
import { Clock, Effect, Queue, Random, Schema, Stream } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import type { LoadFailure } from "../data/load-failure"
import {
	isExhausted,
	postponed,
	probed,
	RESUME_WINDOW_MS,
	resume,
	type RetryBudget,
} from "./auto-retry-budget"
import { button } from "./button"

// The error state. The failure is already the
// `displayError` body (`data/load-failure.ts`).

export type ErrorStateOptions<M> = Readonly<{
	failure: LoadFailure
	title?: string
	onRetry?: M
	/** Keep the auto-retry but draw no button: a page-level strip already offers Try again. */
	hidesRetryButton?: boolean
	/** `quiet`: one muted line (the title) under a page-level error that already explains it. */
	variant?: "panel" | "row" | "inline" | "quiet"
	className?: string
}>

const attr = <M>(h: HtmlBuilder<M>, entries: Readonly<Record<string, string>>) =>
	Object.entries(entries).map(([name, value]) => h.Attribute(name, value))

/** `DroppedSignalGlyph`: a signal line that cuts out, the break, and a dashed trail. */
const droppedSignalGlyph = <M>(h: HtmlBuilder<M>, isCompact: boolean): Html =>
	h.svg(
		attr(h, {
			width: isCompact ? "64" : "176",
			height: isCompact ? "18" : "50",
			viewBox: "0 0 200 56",
			fill: "none",
			"aria-hidden": "true",
			class: "shrink-0",
		}),
		[
			h.line(
				attr(h, {
					x1: "4",
					y1: "12",
					x2: "196",
					y2: "12",
					class: "stroke-border",
					"stroke-width": "1",
					opacity: "0.5",
				}),
			),
			h.line(
				attr(h, {
					x1: "4",
					y1: "44",
					x2: "196",
					y2: "44",
					class: "stroke-border",
					"stroke-width": "1",
					opacity: "0.5",
				}),
			),
			h.polyline(
				attr(h, {
					points: "6,32 20,30 32,33 44,28 56,31 68,27 80,31 92,29 104,33 116,30",
					fill: "none",
					class: "stroke-muted-foreground",
					"stroke-width": "2",
					"stroke-linecap": "round",
					"stroke-linejoin": "round",
					opacity: "0.7",
				}),
			),
			h.line(
				attr(h, {
					x1: "130",
					y1: "30",
					x2: "194",
					y2: "30",
					class: "stroke-destructive",
					"stroke-width": "1.5",
					"stroke-dasharray": "3 5",
					"stroke-linecap": "round",
					opacity: "0.45",
				}),
			),
			h.circle(attr(h, { cx: "118", cy: "30", r: "5.5", class: "fill-destructive", opacity: "0.35" })),
			h.circle(attr(h, { cx: "118", cy: "30", r: "2.5", class: "fill-destructive" })),
		],
	)

/** `SignalBreakTick`: the inline variant's glyph, a signal stub, a break and a dashed trail. */
const signalBreakTick = <M>(h: HtmlBuilder<M>): Html =>
	h.svg(attr(h, { width: "12", height: "12", viewBox: "0 0 12 12", fill: "none", "aria-hidden": "true" }), [
		h.polyline(
			attr(h, {
				points: "1,7 3,6 5,7.5 6.5,6",
				fill: "none",
				stroke: "currentColor",
				"stroke-width": "1.5",
				"stroke-linecap": "round",
				"stroke-linejoin": "round",
			}),
		),
		h.circle(attr(h, { cx: "7.5", cy: "6", r: "1.25", fill: "currentColor" })),
		h.line(
			attr(h, {
				x1: "9.5",
				y1: "6",
				x2: "11.5",
				y2: "6",
				stroke: "currentColor",
				"stroke-width": "1.25",
				"stroke-dasharray": "1.5 1.75",
				"stroke-linecap": "round",
				opacity: "0.6",
			}),
		),
	])

const alertRegion = <M>(h: HtmlBuilder<M>) => [h.Role("alert"), h.AriaLive("polite"), h.AriaAtomic(true)]

const AutoRetryMessage = defineMessageUnion({ ElapsedAutoRetry: {} })

/** One backoff per page and retry Message, shared by every mount that retries the same thing. */
const budgets = new Map<string, RetryBudget>()

/** `useNetworkAutoRetry`: jittered backoff probes, plus the `online` and visibility events. */
export const MountNetworkAutoRetry = Mount.defineStream("MountNetworkAutoRetry", {
	args: { retryKey: Schema.String },
	messages: [AutoRetryMessage.ElapsedAutoRetry],
	execute: ({ retryKey }) =>
		Stream.callback<typeof AutoRetryMessage.ElapsedAutoRetry.Type>((queue) =>
			Effect.acquireRelease(
				Effect.flatMap(Effect.all([Clock.currentTimeMillis, Random.next]), ([now, jitter]) =>
					Effect.sync(() => {
						const key = `${location.pathname} ${retryKey}`
						budgets.forEach((budget, other) => {
							if (now - budget.touchedAt >= RESUME_WINDOW_MS) budgets.delete(other)
						})
						budgets.set(key, resume(budgets.get(key), now, jitter))
						const state = { timeout: 0 }
						const probe = () => Queue.offerUnsafe(queue, AutoRetryMessage.ElapsedAutoRetry())
						const schedule = () => {
							const budget = budgets.get(key)
							if (budget === undefined || isExhausted(budget)) return
							state.timeout = window.setTimeout(
								() => {
									const due = budgets.get(key)
									const at = Date.now()
									if (due !== undefined && at >= due.nextAt) {
										const isUp = !document.hidden && navigator.onLine !== false
										budgets.set(
											key,
											isUp
												? probed(due, at, Math.random())
												: postponed(due, at, Math.random()),
										)
										if (isUp) probe()
									}
									schedule()
								},
								Math.max(0, budget.nextAt - Date.now()),
							)
						}
						const onVisibilityChange = () => {
							if (!document.hidden && navigator.onLine !== false) probe()
						}
						window.addEventListener("online", probe)
						document.addEventListener("visibilitychange", onVisibilityChange)
						schedule()
						return () => {
							window.removeEventListener("online", probe)
							document.removeEventListener("visibilitychange", onVisibilityChange)
							window.clearTimeout(state.timeout)
						}
					}),
				),
				(release) => Effect.sync(release),
			),
		),
})

export const errorState = <M>(h: HtmlBuilder<M>, options: ErrorStateOptions<M>): Html => {
	const { failure } = options
	const heading = options.title ?? failure.title
	const canRetry =
		options.onRetry !== undefined && (failure.recovery === "retry" || failure.recovery === "refresh")
	const { onRetry } = options
	// TODO(auto-retry-exhausted): drop the "Retrying" note after the sixth probe.
	const autoRetry =
		onRetry !== undefined && canRetry && failure.retryable
			? [
					h.OnMount(
						Mount.mapMessage(
							MountNetworkAutoRetry({ retryKey: JSON.stringify(onRetry) }),
							() => onRetry,
						),
					),
				]
			: []
	// "Retry in a few seconds" contradicts the auto-retry note, so the note replaces it.
	const message =
		autoRetry.length > 0
			? `${failure.message.replace(/\s*Retry in a few seconds\.$/, "")} Retrying automatically…`
			: failure.message
	const retry = (variant: "ghost" | "outline", className?: string) =>
		options.onRetry === undefined || !canRetry || options.hidesRetryButton === true
			? []
			: [
					button(h, { size: "sm", variant, className, attributes: [h.OnClick(options.onRetry)] }, [
						"Try again",
					]),
				]
	const variant = options.variant ?? "panel"

	if (variant === "quiet") {
		return h.div(
			[
				h.Class(cn("flex items-center gap-2", options.className)),
				h.Role("status"),
				h.Title(message),
				...autoRetry,
			],
			[
				h.p(
					[h.Class("font-prose text-xs text-muted-foreground")],
					[heading, h.span([h.Class("sr-only")], [heading === "" ? message : `. ${message}`])],
				),
				...retry("ghost", "h-6 px-2 font-prose text-xs text-muted-foreground hover:text-foreground sm:text-xs"),
			],
		)
	}

	if (variant === "inline") {
		return h.div(
			[h.Class(cn("flex flex-col gap-1.5 py-4", options.className)), ...alertRegion(h), ...autoRetry],
			[
				h.div(
					[h.Class("flex items-center gap-2")],
					[
						h.span(
							[
								h.Class(
									"flex size-5 shrink-0 items-center justify-center rounded-md bg-destructive/10 text-destructive",
								),
								h.AriaHidden(true),
							],
							[signalBreakTick(h)],
						),
						h.p([h.Class("font-prose text-xs font-medium text-foreground")], [heading]),
					],
				),
				h.p([h.Class("font-prose text-xs whitespace-pre-wrap text-muted-foreground")], [message]),
				...retry("ghost", "-ml-2 h-6 w-fit px-2 text-xs text-muted-foreground hover:text-foreground"),
			],
		)
	}

	if (variant === "row") {
		return h.div(
			[
				h.Class(
					cn(
						"flex flex-wrap items-center gap-x-4 gap-y-3 rounded-md border border-dashed px-4 py-3.5",
						options.className,
					),
				),
				...alertRegion(h),
				...autoRetry,
			],
			[
				droppedSignalGlyph(h, true),
				h.div(
					[h.Class("min-w-0 flex-1 basis-56 space-y-0.5")],
					[
						h.p([h.Class("font-prose text-sm font-medium text-foreground")], [heading]),
						h.p([h.Class("font-prose line-clamp-2 text-xs text-muted-foreground")], [message]),
					],
				),
				...retry("outline", "shrink-0"),
			],
		)
	}

	return h.div(
		[
			h.Class(
				cn(
					"flex h-full flex-col items-center justify-center gap-4 rounded-md border border-dashed px-6 py-8 text-center",
					options.className,
				),
			),
			...alertRegion(h),
			...autoRetry,
		],
		[
			h.div([h.Class("rounded-md border bg-card/50 px-3 py-2.5")], [droppedSignalGlyph(h, false)]),
			h.div(
				[h.Class("max-w-sm space-y-1")],
				[
					h.p([h.Class("font-prose text-sm font-medium text-foreground")], [heading]),
					h.p([h.Class("font-prose text-xs whitespace-pre-wrap text-muted-foreground")], [message]),
				],
			),
			...retry("outline"),
		],
	)
}
