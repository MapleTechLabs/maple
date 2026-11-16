import type { StatusPagePreviewParams } from "@maple/domain/http/v2"
import { STATUS_PAGE_PRESET_DEFAULTS } from "@maple/domain/status-page"
import { Option, Result, Array as Arr } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import * as Keyed from "@maple/views/data/keyed"
import type { AppRoute } from "../../../route"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import { type PageContext, PageOutMessage } from "../../contract"
import type { StatusPageSearch } from "../../../route/search"
import {
	pageIdFromUrl,
	SETTINGS_SECTIONS,
	type SettingsSection,
	STATUS_PAGE_BASE_URL,
	statusPageHref,
} from "../shared/commands"
import { emptyComponentForm, emptyIncidentForm } from "../shared/form"
import { emptyPicker } from "../shared/picker"
import { historyFrom } from "../shared/preview"
import {
	FetchEditorPreview,
	FetchEditorSession,
	FocusEditorElement,
	ReadEditorClock,
	WaitEditorPreview,
} from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import {
	chain,
	componentsOf,
	incidentsOf,
	pageOf,
	readComponents,
	readConfig,
	readIncidents,
	readMonitors,
	readPage,
	type Return,
} from "./reads"
import {
	addedComponents,
	addMonitorCreated,
	addPickerStep,
	askDeleteComponent,
	changeComponent,
	commitComponent,
	componentRowId,
	confirmDeleteComponent,
	deleteComponentDialog,
	deletedComponent,
	moveComponent,
	openAdd,
	reordered,
	savedComponent,
	selectComponent,
	submitAdd,
} from "./update-components"
import {
	askDeleteIncident,
	backToIncidentWrite,
	backToUpdateWrite,
	changeIncident,
	changeIncidentEdit,
	changeIncidentKind,
	changeUpdate,
	composeDialog,
	confirmDeleteIncident,
	createdIncident,
	deletedIncident,
	deleteIncidentDialog,
	editIncidentDialog,
	openComposer,
	openIncidentEdit,
	openUpdate,
	postedUpdate,
	publishedIncident,
	publishIncident,
	reviewIncident,
	reviewUpdate,
	savedIncident,
	selectIncident,
	submitIncident,
	submitIncidentEdit,
	submitUpdate,
	toggleIncidentComponent,
	toggleIncidentEditComponent,
	updateDialog,
} from "./update-incidents"
import {
	askBreakGlass,
	breakGlassDialog,
	changeSetting,
	confirmDeletePage,
	deletedPage,
	deletePageDialog,
	published,
	publish,
	revoked,
	rotated,
	runBreakGlass,
	savedSettings,
	saveSettings,
	togglePoweredBy,
	changeTheme,
	updateTokenCopy,
} from "./update-settings"
import {
	cancelPassword,
	changedAccess,
	changePassword,
	openPassword,
	pickVisibility,
	removePassword,
	submitPassword,
} from "./update-access"
import {
	appliedJson,
	applyJson,
	cancelJson,
	changeJson,
	editJson,
	rebaseJsonDraft,
	updateJsonCopy,
} from "./update-json"
import {
	changeCustomDomain,
	checkCustomDomain,
	checkedCustomDomain,
	confirmRemoveCustomDomain,
	readCustomDomain,
	removeCustomDomainDialog,
	removedCustomDomain,
	savedCustomDomain,
	submitCustomDomain,
	updateDnsCopy,
} from "./update-domain"
import { acceptGrants } from "../../kit/session-grants"

type EditorRoute = Extract<AppRoute, { readonly _tag: "StatusPage" }>

/** The editor's tabs: the live page, incidents, maintenance, settings, and the just-published screen. */
export type EditorTab = "page" | "incidents" | "maintenance" | "settings" | "live"

export type EditorLocation = Readonly<{ tab: EditorTab; section: SettingsSection }>

const isSection = (value: string | undefined): value is SettingsSection =>
	Arr.some(SETTINGS_SECTIONS, (section) => section === value)

/**
 * Where the search points; anything unknown is the live page, so an old or mistyped link lands.
 * The old Appearance and JSON tabs are Settings sections now.
 */
