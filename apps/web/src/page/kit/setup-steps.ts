import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { heading } from "@maple/views/ui/heading"
import { icon } from "@maple/views/ui/icon"
import { spinner } from "@maple/views/ui/spinner"
import { vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"

// Setup as plain steps: a short heading per thing to do, a line of detail, then its snippets and notes.
// Never numbered; a flow that tracks progress marks each step done, waiting, current or still to come.

type Children = ReadonlyArray<Html | string>

/** Where a tracked step stands: `waiting` is the app checking that it happened. */
export type SetupStepState = "current" | "pending" | "waiting" | "done"

export type SetupStepOptions = Readonly<{
	title: Children
	/** One line under the title: what to know before doing it. */
	hint?: Children
	/** A tracked step: a marker on a rail to the next step. Leave it out on every step of a plain list. */
	state?: SetupStepState
}>

/** The steps of one setup, in order: give every step a `state`, or none. */
export const setupSteps = <M>(
	h: HtmlBuilder<M>,
	steps: ReadonlyArray<Html>,
	options: Readonly<{ isTracked?: boolean; className?: string }> = {},
): Html =>
	h.ol(
		[h.Class(cn("flex min-w-0 flex-col", options.isTracked === true ? "" : "gap-5", options.className))],
		steps,
	)

const marker = <M>(h: HtmlBuilder<M>, state: SetupStepState): Html =>
	state === "done"
		? icon(h, "CircleCheckIcon", { size: 20, className: "shrink-0 text-severity-info" })
		: state === "waiting"
			? spinner(h, "size-5 shrink-0 p-0.5 text-muted-foreground")
			: h.span(
					[
						h.AriaHidden(true),
						h.Class(
							cn(
								"flex size-5 shrink-0 items-center justify-center rounded-full border",
								state === "current" ? "border-border-strong" : "border-border",
							),
						),
					],
					[
						h.span(
							[
								h.Class(
									cn(
										"size-1.5 rounded-full",
										state === "current" ? "bg-foreground" : "bg-transparent",
									),
								),
							],
							[],
						),
					],
				)

/** One thing to do in a `setupSteps` list: its heading, a hint, then what it needs (snippets, fields, notes). */
export const setupStep = <M>(
	h: HtmlBuilder<M>,
	options: SetupStepOptions,
	children: ReadonlyArray<Html>,
): Html => {
	const body = vstack(h, { gap: "2", shrink: true, grow: true, className: "min-w-0" }, [
		vstack(h, { gap: "0.5" }, [
			heading(
				h,
				{
					level: 3,
					variant: "subsection",
					className: options.state === "pending" ? "text-muted-foreground" : undefined,
				},
				options.title,
			),
			...(options.hint === undefined
				? []
				: [typography(h, { size: "xs", tone: "muted", as: "p" }, options.hint)]),
		]),
		...children,
	])
	const state = options.state
	return state === undefined
		? h.li([h.Class("min-w-0")], [body])
		: h.li(
				[
					h.Class(
						cn(
							"relative flex gap-3 before:absolute before:top-6 before:bottom-1 before:left-2.5 before:w-px before:-translate-x-1/2 before:bg-border last:pb-0 last:before:hidden",
							state === "done" ? "pb-4" : "pb-6",
						),
					),
				],
				[marker(h, state), body],
			)
}
