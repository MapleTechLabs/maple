import { pickDashboardControlParams } from "../../../lib/dashboard-controls/search-params"
import {
	type SectionViewSearch,
	withActiveTab,
	withSectionCollapsed,
} from "../../../lib/dashboards/section-view-state"
import { Command } from "foldkit"
import { AppRoute, hrefOf } from "../../../route"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { EditSections } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { isEditing } from "./mode"
import { menuStep } from "./menu-step"
import { SectionEdit } from "./section-edit"

// The groups' interactions (`DashboardSectionView`, `SectionTabBar`, `InlineEditableText`): view state
// rides the URL with `replace`; every structural change is one `EditSections` write.

type Return = PageReturn<Model, Message>
type SectionMessage = Extract<
	Message,
	{
		readonly _tag:
			| "ClickedSectionChevron"
			| "ClickedSectionTab"
			| "ClickedAddSectionWidget"
			| "GotSectionMenuMessage"
			| "StartedRename"
			| "ChangedRenameDraft"
			| "SubmittedRename"
			| "CancelledRename"
			| "ClickedAddTab"
			| "ClickedDeleteTab"
			| "GotSectionDialogMessage"
			| "GotTabDialogMessage"
			| "ConfirmedDeleteSection"
			| "ConfirmedDeleteTab"
	}
>

export const sectionMenuIdOf = (sectionId: string): string => `dashboard-section-menu-${sectionId}`

/**
 * `applySectionView`: the update applied to the picked controls, `mode` kept as the URL had it.
 * A previewed version's groups are browsed locally (`PreviewedCanvas`), never in the URL.
 */
const applySectionView = (model: Model, update: (search: SectionViewSearch) => SectionViewSearch): Return => {
	if (model.history.previewed !== null)
		return { model: { ...model, history: { ...model.history, sectionView: update(model.history.sectionView) } } }
	const { collapsed, expanded, tab, widget, ...rest } = pickDashboardControlParams(model.search)
	// The update may drop a key (an emptied list); only what it hands back is written.
	const controls = { ...rest, ...update({ collapsed, expanded, tab, widget }) }
	const search = model.search.mode === "edit" ? { ...controls, mode: "edit" as const } : controls
	return {
		model,
		outMessage: PageOutMessage.RequestedNavigation({
			url: hrefOf(
				AppRoute.Dashboard({
					dashboardId: AppRoute.Dashboard.fields.dashboardId.make(model.dashboardId),
					search,
				}),
			),
			isReplace: true,
		}),
	}
}

const write = (model: Model, context: PageContext, edit: SectionEdit): Return =>
	model.persistenceError !== null
		? { model }
		: { model, commands: [EditSections({ orgId: context.orgId, dashboardId: model.dashboardId, edit })] }

const sectionsOf = (model: Model) => model.document?.sections ?? []

const openDialog = (
	model: Model,
	dialog: "sectionDialog" | "tabDialog",
	wrap: (message: Dialog.Message) => Message,
	patch: Partial<Model>,
): Return => {
	const next = Dialog.open(model[dialog])
	return {
		model: { ...model, ...patch, [dialog]: next.model },
		commands: Command.mapMessages(next.commands ?? [], wrap),
	}
}

const wrapSectionDialog = (message: Dialog.Message) => Message.GotSectionDialogMessage({ message })
const wrapTabDialog = (message: Dialog.Message) => Message.GotTabDialogMessage({ message })

const closeDialog = (
	model: Model,
	dialog: "sectionDialog" | "tabDialog",
	wrap: (message: Dialog.Message) => Message,
): Return => {
	const next = Dialog.close(model[dialog])
	return { model: { ...model, [dialog]: next.model }, commands: Command.mapMessages(next.commands ?? [], wrap) }
}

/** The group options menu: add tab, move up or down, the collapse defaults, delete. */
const sectionAction = (model: Model, context: PageContext, sectionId: string, value: string): Return => {
	const sections = sectionsOf(model)
	const index = sections.findIndex((section) => section.id === sectionId)
	const section = sections[index]
	if (section === undefined) return { model }
	switch (value) {
		case "add-tab":
			return write(model, context, SectionEdit.AddTab({ sectionId }))
		case "move-up":
			return write(model, context, SectionEdit.ReorderSections({ fromIndex: index, toIndex: index - 1 }))
		case "move-down":
			return write(model, context, SectionEdit.ReorderSections({ fromIndex: index, toIndex: index + 1 }))
		case "collapsed-default":
			return write(
				model,
				context,
				SectionEdit.SetCollapsedDefault({ sectionId, collapsed: !(section.collapsed ?? false) }),
			)
		case "collapsible":
			return write(
				model,
				context,
				SectionEdit.SetCollapsible({ sectionId, collapsible: section.collapsible === false }),
			)
		case "delete":
			return openDialog(model, "sectionDialog", wrapSectionDialog, { pendingSectionDelete: sectionId })
		default:
			return { model }
	}
}