export const resolveView = (search: typeof StatusPageSearch.Type): EditorLocation => {
	const section = isSection(search.section) ? search.section : "basic"
	switch (search.view) {
		case "incidents":
		case "maintenance":
		case "settings":
		case "live":
			return { tab: search.view, section }
		case "appearance":
			return { tab: "settings", section: "appearance" }
		case "json":
			return { tab: "settings", section: "advanced" }
		default:
			return { tab: "page", section }
	}
}

/** Whether the tab shows what is open: a component under Monitors, an incident under its tab. */
const showsPanel = (panel: Model["panel"], location: EditorLocation): boolean => {
	if (panel === null) return false
	switch (panel._tag) {
		case "Component":
		case "Add":
			return location.tab === "settings" && location.section === "monitors"
		case "Incident":
			return location.tab === "incidents" || location.tab === "maintenance"
	}
}

export const PAGE_MENU_ID = "status-page-menu"

export const init = (route: EditorRoute, context: PageContext): Return => {
	const model: Model = {
		search: route.search,
		rawPageId: route.pageId,
		pageId: Option.getOrNull(pageIdFromUrl(route.pageId)),
		nowMs: null,
		revealComponentId: null,
		page: Keyed.idle(),
		components: Keyed.idle(),
		incidents: Keyed.idle(),
		config: Keyed.idle(),
		monitors: Keyed.idle(),
		grants: [],
		isSessionLoaded: false,
		pageMenu: Menu.init(PAGE_MENU_ID),
		panel: null,
		panelSheet: Dialog.init("status-page-panel", "sheet"),
		sheetPanel: null,
		sheetIncident: null,
		previewScheme: "light",
		previewWidth: "desktop",
		previewState: "live",
		previewGeneration: 0,
		previewShown: 0,
		previewHistory: [],
		componentForm: emptyComponentForm,
		componentSave: null,
		queuedComponentForms: [],
		confirmDeleteComponentId: null,
		deleteComponentDialog: Dialog.init("status-page-delete-component", "alert-dialog"),
		isDeletingComponent: false,
		isReordering: false,
		addPicker: emptyPicker,
		isAddingComponents: false,
		addSession: 0,
		composeDialog: Dialog.init("status-page-compose", "dialog"),
		composeStep: "write",
		incidentForm: emptyIncidentForm("incident"),
		isCreatingIncident: false,
		incidentFailure: null,
		updateDialog: Dialog.init("status-page-update", "dialog"),
		updateForm: { _tag: "Closed" },
		publishingIncidentIds: [],
		editIncidentDialog: Dialog.init("status-page-edit-incident", "dialog"),
		incidentEdit: null,
		isSavingIncident: false,
		incidentEditFailure: null,
		confirmDeleteIncidentId: null,
		deleteIncidentDialog: Dialog.init("status-page-delete-incident", "alert-dialog"),
		isDeletingIncident: false,
		publicBaseUrl: STATUS_PAGE_BASE_URL,
		urlCopy: CopyButton.init(),
		settingsEdits: null,
		isSavingSettings: false,
		settingsFailure: null,
		isPublishing: false,
		breakGlassDialog: Dialog.init("status-page-break-glass", "alert-dialog"),
		breakGlassAction: null,
		isChangingBreakGlass: false,
		revealedToken: null,
		tokenCopy: CopyButton.init(),
		deletePageDialog: Dialog.init("status-page-delete", "alert-dialog"),
		isDeletingPage: false,
		accessAction: null,
		passwordDraft: null,
		accessFailure: null,
		customDomain: Keyed.idle(),
		customDomainDraft: null,
		customDomainAction: null,
		customDomainFailure: null,
		removeCustomDomainDialog: Dialog.init("status-page-remove-custom-domain", "alert-dialog"),
		dnsCopy: CopyButton.init(),
		dnsCopyKey: null,
		jsonEdit: null,
		isApplyingJson: false,
		jsonFailure: null,
		jsonCopy: CopyButton.init(),
	}
	const reads = chain(
		model,
		readPage(context, "Load"),
		readComponents(context, "Load"),
		readIncidents(context, "Load"),
		readMonitors(context, "Load"),
		readCustomDomain(context, "Load"),
		whenJson(context, "Load"),
	)
	return {
		model: reads.model,
		commands: [
			ReadEditorClock(),
			FetchEditorSession({ orgId: context.orgId }),
			...(reads.commands ?? []),
		],
	}
}

