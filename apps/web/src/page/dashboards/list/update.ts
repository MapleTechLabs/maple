import { Option, Result } from "effect"
import { behindToast } from "../kit/store"
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
	FocusTagSearch,
	FetchDashboardsFallback,
} from "./command"
import { countLabel } from "@maple/ui/lib/format"
import * as TagEditor from "../kit/tag-editor"
import { displayName, queryOf, tagsOf } from "./derive"
import * as Combobox from "../../../ui/combobox"
import { INITIAL_LOCALE } from "../../kit/locale"
import { Message } from "./message"
import type { ListDashboard, Model } from "./model"

export type Return = PageReturn<Model, Message>
type Search = typeof DashboardsSearch.Type
type Route = Readonly<{ search: Search }>

export const SORT_MENU_ID = "dashboards-sort-menu"
export const TAG_FILTER_ID = "dashboards-tag-filter"
export const rowMenuIdOf = (id: string): string => `dashboard-row-menu-${id}`

export const init = (route: Route, _context: PageContext): Return => ({
	model: {
		search: route.search,
		dashboards: null,
		nowMs: null,
		locale: INITIAL_LOCALE,
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
		tagEditor: TagEditor.init("dashboard-tags-dialog"),
		tagFilter: Combobox.init(TAG_FILTER_ID, "multiple", { selected: tagsOf(route.search) }),
		persistenceError: null,
		isCreating: false,
		fallback: { _tag: "Idle" },
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
			tagFilter: { ...model.tagFilter, selected: tagsOf(route.search) },
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

/** Live rows win; the HTTP snapshot stands in only while the live list never answered. */
export const listedOf = (model: Model): ReadonlyArray<ListDashboard> | null =>
	model.dashboards ?? (model.fallback._tag === "Ready" ? model.fallback.dashboards : null)

/** `degraded`: reading the snapshot, so writes are off. */
export const isDegraded = (model: Model): boolean => model.dashboards === null && model.fallback._tag === "Ready"

/** `isError`: neither the live list nor the snapshot could be read. */
export const isLoadFailed = (model: Model): boolean => model.dashboards === null && model.fallback._tag === "Failed"

export const isReadOnly = (model: Model): boolean => model.persistenceError !== null || isDegraded(model)

/** `navigate(...)` then a success toast. */
const navigateWithToast = (model: Model, url: string, title: string): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url,
		isReplace: false,
		toast: { type: "success", title, description: "" },
	}),
})

/** `toastManager.add({ title: errorMessage(error), type: "error" })`. */
const toastFailure = (model: Model, message: string): Return => ({
	model,
	outMessage: PageOutMessage.RequestedToast({
		type: "error",
		title: message,
		description: "",
		timeoutMs: null,
		action: null,
	}),
})

