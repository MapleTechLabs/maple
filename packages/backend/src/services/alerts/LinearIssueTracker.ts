/**
 * The Linear side of a `linear` alert destination: GraphQL with the org's token, and the
 * `alert_linear_issues` row that remembers which issue each alert thread keeps.
 */
import {
	AlertDeliveryAuthError,
	AlertDeliveryError,
	AlertDeliveryTargetMissingError,
	type AlertDeliveryFailure,
	type IntegrationsNotConnectedError,
	type IntegrationsPersistenceError,
	type IntegrationsRevokedError,
	type IntegrationsUpstreamError,
	type IntegrationsValidationError,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { AlertLinearIssues } from "@maple/db/tables"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { LinearOAuthService } from "@maple/backend/services/auth/LinearOAuthService"
import {
	isNotFound,
	linearGraphql,
	type LinearGraphqlError,
} from "@maple/backend/services/integrations/linear/LinearGraphql"
import { linearEntityId } from "./delivery/transports/linear"
import type { LinearDeliveryPort, LinearThread } from "./delivery/Transport"

/** Linear's answer to a create whose caller-chosen id is taken. */
const isDuplicate = (error: LinearGraphqlError) =>
	/already exists|duplicate|unique constraint/i.test(error.message)

const toDeliveryFailure = (
	error:
		| IntegrationsNotConnectedError
		| IntegrationsRevokedError
		| IntegrationsUpstreamError
		| IntegrationsPersistenceError
		| IntegrationsValidationError,
): AlertDeliveryFailure => {
	switch (error._tag) {
		case "@maple/http/errors/IntegrationsNotConnectedError":
		case "@maple/http/errors/IntegrationsRevokedError":
			return new AlertDeliveryAuthError({
				message: "Linear is disconnected. Reconnect it on the Integrations page.",
				destinationType: "linear",
			})
		case "@maple/http/errors/IntegrationsUpstreamError":
			return new AlertDeliveryError({
				message: error.message,
				destinationType: "linear",
				...(error.status === undefined ? undefined : { providerStatus: error.status }),
			})
		default:
			return new AlertDeliveryError({ message: error.message, destinationType: "linear" })
	}
}

export class LinearIssueTracker extends Context.Service<LinearIssueTracker, LinearDeliveryPort>()(
	"@maple/backend/services/alerts/LinearIssueTracker",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const linearOAuth = yield* LinearOAuthService
			const httpClient = yield* HttpClient.HttpClient
			const dbExecute = makeDbExecute(
				database,
				"LinearIssueTracker",
				(error) =>
					new AlertDeliveryError({
						message: `Linear issue bookkeeping failed: ${error.message}`,
						destinationType: "linear",
						cause: error,
					}),
			)

			const request: LinearDeliveryPort["request"] = (orgId, operation, schema, options = {}) =>
				Effect.gen(function* () {
					const result = yield* linearOAuth.withAccessToken(orgId, (accessToken) =>
						linearGraphql(
							httpClient,
							accessToken,
							operation.name,
							operation.document,
							operation.variables,
						),
					)
					if (result.errors.some(isNotFound)) {
						if (options.notFoundIsNull === true) return null
						return yield* new AlertDeliveryTargetMissingError({
							message: `Linear could not find what ${operation.name} refers to. Check the destination's team.`,
							destinationType: "linear",
						})
					}
					if (result.errors.some((error) => error.code === "FORBIDDEN")) {
						return yield* new AlertDeliveryTargetMissingError({
							message:
								"Maple no longer has access to this Linear team. Reconnect Linear or pick another team.",
							destinationType: "linear",
						})
					}
					if (options.duplicateIsSuccess === true && result.errors.some(isDuplicate)) return null
					if (result.errors.length > 0) {
						return yield* new AlertDeliveryError({
							message: `Linear ${operation.name} failed: ${result.errors.map((e) => e.message).join("; ")}`,
							destinationType: "linear",
						})
					}
					return yield* Schema.decodeUnknownEffect(schema)(result.data).pipe(
						Effect.mapError(
							() =>
								new AlertDeliveryError({
									message: `Linear ${operation.name} returned an unexpected payload`,
									destinationType: "linear",
								}),
						),
					)
				}).pipe(
					Effect.catchTags({
						"@maple/http/errors/IntegrationsNotConnectedError": (e) =>
							Effect.fail(toDeliveryFailure(e)),
						"@maple/http/errors/IntegrationsRevokedError": (e) =>
							Effect.fail(toDeliveryFailure(e)),
						"@maple/http/errors/IntegrationsUpstreamError": (e) =>
							Effect.fail(toDeliveryFailure(e)),
						"@maple/http/errors/IntegrationsPersistenceError": (e) =>
							Effect.fail(toDeliveryFailure(e)),
						"@maple/http/errors/IntegrationsValidationError": (e) =>
							Effect.fail(toDeliveryFailure(e)),
					}),
					Effect.withSpan("LinearIssueTracker.request", {
						attributes: { "maple.linear.operation": operation.name },
					}),
				)

			const findThread: LinearDeliveryPort["findThread"] = (orgId, destinationId, threadKey) =>
				dbExecute((db) =>
					db.run(
						PG.from(AlertLinearIssues)
							.select()
							.where(($) => [
								$.orgId.eq(orgId),
								$.destinationId.eq(destinationId),
								$.threadKey.eq(threadKey),
							])
							.limit(1),
					),
				).pipe(
					Effect.map((rows) => {
						const row = rows[0]
						return row === undefined
							? null
							: ({
									orgId: row.orgId,
									destinationId: row.destinationId,
									threadKey: row.threadKey,
									linearIssueId: row.linearIssueId,
									linearIdentifier: row.linearIdentifier,
									linearUrl: row.linearUrl,
									incidentId: row.incidentId,
								} satisfies LinearThread)
					}),
				)

			const saveThread: LinearDeliveryPort["saveThread"] = (thread) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					const values = {
						linearIssueId: thread.linearIssueId,
						linearIdentifier: thread.linearIdentifier,
						linearUrl: thread.linearUrl,
						incidentId: thread.incidentId,
						updatedAt: now,
					}
					yield* dbExecute((db) =>
						db.run(
							PG.insertInto(AlertLinearIssues)
								.values({
									id: linearEntityId("thread", thread.destinationId, thread.threadKey),
									orgId: thread.orgId,
									destinationId: thread.destinationId,
									threadKey: thread.threadKey,
									createdAt: now,
									...values,
								})
								.onConflictDoUpdate({ target: ["destinationId", "threadKey"], set: values }),
						),
					)
				})

			return { request, findThread, saveThread } satisfies LinearDeliveryPort
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(LinearOAuthService.layer),
		Layer.provide(FetchHttpClient.layer),
	)
}
