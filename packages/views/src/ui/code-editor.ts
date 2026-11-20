import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder, KeyboardModifiers, TextareaAttribute } from "foldkit/html"
import { Array as Arr, Option, String as Str } from "effect"

/** A coloured run of an editor's text: `start` is its offset, `className` its colour (none is plain). */
export type CodeToken = Readonly<{ text: string; start: number; className?: string }>

/** One completion: what the list shows, its kind tag, and an optional signature and one-line doc. */
export type CodeSuggestion = Readonly<{ label: string; kind: string; detail?: string; doc?: string }>

/** The open completion list: the caret it hangs under, its items and the highlighted one. */
export type CodeCompletion<M> = Readonly<{
	caret: number
	items: ReadonlyArray<CodeSuggestion>
	activeIndex: number
	/** A pointer press on an item (mousedown, before the textarea blurs). */
	onPick: (index: number) => M
}>

/** `CodeEditor`: a textarea whose text is drawn, syntax-highlighted, by a `<pre>` laid under it. */
export type CodeEditorOptions<M> = Readonly<{
	id: string
	/** Accessible name ("SQL query"). */
	label: string
	value: string
	tokens: ReadonlyArray<CodeToken>
	placeholder?: string
	/** Both grow with the text, so the layers never scroll apart: `tall` from 200px, scrolling as one past 60vh; `auto` from 8rem. */
	size?: "tall" | "auto"
	describedBy?: string
	/** The span `[from, to)` a parse error points at, underlined; `isInvalid` without one. */
	error?: Readonly<{ from: number; to: number }> | null
	/** Present makes the textarea a combobox; null is a closed list. */
	completion?: CodeCompletion<M> | null
	onInput: (value: string) => M
	/** Keys the editor takes over (the list's arrows, Enter, Tab, Esc); Some prevents the default. */
	onKeyDown?: (key: string, modifiers: KeyboardModifiers) => Option.Option<M>
	/** Every key release and click, for a host that tracks the caret. */
	onKeyUp?: (key: string) => M
	onClick?: M
	onBlur?: M
}>

const SURFACE = "whitespace-pre-wrap break-words rounded-sm border px-2 py-1.5 leading-5"
const ERROR_MARK = "underline decoration-wavy decoration-destructive underline-offset-4"

export const suggestionListId = (id: string): string => `${id}-suggestions`
export const suggestionId = (id: string, index: number): string => `${id}-suggestion-${index}`

/** The tokens cut at the error's edges, so the marked span is its own runs. */
const marked = (
	tokens: ReadonlyArray<CodeToken>,
	error: Readonly<{ from: number; to: number }> | null,
): ReadonlyArray<CodeToken & { isError: boolean }> =>
	Arr.flatMap(tokens, (token) => {
		const end = token.start + token.text.length
		if (error === null || end <= error.from || token.start >= error.to)
			return [{ ...token, isError: false }]
		const cuts = Arr.dedupe([
			token.start,
			Math.max(token.start, error.from),
			Math.min(end, error.to),
			end,
		])
		const spans = Arr.makeBy(cuts.length - 1, (index): readonly [number, number] => [
			cuts[index] ?? 0,
			cuts[index + 1] ?? 0,
		])
		return Arr.flatMap(spans, ([from, to]) =>
			from === to
				? []
				: [
						{
							...token,
							text: Str.slice(from - token.start, to - token.start)(token.text),
							start: from,
							isError: from >= error.from && to <= error.to,
						},
					],
		)
	})

const highlighted = <M>(h: HtmlBuilder<M>, options: CodeEditorOptions<M>): Html =>
	h.pre(
		[
			h.AriaHidden(true),
			h.Class(
				cn("pointer-events-none absolute inset-0 m-0 overflow-hidden border-transparent", SURFACE),
			),
		],
		[
			h.code(
				[h.Class("font-mono")],
				[
					...Arr.map(marked(options.tokens, options.error ?? null), (token) => {
						const className = cn(token.className, token.isError && ERROR_MARK)
						return h.span(className === "" ? [] : [h.Class(className)], [token.text])
					}),
					// An error past the last character (an unclosed call) marks a space after it.
					...(options.error !== undefined &&
					options.error !== null &&
					options.error.from >= options.value.length
						? [h.span([h.Class(ERROR_MARK)], [" "])]
						: []),
					"\n",
				],
			),
		],
	)

const kindTag = <M>(h: HtmlBuilder<M>, kind: string): Html =>
	h.span([h.AriaHidden(true), h.Class("w-14 shrink-0 font-sans text-2xs text-foreground-subtle")], [kind])

const item = <M>(
	h: HtmlBuilder<M>,
	id: string,
	completion: CodeCompletion<M>,
	suggestion: CodeSuggestion,
	index: number,
): Html =>
	h.li(
		[
			h.Id(suggestionId(id, index)),
			h.Role("option"),
			h.AriaSelected(index === completion.activeIndex),
			h.DataAttribute("highlighted", index === completion.activeIndex ? "true" : "false"),
			h.OnMouseDown(completion.onPick(index)),
			h.Class(
				"flex min-h-7 cursor-default select-none items-center gap-2 rounded-sm px-2 py-1 text-xs data-[highlighted=true]:bg-accent data-[highlighted=true]:text-accent-foreground",
			),
		],
		[kindTag(h, suggestion.kind), h.span([h.Class("min-w-0 truncate font-mono")], [suggestion.label])],
	)

