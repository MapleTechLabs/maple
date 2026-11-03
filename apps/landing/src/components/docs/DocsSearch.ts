import { isEditableTarget } from "@maple/ui/lib/keyboard"
import { cn } from "@maple/ui/lib/utils"
import * as Combobox from "@maple/views/ui/combobox"
import {
	type CommandGroup,
	type CommandItem,
	commandEmpty,
	commandFooter,
	commandHiddenInput,
	commandInput,
	commandList,
	MeasureCommandList,
} from "@maple/views/ui/command"
import * as Dialog from "@maple/views/ui/dialog"
import { view as dialogView } from "@maple/views/ui/dialog-view"
import { MagnifierIcon } from "@maple/views/ui/control-icons"
import { iconNode } from "@maple/views/ui/icon"
import {
	Array as Arr,
	Effect,
	Option,
	Order,
	Queue,
	Schema,
	Stream,
	Record as Rec,
	String as Str,
} from "effect"
import { Command, Mount, type Update } from "foldkit"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http"
import Fuse, { type IFuseOptions } from "fuse.js"
import { makeIsland } from "../../foldkit-island/island"
import { groupRank } from "../../lib/docs-nav"
import {
	queryTerms,
	SearchIndexPayload,
	searchRecords,
	termPattern,
	toRecords,
	type SearchDoc,
	type SearchHit,
	type SearchRecord,
} from "../../lib/docs-search"
import { trackLanding } from "../../lib/telemetry"

/**
 * The docs ⌘K palette: the dashboard kit's command dialog over the prebuilt docs index, fetched
 * once the island starts. An empty query browses every page by group; a query ranks page and
 * section rows, with fuse.js as the typo fallback.
 */

const PALETTE_ID = "docs-search"
const MAX_RESULTS = 10

// Typo fallback only: runs when no row contains every term, and only over
// titles and headings, so a fuzzy hit in body text can't outrank a real one.
const FUZZY_OPTIONS: IFuseOptions<SearchRecord> = {
	keys: [
		{ name: "heading", weight: 0.6 },
		{ name: "doc.title", weight: 0.4 },
	],
	ignoreLocation: true,
	threshold: 0.3,
	minMatchCharLength: 3,
}

// MODEL

const Model = Schema.Struct({
	dialog: Dialog.Model,
	list: Combobox.Model,
	index: Schema.Option(SearchIndexPayload),
	isLoading: Schema.Boolean,
})
type Model = typeof Model.Type

const freshList = (): Combobox.Model =>
	Combobox.init(`${PALETTE_ID}-list`, "autocomplete", { isOpen: true, autoHighlight: true })

// MESSAGE

const Message = defineMessageUnion({
	StartedShortcuts: {},
	PressedToggleShortcut: {},
	PressedSlash: {},
	GotDialogMessage: { message: Dialog.Message },
	GotListMessage: { message: Combobox.Message },
	ClickedHit: {},
	SucceededLoadIndex: { index: SearchIndexPayload },
	FailedLoadIndex: {},
	CompletedSideEffect: {},
})
type Message = typeof Message.Type

// COMMANDS

const LoadIndex = Command.define("LoadDocsSearchIndex", {
	messages: [Message.SucceededLoadIndex, Message.FailedLoadIndex],
	execute: Effect.gen(function* () {
		const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
		const response = yield* client.get("/docs/search-index.json")
		const index = yield* HttpClientResponse.schemaBodyJson(SearchIndexPayload)(response)
		return Message.SucceededLoadIndex({ index })
	}).pipe(
		// An island runtime takes no resources, so its one request is its own entry point.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(FetchHttpClient.layer),
		// The palette stays usable without it; the next open retries.
		Effect.orElseSucceed(() => Message.FailedLoadIndex()),
	),
})

/** Reported on close, not per keystroke: what someone searched for, not each prefix on the way. */
const ReportSearch = Command.define("ReportDocsSearch", {
	args: { query: Schema.String },
	messages: [Message.CompletedSideEffect],
	execute: ({ query }) =>
		Effect.sync(() => {
			trackLanding("docs_search", { query: Str.slice(0, 120)(query) })
			return Message.CompletedSideEffect()
		}),
})

