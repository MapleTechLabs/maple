import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Array as Arr } from "effect"
import { icon } from "./icon"
import { pressable } from "./pressable"

// `AnswerTrail`: every step flow's progress line (connect pages, setup dialogs, onboarding). A done
// step shows the answer it was given as a receipt chip, the current step is underlined in primary.
// The one place a flow marks `aria-current="step"`; `maple/one-step-trail` keeps it that way.

export type AnswerTrailStep<M> = Readonly<{
	label: string
	state: "done" | "current" | "next" | "blocked"
	/** What a done step was answered with ("us-east-1"); the label when absent. */
	answer?: string | null
	/** Reopens a done step. */
	onClick?: M | null
}>

export type AnswerTrailOptions<M> = Readonly<{
	steps: ReadonlyArray<AnswerTrailStep<M>>
	/** The list's accessible name. */
	label?: string
	className?: string
}>

const CHIP =
	"inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-card py-0.5 pr-2 pl-1.5 text-foreground"

const doneStep = <M>(h: HtmlBuilder<M>, step: AnswerTrailStep<M>): Html => {
	const answer = step.answer ?? step.label
	const content = [icon(h, "CheckIcon", { size: 12, className: "text-severity-info" }), answer]
	const onClick = step.onClick ?? null
	// The check is decorative, so a static chip says its state in words; a button says it in its name.
	return onClick === null
		? h.span([h.Class(CHIP)], [...content, h.span([h.Class("sr-only")], [" (done)"])])
		: pressable(
				h,
				{
					onClick,
					// Starts with the visible text, so voice control can say what it sees.
					label: answer === step.label ? `Go to ${step.label}` : `${answer}, go to ${step.label}`,
					className: cn(CHIP, "hover:bg-surface-sunken active:bg-surface-sunken"),
				},
				content,
			)
}

const step = <M>(h: HtmlBuilder<M>, entry: AnswerTrailStep<M>): Html => {
	const isCurrent = entry.state === "current" || entry.state === "blocked"
	return h.li(
		[
			h.Key(entry.label),
			h.Class("inline-flex items-center"),
			...(isCurrent ? [h.AriaCurrent("step")] : []),
		],
		[
			entry.state === "done"
				? doneStep(h, entry)
				: entry.state === "blocked"
					? h.span(
							[
								h.Class(
									"inline-flex items-center gap-1.5 whitespace-nowrap font-medium text-severity-warn underline decoration-severity-warn underline-offset-4",
								),
							],
							[icon(h, "AlertWarningIcon", { size: 12 }), entry.label],
						)
					: h.span(
							[
								h.Class(
									entry.state === "current"
										? "whitespace-nowrap font-medium text-foreground underline decoration-primary underline-offset-4"
										: "whitespace-nowrap text-muted-foreground",
								),
							],
							[entry.label],
						),
		],
	)
}

export const answerTrail = <M>(h: HtmlBuilder<M>, options: AnswerTrailOptions<M>): Html =>
	h.ol(
		[
			h.AriaLabel(options.label ?? "Steps"),
			h.Class(cn("flex flex-wrap items-center gap-x-2 gap-y-1.5 font-sans text-xs", options.className)),
			h.DataAttribute("slot", "answer-trail"),
		],
		Arr.flatMap(options.steps, (entry, index) =>
			index === 0
				? [step(h, entry)]
				: [
						// An arrow, not a slash: the steps are a flow, not a path back up.
						h.li(
							[
								h.Key(`${entry.label}-sep`),
								h.AriaHidden(true),
								h.Class("inline-flex text-foreground-subtle"),
							],
							[icon(h, "ArrowRightIcon", { size: 12 })],
						),
						step(h, entry),
					],
		),
	)
