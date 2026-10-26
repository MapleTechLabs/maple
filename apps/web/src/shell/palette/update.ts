import { Array as Arr, Option } from "effect"
import { Command, type Update } from "foldkit"
import Fuse from "fuse.js"
import * as Combobox from "../../ui/combobox"
import * as Dialog from "../../ui/dialog"
import type { Resources } from "../../platform/resources"
import {
	browseEntries,
	type EntryInputs,
	groupEntries,
	MAX_RESULTS,
	type PaletteEntry,
	paletteEntries,
	searchEntriesOf,
} from "./entries"
import { LoadPaletteServices, ScrollHighlighted } from "./command"
import { init, Message, type Model, OutMessage } from "./model"

export type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

/** What the entries read from the shell (the palette's own services read is in its Model). */
export type Context = Omit<EntryInputs, "serviceNames">

const entriesOf = (model: Model, context: Context) =>
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

/** The entries in list order (grouped), what the highlight indexes. */
const listedEntries = (model: Model, context: Context, visibleFlagged: ReadonlyArray<string>) =>
	groupEntries(shownEntries(model, context, visibleFlagged).entries).flatMap((section) => section.entries)

/** Opening mounts the palette, whose services read goes out with it. */
export const open = (): UpdateReturn => ({ model: init(), commands: [LoadPaletteServices()] })

/** A pick: links navigate, actions run; either way the palette closes. */
const picked = (model: Model, entry: PaletteEntry | undefined): UpdateReturn =>
	entry === undefined
		? { model }
		: {
				model,
				outMessage:
					entry.target._tag === "Href"
						? OutMessage.Navigated({ href: entry.target.href })
						: OutMessage.RanAction({ action: entry.target.action }),
			}

const findEntry = (model: Model, context: Context, id: string) =>
	Option.getOrUndefined(Arr.findFirst(entriesOf(model, context), (entry) => entry.id === id))

const toList = Command.mapMessage((message: Combobox.Message) => Message.GotListMessage({ message }))
const toDialog = Command.mapMessage((message: Dialog.Message) => Message.GotDialogMessage({ message }))

/** Base UI's Enter: the highlighted entry is picked. */
const enter = (model: Model, context: Context, visibleFlagged: ReadonlyArray<string>): UpdateReturn =>
	picked(model, listedEntries(model, context, visibleFlagged)[model.list.highlighted ?? -1])

/** The inline autocomplete: typing searches, arrows move the highlight into view, Enter picks. */
const listStep = (model: Model, child: Combobox.Message, context: Context): UpdateReturn => {
	const next = Combobox.update(model.list, child)
	const out = next.outMessage
	if (out !== undefined && out._tag === "ChangedValue")
		return picked(model, findEntry(model, context, out.value))
	const stepped: Model = { ...model, list: next.model }
	const commands = (next.commands ?? []).map(toList)
	const highlighted = stepped.list.highlighted
	const isMove =
		child._tag === "PressedInputKey" && highlighted !== null && highlighted !== model.list.highlighted
	return {
		model: stepped,
		commands: isMove
			? [...commands, ScrollHighlighted({ itemId: Combobox.itemId(stepped.list.id, highlighted) })]
			: commands,
	}
}

export const update = (model: Model, message: Message, context: Context): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		GotDialogMessage: ({ message: child }) => {
			const next = Dialog.update(model.dialog, child)
			return {
				model: { ...model, dialog: next.model },
				commands: (next.commands ?? []).map(toDialog),
				outMessage: next.outMessage?._tag === "Closed" ? OutMessage.Closed() : undefined,
			}
		},
		GotListMessage: ({ message: child }) => listStep(model, child, context),
		PressedEnter: ({ visibleFlagged }) => enter(model, context, visibleFlagged),
		ClickedEntry: ({ id }) => {
			const entry = findEntry(model, context, id)
			// A link's own click navigates (the root routes it), so only the palette closes.
			return entry?.target._tag === "Href"
				? { model, outMessage: OutMessage.Closed() }
				: picked(model, entry)
		},
		SucceededLoadServices: ({ serviceNames }) => ({ model: { ...model, serviceNames } }),
		FailedLoadServices: () => ({ model }),
		CompletedReleaseServices: () => ({ model }),
		ElapsedCloseDelay: () => ({ model, outMessage: OutMessage.Closed() }),
		CompletedMeasureList: () => ({ model }),
		CompletedScrollHighlighted: () => ({ model }),
	})