const Navigate = Command.define("NavigateToDocsHit", {
	args: { url: Schema.String },
	messages: [Message.CompletedSideEffect],
	execute: ({ url }) =>
		Effect.sync(() => {
			window.location.assign(url)
			return Message.CompletedSideEffect()
		}),
})

/** The highlighted row stays in view as the arrows move it (`scrollIntoView` nearest). */
const ScrollHighlighted = Command.define("ScrollDocsHitIntoView", {
	args: { itemId: Schema.String },
	messages: [Message.CompletedSideEffect],
	execute: ({ itemId }) =>
		Effect.sync(() => {
			document.getElementById(itemId)?.scrollIntoView({ block: "nearest" })
			return Message.CompletedSideEffect()
		}),
})

const ShortcutMessage = Schema.Union([
	Message.StartedShortcuts,
	Message.PressedToggleShortcut,
	Message.PressedSlash,
])
type ShortcutMessage = typeof ShortcutMessage.Type

/** ⌘K / Ctrl+K toggles the palette from anywhere; `/` opens it outside a text field. */
const ListenForShortcuts = Mount.defineStream("ListenForDocsSearchShortcuts", {
	messages: [Message.StartedShortcuts, Message.PressedToggleShortcut, Message.PressedSlash],
	execute: () =>
		Stream.callback<ShortcutMessage>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const onKeyDown = (event: KeyboardEvent) => {
						if ((event.key === "k" || event.key === "K") && (event.metaKey || event.ctrlKey)) {
							event.preventDefault()
							Queue.offerUnsafe(queue, Message.PressedToggleShortcut())
						} else if (
							event.key === "/" &&
							!isEditableTarget(event.target) &&
							document.getElementById(Dialog.popupId(PALETTE_ID)) === null
						) {
							event.preventDefault()
							Queue.offerUnsafe(queue, Message.PressedSlash())
						}
					}
					// Capture phase, so ⌘K still toggles while focus is trapped in the open dialog.
					document.addEventListener("keydown", onKeyDown, true)
					Queue.offerUnsafe(queue, Message.StartedShortcuts())
					return onKeyDown
				}),
				(onKeyDown) => Effect.sync(() => document.removeEventListener("keydown", onKeyDown, true)),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})

// SEARCH

type Searchable = Readonly<{ records: ReadonlyArray<SearchRecord>; fuzzy: Fuse<SearchRecord> }>

// Built once per fetched index, the way the React palette kept it beside its promise.
const searchables = new WeakMap<object, Searchable>()

const searchableOf = (index: SearchIndexPayload): Searchable => {
	const cached = searchables.get(index.docs)
	if (cached !== undefined) return cached
	const records = toRecords(index.docs)
	const built = { records, fuzzy: new Fuse(records, FUZZY_OPTIONS) }
	searchables.set(index.docs, built)
	return built
}

/** `None` browses every page (empty query); otherwise the ranked page and section hits. */
const hitsOf = (model: Model): Option.Option<ReadonlyArray<SearchHit>> => {
	const query = Str.trim(model.list.inputValue)
	if (query === "") return Option.none()
	return Option.some(
		Option.match(model.index, {
			onNone: () => [],
			onSome: (index) => {
				const { records, fuzzy } = searchableOf(index)
				const exact = searchRecords(records, query, MAX_RESULTS)
				if (exact.length > 0) return exact
				return Arr.map(fuzzy.search(query, { limit: MAX_RESULTS }), (result) => ({
					record: result.item,
					snippet: "",
				}))
			},
		}),
	)
}

// UPDATE

type UpdateReturn = Update.Return<Model, Message>

const toDialog = Command.mapMessage((message: Dialog.Message) => Message.GotDialogMessage({ message }))
const toList = Command.mapMessage((message: Combobox.Message) => Message.GotListMessage({ message }))

/** Fetched at most once per page; a failed fetch is retried on the next open. */
const loadIfMissing = (model: Model): UpdateReturn =>
	Option.isSome(model.index) || model.isLoading
		? { model }
		: { model: { ...model, isLoading: true }, commands: [LoadIndex()] }