/** The highlighted item's signature and doc, under the list. */
const itemDoc = <M>(h: HtmlBuilder<M>, suggestion: CodeSuggestion | undefined): ReadonlyArray<Html> =>
	suggestion === undefined || (suggestion.detail === undefined && suggestion.doc === undefined)
		? []
		: [
				h.div(
					[h.Class("border-t px-3 py-2 font-sans text-2xs leading-4 text-muted-foreground")],
					[
						...(suggestion.detail === undefined
							? []
							: [h.div([h.Class("font-mono text-foreground")], [suggestion.detail])]),
						...(suggestion.doc === undefined ? [] : [h.div([], [suggestion.doc])]),
					],
				),
			]

/** The list, hung under the caret: the text before it is laid out invisibly to find where that is. */
const suggestionLayer = <M>(
	h: HtmlBuilder<M>,
	options: CodeEditorOptions<M>,
	completion: CodeCompletion<M>,
): Html =>
	h.div(
		[h.Class(cn("pointer-events-none absolute inset-0 z-10 border-transparent", SURFACE))],
		[
			h.span(
				[h.AriaHidden(true), h.Class("text-transparent")],
				[Str.slice(0, completion.caret)(options.value)],
			),
			h.span(
				[h.Class("relative inline-block w-0")],
				[
					h.div(
						[
							h.Class(
								"pointer-events-auto absolute top-1.5 left-0 w-max min-w-64 max-w-[min(32rem,80vw)] overflow-hidden rounded-lg border bg-popover text-foreground shadow-popup",
							),
						],
						[
							h.ul(
								[
									h.Id(suggestionListId(options.id)),
									h.Role("listbox"),
									h.AriaLabel(`${options.label} suggestions`),
									h.Class("max-h-60 overflow-y-auto p-1"),
								],
								Arr.map(completion.items, (suggestion, index) =>
									item(h, options.id, completion, suggestion, index),
								),
							),
							...itemDoc(h, completion.items[completion.activeIndex]),
						],
					),
				],
			),
		],
	)

const comboboxAttributes = <M>(
	options: CodeEditorOptions<M>,
	h: HtmlBuilder<M>,
): ReadonlyArray<TextareaAttribute<M>> => {
	if (options.completion === undefined) return []
	const completion = options.completion
	const isOpen = completion !== null && completion.items.length > 0
	return [
		h.Role("combobox"),
		h.AriaAutocomplete("list"),
		h.AriaExpanded(isOpen),
		h.AriaControls(suggestionListId(options.id)),
		...(isOpen ? [h.AriaActiveDescendant(suggestionId(options.id, completion.activeIndex))] : []),
	]
}

export const codeEditor = <M>(h: HtmlBuilder<M>, options: CodeEditorOptions<M>): Html => {
	const completion = options.completion ?? null
	const attributes: ReadonlyArray<TextareaAttribute<M>> = [
		h.Id(options.id),
		h.AriaLabel(options.label),
		h.Value(options.value),
		h.Spellcheck(false),
		h.OnInput(options.onInput),
		...(options.placeholder === undefined ? [] : [h.Placeholder(options.placeholder)]),
		...(options.describedBy === undefined ? [] : [h.AriaDescribedBy(options.describedBy)]),
		...(options.error === undefined || options.error === null ? [] : [h.AriaInvalid(true)]),
		...comboboxAttributes(options, h),
		...(options.onKeyDown === undefined ? [] : [h.OnKeyDownPreventDefault(options.onKeyDown)]),
		...(options.onKeyUp === undefined ? [] : [h.OnKeyUp(options.onKeyUp)]),
		...(options.onClick === undefined ? [] : [h.OnClick(options.onClick)]),
		...(options.onBlur === undefined ? [] : [h.OnBlur(options.onBlur)]),
		h.Class(
			cn(
				"relative block w-full bg-transparent text-transparent caret-foreground placeholder:text-foreground-subtle border-border outline-none focus:ring-1 focus:ring-foreground/20 aria-invalid:border-destructive",
				SURFACE,
				"resize-none field-sizing-content",
				options.size === "auto" ? "min-h-32" : "min-h-[200px]",
			),
		),
	]
	const editor = h.div(
		[h.Class("relative w-full text-xs font-mono leading-5"), h.DataAttribute("slot", "code-editor")],
		[
			highlighted(h, options),
			h.textarea(attributes),
			...(completion === null || completion.items.length === 0
				? []
				: [suggestionLayer(h, options, completion)]),
		],
	)
	// One scrolling surface for both layers; the auto editor never needs one, so its list is not clipped.
	return options.size === "auto"
		? editor
		: h.div([h.Class("max-h-[60vh] w-full overflow-y-auto")], [editor])
}
