import { Option, Result } from "effect"
import { Command } from "foldkit"
import { AppRoute, hrefOf } from "../../../route"
import type { DashboardsSearch } from "../../../route/search"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { isDashboardSortOption } from "../kit/summary"
import {
	CreateDashboard,
	DeleteDashboard,
	DuplicateDashboard,
	ExportDashboard,
	ImportDashboard,
	LoadPreferences,
	OpenImportPicker,
	ReadClock,
	SavePreferences,
	SaveTags,
	WaitSearchDebounce,
} from "./command"
import { normalizeTags, queryOf, splitTagInput } from "./derive"
import { Message } from "./message"
import type { ListDashboard, Model } from "./model"

export type Return = PageReturn<Model, Message>
type Search = typeof DashboardsSearch.Type
type Route = Readonly<{ search: Search }>

export const SORT_MENU_ID = "dashboards-sort-menu"
export const rowMenuIdOf = (id: string): string => `dashboard-row-menu-${id}`

export const init = (route: Route, _context: PageContext): Return => ({
	model: {
		search: route.search,
		dashboards: null,
		nowMs: null,
		favorites: [],
		storedSort: "updated",
		isPrefsLoaded: false,
		searchDraft: queryOf(route.search),
		searchGeneration: 0,
		sortMenu: Menu.init(SORT_MENU_ID),
		rowMenuId: null,
		rowMenu: Menu.init(rowMenuIdOf("none")),
		pendingDelete: null,
		deleteDialog: Dialog.init("dashboard-delete-dialog", "alert-dialog"),
		pendingTags: null,
		tagsDialog: Dialog.init("dashboard-tags-dialog", "dialog"),
		tagDrafts: [],
		tagInput: "",
		persistenceError: null,
		isCreating: false,
	},
	commands: [ReadClock(), LoadPreferences()],
})

/** `ToolbarSearch`'s resync: an outside change to `q` replaces the input, its own echo does not. */
export const routeChanged = (model: Model, route: Route): Return => {
	const query = queryOf(route.search)
	return {
		model: {
			...model,
			search: route.search,
			searchDraft: query === model.searchDraft.trim() ? model.searchDraft : query,
		},
	}
}

/** `navigate({ search: (prev) => ({ ...prev, [key]: value }), replace: true })`. */
const navigateSearch = (model: Model, patch: Partial<Search>, isReplace = true): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: hrefOf(AppRoute.Dashboards({ search: { ...model.search, ...patch } })),
		isReplace,
	}),
})

const navigateTo = (model: Model, url: string): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url, isReplace: false }),
})

const dashboardHref = (id: string, mode?: "edit") =>
	hrefOf(
		AppRoute.Dashboard({
			dashboardId: AppRoute.Dashboard.fields.dashboardId.make(id),
			search: mode === undefined ? {} : { mode },
		}),
	)

const isReadOnly = (model: Model): boolean => model.persistenceError !== null

const findDashboard = (model: Model, id: string): Option.Option<ListDashboard> =>
	Option.fromNullishOr((model.dashboards ?? []).find((dashboard) => dashboard.id === id))

const dialogStep = (
	model: Model,
	dialog: Dialog.Model,
	message: Dialog.Message,
	write: (dialog: Dialog.Model) => Partial<Model>,
	wrap: (message: Dialog.Message) => Message,
): Return => {
	const next = Dialog.update(dialog, message)
	return {
		model: { ...model, ...write(next.model) },
		commands: Command.mapMessages(next.commands ?? [], wrap),
	}
}

const openDialog = (dialog: Dialog.Model, wrap: (message: Dialog.Message) => Message) => {
	const next = Dialog.open(dialog)
	return { dialog: next.model, commands: Command.mapMessages(next.commands ?? [], wrap) }
}

const closeDialog = (dialog: Dialog.Model, wrap: (message: Dialog.Message) => Message) => {
	const next = Dialog.close(dialog)
	return { dialog: next.model, commands: Command.mapMessages(next.commands ?? [], wrap) }
}

const wrapDelete = (message: Dialog.Message) => Message.GotDeleteDialogMessage({ message })
const wrapTags = (message: Dialog.Message) => Message.GotTagsDialogMessage({ message })

