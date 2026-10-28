import { Option } from "effect"
import * as Keyed from "../../../../data/keyed"
import type { AppRoute } from "../../../../route"
import * as CopyButton from "../../../../ui/copy-button"
import * as Dialog from "../../../../ui/dialog"
import type { PageContext } from "../../../contract"
import { type EditorTab, pageIdFromUrl } from "../../shared/status-page-commands"
import { FetchEditorSession, ReadEditorClock } from "./command"
import { emptyComponentForm, emptyIncidentForm } from "./form"
import { Message } from "./message"
import type { Model } from "./model"
import { chain, readComponents, readIncidents, readMonitors, readPage, type Return } from "./reads"
import {
	askDeleteComponent,
	changeComponent,
	componentDialog,
	confirmDeleteComponent,
	deleteComponentDialog,
	deletedComponent,
	moveComponent,
	openComponent,
	reordered,
	savedComponent,
	submitComponent,
} from "./update-components"
import {
	changeIncident,
	changeUpdate,
	createdIncident,
	incidentDialog,
	openComposer,
	openUpdate,
	postedUpdate,
	publishedIncident,
	publishIncident,
	submitIncident,
	submitUpdate,
	toggleIncidentComponent,
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

type EditorRoute = Extract<AppRoute, { readonly _tag: "AlertsStatusPage" }>

/** Unknown `tab` values open Components, so an old or mistyped link still lands. */
export const resolveTab = (tab: string | undefined): EditorTab =>
	tab === "incidents" || tab === "settings" ? tab : "components"

export const init = (route: EditorRoute, context: PageContext): Return => {
	const model: Model = {
		search: route.search,
		rawPageId: route.pageId,
		pageId: Option.getOrNull(pageIdFromUrl(route.pageId)),
		nowMs: null,
		page: Keyed.idle(),
		components: Keyed.idle(),
		incidents: Keyed.idle(),
		monitors: Keyed.idle(),
		isAdmin: false,
		isSessionLoaded: false,
		componentDialog: Dialog.init("status-page-component", "dialog"),
		componentForm: emptyComponentForm,
		isSavingComponent: false,
		componentFailure: null,
		confirmDeleteComponentId: null,
		deleteComponentDialog: Dialog.init("status-page-delete-component", "alert-dialog"),
		isDeletingComponent: false,
		isReordering: false,
		incidentDialog: Dialog.init("status-page-incident", "dialog"),
		incidentForm: emptyIncidentForm("incident"),
		isCreatingIncident: false,
		incidentFailure: null,
		updateDialog: Dialog.init("status-page-update", "dialog"),
		updateForm: null,
		isPostingUpdate: false,
		updateFailure: null,
		publishingIncidentIds: [],
		settingsEdits: null,
		isSavingSettings: false,
		settingsFailure: null,
		previewScheme: "light",
		isPublishing: false,
		breakGlassDialog: Dialog.init("status-page-break-glass", "alert-dialog"),
		breakGlassAction: null,
		isChangingBreakGlass: false,
		revealedToken: null,
		tokenCopy: CopyButton.init(),
		deletePageDialog: Dialog.init("status-page-delete", "alert-dialog"),
		isDeletingPage: false,
	}
	const reads = chain(
		model,
		readPage(context, "Load"),
		readComponents(context, "Load"),
		readIncidents(context, "Load"),
		readMonitors(context, "Load"),
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

/** A tab switch is a search change: the reads are already in the Model. */
export const routeChanged = (model: Model, route: EditorRoute): Return => ({
	model: { ...model, search: route.search },
})

/** The dialogs ignore dismissal while their write is in flight, as `ConfirmDialog` does. */
const whenIdle = (isBusy: boolean, model: Model, run: () => Return): Return => (isBusy ? { model } : run())

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedFetchPage: ({ key, result }) => ({
			model: { ...model, page: Keyed.accept(model.page, key, result) },
		}),
		CompletedFetchComponents: ({ key, result }) => ({
			model: { ...model, components: Keyed.accept(model.components, key, result) },
		}),
		CompletedFetchIncidents: ({ key, result }) => ({
			model: { ...model, incidents: Keyed.accept(model.incidents, key, result) },
		}),
		CompletedFetchMonitors: ({ key, result }) => ({
			model: { ...model, monitors: Keyed.accept(model.monitors, key, result) },
		}),
		CompletedFetchSession: ({ orgId, isAdmin }) =>
			orgId === context.orgId ? { model: { ...model, isAdmin, isSessionLoaded: true } } : { model },
		ClickedRetry: () =>
			chain(
				model,
				readPage(context, "Supersede"),
				readComponents(context, "Supersede"),
				readIncidents(context, "Supersede"),
				readMonitors(context, "Supersede"),
			),
		// Components
		ClickedAddComponent: () => openComponent(model, null),
		ClickedEditComponent: ({ componentId }) => openComponent(model, componentId),
		ChangedComponentField: ({ field, value }) => changeComponent(model, field, value),
		ToggledComponentUptime: () => ({
			model: {
				...model,
				componentForm: { ...model.componentForm, showUptime: !model.componentForm.showUptime },
			},
		}),
		SubmittedComponent: () => submitComponent(model),
		CompletedSaveComponent: ({ result }) => savedComponent(model, result, context),
		GotComponentDialogMessage: ({ message: child }) =>
			whenIdle(model.isSavingComponent, model, () =>
				componentDialog(model, Dialog.update(model.componentDialog, child)),
			),
		ClickedMoveComponent: ({ componentId, offset }) => moveComponent(model, componentId, offset),
		CompletedReorder: ({ result }) => reordered(model, result, context),
		ClickedDeleteComponent: ({ componentId }) => askDeleteComponent(model, componentId),
		ClickedConfirmDeleteComponent: () => confirmDeleteComponent(model),
		CompletedDeleteComponent: ({ result }) => deletedComponent(model, result, context),
		GotDeleteComponentDialogMessage: ({ message: child }) =>
			whenIdle(model.isDeletingComponent, model, () =>
				deleteComponentDialog(model, Dialog.update(model.deleteComponentDialog, child)),
			),
		// Incidents
		ClickedNewIncident: ({ kind }) => openComposer(model, kind),
		ChangedIncidentField: ({ field, value }) => changeIncident(model, field, value),
		ToggledIncidentComponent: ({ componentId }) => toggleIncidentComponent(model, componentId),
		PickedIncidentPublished: ({ isPublished }) => ({
			model: { ...model, incidentForm: { ...model.incidentForm, isPublished } },
		}),
		SubmittedIncident: () => submitIncident(model, context),
		CompletedCreateIncident: ({ result }) => createdIncident(model, result, context),
		GotIncidentDialogMessage: ({ message: child }) =>
			whenIdle(model.isCreatingIncident, model, () =>
				incidentDialog(model, Dialog.update(model.incidentDialog, child)),
			),
		ClickedPostUpdate: ({ incidentId, isResolving }) => openUpdate(model, incidentId, isResolving),
		ChangedUpdateField: ({ field, value }) => changeUpdate(model, field, value),
		SubmittedUpdate: () => submitUpdate(model),
		CompletedPostUpdate: ({ result }) => postedUpdate(model, result, context),
		GotUpdateDialogMessage: ({ message: child }) =>
			whenIdle(model.isPostingUpdate, model, () =>
				updateDialog(model, Dialog.update(model.updateDialog, child)),
			),
		ClickedPublishIncident: ({ incidentId }) => publishIncident(model, incidentId),
		CompletedPublishIncident: ({ incidentId, result }) =>
			publishedIncident(model, incidentId, result, context),
		// Settings
		ChangedSetting: ({ field, value }) => changeSetting(model, field, value),
		ToggledPoweredBy: () => togglePoweredBy(model),
		PickedThemePreset: ({ preset }) => changeTheme(model, { preset }),
		PickedThemeAppearance: ({ appearance }) => changeTheme(model, { appearance }),
		ChangedThemeColor: ({ field, value }) => changeTheme(model, { [field]: value }),
		PickedThemeRadius: ({ radius }) => changeTheme(model, { radius }),
		PickedThemeFont: ({ font }) => changeTheme(model, { font }),
		PickedPreviewScheme: ({ scheme }) => ({ model: { ...model, previewScheme: scheme } }),
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
		// Page
		ClickedDeletePage: () => deletePageDialog(model, Dialog.open(model.deletePageDialog)),
		ClickedConfirmDeletePage: () => confirmDeletePage(model),
		CompletedDeletePage: ({ result }) => deletedPage(model, result),
		GotDeletePageDialogMessage: ({ message: child }) =>
			whenIdle(model.isDeletingPage, model, () =>
				deletePageDialog(model, Dialog.update(model.deletePageDialog, child)),
			),
	})
