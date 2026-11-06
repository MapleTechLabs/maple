import { AlertRuleId } from "@maple/domain/http"
import {
	V2AlertRuleCreateParams,
	V2AlertRulePreviewParams,
	V2AlertRuleTestParams,
} from "@maple/domain/http/v2"
import { getTracesFacets } from "@maple/web-data/warehouse/traces"
import { displayError } from "@maple/web-data/lib/error-messages"
import { Clock, Effect, Exit, Schema, Array as Arr, String as Str } from "effect"
import * as SecureRandom from "effect/crypto/SecureRandom"
import { HttpClientError } from "effect/http"
import { Command } from "foldkit"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { AutocompleteLookup, autocompleteLookup } from "../../kit/autocomplete-lookups"
import { trackProduct } from "../../../data/analytics"
import { readGrants } from "../../../data/session-tenant"
import { fetchPreview } from "../shared/preview"
import { listEscalationChains } from "../shared/escalation-chains"
import { Message } from "./message"

export const GenerateDraftId = Command.define("GenerateAlertDraftId", {
	messages: [Message.GeneratedDraftId],
	execute: Effect.flatMap(Effect.service(SecureRandom.SecureRandom), (random) =>
		Effect.map(random.uuidV4(), (id) => Message.GeneratedDraftId({ id })),
	),
})

export const ReadEditorClock = Command.define("ReadAlertEditorClock", {
	messages: [Message.CompletedReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadClock({ nowMs })),
})

export const ReadEditorGrants = Command.define("ReadAlertEditorGrants", {
	messages: [Message.CompletedReadGrants],
	execute: Effect.map(readGrants, (grants) => Message.CompletedReadGrants({ grants })),
})

/** `useChatConnectors`: Slack first, empty on failure. */
export const FetchEditorConnectors = Command.define("FetchAlertEditorConnectors", {
	messages: [Message.CompletedFetchConnectors],
	execute: Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		const response = yield* client.chatIntegration.connectors()
		return Message.CompletedFetchConnectors({
			connectors: [...response.data].sort(
				(a, b) => Number(b.id === "slack") - Number(a.id === "slack"),
			),
		})
	}).pipe(Effect.orElseSucceed(() => Message.CompletedFetchConnectors({ connectors: [] }))),
})

/** The org's escalation chains for the tier pickers; a failed read offers none, as the connectors do. */
export const FetchEditorChains = Command.define("FetchAlertEditorChains", {
	messages: [Message.CompletedFetchEscalationChains],
	execute: listEscalationChains.pipe(
		Effect.map((chains) => Message.CompletedFetchEscalationChains({ chains })),
		Effect.orElseSucceed(() => Message.CompletedFetchEscalationChains({ chains: [] })),
	),
})

/** The provider's traces facets: the scope pickers' services and environments. */
export const FetchTraceFacets = Command.define("FetchAlertEditorTraceFacets", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchTraceFacets],
	execute: ({ key, window }) =>
		getTracesFacets({ data: window }).pipe(
			Effect.mapBoth({
				onSuccess: (response) => ({
					services: Arr.map(response.data.services, (row) => row.name),
					environments: Arr.map(response.data.deploymentEnvs, (row) => row.name),
					spanNames: Arr.map(response.data.spanNames, (row) => row.name),
					httpMethods: Arr.map(response.data.httpMethods, (row) => row.name),
					httpStatusCodes: Arr.map(response.data.httpStatusCodes, (row) => row.name),
				}),
				onFailure: toLoadFailure,
			}),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchTraceFacets({ key, result })),
		),
})

export const FetchEditorAutocomplete = Command.define("FetchAlertEditorAutocomplete", {
	args: { key: Schema.String, lookup: AutocompleteLookup, window: TimeWindow },
	messages: [Message.CompletedFetchAutocomplete],
	execute: ({ key, lookup, window }) =>
		autocompleteLookup(lookup, window).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchAutocomplete({ key, lookup, result })),
		),
})