const findDashboard = (model: Model, id: string): Option.Option<ListDashboard> =>
	Option.fromNullishOr((listedOf(model) ?? []).find((dashboard) => dashboard.id === id))

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
const wrapTags = (message: TagEditor.Message) => Message.GotTagEditorMessage({ message })

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
					const opened = TagEditor.open(
						model.tagEditor,
						displayName(dashboard.name),
						dashboard.tags,
					)
					return {
						model: { ...model, pendingTags: dashboard, tagEditor: opened.model },
						commands: Command.mapMessages(opened.commands ?? [], wrapTags),
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

/** "Imported with N warnings": the first three, then "+N more". */
type WarningToast = Readonly<{ type: "warning"; title: string; description: string }>

const warningsToast = (warnings: ReadonlyArray<string>): WarningToast => ({
	type: "warning",
	title: `Imported with ${countLabel(warnings.length, "warning")}`,
	description: `${warnings.slice(0, 3).join("\n")}${warnings.length > 3 ? `\n+${warnings.length - 3} more` : ""}`,
})

/** The editor's pending input committed as tags (`commit`). */
const failedWrite = (model: Model, message: string): Return => ({
	model: { ...model, persistenceError: message, isCreating: false },
})

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedReadClock: ({ nowMs, locale }) => ({ model: { ...model, nowMs, locale } }),
		CompletedLoadPreferences: ({ favorites, sort }) => ({
			model: { ...model, favorites, storedSort: sort, isPrefsLoaded: true },
		}),
		UpdatedDashboards: ({ orgId, dashboards }) =>
			orgId === context.orgId ? { model: { ...model, dashboards } } : { model },
		// `handleCollectionStuck` recreates the collections while the snapshot loads.
		TimedOutLiveDashboards: ({ orgId }) =>
			orgId !== context.orgId || model.dashboards !== null || model.fallback._tag !== "Idle"
				? { model }
				: {
						model: { ...model, fallback: { _tag: "Loading" } },
						commands: [FetchDashboardsFallback({ orgId })],
						outMessage: PageOutMessage.RequestedReconnectOrgCollections(),
					},
		CompletedFetchFallback: ({ orgId, result }) =>
			orgId !== context.orgId
				? { model }
				: {
						model: {
							...model,
							fallback: Result.match(result, {
								onSuccess: (dashboards) => ({ _tag: "Ready", dashboards }),
								onFailure: () => ({ _tag: "Failed" }),
							}),
						},
					},
		// `retryOrgCollections`: a failed snapshot may be read again after the reconnect.
		ClickedRetrySync: () => ({
			model: model.fallback._tag === "Failed" ? { ...model, fallback: { _tag: "Idle" } } : model,
			outMessage: PageOutMessage.RequestedReconnectOrgCollections(),
		}),
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
				onFailure: (error) => toastFailure(failedWrite(model, error).model, error),
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
				onFailure: (error) => toastFailure(model, error),
				onSuccess: (created) => {
					const navigation = navigateWithToast(
						model,
						dashboardHref(created.id),
						created.isPerses
							? `Dashboard "${created.name}" imported from Perses`
							: `Dashboard "${created.name}" imported`,
					)
					const out = navigation.outMessage
					return created.warnings.length === 0 || out?._tag !== "RequestedNavigation"
						? navigation
						: { ...navigation, outMessage: { ...out, followUpToast: warningsToast(created.warnings) } }
				},
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
				onFailure: (error) => toastFailure(failedWrite(model, error).model, error),
				onSuccess: (created) =>
					navigateWithToast(model, dashboardHref(created.id), `Duplicated as "${created.name}"`),
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
				onSuccess: (sync) =>
					sync === "Behind" ? { model, outMessage: behindToast() } : { model: { ...model, persistenceError: null } },
			}),
		GotTagEditorMessage: ({ message: inner }) => {
			const next = TagEditor.update(model.tagEditor, inner)
			const commands = Command.mapMessages(next.commands ?? [], wrapTags)
			const updated = { ...model, tagEditor: next.model }
			if (next.outMessage === undefined) return { model: updated, commands }
			const pending = model.pendingTags
			const saved = { ...updated, pendingTags: null }
			return pending === null || isReadOnly(model)
				? { model: saved, commands }
				: {
						model: saved,
						commands: [
							...commands,
							SaveTags({ orgId: context.orgId, id: pending.id, tags: next.outMessage.tags }),
						],
					}
		},
		CompletedSaveTags: ({ result }) =>
			Result.match(result, {
				onFailure: (error) => failedWrite(model, error),
				onSuccess: (sync) =>
					sync === "Behind" ? { model, outMessage: behindToast() } : { model: { ...model, persistenceError: null } },
			}),
		GotTagFilterMessage: ({ message: inner }) => {
			const next = Combobox.update(model.tagFilter, inner)
			const commands = Command.mapMessages(next.commands ?? [], (message) =>
				Message.GotTagFilterMessage({ message }),
			)
			if (next.outMessage?._tag !== "ChangedSelection") return { model: { ...model, tagFilter: next.model }, commands }
			const tags = next.outMessage.selected
			// The pick re-renders the list under the popup: nothing stays highlighted; the search keeps focus.
			const updated = { ...model, tagFilter: { ...next.model, highlighted: null } }
			const refocus = inner._tag === "ClickedItem" ? [FocusTagSearch({ id: Combobox.inputId(TAG_FILTER_ID) })] : []
			return { ...navigateSearch(updated, { tags: tags.length === 0 ? undefined : tags }), commands: [...commands, ...refocus] }
		},
		CompletedFocusTagSearch: () => ({ model }),
	})