/** Each open starts from an empty query; a dismissal (not a pick) reports what was searched. */
const dialogStep = (
	model: Model,
	next: Update.ReturnWithOutMessage<Dialog.Model, Dialog.Message, Dialog.OutMessage>,
	isDismissal = true,
): UpdateReturn => {
	const stepped = { ...model, dialog: next.model }
	const commands = Arr.map(next.commands ?? [], toDialog)
	if (next.outMessage?._tag === "Opened") {
		const loaded = loadIfMissing({ ...stepped, list: freshList() })
		return { model: loaded.model, commands: [...commands, ...(loaded.commands ?? [])] }
	}
	const query = Str.trim(model.list.inputValue)
	return next.outMessage?._tag === "Closed" && isDismissal && query !== ""
		? { model: stepped, commands: [...commands, ReportSearch({ query })] }
		: { model: stepped, commands }
}

/** The inline autocomplete: typing searches, arrows move the highlight into view, Enter opens it. */
const listStep = (model: Model, child: Combobox.Message): UpdateReturn => {
	const next = Combobox.update(model.list, child)
	if (next.outMessage?._tag === "ChangedValue") {
		// The list's own close step is dropped: the dialog closes around it and each open starts a fresh list.
		const closed = dialogStep(model, Dialog.close(model.dialog), false)
		return {
			model: closed.model,
			commands: [...(closed.commands ?? []), Navigate({ url: next.outMessage.value })],
		}
	}
	const list = next.model
	const commands = Arr.map(next.commands ?? [], toList)
	const moved =
		child._tag === "PressedInputKey" && list.highlighted !== model.list.highlighted
			? list.highlighted
			: null
	return {
		model: { ...model, list },
		commands:
			moved === null
				? commands
				: [...commands, ScrollHighlighted({ itemId: Combobox.itemId(list.id, moved) })],
	}
}

const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		StartedShortcuts: () => loadIfMissing(model),
		PressedToggleShortcut: () =>
			dialogStep(model, model.dialog.isOpen ? Dialog.close(model.dialog) : Dialog.open(model.dialog)),
		PressedSlash: () => dialogStep(model, Dialog.open(model.dialog)),
		GotDialogMessage: ({ message: child }) => dialogStep(model, Dialog.update(model.dialog, child)),
		GotListMessage: ({ message: child }) => listStep(model, child),
		// The row is a link and navigates on its own; the palette just closes.
		ClickedHit: () => dialogStep(model, Dialog.close(model.dialog), false),
		SucceededLoadIndex: ({ index }) => ({
			model: { ...model, index: Option.some(index), isLoading: false },
		}),
		FailedLoadIndex: () => ({ model: { ...model, isLoading: false } }),
		CompletedSideEffect: () => ({ model }),
	})

// VIEW

type Icons = SearchIndexPayload["icons"]

/** Emphasize each query term where it starts a word. */
const highlight = (
	h: HtmlBuilder<Message>,
	text: string,
	terms: ReadonlyArray<string>,
): ReadonlyArray<Html | string> => {
	const best = Arr.reduce(terms, Option.none<Readonly<{ at: number; length: number }>>(), (found, term) => {
		const match = termPattern(term).exec(text)
		if (match === null) return found
		const at = match.index + (match[1] ?? "").length
		return Option.isSome(found) && found.value.at <= at ? found : Option.some({ at, length: term.length })
	})
	return Option.match(best, {
		onNone: () => [text],
		onSome: ({ at, length }) => [
			Str.slice(0, at)(text),
			h.mark(
				[h.Class("bg-transparent font-semibold text-current")],
				[Str.slice(at, at + length)(text)],
			),
			...highlight(h, Str.slice(at + length)(text), terms),
		],
	})
}

// Build-time SVG from our own icon components (see search-index.json.ts).
// Category glyphs paint in currentColor, so they follow the highlighted row.
const svgIcon = (h: HtmlBuilder<Message>, svg: string | undefined, className: string): Option.Option<Html> =>
	Option.map(Option.fromUndefinedOr(svg), (markup) =>
		h.span([h.AriaHidden(true), h.Class(cn("flex shrink-0", className)), h.InnerHTML(markup)], []),
	)

