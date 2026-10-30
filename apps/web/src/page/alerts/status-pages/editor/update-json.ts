import {
	hasStatusPageConfigChanges,
	normalizeStatusPageConfig,
	type StatusPageConfig,
	type V2StatusPage,
} from "@maple/domain/http/v2"
import { Option, Result } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import type { LoadFailure } from "../../../../data/load-failure"
import * as CopyButton from "../../../../ui/copy-button"
import type { PageContext } from "../../../contract"
import { ApplyConfig } from "./command"
import { type DraftResult, formatConfig, parseDraft } from "./config-json"
import { isSameSettings, settingsFormOf } from "./form"
import { Message } from "./message"
import type { Model } from "./model"
import {
	chain,
	pageOf,
	readComponents,
	readConfig,
	readIncidents,
	readPage,
	type Return,
	toast,
} from "./reads"
import { isSettingsDirty } from "./update-settings"

// The JSON tab: the page as one document, and an admin's edit of it applied in one write.

/** The saved page as `GET …/config` returned it, with every component and its version. */
export const currentConfigOf = (model: Model): Option.Option<StatusPageConfig> =>
	AsyncData.getData(model.config.data)

/** The draft parsed against the document it was opened from; none while not editing. */
export const draftOf = (model: Model): Option.Option<DraftResult> =>
	model.jsonDraft === null || model.jsonBase === null
		? Option.none()
		: Option.some(parseDraft(model.jsonDraft, model.jsonBase))

const hasChanges = (draft: DraftResult): boolean =>
	Result.match(draft, {
		onFailure: () => false,
		onSuccess: ({ changes }) => hasStatusPageConfigChanges(changes),
	})

/** Apply needs a valid draft that changes something, and no unsaved Settings edits to fight. */
export const canApply = (model: Model): boolean =>
	model.isAdmin &&
	!model.isApplyingJson &&
	!model.isSavingSettings &&
	!isSettingsDirty(model) &&
	Option.match(draftOf(model), { onNone: () => false, onSome: hasChanges })

const withCurrent = (model: Model, write: (text: string, base: StatusPageConfig) => Model): Return =>
	Option.match(currentConfigOf(model), {
		onNone: () => ({ model }),
		onSome: (current) => ({ model: write(formatConfig(current), current) }),
	})

/** Opens the editor on the saved document; Reset runs it again over the draft. */
export const editJson = (model: Model): Return =>
	model.isAdmin
		? withCurrent(model, (jsonDraft, jsonBase) => ({
				...model,
				jsonDraft,
				jsonBase,
				isRebasingJson: false,
				jsonFailure: null,
			}))
		: { model }

/** Ignored while an apply runs: its result replaces the draft, and would drop the keystrokes. */
export const changeJson = (model: Model, value: string): Return =>
	model.jsonDraft === null || model.isApplyingJson
		? { model }
		: { model: { ...model, jsonDraft: value, jsonFailure: null } }

export const cancelJson = (model: Model): Return =>
	model.isApplyingJson
		? { model }
		: { model: { ...model, jsonDraft: null, jsonBase: null, isRebasingJson: false, jsonFailure: null } }

export const applyJson = (model: Model): Return => {
	const pageId = model.pageId
	if (pageId === null || !canApply(model)) return { model }
	// The version the draft was opened from, not the newest read: a re-read must not hide someone else's edit.
	const ifVersion = model.jsonBase?.version
	return Option.match(draftOf(model), {
		onNone: () => ({ model }),
		onSome: (draft) =>
			Result.match(draft, {
				onFailure: () => ({ model }),
				onSuccess: ({ config }) => ({
					model: { ...model, isApplyingJson: true, jsonFailure: null },
					commands: [ApplyConfig({ pageId, config, ifVersion })],
				}),
			}),
	})
}

/** The loaded page with the applied document's settings, to compare Settings edits against. */
const pageWith = (page: V2StatusPage, applied: StatusPageConfig): V2StatusPage => {
	const config = normalizeStatusPageConfig(applied)
	return {
		...page,
		name: config.name,
		slug: config.slug,
		description: config.description,
		website_url: config.website_url,
		logo_url: config.logo_url,
		show_powered_by: config.show_powered_by,
		auto_incidents: config.auto_incidents,
		theme: config.theme,
	}
}

/**
 * Settings edits survive an apply when they are real edits: ones that match neither the page the
 * apply replaced nor the one it wrote were typed meanwhile, and are kept.
 */
const settingsAfterApply = (model: Model, applied: StatusPageConfig): Model["settingsEdits"] => {
	const edits = model.settingsEdits
	if (edits === null || !isSettingsDirty(model)) return null
	return Option.match(pageOf(model), {
		onNone: () => edits,
		onSome: (page) => (isSameSettings(edits, settingsFormOf(pageWith(page, applied))) ? null : edits),
	})
}

export const appliedJson = (
	model: Model,
	result: Result.Result<StatusPageConfig, LoadFailure>,
	context: PageContext,
): Return =>
	Result.match(result, {
		onSuccess: (applied): Return => ({
			// Deleted components take their incident links with them, so incidents re-read too.
			...chain(
				{
					...model,
					isApplyingJson: false,
					jsonDraft: null,
					jsonBase: null,
					isRebasingJson: false,
					settingsEdits: settingsAfterApply(model, applied),
				},
				readPage(context, "Supersede"),
				readComponents(context, "Supersede"),
				readIncidents(context, "Supersede"),
				readConfig(context, "Supersede"),
			),
			outMessage: toast("success", "Config applied", "It goes out with the next publish."),
		}),
		// A conflict means the page moved on: re-read it and rebase the draft onto it, keeping the text.
		onFailure: (jsonFailure): Return =>
			jsonFailure.code === "status_page_conflict"
				? chain(
						{ ...model, isApplyingJson: false, isRebasingJson: true, jsonFailure },
						readConfig(context, "Supersede"),
					)
				: { model: { ...model, isApplyingJson: false, jsonFailure } },
	})

/**
 * Once the re-read after a conflict lands, the draft is checked against the current page: the
 * summary shows what the next Apply would overwrite, and that Apply carries the current version.
 */
export const rebaseJsonDraft = (model: Model): Model =>
	model.isRebasingJson && model.jsonDraft !== null
		? Option.match(currentConfigOf(model), {
				onNone: () => model,
				onSome: (current) => ({
					...model,
					jsonBase: current,
					isRebasingJson: false,
					jsonFailure: null,
				}),
			})
		: model

export const updateJsonCopy = (model: Model, message: CopyButton.Message): Return => {
	const step = CopyButton.update(model.jsonCopy, message)
	return {
		model: { ...model, jsonCopy: step.model },
		commands: FoldkitCommand.mapMessages(step.commands ?? [], (child) =>
			Message.GotJsonCopyMessage({ message: child }),
		),
	}
}
