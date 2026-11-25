import { ScrapeTargetId } from "@maple/domain/http"
import {
	V2ScrapeTargetCheck,
	V2ScrapeTargetCreateParams,
	V2ScrapeTargetUpdateParams,
} from "@maple/domain/http/v2"
import { Effect, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { collectV2Pages } from "@maple/web-data/lib/v2-pagination"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure, toLoadFailure } from "@maple/views/data/load-failure"
import { MapleApiV2Client } from "../../platform/api-clients"
import * as Dialog from "@maple/views/ui/dialog"
import * as Field from "@maple/views/ui/field"
import * as Menu from "@maple/views/ui/menu"
import * as Select from "@maple/views/ui/select"
import { AuthType, FormFieldName } from "./prometheus-form-field"

export { FormFieldName } from "./prometheus-form-field"

/** The scrape-target module's messages (Prometheus and WarpStream), carried in `GotPrometheusMessage`. */
export const PrometheusMessage = defineMessageUnion({
	ClickedTarget: { id: ScrapeTargetId },
	CompletedFetchChecks: {
		key: Schema.String,
		result: Schema.Result(Schema.Array(V2ScrapeTargetCheck), LoadFailure),
	},
	/** The target list every 30 s, the selected target's checks every 10 s. */
	TickedTargetsRefresh: {},
	TickedChecksRefresh: {},
	ClickedProbe: { id: ScrapeTargetId },
	CompletedProbe: {
		id: ScrapeTargetId,
		failure: Schema.NullOr(LoadFailure),
		success: Schema.Boolean,
		error: Schema.NullOr(Schema.String),
	},
	ClickedToggleTarget: { id: ScrapeTargetId },
	CompletedToggle: { id: ScrapeTargetId, failure: Schema.NullOr(LoadFailure) },
	ClickedEditTarget: { id: ScrapeTargetId },
	ClickedDeleteTarget: { id: ScrapeTargetId },
	GotTargetMenuMessage: { id: ScrapeTargetId, message: Menu.Message },
	GotFormDialogMessage: { message: Dialog.Message },
	GotFormFieldMessage: { field: FormFieldName, message: Field.Message },
	GotAuthSelectMessage: { message: Select.Message },
	SubmittedTargetForm: {},
	CompletedSave: {
		isEdit: Schema.Boolean,
		id: Schema.NullOr(ScrapeTargetId),
		failure: Schema.NullOr(LoadFailure),
	},
	GotTargetDeleteDialogMessage: { message: Dialog.Message },
	ConfirmedTargetDelete: {},
	CompletedTargetDelete: { id: ScrapeTargetId, failure: Schema.NullOr(LoadFailure) },
})
export type PrometheusMessage = typeof PrometheusMessage.Type

/** The hub's scrape target read: every page of 100. */
export const SCRAPE_TARGETS_STATUS_READ = {
	name: "LoadIntegrationsScrapeTargets",
	read: (_refresh: boolean) =>
		Effect.flatMap(MapleApiV2Client, (client) =>
			collectV2Pages((cursor) =>
				client.scrapeTargets.list({
					query: { limit: 100, ...(cursor !== undefined ? { cursor } : undefined) },
				}),
			),
		),
}

export const ScrapeForm = Schema.Struct({
	name: Field.Model,
	serviceName: Field.Model,
	url: Field.Model,
	interval: Field.Model,
	authType: AuthType,
	token: Field.Model,
	username: Field.Model,
	password: Field.Model,
})
export type ScrapeForm = typeof ScrapeForm.Type

/** A probe's answer in this visit: `error` is the scrape's failure, or the call's own. */
export const ProbeOutcome = Schema.Struct({ success: Schema.Boolean, error: Schema.NullOr(Schema.String) })
export type ProbeOutcome = typeof ProbeOutcome.Type

export const PrometheusCardModel = Schema.Struct({
	selectedId: Schema.NullOr(ScrapeTargetId),
	/** The selected target's latest 20 checks, re-read every 10 s. */
	checks: KeyedSchema(Schema.Array(V2ScrapeTargetCheck), LoadFailure),
	formDialog: Dialog.Model,
	editingId: Schema.NullOr(ScrapeTargetId),
	form: ScrapeForm,
	authSelect: Select.Model,
	isSaving: Schema.Boolean,
	deleteDialog: Dialog.Model,
	deleteId: Schema.NullOr(ScrapeTargetId),
	isDeleting: Schema.Boolean,
	/** The targets a probe or an enable toggle is in flight for. */
	probing: Schema.Array(ScrapeTargetId),
	toggling: Schema.Array(ScrapeTargetId),
	/** The last probe per target id, so the connect flow's status row can show it. */
	probes: Schema.Record(Schema.String, ProbeOutcome),
	menus: Schema.Record(Schema.String, Menu.Model),
})
export type PrometheusCardModel = typeof PrometheusCardModel.Type

