import { cn } from "@maple/ui/lib/utils"
import { Clock, Effect, Queue, Random, Schema, Stream } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { failureMessage, type LoadFailure } from "../data/load-failure"
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
	/** Replaces the failure's own message, when it names another subject than this one. */
	message?: string
	/** `quiet`: one muted line (the title) under a page-level error that already explains it. */
	variant?: "panel" | "row" | "inline" | "quiet"
	/** Overrides the glyph `failureKind` derives from the failure. */
	kind?: FailureKind
	/** A sentence after the message, e.g. what the failure leaves untouched. */
	note?: string
	/** A way forward that does not need the load, drawn beside Try again. */
	secondaryAction?: Readonly<{ label: string; onClick: M }>
	className?: string
}>

/** What the reader can do about it: wait (`outage`), change the request (`fixable`), or get access. */
export type FailureKind = "outage" | "fixable" | "access"

export const failureKind = (failure: LoadFailure): FailureKind => {
	if (
		failure.type === "permission_error" ||
		failure.type === "authentication_error" ||
		failure.recovery === "request_access" ||
		failure.recovery === "reauthenticate"
	)
		return "access"
	if (
		failure.recovery === "fix_request" ||
		(failure.type === "invalid_request_error" && !failure.retryable)
	)
		return "fixable"
	return "outage"
}

const attr = <M>(h: HtmlBuilder<M>, entries: Readonly<Record<string, string>>) =>
	Object.entries(entries).map(([name, value]) => h.Attribute(name, value))

/** The shared 200x56 box: two faint rails the signal runs between. */
const glyphFrame = <M>(h: HtmlBuilder<M>, isCompact: boolean, children: ReadonlyArray<Html>): Html =>
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
			...children,
		],
	)

/** `DroppedSignalGlyph`: a signal line that cuts out, the break, and a dashed trail. */
const droppedSignalGlyph = <M>(h: HtmlBuilder<M>, isCompact: boolean): Html =>
	glyphFrame(h, isCompact, [
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
	])

/** `NarrowedSignalGlyph`: scattered lines funnelled into one, the request needs narrowing. */
const narrowedSignalGlyph = <M>(h: HtmlBuilder<M>, isCompact: boolean): Html =>
	glyphFrame(h, isCompact, [
		...["17", "22.5", "28", "33.5", "39"].map((y) =>
			h.line(
				attr(h, {
					x1: "6",
					y1: y,
					x2: "86",
					y2: y,
					class: "stroke-muted-foreground",
					"stroke-width": "1.5",
					"stroke-linecap": "round",
					opacity: "0.35",
				}),
			),
		),
		h.polyline(
			attr(h, {
				points: "92,16 108,28 92,40",
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
				x1: "124",
				y1: "28",
				x2: "194",
				y2: "28",
				class: "stroke-muted-foreground",
				"stroke-width": "2",
				"stroke-linecap": "round",
				opacity: "0.7",
			}),
		),
		h.circle(attr(h, { cx: "116", cy: "28", r: "5.5", class: "fill-warning", opacity: "0.35" })),
		h.circle(attr(h, { cx: "116", cy: "28", r: "2.5", class: "fill-warning" })),
	])

/** `LockedSignalGlyph`: a signal line that stops at a lock, with no trail past it. */
const lockedSignalGlyph = <M>(h: HtmlBuilder<M>, isCompact: boolean): Html =>
	glyphFrame(h, isCompact, [
		h.polyline(
			attr(h, {
				points: "6,32 20,30 32,33 44,28 56,31 68,27 80,31",
				fill: "none",
				class: "stroke-muted-foreground",
				"stroke-width": "2",
				"stroke-linecap": "round",
				"stroke-linejoin": "round",
				opacity: "0.7",
			}),
		),
		h.path(
			attr(h, {
				d: "M93 25 V21 a7 7 0 0 1 14 0 V25",
				class: "stroke-muted-foreground",
				"stroke-width": "2",
				"stroke-linecap": "round",
			}),
		),
		h.rect(
			attr(h, {
				x: "88",
				y: "25",
				width: "24",
				height: "15",
				rx: "3",
				class: "stroke-muted-foreground",
				"stroke-width": "2",
			}),
		),
		h.circle(attr(h, { cx: "100", cy: "32.5", r: "2.25", class: "fill-destructive" })),
		h.line(
			attr(h, {
				x1: "124",
				y1: "32",
				x2: "194",
				y2: "32",
				class: "stroke-border",
				"stroke-width": "1.5",
				"stroke-dasharray": "3 5",
				"stroke-linecap": "round",
			}),
		),
	])

const glyphFor = <M>(h: HtmlBuilder<M>, kind: FailureKind, isCompact: boolean): Html =>
	kind === "access"
		? lockedSignalGlyph(h, isCompact)
		: kind === "fixable"
			? narrowedSignalGlyph(h, isCompact)
			: droppedSignalGlyph(h, isCompact)

/** The inline variant's 12px marks for `fixable` (a funnel) and `access` (a lock). */
const funnelTick = <M>(h: HtmlBuilder<M>): Html =>
	h.svg(attr(h, { width: "12", height: "12", viewBox: "0 0 12 12", fill: "none", "aria-hidden": "true" }), [
		h.path(
			attr(h, {
				d: "M1.5 2.5h9L7 6.5v3l-2 1v-4z",
				stroke: "currentColor",
				"stroke-width": "1.25",
				"stroke-linejoin": "round",
			}),
		),
	])

