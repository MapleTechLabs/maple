import type { StatusPageConfig } from "@maple/domain/http/v2"
import { Option, Result } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import type { LoadFailure } from "../../../../data/load-failure"
import * as CopyButton from "../../../../ui/copy-button"
import type { PageContext } from "../../../contract"
import { ApplyConfig } from "./command"
import { configOf, type DraftResult, formatConfig, parseDraft } from "./config-json"
import { Message } from "./message"
import type { Model } from "./model"
import { chain, componentsOf, pageOf, readComponents, readPage, type Return, toast } from "./reads"
import { isSettingsDirty } from "./update-settings"

// The JSON tab: the page as one document, and an admin's edit of it applied in one write.

/** The saved page as its config, once the page and its components are in. */
export const currentConfigOf = (model: Model): Option.Option<StatusPageConfig> =>
	AsyncData.hasData(model.components.data)
		? Option.map(pageOf(model), (page) => configOf(page, componentsOf(model)))
		: Option.none()

/** The draft parsed against the saved page; none while not editing. */
export const draftOf = (model: Model): Option.Option<DraftResult> =>
	model.jsonDraft === null
		? Option.none()
		: Option.map(currentConfigOf(model), (current) => parseDraft(model.jsonDraft ?? "", current))

const hasChanges = (draft: DraftResult): boolean =>
	Result.match(draft, {
		onFailure: () => false,
		onSuccess: ({ changes }) =>
			changes.fields.length > 0 ||
			changes.created.length > 0 ||
			changes.updated.length > 0 ||
			changes.deleted.length > 0 ||
			changes.reordered,
	})

/** Apply needs a valid draft that changes something, and no unsaved Settings edits to fight. */
export const canApply = (model: Model): boolean =>
	model.isAdmin &&
	!model.isApplyingJson &&
	!isSettingsDirty(model) &&
	Option.match(draftOf(model), { onNone: () => false, onSome: hasChanges })

const withCurrent = (model: Model, write: (text: string) => Model): Return =>
	Option.match(currentConfigOf(model), {
		onNone: () => ({ model }),
		onSome: (current) => ({ model: write(formatConfig(current)) }),
	})

/** Opens the editor on the saved document; Reset runs it again over the draft. */
export const editJson = (model: Model): Return =>
	model.isAdmin
		? withCurrent(model, (jsonDraft) => ({ ...model, jsonDraft, jsonFailure: null }))
		: { model }

export const changeJson = (model: Model, value: string): Return =>
	model.jsonDraft === null ? { model } : { model: { ...model, jsonDraft: value, jsonFailure: null } }

export const cancelJson = (model: Model): Return =>
	model.isApplyingJson ? { model } : { model: { ...model, jsonDraft: null, jsonFailure: null } }

export const applyJson = (model: Model): Return => {
	const pageId = model.pageId
	if (pageId === null || !canApply(model)) return { model }
	return Option.match(draftOf(model), {
		onNone: () => ({ model }),
		onSome: (draft) =>
			Result.match(draft, {
				onFailure: () => ({ model }),
				onSuccess: ({ config }) => ({
					model: { ...model, isApplyingJson: true, jsonFailure: null },
					commands: [ApplyConfig({ pageId, config })],
				}),
			}),
	})
}

export const appliedJson = (
	model: Model,
	result: Result.Result<StatusPageConfig, LoadFailure>,
	context: PageContext,
): Return =>
	Result.match(result, {
		onSuccess: (): Return => ({
			...chain(
				{ ...model, isApplyingJson: false, jsonDraft: null, settingsEdits: null },
				readPage(context, "Supersede"),
				readComponents(context, "Supersede"),
			),
			outMessage: toast("success", "Config applied", "It goes out with the next publish."),
		}),
		onFailure: (jsonFailure): Return => ({ model: { ...model, isApplyingJson: false, jsonFailure } }),
	})

export const updateJsonCopy = (model: Model, message: CopyButton.Message): Return => {
	const step = CopyButton.update(model.jsonCopy, message)
	return {
		model: { ...model, jsonCopy: step.model },
		commands: FoldkitCommand.mapMessages(step.commands ?? [], (child) =>
			Message.GotJsonCopyMessage({ message: child }),
		),
	}
}
