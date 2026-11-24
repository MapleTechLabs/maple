import { cn } from "@maple/ui/lib/utils"
import type { StackFrame, StackFrameContext } from "@maple/domain/errors/js-stack"
import { Array as Arr, Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "./icon"
import { typography } from "./typography"

// A symbolicated stack trace as a frame list: library runs fold, in-app frames open on their code.

/** One row of the list: an app frame, or a run of two or more library frames folded into one. */
export type StackFrameRow =
	| Readonly<{ _tag: "Frame"; key: string; frame: StackFrame }>
	| Readonly<{ _tag: "Library"; key: string; frames: ReadonlyArray<StackFrame> }>

type Run = Readonly<{ start: number; inApp: boolean; frames: ReadonlyArray<StackFrame> }>

/** The frames as rows, top of stack first: consecutive library frames fold into one row. */
export const stackFrameRows = (frames: ReadonlyArray<StackFrame>): ReadonlyArray<StackFrameRow> => {
	const none: ReadonlyArray<Run> = []
	const runs = Arr.reduce(frames, none, (acc, frame, index) =>
		Option.match(Arr.last(acc), {
			onSome: (run) =>
				run.inApp === frame.in_app
					? [...Arr.dropRight(acc, 1), { ...run, frames: [...run.frames, frame] }]
					: [...acc, { start: index, inApp: frame.in_app, frames: [frame] }],
			onNone: () => [{ start: index, inApp: frame.in_app, frames: [frame] }],
		}),
	)
	return Arr.flatMap(runs, (run): ReadonlyArray<StackFrameRow> =>
		!run.inApp && run.frames.length > 1
			? [{ _tag: "Library", key: `lib-${run.start}`, frames: run.frames }]
			: Arr.map(run.frames, (frame, offset) => ({
					_tag: "Frame",
					key: `frame-${run.start + offset}`,
					frame,
				})),
	)
}

/** The row open on load: the top in-app frame, when it carries code context. */
export const defaultOpenFrameKey = (frames: ReadonlyArray<StackFrame>): string | null =>
	Option.match(
		Arr.findFirstIndex(frames, (frame) => frame.in_app),
		{
			onNone: () => null,
			onSome: (index) => (frames[index]?.context === null ? null : `frame-${index}`),
		},
	)

/** Whether a row is open: its default, flipped when its key is in `toggled`. */
export const isStackRowOpen = (
	frames: ReadonlyArray<StackFrame>,
	toggled: ReadonlyArray<string>,
	key: string,
): boolean => (defaultOpenFrameKey(frames) === key) !== toggled.includes(key)

export type StackFrameListOptions<M> = Readonly<{
	/** Top of stack first, as the backend symbolicated them. */
	frames: ReadonlyArray<StackFrame>
	/** Row keys flipped from their default (the top in-app frame open, the rest closed). */
	toggled: ReadonlyArray<string>
	onToggle: (key: string) => M
	/** Prefixes the panel ids, unique on the page. */
	idPrefix: string
	className?: string
}>

const ROW_CLASS = "w-full min-w-0 px-4 py-1.5 text-left"
const TOGGLE_CLASS = cn(
	ROW_CLASS,
	"cursor-pointer outline-none hover:bg-surface-sunken active:bg-surface-sunken focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
)

const chevron = <M>(h: HtmlBuilder<M>, isOpen: boolean): Html =>
	icon(h, isOpen ? "ChevronDownIcon" : "ChevronRightIcon", { size: 12, className: "shrink-0" })

const chevronSpacer = <M>(h: HtmlBuilder<M>): Html => h.span([h.Class("size-3 shrink-0")], [])

const position = (frame: StackFrame): string =>
	frame.line === null ? "" : frame.column === null ? `:${frame.line}` : `:${frame.line}:${frame.column}`

/** The frame's function, then where it is: the original source path once a map resolved it. */
const frameLabel = <M>(h: HtmlBuilder<M>, frame: StackFrame): ReadonlyArray<Html> => [
	typography(
		h,
		{
			size: "xs",
			mono: true,
			tone: frame.in_app ? "foreground" : "subtle",
			weight: frame.in_app ? "medium" : "normal",
			className: "shrink-0",
		},
		[frame.function ?? "(anonymous)"],
	),
	typography(
		h,
		{ size: "xs", mono: true, tone: frame.in_app ? "muted" : "subtle", className: "min-w-0 break-all" },
		[frame.file ?? "unknown location", position(frame)],
	),
]

const labelLine = <M>(h: HtmlBuilder<M>, lead: Html, label: ReadonlyArray<Html>): Html =>
	h.span(
		[h.Class("flex min-w-0 items-baseline gap-2")],
		[lead, h.span([h.Class("flex min-w-0 flex-wrap items-baseline gap-x-2")], label)],
	)

const codeLine = <M>(
	h: HtmlBuilder<M>,
	number: number | null,
	text: string,
	isError: boolean,
	key: string,
): Html =>
	h.div(
		[
			h.Key(key),
			h.Class(cn("flex", isError && "bg-severity-error-a2")),
			...(isError ? [h.DataAttribute("error-line", "")] : []),
		],
		[
			h.span(
				[
					h.Class(
						cn(
							"w-12 shrink-0 pr-3 text-right tabular-nums select-none",
							isError ? "text-severity-error" : "text-foreground-subtle",
						),
					),
					h.AriaHidden(true),
				],
				[number === null ? "" : String(number)],
			),
			h.span(
				[h.Class(cn("pr-4 whitespace-pre", isError ? "text-foreground" : "text-foreground-soft"))],
				[text === "" ? " " : text],
			),
		],
	)

/** The frame's source around the error line, numbered, the error line marked. */
const codeContext = <M>(
	h: HtmlBuilder<M>,
	frame: StackFrame,
	context: StackFrameContext,
	id: string,
): Html => {
	const first = frame.line === null ? null : frame.line - context.pre.length
	const numberAt = (offset: number) => (first === null ? null : first + offset)
	return h.div(
		[
			h.Id(id),
			h.Class(
				"overflow-x-auto border-y border-border-subtle bg-surface-sunken py-1.5 font-mono text-xs leading-5",
			),
		],
		[
			h.div(
				[h.Class("w-max min-w-full")],
				[
					...Arr.map(context.pre, (text, i) => codeLine(h, numberAt(i), text, false, `pre-${i}`)),
					codeLine(h, numberAt(context.pre.length), context.line, true, "line"),
					...Arr.map(context.post, (text, i) =>
						codeLine(h, numberAt(context.pre.length + 1 + i), text, false, `post-${i}`),
					),
				],
			),
		],
	)
}

const frameRow = <M>(
	h: HtmlBuilder<M>,
	options: StackFrameListOptions<M>,
	frame: StackFrame,
	key: string,
): Html => {
	const id = `${options.idPrefix}-${key}`
	const context = frame.context
	if (context === null || !frame.in_app)
		return h.li([h.Key(key), h.Class(ROW_CLASS)], [labelLine(h, chevronSpacer(h), frameLabel(h, frame))])
	const isOpen = isStackRowOpen(options.frames, options.toggled, key)
	return h.li(
		[h.Key(key)],
		[
			h.button(
				[
					h.Type("button"),
					h.Class(TOGGLE_CLASS),
					h.AriaExpanded(isOpen),
					...(isOpen ? [h.AriaControls(id)] : []),
					h.OnClick(options.onToggle(key)),
				],
				[labelLine(h, chevron(h, isOpen), frameLabel(h, frame))],
			),
			...(isOpen ? [codeContext(h, frame, context, id)] : []),
		],
	)
}

const libraryRow = <M>(
	h: HtmlBuilder<M>,
	options: StackFrameListOptions<M>,
	frames: ReadonlyArray<StackFrame>,
	key: string,
): Html => {
	const id = `${options.idPrefix}-${key}`
	const isOpen = isStackRowOpen(options.frames, options.toggled, key)
	return h.li(
		[h.Key(key)],
		[
			h.button(
				[
					h.Type("button"),
					h.Class(TOGGLE_CLASS),
					h.AriaExpanded(isOpen),
					...(isOpen ? [h.AriaControls(id)] : []),
					h.OnClick(options.onToggle(key)),
				],
				[
					labelLine(h, chevron(h, isOpen), [
						typography(h, { size: "xs", tone: "muted" }, [`${frames.length} library frames`]),
					]),
				],
			),
			...(isOpen
				? [
						h.ol(
							[h.Id(id), h.Class("pl-5")],
							Arr.map(frames, (frame, i) =>
								h.li(
									[h.Key(`${key}-${i}`), h.Class(ROW_CLASS)],
									[labelLine(h, chevronSpacer(h), frameLabel(h, frame))],
								),
							),
						),
					]
				: []),
		],
	)
}

/**
 * `StackFrameList`: a symbolicated stack trace, top of stack first. Library frames are muted and
 * consecutive ones fold into one "N library frames" row; in-app frames with source open on their
 * code context, the top one open by default. The owner's Model holds the flipped row keys.
 */
export const stackFrameList = <M>(h: HtmlBuilder<M>, options: StackFrameListOptions<M>): Html =>
	h.ol(
		[h.Class(cn("min-w-0 py-1", options.className)), h.DataAttribute("slot", "stack-frames")],
		Arr.map(stackFrameRows(options.frames), (row) =>
			row._tag === "Frame"
				? frameRow(h, options, row.frame, row.key)
				: libraryRow(h, options, row.frames, row.key),
		),
	)
