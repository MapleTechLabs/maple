import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { cardButton } from "@maple/views/ui/card-button"
import { separator } from "@maple/views/ui/display"
import { heading } from "@maple/views/ui/heading"
import { icon } from "@maple/views/ui/icon"
import { hstack, vstack } from "@maple/views/ui/stack"
import { statusDot } from "@maple/views/ui/status-dot"
import { typography } from "@maple/views/ui/typography"
import { Array as Arr } from "effect"

// Sentence cards: a form that reads top to bottom as one sentence ("When ... Alert when ...
// Notify ... Name"), each card a clause. No numbers: a status dot on a rail joins them.

export type SentenceCardStatus = "done" | "missing"

export type SentenceCardOptions<M> = Readonly<{
	/** Unique on the page; the card's element ids derive from it. */
	id: string
	/** The clause's lead word, the card's heading: "When", "Alert when", "Notify". */
	lead: string
	/** A line beside the lead while the card is open. */
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

/** The open card's heading: focus lands here when the card opens. */
export const sentenceCardHeadingId = (id: string): string => `sentence-card-${id}`
/** The closed card's summary button: focus returns here when the card closes. */
export const sentenceCardSummaryId = (id: string): string => `sentence-card-${id}-summary`
const panelIdOf = (id: string): string => `sentence-card-${id}-panel`

const DOT_TONE = { done: "done", missing: "warn" } as const

const LEAD_CLASS = "w-20 shrink-0 sm:w-24"

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

/** The lead as the heading, its whole card a disclosure button that opens the card. */
const closedCard = <M>(h: HtmlBuilder<M>, options: SentenceCardOptions<M>): Html =>
	heading(h, { level: 2, variant: "section" }, [
		cardButton(
			h,
			{
				onClick: options.onExpand,
				label: `${options.lead}: ${options.summary}. Edit`,
				className: "block w-full px-4 py-3",
				attributes: [
					h.Id(sentenceCardSummaryId(options.id)),
					h.AriaExpanded(false),
					h.AriaControls(panelIdOf(options.id)),
				],
			},
			[
				// Top-aligned with the first line on the rail dot: a phone wraps the summary to two lines.
				hstack(h, { gap: "3", align: "start", as: "span", className: "min-h-8 py-1.5" }, [
					typography(h, { size: "sm", weight: "semibold", className: LEAD_CLASS }, [options.lead]),
					typography(
						h,
						{
							size: "sm",
							weight: "normal",
							className: "line-clamp-2 min-w-0 grow sm:line-clamp-1",
						},
						[options.summary],
					),
					hstack(h, { gap: "1", align: "center", as: "span", className: "h-5 shrink-0" }, [
						icon(h, "PencilIcon", { size: 12, className: "text-muted-foreground" }),
						typography(h, { size: "xs", weight: "normal", tone: "muted" }, ["Edit"]),
					]),
				]),
			],
		),
	])

const openCard = <M>(
	h: HtmlBuilder<M>,
	options: SentenceCardOptions<M>,
	body: () => ReadonlyArray<Html>,
): Html => {
	const headingId = sentenceCardHeadingId(options.id)
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
						heading(
							h,
							{
								level: 2,
								variant: "section",
								id: headingId,
								className: cn(LEAD_CLASS, "outline-none"),
								attributes: [h.Tabindex(-1)],
							},
							[options.lead],
						),
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
										attributes: [
											h.AriaExpanded(true),
											h.AriaControls(panelIdOf(options.id)),
											h.OnClick(options.onCollapse),
										],
									},
									["Done"],
								),
							]),
				],
			),
			h.div([h.Id(panelIdOf(options.id)), h.Class("flex min-w-0 flex-col gap-3")], body()),
		],
	)
}

/**
 * `SentenceCard`: one clause of a sentence-card form, on its rail. Open, it shows its lead and
 * controls (`body`, called only then); closed (complete and not being edited), a one-line summary
 * that opens it on click. A missing card is always open.
 */
export const sentenceCard = <M>(
	h: HtmlBuilder<M>,
	options: SentenceCardOptions<M>,
	body: () => ReadonlyArray<Html>,
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
				[isOpen ? openCard(h, options, body) : closedCard(h, options)],
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