/** The config read, only while Advanced (the JSON editor) is open: the document must be current when edited. */
const whenJson =
	(context: PageContext, mode: Keyed.ReadMode) =>
	(model: Model): Return => {
		const location = resolveView(model.search)
		return location.tab === "settings" && location.section === "advanced"
			? readConfig(context, mode)(model)
			: { model }
	}

/** The custom domain moves on the server's schedule: opening Settings shows where it is now. */
const whenSettings =
	(context: PageContext, mode: Keyed.ReadMode) =>
	(model: Model): Return =>
		resolveView(model.search).tab === "settings" ? readCustomDomain(context, mode)(model) : { model }

/**
 * A tab switch is a search change; what is open stays open only where the new tab shows it.
 * Opening Advanced re-reads the config, since other sections write too.
 */
export const routeChanged = (model: Model, route: EditorRoute, context: PageContext): Return =>
	withSheet(
		chain(
			{ ...model, search: route.search },
			// A route change can skip the field's blur (a keyboard Back): typed edits save first.
			(next) =>
				showsPanel(next.panel, resolveView(route.search))
					? { model: next }
					: chain(next, commitComponent, (committed) => ({
							model: { ...committed, panel: null, componentForm: emptyComponentForm },
						})),
			whenJson(context, "Refresh"),
			whenSettings(context, "Refresh"),
		),
	)

/** The dialogs ignore dismissal while their write is in flight, as `ConfirmDialog` does. */
const whenIdle = (isBusy: boolean, model: Model, run: () => Return): Return => (isBusy ? { model } : run())

// PREVIEW

/** The saved page as the preview endpoint takes it: only the monitors' history comes back used. */
export const previewDraftOf = (model: Model): Option.Option<StatusPagePreviewParams> =>
	Option.map(pageOf(model), (page) => ({
		name: page.name,
		slug: page.slug,
		components: Arr.map(componentsOf(model), (component) => ({
			name: component.name,
			group: component.group,
			monitor_id: component.monitor_id,
			manual_status: component.manual_status,
			show_uptime: component.show_uptime,
		})),
	}))

const schedulePreview = (model: Model): Return => {
	const generation = model.previewGeneration + 1
	return {
		model: { ...model, previewGeneration: generation },
		commands: [WaitEditorPreview({ generation })],
	}
}

// PANEL

/** Closing a component hands focus back to its row; the sheet hands it back on its own. */
const closePanel = (model: Model): Return => {
	const panel = model.panel
	if (panel === null) return { model }
	return panel._tag === "Component"
		? {
				model: { ...model, panel: null, componentForm: emptyComponentForm },
				commands: [FocusEditorElement({ id: componentRowId(panel.componentId) })],
			}
		: { model: { ...model, panel: null } }
}

const sheetCommands = (step: ReturnType<typeof Dialog.update>) =>
	FoldkitCommand.mapMessages(step.commands ?? [], (message) => Message.GotPanelSheetMessage({ message }))

/** The open incident as listed, else the one the sheet last showed. */
const shownIncident = (model: Model): Model["sheetIncident"] => {
	const panel = model.panel
	if (panel?._tag !== "Incident") return model.sheetIncident
	return Option.getOrElse(
		Arr.findFirst(incidentsOf(model), (row) => row.id === panel.incidentId),
		() => model.sheetIncident,
	)
}

/**
 * Opens the sheet while an incident or Add is open and closes it otherwise, whatever opened them.
 * The sheet keeps showing the last of them, the incident as last listed, while it animates out.
 */
const withSheet = (result: Return): Return => {
	const isWanted = result.model.panel !== null && result.model.panel._tag !== "Component"
	const model = {
		...result.model,
		sheetPanel: isWanted ? result.model.panel : result.model.sheetPanel,
		sheetIncident: shownIncident(result.model),
	}
	if (isWanted === model.panelSheet.isOpen) return { ...result, model }
	const step = isWanted ? Dialog.open(model.panelSheet) : Dialog.close(model.panelSheet)
	return {
		...result,
		model: { ...model, panelSheet: step.model },
		commands: [...(result.commands ?? []), ...sheetCommands(step)],
	}
}

