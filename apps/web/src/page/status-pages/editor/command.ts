import { StatusPageComponentId, StatusPageId, StatusPageIncidentId } from "@maple/domain"
import {
	StatusPageConfig,
	StatusPageDraftComponent,
	StatusPagePreviewParams,
	V2StatusPageComponentCreateParams,
	V2StatusPageIncidentCreateParams,
	V2StatusPageIncidentPostUpdateParams,
	V2StatusPageUpdateParams,
} from "@maple/domain/http/v2"
import { Clock, Duration, Effect, Schema } from "effect"
import { Command, Dom, Mount } from "foldkit"
import { readIsAdmin } from "../../alerts/shared/commands"
import {
	applyPageConfig,
	createIncident,
	deleteComponent,
	deletePage,
	listComponents,
	listPageIncidents,
	postIncidentUpdate,
	previewPage,
	publishPage,
	reorderComponents,
	retrievePage,
	retrievePageConfig,
	revokeBreakGlass,
	rotateBreakGlass,
	saveComponent,
	updateIncident,
	updatePage,
} from "../shared/commands"
import { listMonitors, saveMonitor } from "../../alerts/shared/uptime-commands"
import { monitorPayloadFor } from "../shared/picker"
import { Message } from "./message"

export const ReadEditorClock = Command.define("ReadStatusPageClock", {
	messages: [Message.ReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.ReadClock({ nowMs })),
})

export const FetchEditorSession = Command.define("FetchStatusPageSession", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedFetchSession],
	execute: ({ orgId }) =>
		Effect.map(readIsAdmin, (isAdmin) => Message.CompletedFetchSession({ orgId, isAdmin })),
})

export const FetchPage = Command.define("FetchStatusPage", {
	args: { key: Schema.String, pageId: StatusPageId },
	messages: [Message.CompletedFetchPage],
	execute: ({ key, pageId }) =>
		retrievePage(pageId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchPage({ key, result })),
		),
})

export const FetchComponents = Command.define("FetchStatusPageComponents", {
	args: { key: Schema.String, pageId: StatusPageId },
	messages: [Message.CompletedFetchComponents],
	execute: ({ key, pageId }) =>
		listComponents(pageId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchComponents({ key, result })),
		),
})

export const FetchIncidents = Command.define("FetchStatusPageIncidents", {
	args: { key: Schema.String, pageId: StatusPageId },
	messages: [Message.CompletedFetchIncidents],
	execute: ({ key, pageId }) =>
		listPageIncidents(pageId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchIncidents({ key, result })),
		),
})

export const FetchEditorMonitors = Command.define("FetchStatusPageMonitors", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchMonitors],
	execute: ({ key }) =>
		listMonitors.pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchMonitors({ key, result })),
		),
})

export const SaveComponent = Command.define("SaveStatusPageComponent", {
	args: {
		pageId: StatusPageId,
		componentId: Schema.NullOr(StatusPageComponentId),
		payload: V2StatusPageComponentCreateParams,
	},
	messages: [Message.CompletedSaveComponent],
	execute: ({ pageId, componentId, payload }) =>
		saveComponent(pageId, componentId, payload).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedSaveComponent({ result })),
		),
})

export const ReorderComponents = Command.define("ReorderStatusPageComponents", {
	args: { pageId: StatusPageId, componentIds: Schema.Array(StatusPageComponentId) },
	messages: [Message.CompletedReorder],
	execute: ({ pageId, componentIds }) =>
		reorderComponents(pageId, componentIds).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedReorder({ result })),
		),
})

export const DeleteComponent = Command.define("DeleteStatusPageComponent", {
	args: { pageId: StatusPageId, componentId: StatusPageComponentId },
	messages: [Message.CompletedDeleteComponent],
	execute: ({ pageId, componentId }) =>
		deleteComponent(pageId, componentId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedDeleteComponent({ result })),
		),
})

export const CreateIncident = Command.define("CreateStatusPageIncident", {
	args: { payload: V2StatusPageIncidentCreateParams },
	messages: [Message.CompletedCreateIncident],
	execute: ({ payload }) =>
		createIncident(payload).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedCreateIncident({ result })),
		),
})

export const PostIncidentUpdate = Command.define("PostStatusPageIncidentUpdate", {
	args: { incidentId: StatusPageIncidentId, payload: V2StatusPageIncidentPostUpdateParams },
	messages: [Message.CompletedPostUpdate],
	execute: ({ incidentId, payload }) =>
		postIncidentUpdate(incidentId, payload).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedPostUpdate({ result })),
		),
})

export const PublishIncident = Command.define("PublishStatusPageIncident", {
	args: { incidentId: StatusPageIncidentId },
	messages: [Message.CompletedPublishIncident],
	execute: ({ incidentId }) =>
		updateIncident(incidentId, { published: true }).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedPublishIncident({ incidentId, result })),
		),
})