/** `useAlertRulePreview`: the draft's replay, or the saved rule's while editing. */
export const FetchEditorPreview = Command.define("FetchAlertEditorPreview", {
	args: { key: Schema.String, payload: V2AlertRulePreviewParams, isSaved: Schema.Boolean },
	messages: [Message.CompletedFetchPreview],
	execute: ({ key, payload, isSaved }) =>
		fetchPreview(payload).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchPreview({ key, isSaved, result })),
		),
})

/** `AtomHttpApi` turns transport and decode failures into defects, which `toastExit` reads as unexpected. */
const failure = (error: unknown) => {
	const isDefect = Schema.isSchemaError(error) || HttpClientError.isHttpClientError(error)
	const body = displayError(isDefect ? Exit.die(error) : Exit.fail(error))
	return { title: body.title, message: body.message }
}

/** `runTest`: Dry run evaluates once; Send test also notifies. */
export const RunRuleTest = Command.define("RunAlertRuleTest", {
	args: { key: Schema.String, payload: V2AlertRuleTestParams },
	messages: [Message.CompletedTest],
	execute: ({ key, payload }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const result = yield* client.alertRules.test({ payload })
			return { key, status: result.status, value: result.value }
		}).pipe(
			Effect.mapError(failure),
			Effect.result,
			Effect.map((result) =>
				Message.CompletedTest({ isSending: payload.send_notification === true, key, result }),
			),
		),
})

/** `insertToken`: the token at the caret (replacing a selection), read off the textarea. */
export const InsertSqlToken = Command.define("InsertAlertSqlToken", {
	args: { id: Schema.String, sql: Schema.String, token: Schema.String },
	messages: [Message.CompletedInsertSqlToken],
	execute: ({ id, sql, token }) =>
		Effect.sync(() => {
			const element = document.getElementById(id)
			const textarea = element instanceof HTMLTextAreaElement ? element : null
			const start = textarea?.selectionStart ?? sql.length
			const end = textarea?.selectionEnd ?? start
			return Message.CompletedInsertSqlToken({
				sql: Str.slice(0, start)(sql) + token + Str.slice(end)(sql),
				caret: start + token.length,
			})
		}),
})

/** The caret after the inserted token, once the textarea holds it. */
export const FocusSqlCaret = Command.define("FocusAlertSqlCaret", {
	args: { id: Schema.String, caret: Schema.Number },
	messages: [Message.CompletedFocusSql],
	execute: ({ id, caret }) =>
		Effect.sync(() => {
			const element = document.getElementById(id)
			if (element instanceof HTMLTextAreaElement) {
				element.focus()
				element.setSelectionRange(caret, caret)
			}
			return Message.CompletedFocusSql()
		}),
})

/** `onRetry={() => window.location.reload()}`: a live query past its recovery has no other retry. */
export const ReloadPage = Command.define("ReloadAlertEditorPage", {
	messages: [Message.ReloadedPage],
	execute: Effect.sync(() => {
		window.location.reload()
		return Message.ReloadedPage()
	}),
})

/** `trackProduct("alert_rule_created", { signal })` after a create lands. */
export const TrackRuleCreated = Command.define("TrackAlertRuleCreated", {
	args: { signal: Schema.String },
	messages: [Message.TrackedRuleCreated],
	execute: ({ signal }) =>
		Effect.as(trackProduct("alert_rule_created", { signal }), Message.TrackedRuleCreated()),
})

/** `handleSave`: create, or update the rule being edited. */
export const SaveRule = Command.define("SaveAlertRule", {
	args: { ruleId: Schema.NullOr(AlertRuleId), payload: V2AlertRuleCreateParams },
	messages: [Message.CompletedSave],
	execute: ({ ruleId, payload }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			if (ruleId === null) yield* client.alertRules.create({ payload })
			else yield* client.alertRules.update({ params: { id: ruleId }, payload })
		}).pipe(
			Effect.mapError(failure),
			Effect.result,
			Effect.map((result) => Message.CompletedSave({ result })),
		),
})
