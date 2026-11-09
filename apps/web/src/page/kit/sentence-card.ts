import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { card } from "@maple/views/ui/card"
import { separator } from "@maple/views/ui/display"
import { heading } from "@maple/views/ui/heading"
import { icon } from "@maple/views/ui/icon"
import { pressable } from "@maple/views/ui/pressable"
import { hstack, vstack } from "@maple/views/ui/stack"
import { statusDot } from "@maple/views/ui/status-dot"
import { typography } from "@maple/views/ui/typography"
import { Array as Arr } from "effect"

// Sentence cards: a form that reads top to bottom as one sentence ("When ... Alert when ...
// Notify ... Name"), each card a clause. No numbers: a status dot on a rail joins them.

export type SentenceCardStatus = "done" | "missing" | "optional"

export type SentenceCardOptions<M> = Readonly<{
	/** Unique on the page: the heading's id. */
	id: string
	/** The clause's lead word, the card's label: "When", "Alert when", "Notify". */
	lead: string
	/** A line under the lead while the card is open. */
	hint?: string | undefined
	status: SentenceCardStatus
	/** What is missing, said while `status` is `missing`: "Threshold", "Rule name". */
	issues?: ReadonlyArray<string>
	/** The clause in plain words, shown while the card is closed. */
	summary: string
	isExpanded: boolean
	onExpand: M
	/** Closes an open card back to its summary; a missing card stays open, so it has none. */
	onCollapse?: M
}>

const DOT_TONE = { done: "done", missing: "warn", optional: "neutral" } as const

const LEAD_CLASS = "w-24 shrink-0"

/** The rail beside a card: its status dot, then the line down to the next card (none after the last). */
const rail = <M>(h: HtmlBuilder<M>, status: SentenceCardStatus): Html =>
	vstack(h, { align: "center", className: "h-full" }, [
		h.span(
			[h.Class("mt-[calc(--spacing(5)+1px)] grid size-4 shrink-0 place-items-center")],
			[statusDot(h, { tone: DOT_TONE[status], size: "lg" })],
		),
		// In a row the separator stretches to the row's height: the rest of the step, gap included.
		hstack(h, { justify: "center", grow: true, className: "mt-1.5 group-last/sentence:hidden" }, [
			separator(h, "vertical", undefined),
		]),
	])

const closedCard = <M>(h: HtmlBuilder<M>, options: SentenceCardOptions<M>): Html =>
	card(
		h,
		[
			pressable(
				h,
				{
					onClick: options.onExpand,
					className:
						"w-full rounded-md-inset px-4 py-3 text-left hover:bg-surface-sunken active:bg-surface-sunken",
					attributes: [
						h.AriaExpanded(false),
						h.AriaLabel(`${options.lead}: ${options.summary}. Edit`),
					],
				},
				[
					hstack(h, { gap: "3", align: "center", className: "min-h-8" }, [
						typography(h, { size: "sm", weight: "medium", className: LEAD_CLASS }, [
							options.lead,
						]),
						typography(h, { size: "sm", truncate: true, className: "min-w-0 grow" }, [
							options.summary,
						]),
						hstack(h, { gap: "1", align: "center", as: "span", className: "shrink-0" }, [
							icon(h, "PencilIcon", { size: 12, className: "text-muted-foreground" }),
							typography(h, { size: "xs", tone: "muted" }, ["Edit"]),
						]),
					]),
				],
			),
		],
		"gap-0 p-0",
	)

const openCard = <M>(
	h: HtmlBuilder<M>,
	options: SentenceCardOptions<M>,
	children: ReadonlyArray<Html>,
): Html => {
	const headingId = `sentence-card-${options.id}`
	const issues = options.issues ?? []
	// No frame of its own: the sections inside are cards. The header lines up with a closed card's row.
	return h.section(
		[h.AriaLabelledBy(headingId), h.Class("flex min-w-0 flex-col gap-3 pt-[calc(--spacing(3)+1px)]")],
		[
			hstack(
				h,
				{
					gap: "3",
					align: "start",
					justify: "between",
					className: "min-h-8 pl-[calc(--spacing(4)+1px)]",
				},
				[
					hstack(h, { gap: "3", align: "baseline", wrap: true, className: "min-w-0 pt-1.5" }, [
						heading(h, { level: 2, variant: "section", id: headingId, className: LEAD_CLASS }, [
							options.lead,
						]),
						...(options.hint === undefined
							? []
							: [
									typography(
										h,
										{ size: "xs", tone: "muted", as: "p", className: "min-w-0" },
										[options.hint],
									),
								]),
						...(options.status === "missing"
							? [
									typography(h, { size: "xs", tone: "warning", as: "p" }, [
										issues.length === 0
											? "Required"
											: `Missing: ${Arr.join(issues, ", ")}`,
									]),
								]
							: []),
					]),
					...(options.onCollapse === undefined || options.status === "missing"
						? []
						: [
								button(
									h,
									{
										variant: "ghost",
										size: "xs",
										attributes: [h.AriaExpanded(true), h.OnClick(options.onCollapse)],
									},
									["Done"],
								),
							]),
				],
			),
			...children,
		],
	)
}

/**
 * `SentenceCard`: one clause of a sentence-card form, on its rail. Open, it shows its lead word and
 * controls; closed (complete and not being edited), a one-line summary that opens it on click.
 */
export const sentenceCard = <M>(
	h: HtmlBuilder<M>,
	options: SentenceCardOptions<M>,
	children: ReadonlyArray<Html>,
): Html => {
	const isOpen = options.isExpanded || options.status === "missing"
	return h.li(
		[
			h.Key(options.id),
			h.Class("group/sentence grid grid-cols-[--spacing(4)_minmax(0,1fr)] gap-x-3"),
			h.DataAttribute("state", isOpen ? "open" : "closed"),
		],
		[
			rail(h, options.status),
			h.div(
				[h.Class("min-w-0 pb-4 group-last/sentence:pb-0")],
				[isOpen ? openCard(h, options, children) : closedCard(h, options)],
			),
		],
	)
}

/** `SentenceChain`: the sentence cards top to bottom, their rails joined into one line. */
export const sentenceChain = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ label: string; className?: string }>,
	cards: ReadonlyArray<Html>,
): Html => h.ol([h.AriaLabel(options.label), h.Class(cn("flex flex-col", options.className))], cards)
