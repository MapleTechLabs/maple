import { readLocalStorage, writeLocalStorage } from "@maple/ui/lib/local-storage"
import { Effect, Layer, Option, Record, Schema } from "effect"
import { Block } from "foldkit"
import { type ChildAttribute, childAttributes, type Html } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { searchInput } from "../search-input"

// The UI state of a filter rail's `FilterSection`s (packages/ui/src/components/filters/filter-section.tsx):
// open/closed (remembered across pages like `useSectionCollapse`), "Show N more" and the search text.
// What is selected lives in the page's URL search, not here.

/** `useSectionCollapse`'s storage: section key to open, shared by every sidebar. */
const STORAGE_KEY = "maple-filter-sections"
const Remembered = Schema.Record(Schema.String, Schema.Boolean)
const decodeRemembered = Schema.decodeUnknownOption(Schema.fromJsonString(Remembered))

export const SectionState = Schema.Struct({
	isOpen: Schema.Boolean,
	isShowingAll: Schema.Boolean,
	search: Schema.String,
})
export type SectionState = typeof SectionState.Type

export const Model = Schema.Struct({
	/** Remembered open state by section key; a key never toggled falls back to its default. */
	remembered: Remembered,
	sections: Schema.Record(Schema.String, SectionState),
})
export type Model = typeof Model.Type

/** A section's state; `defaultOpen` applies until the user toggles it on any page. */
export const sectionOf = (model: Model, key: string, defaultOpen = true): SectionState =>
	Option.getOrElse(Record.get(model.sections, key), () => ({
		isOpen: model.remembered[key] ?? defaultOpen,
		isShowingAll: false,
		search: "",
	}))


// MESSAGE

export const Message = defineMessageUnion({
	CompletedReadRemembered: { remembered: Remembered },
	ToggledSection: { key: Schema.String, defaultOpen: Schema.Boolean },
	ClickedShowMore: { key: Schema.String },
	ChangedSearch: { key: Schema.String, search: Schema.String },
	CompletedSaveRemembered: {},
})
export type Message = typeof Message.Type

const FilterSectionsDefinition = Block.makeDefinition("FilterSections", { Model, Message })

const FilterSectionsComposition = FilterSectionsDefinition.makeComposition()

// COMMAND

const readRemembered = () =>
	Option.getOrElse(Option.flatMap(readLocalStorage(STORAGE_KEY), decodeRemembered), () => ({}))

/** Read before the rail renders its sections, on page entry (the Block's init). */
export const ReadRemembered = FilterSectionsDefinition.makeCommand("ReadRememberedFilterSections", {
	messages: [Message.CompletedReadRemembered],
	handler: function* () {
		return () => Effect.sync(() => Message.CompletedReadRemembered({ remembered: readRemembered() }))
	},
})

export const SaveRemembered = FilterSectionsDefinition.makeCommand("SaveRememberedFilterSections", {
	args: { key: Schema.String, isOpen: Schema.Boolean },
	messages: [Message.CompletedSaveRemembered],
	handler: function* () {
		return ({ key, isOpen }) =>
			Effect.sync(() => {
				writeLocalStorage(STORAGE_KEY, JSON.stringify({ ...readRemembered(), [key]: isOpen }))
				return Message.CompletedSaveRemembered()
			})
	},
})

// INIT

const init = FilterSectionsComposition.makeInit(() => ({
	model: Model.make({ remembered: {}, sections: {} }),
	commands: [ReadRemembered()],
}))

// UPDATE

const write = (model: Model, key: string, next: SectionState): Model => ({
	...model,
	sections: Record.set(model.sections, key, next),
})

const update = FilterSectionsComposition.makeUpdate({
	CompletedReadRemembered: (model, { remembered }) => ({ model: { ...model, remembered } }),
	ToggledSection: (model, { key, defaultOpen }) => {
		const current = sectionOf(model, key, defaultOpen)
		const isOpen = !current.isOpen
		// Closing resets what it hid, like `handleOpenChange`.
		const next = isOpen ? { ...current, isOpen } : { isOpen, isShowingAll: false, search: "" }
		return {
			model: { ...write(model, key, next), remembered: { ...model.remembered, [key]: isOpen } },
			commands: [SaveRemembered({ key, isOpen })],
		}
	},
	ClickedShowMore: (model, { key }) => {
		const current = sectionOf(model, key)
		return { model: write(model, key, { ...current, isShowingAll: !current.isShowingAll }) }
	},
	ChangedSearch: (model, { key, search }) => ({
		model: write(model, key, { ...sectionOf(model, key), search, isShowingAll: false }),
	}),
	CompletedSaveRemembered: (model) => ({ model }),
})

// VIEW

/** What one section's markup needs from this Block: its state and the controls that change it. */
export type SectionRender = Readonly<{
	state: SectionState
	/** Spread onto the collapsible trigger. */
	toggle: ReadonlyArray<ChildAttribute>
	/** Spread onto the "Show N more" / "Show less" button. */
	showMore: ReadonlyArray<ChildAttribute>
	/** The section's search box, when `ViewInputs.search` asks for one. */
	searchInput: Html
}>

export type ViewInputs = Readonly<{
	key: string
	defaultOpen: boolean
	search?: Readonly<{ id: string; placeholder: string }>
	/** Runs in the embedding view, so the section's own rows dispatch the parent's Messages. */
	toView: (render: SectionRender) => Html
}>

const view = FilterSectionsComposition.makeView.withInputs<ViewInputs>((model, viewInputs, h) => {
	const { key, defaultOpen, search } = viewInputs
	const state = sectionOf(model, key, defaultOpen)
	return viewInputs.toView({
		state,
		toggle: childAttributes([h.OnClick(Message.ToggledSection({ key, defaultOpen }))]),
		showMore: childAttributes([h.OnClick(Message.ClickedShowMore({ key }))]),
		searchInput:
			search === undefined
				? null
				: searchInput(h, {
						id: search.id,
						size: "sm",
						className: "mb-2",
						placeholder: search.placeholder,
						value: state.search,
						onInput: (value) => Message.ChangedSearch({ key, search: value }),
						onClear: Message.ChangedSearch({ key, search: "" }),
					}),
	})
})

const prepare = () =>
	FilterSectionsComposition.prepareBlock({
		init,
		update,
		view,
		EffectsLayer: Layer.mergeAll(ReadRemembered.layer, SaveRemembered.layer),
	})
/** One per filter rail: bind it to the page's `sections` field and embed it once per section. */
export const FilterSectionsBlock: Block.FromAssemblyWithView<typeof Model, typeof prepare> = Block.assemble(prepare)
