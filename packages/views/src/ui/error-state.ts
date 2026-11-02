import { cn } from "@maple/ui/lib/utils"
import { Clock, Effect, Queue, Random, Schema, Stream } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import {
	FAILURE_SENTENCE,
	failureMessage,
	isTransientOutage,
	isWarehouseFailure,
	type LoadFailure,
} from "../data/load-failure"
import {
	isExhausted,
	postponed,
	probed,
	RESUME_WINDOW_MS,
	resume,
	type RetryBudget,
} from "./auto-retry-budget"
import { button } from "./button"
import { emptyContent, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "./empty"
import { icon } from "./icon"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

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

const tickAttributes = <M>(h: HtmlBuilder<M>, size: number) =>
	attr(h, {
		width: `${size}`,
		height: `${size}`,
		viewBox: "0 0 12 12",
		fill: "none",
		"aria-hidden": "true",
	})

/** The inline and row variants' small marks for `fixable` (a funnel) and `access` (a lock). */
const funnelTick = <M>(h: HtmlBuilder<M>, size: number): Html =>
	h.svg(tickAttributes(h, size), [
		h.path(
			attr(h, {
				d: "M1.5 2.5h9L7 6.5v3l-2 1v-4z",
				stroke: "currentColor",
				"stroke-width": "1.25",
				"stroke-linejoin": "round",
			}),
		),
	])

const lockTick = <M>(h: HtmlBuilder<M>, size: number): Html =>
	h.svg(tickAttributes(h, size), [
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
	outage: "bg-severity-error-a2 text-severity-error",
	fixable: "bg-severity-warn-a2 text-severity-warn",
	access: "bg-muted text-muted-foreground",
} satisfies Record<FailureKind, string>

/** `SignalBreakTick`: the outage mark, a signal stub, a break and a dashed trail. */
const signalBreakTick = <M>(h: HtmlBuilder<M>, size: number): Html =>
	h.svg(tickAttributes(h, size), [
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

/** The kind's mark on its tint: 12px in a 20px chip inline, 16px in a 28px chip in a row. */
const kindChip = <M>(h: HtmlBuilder<M>, kind: FailureKind, isRow: boolean): Html =>
	h.span(
		[
			h.Class(
				cn(
					"flex shrink-0 items-center justify-center rounded-md",
					isRow ? "size-7" : "size-5",
					INLINE_TINT[kind],
				),
			),
			h.AriaHidden(true),
		],
		[
			kind === "access"
				? lockTick(h, isRow ? 16 : 12)
				: kind === "fixable"
					? funnelTick(h, isRow ? 16 : 12)
					: signalBreakTick(h, isRow ? 16 : 12),
		],
	)

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

/** A "retry soon" ending ("Retry in a few seconds.", "Try again or reload.") the retry affordance replaces. */
const RETRY_SOON_ENDING =
	/\s*(?:Retry|Try again)(?: in a few seconds| in a moment| shortly| when you're ready| or reload)?(?:, or reload if the problem continues)?\.$/

export { FAILURE_SENTENCE }

/** A failure's one sentence: a failing warehouse, a dropped backend and an unknown error read as their class. */
export const failureSentence = (failure: LoadFailure): string => {
	if (failure.code === "unexpected_error") return FAILURE_SENTENCE.unknown
	if (isTransientOutage(failure))
		return isWarehouseFailure(failure) ? FAILURE_SENTENCE.warehouse : FAILURE_SENTENCE.backend
	return failureMessage(failure)
}

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
							MountNetworkAutoRetry({ retryKey: encodeJson(onRetry) }),
							() => onRetry,
						),
					),
				]
			: []
	const ownMessage = options.message ?? failureSentence(failure)
	const showsRetryButton = onRetry !== undefined && canRetry && options.hidesRetryButton !== true
	// An auto-retrying failure always says so, quietly, even beside a Try again button.
	const message =
		autoRetry.length > 0
			? autoRetryMessage(ownMessage, options.note)
			: [
					canRetry ? ownMessage.replace(RETRY_SOON_ENDING, "") : ownMessage,
					...(options.note === undefined ? [] : [options.note]),
				].join(" ")
	// `className` styles the Try again button itself; `retry`'s styles the button row.
	const retryButtons = (variant: "ghost" | "outline", className?: string) =>
		options.onRetry === undefined || !showsRetryButton
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
					"h-6 px-2 font-prose text-xs text-muted-foreground hover:text-foreground active:text-foreground sm:text-xs",
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
						kindChip(h, kind, false),
						h.p([h.Class("font-prose text-xs font-medium text-foreground")], [heading]),
					],
				),
				h.p(
					[h.Class("font-prose text-xs whitespace-pre-wrap break-words text-muted-foreground")],
					[message],
				),
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
				kindChip(h, kind, true),
				h.div(
					[h.Class("min-w-0 flex-1 basis-56 space-y-0.5")],
					[
						h.p([h.Class("font-prose text-sm font-medium text-foreground")], [heading]),
						h.p(
							[h.Class("font-prose line-clamp-2 text-xs break-words text-muted-foreground")],
							[message],
						),
					],
				),
				...retry("outline", "shrink-0"),
			],
		)
	}

	const actions = retry("outline")
	// The empty state's layout with a warning tile; `py-12` at every width keeps it inside short cards.
	return h.div(
		[
			h.Class(
				cn(
					"flex h-full min-w-0 flex-col items-center justify-center gap-6 px-6 py-12 text-center text-balance",
					options.className,
				),
			),
			...alertRegion(h),
			kindAttribute,
			...autoRetry,
		],
		[
			emptyMedia(h, { variant: "icon" }, [icon(h, "CircleWarningIcon", { className: "text-destructive" })]),
			emptyHeader(h, [
				emptyTitle(h, [heading]),
				emptyDescription(h, [message], "font-mono text-xs whitespace-pre-wrap wrap-anywhere"),
			]),
			...(actions.length === 0 ? [] : [emptyContent(h, actions)]),
		],
	)
}