/** `commit`: a trimmed, changed title is saved; an empty one is discarded. */
const submitRename = (model: Model, context: PageContext): Return => {
	const rename = model.rename
	const closed = { ...model, rename: null }
	if (rename === null) return { model: closed }
	const section = sectionsOf(model).find((candidate) => candidate.id === rename.sectionId)
	const current =
		rename.tabId === null ? section?.title : section?.tabs.find((tab) => tab.id === rename.tabId)?.title
	const title = rename.draft.trim()
	if (title === "" || title === current) return { model: closed }
	return write(
		closed,
		context,
		rename.tabId === null
			? SectionEdit.RenameSection({ sectionId: rename.sectionId, title })
			: SectionEdit.RenameTab({ sectionId: rename.sectionId, tabId: rename.tabId, title }),
	)
}

const startRename = (model: Model, sectionId: string, tabId: string | null): Return => {
	if (!isEditing(model) || model.persistenceError !== null) return { model }
	const section = sectionsOf(model).find((candidate) => candidate.id === sectionId)
	const title = tabId === null ? section?.title : section?.tabs.find((tab) => tab.id === tabId)?.title
	return title === undefined ? { model } : { model: { ...model, rename: { sectionId, tabId, draft: title } } }
}

export const sectionStep = (model: Model, context: PageContext, message: SectionMessage): Return => {
	switch (message._tag) {
		case "ClickedSectionChevron":
			return applySectionView(model, (search) =>
				withSectionCollapsed(search, message.sectionId, message.collapsed),
			)
		case "ClickedSectionTab":
			return applySectionView(model, (search) => withActiveTab(search, message.sectionId, message.tabId))
		case "ClickedAddSectionWidget": {
			const next = Dialog.open(model.pickerDialog)
			return {
				model: {
					...model,
					pickerDialog: next.model,
					pickerTarget: { sectionId: message.sectionId, tabId: message.tabId },
				},
				commands: Command.mapMessages(next.commands ?? [], (dialog) =>
					Message.GotPickerDialogMessage({ message: dialog }),
				),
			}
		}
		case "GotSectionMenuMessage": {
			const current =
				model.sectionMenuId === message.sectionId ? model.sectionMenu : Menu.init(sectionMenuIdOf(message.sectionId))
			const next = menuStep(current, message.message, (menu) =>
				Message.GotSectionMenuMessage({ sectionId: message.sectionId, message: menu }),
			)
			const updated = { ...model, sectionMenuId: message.sectionId, sectionMenu: next.model }
			if (next.picked._tag === "None") return { model: updated, commands: next.commands }
			const action = sectionAction(updated, context, message.sectionId, next.picked.value)
			return { ...action, commands: [...next.commands, ...(action.commands ?? [])] }
		}
		case "StartedRename":
			return startRename(model, message.sectionId, message.tabId)
		case "ChangedRenameDraft":
			return model.rename === null ? { model } : { model: { ...model, rename: { ...model.rename, draft: message.value } } }
		case "SubmittedRename":
			return submitRename(model, context)
		case "CancelledRename":
			return { model: { ...model, rename: null } }
		case "ClickedAddTab":
			return write(model, context, SectionEdit.AddTab({ sectionId: message.sectionId }))
		case "ClickedDeleteTab":
			return openDialog(model, "tabDialog", wrapTabDialog, {
				pendingTabDelete: { sectionId: message.sectionId, tabId: message.tabId },
			})
		case "GotSectionDialogMessage": {
			const next = Dialog.update(model.sectionDialog, message.message)
			return {
				model: { ...model, sectionDialog: next.model },
				commands: Command.mapMessages(next.commands ?? [], wrapSectionDialog),
			}
		}
		case "GotTabDialogMessage": {
			const next = Dialog.update(model.tabDialog, message.message)
			return {
				model: { ...model, tabDialog: next.model },
				commands: Command.mapMessages(next.commands ?? [], wrapTabDialog),
			}
		}
		case "ConfirmedDeleteSection": {
			const sectionId = model.pendingSectionDelete
			const closed = closeDialog(model, "sectionDialog", wrapSectionDialog)
			if (sectionId === null) return closed
			const written = write(closed.model, context, SectionEdit.DeleteSection({ sectionId, action: message.action }))
			const removed =
				message.action === "delete"
					? (model.document?.widgets ?? []).filter((widget) => widget.sectionId === sectionId)
					: []
			return {
				...written,
				commands: [...(closed.commands ?? []), ...(written.commands ?? [])],
				...(removed.length === 0 || written.commands === undefined
					? undefined
					: {
							outMessage: PageOutMessage.RequestedToast({
								type: "default",
								title: `Group and ${removed.length === 1 ? "its widget" : `${removed.length} widgets`} deleted`,
								description: "",
								timeoutMs: 6000,
								action: null,
								rootAction: {
									label: "Undo",
									action: {
										_tag: "RestoreDashboardWidgets",
										orgId: context.orgId,
										dashboardId: model.dashboardId,
										widgets: removed,
									},
								},
							}),
						}),
			}
		}
		case "ConfirmedDeleteTab": {
			const pending = model.pendingTabDelete
			const closed = closeDialog(model, "tabDialog", wrapTabDialog)
			if (pending === null) return closed
			const written = write(closed.model, context, SectionEdit.DeleteTab({ ...pending, action: message.action }))
			return { ...written, commands: [...(closed.commands ?? []), ...(written.commands ?? [])] }
		}
	}
}
