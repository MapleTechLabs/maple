import { Array as Arr, Function, Layer, Option } from "effect"
import { Block, Update } from "foldkit"
import Fuse from "fuse.js"
import * as Combobox from "../../ui/combobox"
import { ComboboxBlock } from "../../ui/combobox-view"
import * as Dialog from "../../ui/dialog"
import { DialogBlock } from "../../ui/dialog-view"
import {
	browseEntries,
	type EntryInputs,
	MAX_RESULTS,
	type PaletteEntry,
	paletteEntries,
	searchEntriesOf,
} from "./entries"
import { DelayClose, LoadPaletteServices, MeasurePaletteList } from "./command"
import { Message, type Model, OutMessage, PALETTE_ID, PaletteDefinition } from "./model"

/** What the entries read from the shell (the palette's own services read is in its Model). */
export type Context = Omit<EntryInputs, "serviceNames">

export const entriesOf = (model: Model, context: Context) =>
	paletteEntries({ ...context, serviceNames: model.serviceNames })

export type Shown = Readonly<{ entries: ReadonlyArray<PaletteEntry>; isSearch: boolean }>

/** `FUSE_OPTIONS`: title-weighted, location-free, threshold 0.35. */
const FUSE_OPTIONS = {
	keys: [
		{ name: "title", weight: 0.7 },
		{ name: "keywords", weight: 0.3 },
	],
	ignoreLocation: true,
	threshold: 0.35,
}

/** A title with a word starting with the query ("serv" in "Service Map", not in "Overview"). */
const isWordStartMatch = (title: string, query: string): boolean => {
	const needle = query.toLowerCase()
	return (
		title.toLowerCase().startsWith(needle) ||
		title
			.toLowerCase()
			.split(/[\s\-_./:]+/)
			.some((word) => word.startsWith(needle))
	)
}

/**
 * `fuse.search(query)` over every entry (flagged rows included), best first. When some titles have
 * a word starting with the query, the fuzzy mid-word hits drop out; a typo still falls back to them.
 */
const rankedIds = (entries: ReadonlyArray<PaletteEntry>, query: string): ReadonlyArray<string> => {
	const items = new Fuse(searchEntriesOf(entries), FUSE_OPTIONS).search(query).map(({ item }) => item)
	const prefixed = items.filter((item) => isWordStartMatch(item.title, query))
	return (prefixed.length > 0 ? prefixed : items).map((item) => item.id)
}

/** Browse mode for an empty query; otherwise fuse's top matches, ranked in render as cmdk does. */
export const shownEntries = (
	model: Model,
	context: Context,
	visibleFlagged: ReadonlyArray<string>,
): Shown => {
	const all = entriesOf(model, context)
	const entries = all.filter(
		(entry) =>
			entry.isFlagged !== true ||
			(entry.target._tag === "Href" && visibleFlagged.includes(entry.target.href)),
	)
	const query = model.list.inputValue.trim()
	if (query === "") return { entries: browseEntries(entries), isSearch: false }
	const byId = new Map(entries.map((entry) => [entry.id, entry]))
	const ranked = rankedIds(all, query)
		.flatMap((id) => byId.get(id) ?? [])
		.slice(0, MAX_RESULTS)
	return { entries: ranked, isSearch: true }
}

/** An entry by id, what the shell resolves a pick against. */
export const findEntry = (model: Model, context: Context, id: string): PaletteEntry | undefined =>
	Option.getOrUndefined(Arr.findFirst(entriesOf(model, context), (entry) => entry.id === id))

const { makeStep, makeNoopStep, makeOutMessageStep } = PaletteDefinition

/** Both children start open with the palette; a closing palette only waits for its delay. */
export const DialogBinding = PaletteDefinition.makeBinding(DialogBlock, {
	field: "dialog",
	init: false,
	delivery: { when: (model) => !model.isClosing },
}).withOutMessagePolicy({
	fold: PaletteDefinition.makeOutMessageFold(DialogBlock, {
		Opened: makeNoopStep,
		Closed: () => makeOutMessageStep(() => OutMessage.Closed()),
	}),
})

/** The inline autocomplete: typing searches, arrows move the highlight, Enter picks. */
export const ListBinding = PaletteDefinition.makeBinding(ComboboxBlock, {
	field: "list",
	init: false,
	delivery: { when: (model) => !model.isClosing },
})

/** A pick fills the input with the entry id; the query is put back while the palette goes. */
export const ListBindingWithOutMessagePolicy = ListBinding.withOutMessagePolicy({
	fold: PaletteDefinition.makeOutMessageFold(ComboboxBlock, {
		ChangedSelection: makeNoopStep,
		ChangedValue: ({ value }, { modelBeforeUpdate }) =>
			makeStep(() =>
				Function.compose(
					ListBinding.informOfInput({ value: modelBeforeUpdate.list.inputValue }),
					Update.withOutMessage(OutMessage.PickedEntry({ id: value })),
				),
			),
	}),
})

export const PaletteComposition = PaletteDefinition.makeComposition({
	bindings: [DialogBinding, ListBindingWithOutMessagePolicy],
	mounts: [MeasurePaletteList],
})
export type PaletteViewBuilder = Block.ViewBuilderFor<typeof PaletteComposition>

/** Opening mounts the palette, whose services read goes out with it. */
export const init = PaletteComposition.makeInit(() => ({
	model: {
		dialog: Dialog.initialModel(PALETTE_ID, "command-dialog", { isOpen: true }),
		list: Combobox.init(`${PALETTE_ID}-list`, "autocomplete", { isOpen: true, autoHighlight: true })
			.model,
		serviceNames: [],
		isClosing: false,
	},
	commands: [LoadPaletteServices()],
}))

export const update = PaletteComposition.makeUpdate({
	ClickedEntry: (model, { id }) =>
		model.isClosing ? { model } : { model, outMessage: OutMessage.ClickedEntry({ id }) },
	SucceededLoadServices: (model, { serviceNames }) =>
		model.isClosing ? { model } : { model: { ...model, serviceNames } },
	FailedLoadServices: (model) => ({ model }),
	ElapsedCloseDelay: (model) => ({ model, outMessage: OutMessage.Closed() }),
	CompletedMeasureList: (model) => ({ model }),
	RequestedDelayedClose: (model) => ({ model: { ...model, isClosing: true }, commands: [DelayClose()] }),
})

/** Parent-initiated: an action that opened another overlay closes the palette after it. */
export const operations = { requestDelayedClose: Message.RequestedDelayedClose }

export const EffectsLayer = Layer.mergeAll(
	LoadPaletteServices.layer,
	DelayClose.layer,
	MeasurePaletteList.layer,
)