const lockTick = <M>(h: HtmlBuilder<M>): Html =>
	h.svg(attr(h, { width: "12", height: "12", viewBox: "0 0 12 12", fill: "none", "aria-hidden": "true" }), [
		h.path(attr(h, { d: "M4 5.5V4a2 2 0 0 1 4 0v1.5", stroke: "currentColor", "stroke-width": "1.25" })),
		h.rect(
			attr(h, {
				x: "2.5",
				y: "5.5",
				width: "7",
				height: "5",
				rx: "1",
				stroke: "currentColor",
				"stroke-width": "1.25",
			}),
		),
	])

const INLINE_TINT = {
	outage: "bg-destructive/10 text-destructive",
	fixable: "bg-warning/10 text-warning-foreground",
	access: "bg-muted text-muted-foreground",
} satisfies Record<FailureKind, string>

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

/** A "retry soon" ending ("Retry in a few seconds.", "Try again shortly.") the auto-retry note replaces. */
const RETRY_SOON_ENDING =
	/\s*(?:Retry|Try again)(?: in a few seconds| in a moment| shortly| when you're ready)?(?:, or reload if the problem continues)?\.$/

/** An auto-retrying failure's message: its own cause, an optional note, then "Retrying automatically…". */
export const autoRetryMessage = (message: string, note?: string): string =>
	[
		message.replace(RETRY_SOON_ENDING, ""),
		...(note === undefined ? [] : [note]),
		"Retrying automatically…",
	].join(" ")

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
	const ownMessage = options.message ?? failureMessage(failure)
	const message =
		autoRetry.length > 0
			? autoRetryMessage(ownMessage, options.note)
			: options.note === undefined
				? ownMessage
				: `${ownMessage} ${options.note}`
	// `className` styles the Try again button itself; `retry`'s styles the button row.
	const retryButtons = (variant: "ghost" | "outline", className?: string) =>
		options.onRetry === undefined || !canRetry || options.hidesRetryButton === true
			? []
			: [
					button(h, { size: "sm", variant, className, attributes: [h.OnClick(options.onRetry)] }, [
						"Try again",
					]),
				]
	const { secondaryAction } = options
	// Drawn in the row's own variant, so it reads as a peer button beside Try again.
	const secondary = (variant: "ghost" | "outline") =>
		secondaryAction === undefined
			? []
			: [
					button(h, { size: "sm", variant, attributes: [h.OnClick(secondaryAction.onClick)] }, [
						secondaryAction.label,
					]),
				]
	const retry = (variant: "ghost" | "outline", className?: string) => {
		const buttons = [...retryButtons(variant), ...secondary(variant)]
		return buttons.length === 0
			? []
			: [h.div([h.Class(cn("flex flex-wrap items-center gap-2", className))], buttons)]
	}
	const variant = options.variant ?? "panel"
	const kind = options.kind ?? failureKind(failure)
	const kindAttribute = h.DataAttribute("failure-kind", kind)

	if (variant === "quiet") {
		return h.div(
			[
				h.Class(cn("flex items-center gap-2", options.className)),
				h.Role("status"),
				h.Title(message),
				kindAttribute,
				...autoRetry,
			],
			[
				h.p(
					[h.Class("font-prose text-xs text-muted-foreground")],
					[heading, h.span([h.Class("sr-only")], [`. ${message}`])],
				),
				...retryButtons(
					"ghost",
					"h-6 px-2 font-prose text-xs text-muted-foreground hover:text-foreground sm:text-xs",
				),
			],
		)
	}

	if (variant === "inline") {
		return h.div(
			[
				h.Class(cn("flex flex-col gap-1.5 py-4", options.className)),
				...alertRegion(h),
				kindAttribute,
				...autoRetry,
			],
			[
				h.div(
					[h.Class("flex items-center gap-2")],
					[
						h.span(
							[
								h.Class(
									cn(
										"flex size-5 shrink-0 items-center justify-center rounded-md",
										INLINE_TINT[kind],
									),
								),
								h.AriaHidden(true),
							],
							[
								kind === "access"
									? lockTick(h)
									: kind === "fixable"
										? funnelTick(h)
										: signalBreakTick(h),
							],
						),
						h.p([h.Class("font-prose text-xs font-medium text-foreground")], [heading]),
					],
				),
				h.p([h.Class("font-prose text-xs whitespace-pre-wrap text-muted-foreground")], [message]),
				...retry("outline", "mt-1 w-fit"),
			],
		)
	}

	if (variant === "row") {
		return h.div(
			[
				h.Class(
					cn(
						"flex flex-wrap items-center gap-x-4 gap-y-3 rounded-md border border-dashed px-4 py-4",
						options.className,
					),
				),
				...alertRegion(h),
				kindAttribute,
				...autoRetry,
			],
			[
				glyphFor(h, kind, true),
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

	// Fills a short card, but caps at a compact block at the top of a viewport-tall list area.
	return h.div(
		[
			h.Class(
				cn(
					"flex h-full max-h-70 flex-col items-center justify-center gap-4 rounded-md border border-dashed px-6 py-8 text-center",
					options.className,
				),
			),
			...alertRegion(h),
			kindAttribute,
			...autoRetry,
		],
		[
			h.div([h.Class("rounded-md border bg-card/50 px-3 py-2.5")], [glyphFor(h, kind, false)]),
			h.div(
				[h.Class("max-w-md space-y-1")],
				[
					h.p([h.Class("font-prose text-sm font-medium text-foreground")], [heading]),
					h.p(
						[
							h.Class(
								"font-prose text-ui text-balance whitespace-pre-wrap text-muted-foreground",
							),
						],
						[message],
					),
				],
			),
			...retry("outline"),
		],
	)
}