/** The sheet closed itself (Escape, backdrop, close button): what it showed closes with it. */
const updatePanelSheet = (model: Model, message: Dialog.Message): Return => {
	const step = Dialog.update(model.panelSheet, message)
	return {
		model: {
			...model,
			panelSheet: step.model,
			panel: step.outMessage?._tag === "Closed" ? null : model.panel,
		},
		commands: sheetCommands(step),
	}
}

/** A click in the live page opens what it landed on where it is edited. */
const selectFromPreview = (model: Model, kind: "component" | "incident", id: string): Return => {
	const navigate = (url: string) => PageOutMessage.RequestedNavigation({ url, isReplace: false })
	if (model.pageId === null) return { model }
	const pageId = model.pageId
	if (kind === "component")
		return Option.match(
			Arr.findFirst(componentsOf(model), (row) => row.id === id),
			{
				onNone: () => ({ model }),
				onSome: (component) => {
					const selected = selectComponent(model, component.id)
					return {
						...selected,
						model: { ...selected.model, revealComponentId: component.id },
						outMessage: navigate(statusPageHref(pageId, "settings", "monitors")),
					}
				},
			},
		)
	return Option.match(
		Arr.findFirst(incidentsOf(model), (row) => row.id === id),
		{
			onNone: () => ({ model }),
			onSome: (incident) => ({
				...selectIncident(model, incident.id),
				outMessage: navigate(
					statusPageHref(pageId, incident.kind === "incident" ? "incidents" : "maintenance"),
				),
			}),
		},
	)
}

