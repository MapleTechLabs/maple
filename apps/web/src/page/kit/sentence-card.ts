import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { card } from "@maple/views/ui/card"
import { cardButton } from "@maple/views/ui/card-button"
import { separator } from "@maple/views/ui/display"
import { heading } from "@maple/views/ui/heading"
import { icon } from "@maple/views/ui/icon"
import { hstack, vstack } from "@maple/views/ui/stack"
import { statusDot } from "@maple/views/ui/status-dot"
import { typography } from "@maple/views/ui/typography"
import { Array as Arr, Option } from "effect"

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
	/** Blockers that are not a missing field, said as they are: "Query too slow for this check interval". */
	problems?: ReadonlyArray<string>
	/** The clause in plain words, shown while the card is closed. */
	summary: string
	isExpanded: boolean
	onExpand: M
	/** Closes an open card back to its summary (Done, or Escape); a missing card stays open. */
	onCollapse?: M
	/** Layout of the open card's body: a width cap for a card of short fields. */
	bodyClassName?: string
}>

/** The open card's heading: focus lands here when the card opens. */
export const sentenceCardHeadingId = (id: string): string => `sentence-card-${id}`
/** The closed card's summary button: focus returns here when the card closes. */
export const sentenceCardSummaryId = (id: string): string => `sentence-card-${id}-summary`
const panelIdOf = (id: string): string => `sentence-card-${id}-panel`

const DOT_TONE = { done: "done", missing: "warn" } as const

const LEAD_CLASS = "shrink-0 sm:w-24"

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
				// A phone stacks the lead over the summary; from `sm` they share one line.
				h.span(
					[
						h.Class(
							"grid min-h-8 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-0.5 py-1.5 sm:grid-cols-[--spacing(24)_minmax(0,1fr)_auto]",
						),
					],
					[
						typography(
							h,
							{ size: "sm", weight: "semibold", className: "col-start-1 row-start-1" },
							[options.lead],
						),
						typography(
							h,
							{
								size: "sm",
								weight: "normal",
								className:
									"col-span-2 row-start-2 line-clamp-3 min-w-0 sm:col-span-1 sm:col-start-2 sm:row-start-1 sm:line-clamp-1",
							},
							[options.summary],
						),
						hstack(
							h,
							{
								gap: "1",
								align: "center",
								as: "span",
								className: "col-start-2 row-start-1 h-5 sm:col-start-3",
							},
							[
								icon(h, "PencilIcon", { size: 12, className: "text-muted-foreground" }),
								typography(h, { size: "xs", weight: "normal", tone: "muted" }, ["Edit"]),
							],
						),
					],
				),
			],
		),
	])

// A popup open over the card (a select, a menu, a chip picker) takes Escape for itself: it is read
// off the page at the keypress, the one moment the popup is certain to still be mounted.
const isPopupOpen = (): boolean =>
	typeof document !== "undefined" &&
	document.querySelector('[data-base-ui-portal]:not([data-slot^="toast"])') !== null

const openCard = <M>(
	h: HtmlBuilder<M>,
	options: SentenceCardOptions<M>,
	body: () => ReadonlyArray<Html>,
): Html => {
	const headingId = sentenceCardHeadingId(options.id)
	const issues = options.issues ?? []
	// "Missing: Threshold. Query too slow for this check interval": fields by name, problems in full.
	const issueLine = Arr.join(
		[...(issues.length === 0 ? [] : [`Missing: ${Arr.join(issues, ", ")}`]), ...(options.problems ?? [])],
		". ",
	)
	const onCollapse = options.status === "missing" ? undefined : options.onCollapse
	// One frame around the header and the body, the same box the closed card draws.
	return card(
		h,
		[
			h.section(
				[
					h.AriaLabelledBy(headingId),
					h.Class("flex min-w-0 flex-col gap-4 px-4 pt-3 pb-4"),
					...(onCollapse === undefined
						? []
						: [
								h.OnKeyDownPreventDefault((key) =>
									key === "Escape" && !isPopupOpen()
										? Option.some(onCollapse)
										: Option.none(),
								),
							]),
				],
				[
					hstack(
						h,
						{ gap: "3", align: "baseline", wrap: true, className: "min-h-8 gap-y-1 pt-1.5" },
						[
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
											issueLine === "" ? "Required" : issueLine,
										]),
									]
								: []),
						],
					),
					h.div(
						[
							h.Id(panelIdOf(options.id)),
							h.Class(cn("flex min-w-0 flex-col gap-4", options.bodyClassName)),
						],
						[
							...body(),
							// Last in the tab order, after the fields it closes.
							...(onCollapse === undefined
								? []
								: [
										hstack(h, { justify: "end" }, [
											button(
												h,
												{
													variant: "outline",
													attributes: [
														h.AriaExpanded(true),
														h.AriaControls(panelIdOf(options.id)),
														h.OnClick(onCollapse),
													],
												},
												["Done"],
											),
										]),
									]),
						],
					),
				],
			),
		],
		"gap-0 p-0",
	)
}

/**
 * One clause of a sentence-card form, on its rail. Open, it shows its lead and
 * controls (`body`, called only then); closed (complete and not being edited), a one-line summary
 * that opens it on click. A missing card is always open; Done or Escape closes a complete one.
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

/** The sentence cards top to bottom, their rails joined into one line. */
export const sentenceChain = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ label: string; className?: string }>,
	cards: ReadonlyArray<Html>,
): Html => h.ol([h.AriaLabel(options.label), h.Class(cn("flex flex-col", options.className))], cards)

/**
 * One line of a sentence form, its words and inline controls wrapping together
 * ("Fire after [3] breaches [in a row]."). Controls sit at 32px, 36px on a phone.
 */
export const sentenceRow = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ className?: string }>,
	children: ReadonlyArray<Html | string>,
): Html =>
	h.div(
		[
			h.Class(
				cn("flex flex-wrap items-center gap-x-2 gap-y-2 text-sm text-foreground", options.className),
			),
		],
		children,
	)

/** Words and their control kept together, so a wrap never strands the control. */
export const sentencePhrase = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html | string>): Html =>
	h.span([h.Class("inline-flex min-w-0 items-center gap-2")], children)

/** A sentence row with the notes that belong to it (a hint, what it was) under it. */
export const sentenceClause = <M>(h: HtmlBuilder<M>, row: Html, notes: ReadonlyArray<Html> = []): Html =>
	notes.length === 0 ? row : h.div([h.Class("flex min-w-0 flex-col gap-1.5")], [row, ...notes])

/** A titled group of sentence rows inside a card, ruled off from the one above. */
export const sentenceSection = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ title: string; className?: string }>,
	children: ReadonlyArray<Html>,
): Html =>
	h.section(
		[
			h.AriaLabel(options.title),
			h.Class(cn("flex flex-col gap-4 border-t pt-4 first:border-t-0 first:pt-0", options.className)),
		],
		[
			typography(h, { size: "xs", weight: "medium", tone: "muted", as: "p" }, [options.title]),
			...children,
		],
	)