/** A row menu item picked: export, duplicate, edit tags, delete. */
const rowAction = (model: Model, context: PageContext, rowId: string, value: string): Return =>
	Option.match(findDashboard(model, rowId), {
		onNone: () => ({ model }),
		onSome: (dashboard): Return => {
			switch (value) {
				case "export":
					return { model, commands: [ExportDashboard({ orgId: context.orgId, id: rowId })] }
				case "duplicate":
					return isReadOnly(model)
						? { model }
						: { model, commands: [DuplicateDashboard({ orgId: context.orgId, id: rowId })] }
				case "tags": {
					if (isReadOnly(model)) return { model }
					const opened = openDialog(model.tagsDialog, wrapTags)
					return {
						model: {
							...model,
							pendingTags: dashboard,
							tagsDialog: opened.dialog,
							tagDrafts: normalizeTags(dashboard.tags),
							tagInput: "",
						},
						commands: opened.commands,
					}
				}
				case "delete": {
					if (isReadOnly(model)) return { model }
					const opened = openDialog(model.deleteDialog, wrapDelete)
					return {
						model: { ...model, pendingDelete: dashboard, deleteDialog: opened.dialog },
						commands: opened.commands,
					}
				}
				default:
					return { model }
			}
		},
	})

/** One row's kebab menu; a message from a closed row's menu makes that row the active one. */
const rowMenuStep = (model: Model, context: PageContext, rowId: string, message: Menu.Message): Return => {
	const current = model.rowMenuId === rowId ? model.rowMenu : Menu.init(rowMenuIdOf(rowId))
	const next = Menu.update(current, message)
	const updated = { ...model, rowMenuId: rowId, rowMenu: next.model }
	const commands = Command.mapMessages(next.commands ?? [], (inner) =>
		Message.GotRowMenuMessage({ rowId, message: inner }),
	)
	if (next.outMessage === undefined || next.outMessage._tag !== "SelectedItem") {
		return { model: updated, commands }
	}
	const action = rowAction(updated, context, rowId, next.outMessage.value)
	return { ...action, commands: [...commands, ...(action.commands ?? [])] }
}

const sortMenuStep = (model: Model, message: Menu.Message): Return => {
	const next = Menu.update(model.sortMenu, message)
	const updated = { ...model, sortMenu: next.model }
	const commands = Command.mapMessages(next.commands ?? [], (inner) =>
		Message.GotSortMenuMessage({ message: inner }),
	)
	if (next.outMessage === undefined || next.outMessage._tag !== "SelectedRadio") {
		return { model: updated, commands }
	}
	const value = next.outMessage.value
	if (!isDashboardSortOption(value)) return { model: updated, commands }
	// The URL owns the active sort; localStorage remembers it as the next cold load's default.
	const navigation = navigateSearch({ ...updated, storedSort: value }, { sort: value })
	return {
		...navigation,
		commands: [...commands, SavePreferences({ favorites: null, sort: value })],
	}
}

/** The editor's pending input committed as tags (`commit`). */
const commitTagInput = (model: Model, value: string): Model => {
	const added = normalizeTags(splitTagInput(value))
	return added.length === 0
		? model
		: { ...model, tagDrafts: normalizeTags([...model.tagDrafts, ...added]), tagInput: "" }
}

