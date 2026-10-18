import { Array as Arr, Option } from "effect"
import { Command, type Update } from "foldkit"
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
import { LoadPaletteServices, PreloadFuse, ScrollHighlighted, SearchPalette } from "./command"
import { init, Message, type Model, OutMessage } from "./model"

export type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

/** What the entries read from the shell (the palette's own services read is in its Model). */
export type Context = Omit<EntryInputs, "serviceNames">

const entriesOf = (model: Model, context: Context) =>
	paletteEntries({ ...context, serviceNames: model.serviceNames })

export type Shown = Readonly<{ entries: ReadonlyArray<PaletteEntry>; isSearch: boolean }>

/** Browse mode for an empty query; otherwise fuse's top matches, best first. */
export const shownEntries = (model: Model, context: Context, isReleasesVisible: boolean): Shown => {
	const entries = entriesOf(model, context).filter((entry) => entry.isFlagged !== true || isReleasesVisible)
	if (model.list.inputValue.trim() === "") return { entries: browseEntries(entries), isSearch: false }
	// The ranking is a moment away (legacy ranks in render): an empty list, never a stale one.
	if (model.ranked === null || model.rankedQuery !== model.list.inputValue.trim())
		return { entries: [], isSearch: false }
	const byId = new Map(entries.map((entry) => [entry.id, entry]))
	const ranked = model.ranked.flatMap((id) => byId.get(id) ?? []).slice(0, MAX_RESULTS)
	return { entries: ranked, isSearch: true }
}

/** The entries in list order (grouped), what the highlight indexes. */
const listedEntries = (model: Model, context: Context, isReleasesVisible: boolean) =>
	groupEntries(shownEntries(model, context, isReleasesVisible).entries).flatMap(
		(section) => section.entries,
	)

/** Opening mounts the palette, whose services read goes out with it. */
export const open = (): UpdateReturn => ({ model: init(), commands: [LoadPaletteServices(), PreloadFuse()] })

/** fuse ranks the trimmed query; an empty one is browse mode and needs no search. */
const search = (
	model: Model,
	context: Context,
): ReadonlyArray<Command.Command<Message, never, Resources>> => {
	const query = model.list.inputValue.trim()
	return query === "" ? [] : [SearchPalette({ query, entries: searchEntriesOf(entriesOf(model, context)) })]
}

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
const enter = (model: Model, context: Context, isReleasesVisible: boolean): UpdateReturn =>
	picked(model, listedEntries(model, context, isReleasesVisible)[model.list.highlighted ?? -1])

const rankedStep = (model: Model, pendingEnter: boolean | null, context: Context): UpdateReturn =>
	pendingEnter === null ? { model } : enter(model, context, pendingEnter)

/** The inline autocomplete: typing searches, arrows move the highlight into view, Enter picks. */
const listStep = (model: Model, child: Combobox.Message, context: Context): UpdateReturn => {
	const next = Combobox.update(model.list, child)
	const out = next.outMessage
	if (out !== undefined && out._tag === "ChangedValue")
		return picked(model, findEntry(model, context, out.value))
	const stepped: Model = { ...model, list: next.model }
	const commands = (next.commands ?? []).map(toList)
	if (child._tag === "ChangedInput")
		return { model: stepped, commands: [...commands, ...search(stepped, context)] }
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
		// Enter waits for the ranking of what was typed, which legacy computes in the same render.
		PressedEnter: ({ isReleasesVisible }) => {
			const query = model.list.inputValue.trim()
			return query !== "" && model.rankedQuery !== query
				? { model: { ...model, pendingEnter: isReleasesVisible } }
				: enter(model, context, isReleasesVisible)
		},
		ClickedEntry: ({ id }) => {
			const entry = findEntry(model, context, id)
			// A link's own click navigates (the root routes it), so only the palette closes.
			return entry?.target._tag === "Href"
				? { model, outMessage: OutMessage.Closed() }
				: picked(model, entry)
		},
		SucceededLoadServices: ({ serviceNames }) => {
			const loaded: Model = { ...model, serviceNames }
			return { model: loaded, commands: search(loaded, context) }
		},
		FailedLoadServices: () => ({ model }),
		// An answer for an older query is dropped; the newer one is in flight.
		RankedEntries: ({ query, ids }) =>
			query === model.list.inputValue.trim()
				? rankedStep(
						{ ...model, ranked: ids, rankedQuery: query, pendingEnter: null },
						model.pendingEnter,
						context,
					)
				: { model },
		CompletedReleaseServices: () => ({ model }),
		CompletedPreloadFuse: () => ({ model }),
		ElapsedCloseDelay: () => ({ model, outMessage: OutMessage.Closed() }),
		CompletedMeasureList: () => ({ model }),
		CompletedScrollHighlighted: () => ({ model }),
	})