// Only on ranked hits: browse mode already groups rows under their section.
const tag = (h: HtmlBuilder<Message>, doc: SearchDoc): Html =>
	h.span(
		[
			h.Class(
				"ms-auto shrink-0 whitespace-nowrap border border-current/25 px-1.5 py-0.5 font-medium text-[9px] text-current/70 uppercase leading-none tracking-wider",
			),
		],
		[doc.sdk ?? doc.group],
	)

// The highlighted row: a light neutral tint and a thin primary left edge. Text keeps the foreground color and leans on opacity for hierarchy.
const ITEM_CLASS =
	"flex items-center gap-3 rounded-none data-highlighted:bg-fg/[0.06] data-highlighted:text-fg data-highlighted:shadow-[inset_2px_0_0_var(--primary)]"

/** The row's page glyph, when the index has one. */
const leadingOf = (h: HtmlBuilder<Message>, icons: Icons, doc: SearchDoc): Pick<CommandItem, "leading"> =>
	Option.match(svgIcon(h, doc.icon === undefined ? undefined : icons[doc.icon], "opacity-80"), {
		onNone: () => ({}),
		onSome: (leading) => ({ leading }),
	})

const pageItem = (h: HtmlBuilder<Message>, doc: SearchDoc, icons: Icons): CommandItem => ({
	title: doc.title,
	value: doc.url,
	href: doc.url,
	...leadingOf(h, icons, doc),
	body: [
		h.span(
			[h.Class("flex min-w-0 flex-col")],
			[
				h.span([h.Class("truncate text-sm")], [doc.title]),
				h.span([h.Class("truncate text-xs opacity-65")], [doc.description]),
			],
		),
	],
})

const hitItem = (
	h: HtmlBuilder<Message>,
	hit: SearchHit,
	terms: ReadonlyArray<string>,
	icons: Icons,
): CommandItem => {
	const { record, snippet } = hit
	const detail = snippet !== "" ? snippet : record.section === undefined ? record.doc.description : ""
	return {
		title: record.heading,
		value: record.url,
		href: record.url,
		...leadingOf(h, icons, record.doc),
		body: [
			h.span(
				[h.Class("flex min-w-0 flex-col")],
				[
					...(record.section === undefined
						? []
						: [h.span([h.Class("truncate text-[11px] opacity-55")], [record.doc.title])]),
					h.span([h.Class("truncate text-sm")], highlight(h, record.heading, terms)),
					...(detail === ""
						? []
						: [
								h.span(
									[h.Class("line-clamp-2 text-xs opacity-65")],
									highlight(h, detail, terms),
								),
							]),
				],
			),
		],
		trailing: tag(h, record.doc),
	}
}

const byGroupRank = Order.mapInput(Order.Number, ([group]: readonly [string, unknown]) => groupRank(group))

const groupsOf = (
	h: HtmlBuilder<Message>,
	model: Model,
	hits: Option.Option<ReadonlyArray<SearchHit>>,
): ReadonlyArray<CommandGroup> => {
	const icons: Icons = Option.match(model.index, { onNone: () => ({}), onSome: (index) => index.icons })
	return Option.match(hits, {
		onSome: (hits) => {
			const terms = queryTerms(model.list.inputValue)
			return [{ items: Arr.map(hits, (hit) => hitItem(h, hit, terms, icons)) }]
		},
		onNone: () =>
			Option.match(model.index, {
				onNone: () => [],
				onSome: (index) =>
					Arr.map(
						Arr.sort(Rec.toEntries(Arr.groupBy(index.docs, (doc) => doc.group)), byGroupRank),
						([group, docs]) => ({
							label: group,
							labelClassName: "flex items-center gap-1.5",
							...Option.match(
								svgIcon(h, index.icons[`group:${group}`], "text-primary/80 [&_svg]:size-3"),
								{
									onNone: () => ({}),
									onSome: (labelLeading) => ({ labelLeading }),
								},
							),
							items: Arr.map(docs, (doc) => pageItem(h, doc, index.icons)),
						}),
					),
			}),
	})
}

const QUICKSTART_LINK = "underline underline-offset-2 hover:text-fg"