const failedWrite = (model: Model, message: string): Return => ({
	model: { ...model, persistenceError: message, isCreating: false },
})

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedLoadPreferences: ({ favorites, sort }) => ({
			model: { ...model, favorites, storedSort: sort, isPrefsLoaded: true },
		}),
		UpdatedDashboards: ({ orgId, dashboards }) =>
			orgId === context.orgId ? { model: { ...model, dashboards } } : { model },
		ChangedSearchDraft: ({ value }) => {
			const searchGeneration = model.searchGeneration + 1
			return {
				model: { ...model, searchDraft: value, searchGeneration },
				commands: [WaitSearchDebounce({ generation: searchGeneration })],
			}
		},
		ElapsedSearchDebounce: ({ generation }) => {
			if (generation !== model.searchGeneration) return { model }
			const trimmed = model.searchDraft.trim()
			return trimmed === queryOf(model.search)
				? { model }
				: navigateSearch(model, { q: trimmed === "" ? undefined : trimmed })
		},
		ChangedScope: ({ scope }) => navigateSearch(model, { scope: scope === "all" ? undefined : scope }),
		ClickedClearSearch: () => navigateSearch({ ...model, searchDraft: "" }, { q: undefined }),
		ClickedShowAllTags: () => navigateSearch(model, { tags: undefined }),
		ClickedBrowseTemplates: () => navigateTo(model, hrefOf(AppRoute.DashboardsTemplates({ search: {} }))),
		ClickedCreate: () =>
			isReadOnly(model) || model.isCreating
				? { model }
				: {
						model: { ...model, isCreating: true },
						commands: [CreateDashboard({ orgId: context.orgId })],
					},
		CompletedCreateDashboard: ({ result }) =>
			Result.match(result, {
				onFailure: (error) => failedWrite(model, error),
				onSuccess: (id) => navigateTo({ ...model, isCreating: false }, dashboardHref(id, "edit")),
			}),
		ClickedImport: () => (isReadOnly(model) ? { model } : { model, commands: [OpenImportPicker()] }),
		CompletedOpenImportPicker: () => ({ model }),
		ChoseImportFile: ({ files }) => {
			const file = files[0]
			return file === undefined || isReadOnly(model)
				? { model }
				: { model, commands: [ImportDashboard({ orgId: context.orgId, file })] }
		},
		CompletedImportDashboard: ({ result }) =>
			Result.match(result, {
				onFailure: () => ({ model }),
				onSuccess: (id) => navigateTo(model, dashboardHref(id)),
			}),
		ToggledFavorite: ({ id }) => {
			const favorites = model.favorites.includes(id)
				? model.favorites.filter((favorite) => favorite !== id)
				: [...model.favorites, id]
			return {
				model: { ...model, favorites },
				commands: [SavePreferences({ favorites, sort: null })],
			}
		},
		CompletedSavePreferences: () => ({ model }),
		GotSortMenuMessage: ({ message: inner }) => sortMenuStep(model, inner),
		GotRowMenuMessage: ({ rowId, message: inner }) => rowMenuStep(model, context, rowId, inner),
		CompletedExportDashboard: () => ({ model }),
		CompletedDuplicateDashboard: ({ result }) =>
			Result.match(result, {
				// TODO(toast): legacy also toasts "Failed to duplicate dashboard".
				onFailure: (error) => failedWrite(model, error),
				onSuccess: (id) => navigateTo(model, dashboardHref(id)),
			}),
		GotDeleteDialogMessage: ({ message: inner }) =>
			dialogStep(model, model.deleteDialog, inner, (deleteDialog) => ({ deleteDialog }), wrapDelete),
		ClickedConfirmDelete: () => {
			const pending = model.pendingDelete
			const closed = closeDialog(model.deleteDialog, wrapDelete)
			const next = { ...model, deleteDialog: closed.dialog, pendingDelete: null }
			return pending === null || isReadOnly(model)
				? { model: next, commands: closed.commands }
				: {
						model: next,
						commands: [
							...closed.commands,
							DeleteDashboard({ orgId: context.orgId, id: pending.id }),
						],
					}
		},
		CompletedDeleteDashboard: ({ result }) =>
			Result.match(result, {
				onFailure: (error) => failedWrite(model, error),
				onSuccess: () => ({ model: { ...model, persistenceError: null } }),
			}),
		GotTagsDialogMessage: ({ message: inner }) =>
			dialogStep(model, model.tagsDialog, inner, (tagsDialog) => ({ tagsDialog }), wrapTags),
		ChangedTagInput: ({ value }) => ({ model: { ...model, tagInput: value } }),
		PressedTagInputKey: ({ key }) => {
			if (key === "Enter" || key === ",") return { model: commitTagInput(model, model.tagInput) }
			const last = model.tagDrafts[model.tagDrafts.length - 1]
			return key === "Backspace" && model.tagInput === "" && last !== undefined
				? { model: { ...model, tagDrafts: model.tagDrafts.filter((tag) => tag !== last) } }
				: { model }
		},
		ClickedAddTag: () => ({ model: commitTagInput(model, model.tagInput) }),
		ClickedRemoveTag: ({ tag }) => ({
			model: { ...model, tagDrafts: model.tagDrafts.filter((draft) => draft !== tag) },
		}),
		ClickedSuggestedTag: ({ tag }) => ({ model: commitTagInput(model, tag) }),
		ClickedSaveTags: () => {
			const pending = model.pendingTags
			const tags = normalizeTags([...model.tagDrafts, ...splitTagInput(model.tagInput)])
			const closed = closeDialog(model.tagsDialog, wrapTags)
			const next = { ...model, tagsDialog: closed.dialog, pendingTags: null }
			return pending === null || isReadOnly(model)
				? { model: next, commands: closed.commands }
				: {
						model: next,
						commands: [
							...closed.commands,
							SaveTags({ orgId: context.orgId, id: pending.id, tags }),
						],
					}
		},
		CompletedSaveTags: ({ result }) =>
			Result.match(result, {
				onFailure: (error) => failedWrite(model, error),
				onSuccess: () => ({ model: { ...model, persistenceError: null } }),
			}),
	})
