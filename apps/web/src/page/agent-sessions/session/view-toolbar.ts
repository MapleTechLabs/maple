import { Effect, Stream } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { icon } from "../../../ui/icon"
import { label } from "../../../ui/label"
import * as Popover from "../../../ui/popover"
import { switchControl } from "../../../ui/switch"
import { Message } from "./message"
import type { Model, SessionView, ViewOption } from "./model"
import { searchInput } from "../../../ui/search-input"

// The session views' control bar: the filter and the view options.

type H = HtmlBuilder<Message>

type OptionRow = Readonly<{ id: string; option: ViewOption; label: string; hint: string }>

const AGENT_SPANS_ONLY: OptionRow = {
	id: "agent-spans-only",
	option: "agentSpansOnly",
	label: "Agent spans only",
	hint: "Hides the app's own HTTP and DB spans.",
}

/** The Display popover's switches for a view; the Overview has none. */
const optionsOf = (view: SessionView): ReadonlyArray<OptionRow> => {
	if (view === "trace")
		return [
			AGENT_SPANS_ONLY,
			{
				id: "collapse-idle",
				option: "collapseIdle",
				label: "Collapse idle",
				hint: "Folds the gaps where nothing ran.",
			},
		]
	if (view === "flow")
		return [
			AGENT_SPANS_ONLY,
			{
				id: "merge-repeats",
				option: "mergeRepeats",
				label: "Merge repeat tools",
				hint: "Draws one node for a tool called back to back.",
			},
		]
	return [
		{
			id: "show-thinking",
			option: "showThinking",
			label: "Show thinking",
			hint: "Keeps the model's reasoning blocks in the transcript.",
		},
		{
			id: "expand-tool-payloads",
			option: "showPayloads",
			label: "Expand tool payloads",
			hint: "Opens every tool call's arguments and result.",
		},
	]
}

/** `SearchInput` (size sm): not debounced, it filters spans already in hand. */
const filterInput = (h: H, model: Model, view: SessionView): Html =>
	searchInput(h, {
		id: "agent-session-filter",
		size: "sm",
		className: "w-56",
		placeholder: view === "transcript" ? "Filter transcript" : "Filter spans",
		value: model.query,
		onInput: (value) => Message.ChangedQuery({ value }),
		onClear: Message.ChangedQuery({ value: "" }),
	})

const optionRow = (h: H, model: Model, row: OptionRow): Html =>
	h.div(
		[h.Key(row.id), h.Class("flex items-center justify-between gap-4")],
		[
			h.div(
				[h.Class("space-y-0.5")],
				[
					label(
						h,
						{ className: "cursor-pointer", attributes: [h.For(row.id), h.Id(`${row.id}-label`)] },
						[row.label],
					),
					h.p([h.Class("text-muted-foreground text-xs")], [row.hint]),
				],
			),
			// Base UI: the `id` goes to the hidden input the label targets; the switch is labelled by it.
			...switchControl(h, {
				id: `${row.id}-switch`,
				inputId: row.id,
				labelledBy: `${row.id}-label`,
				isChecked: model.options[row.option],
				onToggle: Message.ToggledOption({ option: row.option }),
			}),
		],
	)

/** `ViewOptions`: what this view shows, behind one trigger. */
const displayOptions = (h: H, model: Model, view: SessionView): Html => {
	const rows = optionsOf(view)
	const on = rows.filter((row) => model.options[row.option]).length
	return h.submodel({
		slotId: "agent-session-display",
		model: model.displayPopover,
		view: Popover.view,
		toParentMessage: (message: Popover.Message) => Message.GotDisplayPopoverMessage({ message }),
		viewInputs: {
			className: "w-72 space-y-3",
			toView: ({ trigger, withTrigger }) =>
				h.div(
					[h.Class("contents")],
					withTrigger(
						button(
							h,
							{
								variant: "outline",
								size: "xs",
								className: "data-[popup-open]:bg-surface-strong",
								attributes: [
									h.AriaLabel(`Display options, ${on} of ${rows.length} shown`),
									...trigger,
								],
							},
							[
								icon(h, "SlidersIcon", { size: 14, className: "text-muted-foreground" }),
								"Display",
								h.span(
									[h.Class("text-muted-foreground tabular-nums")],
									[`· ${on} of ${rows.length}`],
								),
							],
						),
					),
				),
			toContent: () => rows.map((row) => optionRow(h, model, row)),
		},
	})
}

/** Publishes the bar's height on its parent, so the views' sticky rulers stack under a wrapped bar. */
const PublishControlsHeight = Mount.defineStream("PublishAgentSessionControlsHeight", {
	messages: [Message.CompletedScroll],
	execute: ({ element }) =>
		Stream.callback<typeof Message.CompletedScroll.Type>(() =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const publish = () => {
						if (element instanceof HTMLElement)
							element.parentElement?.style.setProperty(
								"--session-controls-height",
								`${element.offsetHeight}px`,
							)
					}
					publish()
					const observer = new ResizeObserver(publish)
					observer.observe(element)
					return observer
				}),
				(observer) => Effect.sync(() => observer.disconnect()),
			).pipe(Effect.andThen(Effect.never)),
		),
})

/** The sticky bar: the view tabs, and for every view but the Overview the filter and Display. */
export const controlBar = (h: H, model: Model, view: SessionView, tabList: Html): Html =>
	h.div(
		[
			h.Class(
				"sticky top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-2 border-border border-b bg-background pb-2",
			),
			h.OnMount(PublishControlsHeight()),
		],
		[
			tabList,
			...(view === "overview"
				? []
				: [
						h.div(
							[h.Class("ml-auto flex flex-wrap items-center gap-2")],
							[filterInput(h, model, view), displayOptions(h, model, view)],
						),
					]),
		],
	)