export const SaveSettings = Command.define("SaveStatusPageSettings", {
	args: { pageId: StatusPageId, payload: V2StatusPageUpdateParams },
	messages: [Message.CompletedSaveSettings],
	execute: ({ pageId, payload }) =>
		updatePage(pageId, payload).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedSaveSettings({ result })),
		),
})

export const PublishPage = Command.define("PublishStatusPage", {
	args: { pageId: StatusPageId },
	messages: [Message.CompletedPublish],
	execute: ({ pageId }) =>
		publishPage(pageId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedPublish({ result })),
		),
})

export const RotateToken = Command.define("RotateStatusPageBreakGlassToken", {
	args: { pageId: StatusPageId },
	messages: [Message.CompletedRotateToken],
	execute: ({ pageId }) =>
		rotateBreakGlass(pageId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedRotateToken({ result })),
		),
})

export const RevokeToken = Command.define("RevokeStatusPageBreakGlassToken", {
	args: { pageId: StatusPageId },
	messages: [Message.CompletedRevokeToken],
	execute: ({ pageId }) =>
		revokeBreakGlass(pageId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedRevokeToken({ result })),
		),
})

export const FetchConfig = Command.define("FetchStatusPageConfig", {
	args: { key: Schema.String, pageId: StatusPageId },
	messages: [Message.CompletedFetchConfig],
	execute: ({ key, pageId }) =>
		retrievePageConfig(pageId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchConfig({ key, result })),
		),
})

export const ApplyConfig = Command.define("ApplyStatusPageConfig", {
	args: { pageId: StatusPageId, config: StatusPageConfig, ifVersion: Schema.UndefinedOr(Schema.String) },
	messages: [Message.CompletedApplyJson],
	execute: ({ pageId, config, ifVersion }) =>
		applyPageConfig(pageId, config, ifVersion).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedApplyJson({ result })),
		),
})

export const DeletePage = Command.define("DeleteStatusPage", {
	args: { pageId: StatusPageId },
	messages: [Message.CompletedDeletePage],
	execute: ({ pageId }) =>
		deletePage(pageId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedDeletePage({ result })),
		),
})

/** How long the preview waits after the last change before it reads the monitors' history again. */
const PREVIEW_DEBOUNCE_MS = 400

export const WaitEditorPreview = Command.define("WaitStatusPageEditorPreview", {
	args: { generation: Schema.Number },
	messages: [Message.ElapsedPreviewDebounce],
	execute: ({ generation }) =>
		Effect.as(
			Effect.sleep(Duration.millis(PREVIEW_DEBOUNCE_MS)),
			Message.ElapsedPreviewDebounce({ generation }),
		),
})

export const FetchEditorPreview = Command.define("FetchStatusPageEditorPreview", {
	args: { generation: Schema.Number, draft: StatusPagePreviewParams },
	messages: [Message.CompletedFetchPreview],
	execute: ({ generation, draft }) =>
		previewPage(draft).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchPreview({ generation, draft, result })),
		),
})

export const CreateEditorMonitor = Command.define("CreateStatusPageEditorMonitor", {
	args: { url: Schema.String },
	messages: [Message.CompletedCreateMonitor],
	execute: ({ url }) =>
		saveMonitor(null, monitorPayloadFor(url)).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedCreateMonitor({ result })),
		),
})

/** Adds the picked components in order, one create each; the first failure stops the rest. */
export const AddComponents = Command.define("AddStatusPageComponents", {
	args: { pageId: StatusPageId, components: Schema.Array(StatusPageDraftComponent) },
	messages: [Message.CompletedAddComponents],
	execute: ({ pageId, components }) =>
		Effect.forEach(components, (component) => saveComponent(pageId, null, component)).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedAddComponents({ result })),
		),
})

export const FocusEditorElement = Command.define("FocusStatusPageEditorElement", {
	args: { id: Schema.String },
	messages: [Message.CompletedFocus],
	execute: ({ id }) =>
		Dom.focus(`#${CSS.escape(id)}`).pipe(Effect.ignore, Effect.as(Message.CompletedFocus())),
})

/** The public page in a new tab: it lives on the status Worker's host, outside the app. */
export const OpenPublicPage = Command.define("OpenStatusPagePublicPage", {
	args: { url: Schema.String },
	messages: [Message.OpenedPublicPage],
	execute: ({ url }) =>
		Effect.sync(() => window.open(url, "_blank", "noopener")).pipe(Effect.as(Message.OpenedPublicPage())),
})

/** Focuses the element as it mounts, in the same render, so no keystroke lands elsewhere first. */
export const FocusNewRow = Mount.define("FocusStatusPageEditorRow", {
	messages: [Message.CompletedFocus],
	execute: ({ element }) =>
		Effect.sync(() => (element instanceof HTMLElement ? element.focus() : undefined)).pipe(
			Effect.as(Message.CompletedFocus()),
		),
})