const noResults = (h: HtmlBuilder<Message>, query: string): Html =>
	commandEmpty(h, {}, [
		h.p([], ["No results for “", query, "”."]),
		h.p(
			[h.Class("mt-1.5 text-xs opacity-70")],
			[
				"Try a framework or signal name, or open the ",
				h.a([h.Href("/docs/getting-started/quickstart"), h.Class(QUICKSTART_LINK)], ["quickstart"]),
				" or the ",
				h.a([h.Href("/docs/instrumentation"), h.Class(QUICKSTART_LINK)], ["instrumentation guides"]),
				".",
			],
		),
	])

const TOUCH_HIDDEN = "flex items-center gap-1.5 [@media(hover:none)]:hidden"

const palette = (
	h: HtmlBuilder<Message>,
	model: Model,
	close: ReadonlyArray<ChildAttribute>,
): ReadonlyArray<Html> => {
	const toList = (message: Combobox.Message) => Message.GotListMessage({ message })
	const hits = hitsOf(model)
	const groups = groupsOf(h, model, hits)
	const isEmpty = Option.isSome(hits) && hits.value.length === 0
	return [
		commandInput(
			h,
			model.list,
			{ placeholder: "Search the docs…", groups, hasDismissButton: true, isUnfiltered: true },
			toList,
		),
		commandList(h, model.list, groups, toList, {
			isUnfiltered: true,
			itemClassName: ITEM_CLASS,
			listClassName: "not-empty:pb-3",
			onClickItem: () => Message.ClickedHit(),
			viewportAttributes: [
				h.OnMount(Mount.mapMessage(MeasureCommandList(), () => Message.CompletedSideEffect())),
			],
			hasMeasuredScrollbar: true,
			empty: isEmpty ? noResults(h, model.list.inputValue) : undefined,
		}),
		// Key hints on a keyboard; on touch a slim footer with a close button.
		commandFooter(
			h,
			[
				h.span(
					[h.Class(cn(TOUCH_HIDDEN, isEmpty && "invisible"))],
					[h.kbd([h.Class("font-medium text-fg")], ["↵"]), " to open"],
				),
				h.span(
					[h.Class(TOUCH_HIDDEN)],
					[h.kbd([h.Class("font-medium text-fg")], ["esc"]), " to close"],
				),
				h.button(
					[
						h.Type("button"),
						h.Class(
							"ms-auto hidden rounded-md px-2 py-1 text-fg/75 transition-colors hover:text-fg [@media(hover:none)]:inline-flex",
						),
						...close,
					],
					["Close"],
				),
			],
			"py-2.5 text-fg/75",
		),
		commandHiddenInput(h, model.list),
	]
}

// Focus ring as the kit's buttons draw it (`buttonStyles`), shown for keyboard focus only.
const TRIGGER_CLASS =
	"flex h-7 items-center gap-2 rounded-lg border border-border px-2 text-fg-muted text-xs outline-none transition-colors hover:border-fg-muted/40 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background sm:w-56"

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.submodel({
		slotId: PALETTE_ID,
		model: model.dialog,
		view: dialogView,
		viewInputs: {
			className: "max-h-[calc(100dvh-6rem)] sm:max-h-105",
			toView: ({ trigger, portal }) =>
				h.div(
					[h.Class("contents")],
					[
						h.button(
							[
								...trigger,
								h.Type("button"),
								h.AriaLabel("Search docs"),
								h.Class(TRIGGER_CLASS),
								h.OnMount(ListenForShortcuts()),
							],
							[
								iconNode(h, MagnifierIcon, "MagnifierIcon", {
									className: "size-3.5 shrink-0",
								}),
								h.span([h.Class("hidden sm:inline")], ["Search docs"]),
								h.kbd(
									[
										h.Class(
											"ml-auto hidden font-mono font-medium text-[10px] text-fg-muted/70 tracking-widest sm:inline",
										),
									],
									["⌘K"],
								),
							],
						),
						...(portal === null ? [] : [portal]),
					],
				),
			toContent: (close) => palette(h, model, close),
		},
		toParentMessage: (message: Dialog.Message) => Message.GotDialogMessage({ message }),
	})

export const DocsSearch = makeIsland({
	name: "DocsSearch",
	Props: Schema.Struct({}),
	Model,
	init: () => ({
		model: {
			dialog: Dialog.init(PALETTE_ID, "command-dialog"),
			list: freshList(),
			index: Option.none(),
			isLoading: false,
		},
	}),
	update,
	view,
})
