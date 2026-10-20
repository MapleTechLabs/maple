import { readLocalStorage, writeLocalStorage } from "@maple/ui/lib/local-storage"
import { Effect, Option, Record, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"

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

export const init = (): Model => ({ remembered: {}, sections: {} })

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

// COMMAND

/** Read before the rail renders its sections, on page entry. */
export const ReadRemembered = Command.define("ReadRememberedFilterSections", {
	messages: [Message.CompletedReadRemembered],
	execute: Effect.sync(() =>
		Message.CompletedReadRemembered({
			remembered: Option.getOrElse(
				Option.flatMap(readLocalStorage(STORAGE_KEY), decodeRemembered),
				() => ({}),
			),
		}),
	),
})

const SaveRemembered = Command.define("SaveRememberedFilterSections", {
	args: { key: Schema.String, isOpen: Schema.Boolean },
	messages: [Message.CompletedSaveRemembered],
	execute: ({ key, isOpen }) =>
		Effect.sync(() => {
			const current = Option.getOrElse(
				Option.flatMap(readLocalStorage(STORAGE_KEY), decodeRemembered),
				() => ({}),
			)
			writeLocalStorage(STORAGE_KEY, JSON.stringify({ ...current, [key]: isOpen }))
			return Message.CompletedSaveRemembered()
		}),
})

// UPDATE

const write = (model: Model, key: string, next: SectionState): Model => ({
	...model,
	sections: Record.set(model.sections, key, next),
})

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		CompletedReadRemembered: ({ remembered }) => ({ model: { ...model, remembered } }),
		ToggledSection: ({ key, defaultOpen }) => {
			const current = sectionOf(model, key, defaultOpen)
			const isOpen = !current.isOpen
			// Closing resets what it hid, like `handleOpenChange`.
			const next = isOpen ? { ...current, isOpen } : { isOpen, isShowingAll: false, search: "" }
			return {
				model: { ...write(model, key, next), remembered: { ...model.remembered, [key]: isOpen } },
				commands: [SaveRemembered({ key, isOpen })],
			}
		},
		ClickedShowMore: ({ key }) => {
			const current = sectionOf(model, key)
			return { model: write(model, key, { ...current, isShowingAll: !current.isShowingAll }) }
		},
		ChangedSearch: ({ key, search }) => ({
			model: write(model, key, { ...sectionOf(model, key), search, isShowingAll: false }),
		}),
		CompletedSaveRemembered: () => ({ model }),
	})