/** The "..." menu: links navigate, the rest are this page's own actions. */
const updatePageMenu = (model: Model, message: Menu.Message): Return => {
	const result = Menu.update(model.pageMenu, message)
	const commands = FoldkitCommand.mapMessages(result.commands ?? [], (child) =>
		Message.GotPageMenuMessage({ message: child }),
	)
	const next = { ...model, pageMenu: result.model }
	if (result.outMessage?._tag !== "SelectedItem" || model.pageId === null) return { model: next, commands }
	const navigate = (url: string): Return => ({
		model: next,
		commands,
		outMessage: PageOutMessage.RequestedNavigation({ url, isReplace: false }),
	})
	switch (result.outMessage.value) {
		case "break-glass":
			return navigate(
				`${statusPageHref(model.pageId, "settings", "advanced")}#status-page-settings-break-glass`,
			)
		case "delete":
			return deletePageDialog(next, Dialog.open(next.deletePageDialog))
		default:
			return { model: next, commands }
	}
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	withSheet(step(model, message, context))

const step = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		// Each fresh read re-reads the clock, so "published 2m ago" and update times never drift into the future.
		// The preview's history needs the page too: when the components came first, read it now.
		CompletedFetchPage: ({ key, result }) => {
			const next = { ...model, page: Keyed.accept(model.page, key, result) }
			const awaitsHistory =
				key === model.page.key &&
				Result.isSuccess(result) &&
				model.previewShown === 0 &&
				Option.isSome(AsyncData.getData(model.components.data))
			if (!awaitsHistory) return { model: next, commands: [ReadEditorClock()] }
			const scheduled = schedulePreview(next)
			return { model: scheduled.model, commands: [ReadEditorClock(), ...(scheduled.commands ?? [])] }
		},
		// New components mean new monitors to show history for: the preview reads it again.
		CompletedFetchComponents: ({ key, result }) => {
			const next = { ...model, components: Keyed.accept(model.components, key, result) }
			return key === model.components.key && Result.isSuccess(result)
				? schedulePreview(next)
				: { model: next }
		},
		CompletedFetchIncidents: ({ key, result }) => ({
			model: { ...model, incidents: Keyed.accept(model.incidents, key, result) },
			commands: [ReadEditorClock()],
		}),
		CompletedFetchConfig: ({ key, result }) => {
			const next = { ...model, config: Keyed.accept(model.config, key, result) }
			// Only a successful read the slot kept may rebase the draft; a superseded or failed one
			// carries older data, and the rebase waits for the next good read.
			return {
				model: key === model.config.key && Result.isSuccess(result) ? rebaseJsonDraft(next) : next,
			}
		},
		CompletedFetchMonitors: ({ key, result }) => ({
			model: { ...model, monitors: Keyed.accept(model.monitors, key, result) },
		}),
		CompletedFetchSession: (answer) => ({
			model: acceptGrants(model, context.orgId, answer, { isSessionLoaded: true }),
		}),
		ClickedRetry: () =>
			chain(
				model,
				readPage(context, "Supersede"),
				readComponents(context, "Supersede"),
				readIncidents(context, "Supersede"),
				readMonitors(context, "Supersede"),
				readCustomDomain(context, "Supersede"),
				whenJson(context, "Supersede"),
			),
		GotPageMenuMessage: ({ message: child }) => updatePageMenu(model, child),
		// A reveal happens once: a later remount of the same row (back from another section) stays put.
		CompletedFocus: () => ({ model: { ...model, revealComponentId: null } }),
		// Preview and selection
		ElapsedPreviewDebounce: ({ generation }) =>
			generation !== model.previewGeneration
				? { model }
				: Option.match(previewDraftOf(model), {
						onNone: () => ({ model }),
						onSome: (draft) => ({ model, commands: [FetchEditorPreview({ generation, draft })] }),
					}),
		// History is a nicety: a failed read keeps the last bars rather than blanking the page.
		CompletedFetchPreview: ({ generation, draft, result }) =>
			generation < model.previewShown
				? { model }
				: Result.match(result, {
						onFailure: (): Return => ({ model }),
						onSuccess: (snapshot): Return => ({
							model: {
								...model,
								previewShown: generation,
								previewHistory: historyFrom(draft, snapshot),
							},
						}),
					}),
		ReceivedPreviewSelection: ({ kind, id }) => selectFromPreview(model, kind, id),
		// A second click on the open component closes it; its fields saved on blur.
		ClickedComponent: ({ componentId }) =>
			model.panel?._tag === "Component" && model.panel.componentId === componentId
				? closePanel(model)
				: selectComponent(model, componentId),
		ClickedIncident: ({ incidentId }) => selectIncident(model, incidentId),
		GotPanelSheetMessage: ({ message: child }) => updatePanelSheet(model, child),
		// Escape skips the field's blur, so a component panel saves its typed edits before it closes.
		PressedEscape: () =>
			model.panel?._tag === "Component" ? chain(model, commitComponent, closePanel) : closePanel(model),
		// Components
		ChangedComponentField: ({ field, value }) => changeComponent(model, field, value),
		CommittedComponent: () => commitComponent(model),
		PickedComponentField: ({ field, value }) =>
			commitComponent(changeComponent(model, field, value).model),
		ToggledComponentUptime: () =>
			commitComponent({
				...model,
				componentForm: { ...model.componentForm, showUptime: !model.componentForm.showUptime },
			}),
		CompletedSaveComponent: ({ result }) => savedComponent(model, result, context),
		ClickedMoveComponent: ({ componentId, offset }) => moveComponent(model, componentId, offset),
		CompletedReorder: ({ result }) => reordered(model, result, context),
		ClickedDeleteComponent: ({ componentId }) => askDeleteComponent(model, componentId),
		ClickedConfirmDeleteComponent: () => confirmDeleteComponent(model),
		CompletedDeleteComponent: ({ result }) => deletedComponent(model, result, context),
		GotDeleteComponentDialogMessage: ({ message: child }) =>
			whenIdle(model.isDeletingComponent, model, () =>
				deleteComponentDialog(model, Dialog.update(model.deleteComponentDialog, child)),
			),
		ClickedAddComponent: () => openAdd(model),
		GotAddPickerMessage: ({ message: child }) => addPickerStep(model, child),
		CompletedCreateMonitor: ({ session, result }) => addMonitorCreated(model, session, result),
		CompletedTrackMonitorCreated: () => ({ model }),
		ClickedSubmitAdd: () => submitAdd(model),
		CompletedAddComponents: ({ session, result }) => addedComponents(model, session, result, context),
		// Incidents
		ClickedNewIncident: ({ kind }) => openComposer(model, kind),
		GotComposeDialogMessage: ({ message: child }) =>
			whenIdle(model.isCreatingIncident, model, () =>
				composeDialog(model, Dialog.update(model.composeDialog, child)),
			),
		ChangedIncidentKind: ({ kind }) => changeIncidentKind(model, kind),
		ChangedIncidentField: ({ field, value }) => changeIncident(model, field, value),
		ToggledIncidentComponent: ({ componentId }) => toggleIncidentComponent(model, componentId),
		ChangedIncidentAutoComplete: ({ autoComplete }) => ({
			model: { ...model, incidentForm: { ...model.incidentForm, autoComplete } },
		}),
		SubmittedIncidentWrite: () => reviewIncident(model, context),
		ClickedIncidentBack: () => backToIncidentWrite(model),
		SubmittedIncident: ({ isPublished }) => submitIncident(model, context, isPublished),
		CompletedCreateIncident: ({ result }) => createdIncident(model, result, context),
		ClickedPostUpdate: ({ incidentId, isResolving }) => openUpdate(model, incidentId, isResolving),
		GotUpdateDialogMessage: ({ message: child }) =>
			whenIdle(model.updateForm._tag === "Posting", model, () =>
				updateDialog(model, Dialog.update(model.updateDialog, child)),
			),
		ChangedUpdateField: ({ field, value }) => changeUpdate(model, field, value),
		SubmittedUpdateWrite: () => reviewUpdate(model, context),
		ClickedUpdateBack: () => backToUpdateWrite(model),
		SubmittedUpdate: () => submitUpdate(model, context),
		CompletedPostUpdate: ({ result }) => postedUpdate(model, result, context),
		ClickedPublishIncident: ({ incidentId }) => publishIncident(model, incidentId),
		CompletedPublishIncident: ({ incidentId, result }) =>
			publishedIncident(model, incidentId, result, context),
		ClickedEditIncident: ({ incidentId }) => openIncidentEdit(model, incidentId, context),
		GotEditIncidentDialogMessage: ({ message: child }) =>
			whenIdle(model.isSavingIncident, model, () =>
				editIncidentDialog(model, Dialog.update(model.editIncidentDialog, child)),
			),
		ChangedIncidentEditField: ({ field, value }) => changeIncidentEdit(model, field, value),
		ToggledIncidentEditComponent: ({ componentId }) => toggleIncidentEditComponent(model, componentId),
		ChangedIncidentEditAutoComplete: ({ autoComplete }) =>
			model.incidentEdit === null || model.isSavingIncident
				? { model }
				: { model: { ...model, incidentEdit: { ...model.incidentEdit, autoComplete } } },
		SubmittedIncidentEdit: () => submitIncidentEdit(model, context),
		CompletedSaveIncident: ({ result }) => savedIncident(model, result, context),
		ClickedDeleteIncident: ({ incidentId }) => askDeleteIncident(model, incidentId),
		ClickedConfirmDeleteIncident: () => confirmDeleteIncident(model),
		CompletedDeleteIncident: ({ result }) => deletedIncident(model, result, context),
		GotDeleteIncidentDialogMessage: ({ message: child }) =>
			whenIdle(model.isDeletingIncident, model, () =>
				deleteIncidentDialog(model, Dialog.update(model.deleteIncidentDialog, child)),
			),
		// Live
		GotUrlCopyMessage: ({ message: child }) => {
			const step = CopyButton.update(model.urlCopy, child)
			return {
				model: { ...model, urlCopy: step.model },
				commands: FoldkitCommand.mapMessages(step.commands ?? [], (inner) =>
					Message.GotUrlCopyMessage({ message: inner }),
				),
			}
		},
		// Settings
		ChangedSetting: ({ field, value }) => changeSetting(model, field, value),
		ToggledPoweredBy: () => togglePoweredBy(model),
		PickedThemePreset: ({ preset }) =>
			changeTheme(model, { preset, ...STATUS_PAGE_PRESET_DEFAULTS[preset] }),
		PickedThemeAppearance: ({ appearance }) => changeTheme(model, { appearance }),
		ChangedThemeColor: ({ field, value }) => changeTheme(model, { [field]: value }),
		PickedThemeRadius: ({ radius }) => changeTheme(model, { radius }),
		PickedThemeFont: ({ font }) => changeTheme(model, { font }),
		PickedPreviewScheme: ({ scheme }) => ({ model: { ...model, previewScheme: scheme } }),
		PickedPreviewWidth: ({ width }) => ({ model: { ...model, previewWidth: width } }),
		PickedPreviewState: ({ state }) => ({ model: { ...model, previewState: state } }),
		ClickedDiscardSettings: () => ({ model: { ...model, settingsEdits: null, settingsFailure: null } }),
		ClickedSaveSettings: () => saveSettings(model),
		CompletedSaveSettings: ({ result }) => savedSettings(model, result),
		ClickedPublish: () => publish(model),
		CompletedPublish: ({ result }) => published(model, result, context),
		ClickedRotateToken: () => askBreakGlass(model, "rotate"),
		ClickedRevokeToken: () => askBreakGlass(model, "revoke"),
		ClickedConfirmBreakGlass: () => runBreakGlass(model),
		CompletedRotateToken: ({ result }) => rotated(model, result, context),
		CompletedRevokeToken: ({ result }) => revoked(model, result),
		GotBreakGlassDialogMessage: ({ message: child }) =>
			whenIdle(model.isChangingBreakGlass, model, () =>
				breakGlassDialog(model, Dialog.update(model.breakGlassDialog, child)),
			),
		GotTokenCopyMessage: ({ message: child }) => updateTokenCopy(model, child),
		ClickedDismissToken: () => ({ model: { ...model, revealedToken: null } }),
		// Access
		PickedVisibility: ({ visibility }) => pickVisibility(model, visibility),
		ClickedChangePassword: () => openPassword(model),
		ChangedPassword: ({ value }) => changePassword(model, value),
		ClickedCancelPassword: () => cancelPassword(model),
		SubmittedPassword: () => submitPassword(model),
		ClickedRemovePassword: () => removePassword(model),
		CompletedAccessChange: ({ action, result }) => changedAccess(model, action, result),
		// Custom domain
		CompletedFetchCustomDomain: ({ key, result }) => ({
			model: { ...model, customDomain: Keyed.accept(model.customDomain, key, result) },
		}),
		ClickedRetryCustomDomain: () => readCustomDomain(context, "Refresh")(model),
		ChangedCustomDomain: ({ value }) => changeCustomDomain(model, value),
		SubmittedCustomDomain: () => submitCustomDomain(model),
		CompletedSetCustomDomain: ({ result }) => savedCustomDomain(model, result),
		ClickedCheckCustomDomain: () => checkCustomDomain(model),
		CompletedCheckCustomDomain: ({ result }) => checkedCustomDomain(model, result),
		ClickedRemoveCustomDomain: () =>
			removeCustomDomainDialog(model, Dialog.open(model.removeCustomDomainDialog)),
		ClickedConfirmRemoveCustomDomain: () => confirmRemoveCustomDomain(model),
		CompletedRemoveCustomDomain: ({ result }) => removedCustomDomain(model, result),
		GotRemoveCustomDomainDialogMessage: ({ message: child }) =>
			whenIdle(model.customDomainAction === "remove", model, () =>
				removeCustomDomainDialog(model, Dialog.update(model.removeCustomDomainDialog, child)),
			),
		GotDnsCopyMessage: ({ key, message: child }) => updateDnsCopy(model, key, child),
		// Page
		ClickedDeletePage: () => deletePageDialog(model, Dialog.open(model.deletePageDialog)),
		ClickedConfirmDeletePage: () => confirmDeletePage(model),
		CompletedDeletePage: ({ result }) => deletedPage(model, result),
		GotDeletePageDialogMessage: ({ message: child }) =>
			whenIdle(model.isDeletingPage, model, () =>
				deletePageDialog(model, Dialog.update(model.deletePageDialog, child)),
			),
		// JSON
		ClickedEditJson: () => editJson(model),
		ChangedJson: ({ value }) => changeJson(model, value),
		ClickedResetJson: () => editJson(model),
		ClickedCancelJson: () => cancelJson(model),
		ClickedApplyJson: () => applyJson(model),
		CompletedApplyJson: ({ result }) => appliedJson(model, result, context),
		GotJsonCopyMessage: ({ message: child }) => updateJsonCopy(model, child),
	})
