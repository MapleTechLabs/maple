import { ScrapeTargetId } from "@maple/domain/http"
import {
	V2ScrapeTargetCheck,
	V2ScrapeTargetCreateParams,
	V2ScrapeTargetUpdateParams,
} from "@maple/domain/http/v2"
import { Effect, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import { KeyedSchema } from "../../data/keyed"
import { LoadFailure, toLoadFailure } from "../../data/load-failure"
import { MapleApiV2Client } from "../../platform/api-clients"
import * as Dialog from "../../ui/dialog"
import * as Field from "../../ui/field"
import * as Menu from "../../ui/menu"
import * as Select from "../../ui/select"
import { Message } from "./message"
import { AuthType } from "./prometheus-form-field"

export { FormFieldName } from "./prometheus-form-field"

// `ScrapeTargetsSection`: state and writes.

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
	/** `useScrapeTargetChecks(selectedId)`: the latest 20 checks, re-read every 10 s. */
	checks: KeyedSchema(Schema.Array(V2ScrapeTargetCheck), LoadFailure),
	formDialog: Dialog.Model,
	editingId: Schema.NullOr(ScrapeTargetId),
	form: ScrapeForm,
	authSelect: Select.Model,
	isSaving: Schema.Boolean,
	deleteDialog: Dialog.Model,
	deleteId: Schema.NullOr(ScrapeTargetId),
	isDeleting: Schema.Boolean,
	/** `useKeyedAsyncAction`: the targets a probe or an enable toggle is in flight for. */
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

/** `hostnameFromUrl`: the URL's host, or the raw value when it does not parse. */
export const hostnameOf = (value: string): string => (URL.canParse(value) ? new URL(value).host : value)

const failureOf = (error: unknown): LoadFailure => toLoadFailure(error)

export const FetchChecks = Command.define("FetchScrapeTargetChecks", {
	args: { key: Schema.String, id: ScrapeTargetId },
	messages: [Message.CompletedFetchChecks],
	execute: ({ key, id }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const response = yield* client.scrapeTargets.listChecks({ params: { id }, query: { limit: 20 } })
			return response.data
		}).pipe(
			Effect.mapError(failureOf),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchChecks({ key, result })),
		),
})

export const ProbeTarget = Command.define("ProbeScrapeTarget", {
	args: { id: ScrapeTargetId },
	messages: [Message.CompletedProbe],
	execute: ({ id }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			return yield* client.scrapeTargets.probe({ params: { id } })
		}).pipe(
			Effect.match({
				onFailure: (error) =>
					Message.CompletedProbe({ id, failure: failureOf(error), success: false, error: null }),
				onSuccess: (result) =>
					Message.CompletedProbe({
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
	messages: [Message.CompletedToggle],
	execute: ({ id, enabled }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const payload = yield* Schema.decodeUnknownEffect(V2ScrapeTargetUpdateParams)({ enabled })
			yield* client.scrapeTargets.update({ params: { id }, payload })
		}).pipe(
			Effect.match({
				onFailure: (error) => Message.CompletedToggle({ id, failure: failureOf(error) }),
				onSuccess: () => Message.CompletedToggle({ id, failure: null }),
			}),
		),
})

export const DeleteTarget = Command.define("DeleteScrapeTarget", {
	args: { id: ScrapeTargetId },
	messages: [Message.CompletedTargetDelete],
	execute: ({ id }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			yield* client.scrapeTargets.delete({ params: { id } })
		}).pipe(
			Effect.match({
				onFailure: (error) => Message.CompletedTargetDelete({ id, failure: failureOf(error) }),
				onSuccess: () => Message.CompletedTargetDelete({ id, failure: null }),
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
	messages: [Message.CompletedSave],
	execute: ({ editingId, payload }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			// `auth_credentials` only when entered: the API fields are `optionalKey`.
			const { auth_credentials: credentials, ...base } = payload
			const raw = credentials === undefined ? base : { ...base, auth_credentials: credentials }
			if (editingId !== null) {
				const update = yield* Schema.decodeUnknownEffect(V2ScrapeTargetUpdateParams)(raw)
				yield* client.scrapeTargets.update({ params: { id: editingId }, payload: update })
				return editingId
			}
			const create = yield* Schema.decodeUnknownEffect(V2ScrapeTargetCreateParams)(raw)
			const created = yield* client.scrapeTargets.create({ payload: create })
			return created.id
		}).pipe(
			Effect.match({
				onFailure: (error) =>
					Message.CompletedSave({
						isEdit: editingId !== null,
						id: null,
						failure: failureOf(error),
					}),
				onSuccess: (id) => Message.CompletedSave({ isEdit: editingId !== null, id, failure: null }),
			}),
		),
})