export const emptyForm = (): ScrapeForm => ({
	name: Field.init(),
	serviceName: Field.init(),
	url: Field.init(),
	interval: Field.init("15"),
	authType: "none",
	token: Field.init(),
	username: Field.init(),
	password: Field.init(),
})

export const initPrometheusCard = (): PrometheusCardModel => ({
	selectedId: null,
	checks: { key: null, data: AsyncData.Idle() },
	formDialog: Dialog.init("scrape-target-form", "dialog"),
	editingId: null,
	form: emptyForm(),
	authSelect: Select.init("scrape-auth-type", { value: "none", selectedIndex: 0 }),
	isSaving: false,
	deleteDialog: Dialog.init("scrape-target-delete", "alert-dialog"),
	deleteId: null,
	isDeleting: false,
	probing: [],
	toggling: [],
	probes: {},
	menus: {},
})

export const hostnameOf = (value: string): string => (URL.canParse(value) ? new URL(value).host : value)

const failureOf = (error: unknown): LoadFailure => toLoadFailure(error)

export const FetchChecks = Command.define("FetchScrapeTargetChecks", {
	args: { key: Schema.String, id: ScrapeTargetId },
	messages: [PrometheusMessage.CompletedFetchChecks],
	execute: ({ key, id }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const response = yield* client.scrapeTargets.listChecks({ params: { id }, query: { limit: 20 } })
			return response.data
		}).pipe(
			Effect.mapError(failureOf),
			Effect.result,
			Effect.map((result) => PrometheusMessage.CompletedFetchChecks({ key, result })),
		),
})

export const ProbeTarget = Command.define("ProbeScrapeTarget", {
	args: { id: ScrapeTargetId },
	messages: [PrometheusMessage.CompletedProbe],
	execute: ({ id }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			return yield* client.scrapeTargets.probe({ params: { id } })
		}).pipe(
			Effect.match({
				onFailure: (error) =>
					PrometheusMessage.CompletedProbe({
						id,
						failure: failureOf(error),
						success: false,
						error: null,
					}),
				onSuccess: (result) =>
					PrometheusMessage.CompletedProbe({
						id,
						failure: null,
						success: result.success,
						error: result.last_scrape_error,
					}),
			}),
		),
})

export const ToggleTarget = Command.define("ToggleScrapeTarget", {
	args: { id: ScrapeTargetId, enabled: Schema.Boolean },
	messages: [PrometheusMessage.CompletedToggle],
	execute: ({ id, enabled }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const payload = yield* Schema.decodeEffect(V2ScrapeTargetUpdateParams)({ enabled })
			yield* client.scrapeTargets.update({ params: { id }, payload })
		}).pipe(
			Effect.match({
				onFailure: (error) => PrometheusMessage.CompletedToggle({ id, failure: failureOf(error) }),
				onSuccess: () => PrometheusMessage.CompletedToggle({ id, failure: null }),
			}),
		),
})

export const DeleteTarget = Command.define("DeleteScrapeTarget", {
	args: { id: ScrapeTargetId },
	messages: [PrometheusMessage.CompletedTargetDelete],
	execute: ({ id }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			yield* client.scrapeTargets.delete({ params: { id } })
		}).pipe(
			Effect.match({
				onFailure: (error) =>
					PrometheusMessage.CompletedTargetDelete({ id, failure: failureOf(error) }),
				onSuccess: () => PrometheusMessage.CompletedTargetDelete({ id, failure: null }),
			}),
		),
})

/** The form's payload (`auth_credentials` only when entered). */
export const SavePayload = Schema.Struct({
	name: Schema.String,
	scrape_interval_seconds: Schema.Number,
	service_name: Schema.NullOr(Schema.String),
	url: Schema.String,
	auth_type: AuthType,
	auth_credentials: Schema.optional(Schema.String),
})
export type SavePayload = typeof SavePayload.Type

export const SaveTarget = Command.define("SaveScrapeTarget", {
	args: { editingId: Schema.NullOr(ScrapeTargetId), payload: SavePayload },
	messages: [PrometheusMessage.CompletedSave],
	execute: ({ editingId, payload }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			// `auth_credentials` only when entered: the API fields are `optionalKey`.
			const { auth_credentials: credentials, ...base } = payload
			const raw = credentials === undefined ? base : { ...base, auth_credentials: credentials }
			if (editingId !== null) {
				const update = yield* Schema.decodeEffect(V2ScrapeTargetUpdateParams)(raw)
				yield* client.scrapeTargets.update({ params: { id: editingId }, payload: update })
				return editingId
			}
			const create = yield* Schema.decodeEffect(V2ScrapeTargetCreateParams)(raw)
			const created = yield* client.scrapeTargets.create({ payload: create })
			return created.id
		}).pipe(
			Effect.match({
				onFailure: (error) =>
					PrometheusMessage.CompletedSave({
						isEdit: editingId !== null,
						id: null,
						failure: failureOf(error),
					}),
				onSuccess: (id) =>
					PrometheusMessage.CompletedSave({ isEdit: editingId !== null, id, failure: null }),
			}),
		),
})
