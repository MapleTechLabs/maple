/**
 * The OpenRouter management key an org's OpenRouter spend is read with: checked with OpenRouter,
 * stored sealed, one per org. Saving it makes the org's OpenRouter cost source, replacing it keeps
 * the source and its history, removing it removes the source.
 */
import {
	CloudCostDisabledError,
	OpenRouterKeyPersistenceError,
	OpenRouterKeyValidationError,
	type OrgId,
	type UserId,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { CostSources, OpenRouterCostConnections } from "@maple/db/tables"
import { Clock, Context, Duration, Effect, Layer, Redacted, String as Str } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { randomUUID } from "node:crypto"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import { sealSecret, secretKeyringFromEnv } from "@maple/backend/platform/SecretBox"
import { openRouterCostKeySlot } from "@maple/backend/platform/secret-slots"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import * as OpenRouterApi from "@maple/backend/services/org/openrouter-api"
import { reconcileOpenRouterCostSources } from "./openrouter-cost-sources"

const VALIDATE_TIMEOUT = Duration.seconds(15)

/** A workspace id no account has: how a key answers for it says whether it is scoped to one. */
const NO_SUCH_WORKSPACE = "00000000-0000-4000-8000-000000000000"

const WORKSPACE_SCOPED_KEY =
	"This management key reads one workspace only, so the source would miss the rest of the account's spend. Use a management key for the whole account."

const NOT_A_MANAGEMENT_KEY =
	"This is a regular API key. Reading spend needs a management key, which you create under Settings, Management keys in OpenRouter."

/** OpenRouter's typed failures, as what the Cost page shows next to the key field. */
const toKeyError = (
	error: OpenRouterApi.OpenRouterError,
): OpenRouterKeyValidationError | OpenRouterKeyPersistenceError => {
	switch (error._tag) {
		case "@maple/backend/openrouter/Unauthorized":
			return new OpenRouterKeyValidationError({ message: "OpenRouter rejected this key." })
		// Only the activity read answers 403, and only for a key that is a management key.
		case "@maple/backend/openrouter/Forbidden":
			return new OpenRouterKeyValidationError({
				message:
					"OpenRouter did not let this key read the account's activity. Create a new management key.",
			})
		default:
			return new OpenRouterKeyPersistenceError({
				message: "Could not check this key with OpenRouter. Try again.",
			})
	}
}

const toPersistenceError = makePersistenceErrorMapper(
	OpenRouterKeyPersistenceError,
	"OpenRouter cost key persistence failure",
)

export interface OpenRouterCostConnectionServiceApi {
	/** Saves the key and answers its masked form. */
	readonly set: (
		orgId: OrgId,
		userId: UserId,
		apiKey: string,
	) => Effect.Effect<
		{ readonly keyLabel: string },
		OpenRouterKeyPersistenceError | OpenRouterKeyValidationError | CloudCostDisabledError
	>
	readonly remove: (orgId: OrgId) => Effect.Effect<void, OpenRouterKeyPersistenceError>
}

export class OpenRouterCostConnectionService extends Context.Service<
	OpenRouterCostConnectionService,
	OpenRouterCostConnectionServiceApi
>()("@maple/backend/services/cost/OpenRouterCostConnectionService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		const featureFlags = yield* OrganizationFeatureFlagsService
		const httpClient = yield* HttpClient.HttpClient
		const keyring = yield* secretKeyringFromEnv(
			env,
			(message) => new OpenRouterKeyPersistenceError({ message }),
		)
		const dbExecute = makeDbExecute(database, "OpenRouterCostConnectionService", toPersistenceError)

		const asked = <A, R>(call: Effect.Effect<A, OpenRouterApi.OpenRouterError, R>) =>
			call.pipe(
				// The page shows the mapped message; which failure it was stays on the span.
				Effect.tapError((error) =>
					Effect.annotateCurrentSpan("maple.cost.openrouter.error", error._tag),
				),
				Effect.mapError(toKeyError),
			)

		/**
		 * The key's name and account at OpenRouter, once it has proved it can read the account's
		 * activity: a key that cannot would save and then fail every sync.
		 */
		const validateWithOpenRouter = (apiKey: string) =>
			Effect.gen(function* () {
				const { data } = yield* asked(OpenRouterApi.getKeyInfo({}))
				if (data.is_management_key !== true && data.is_provisioning_key !== true) {
					return yield* new OpenRouterKeyValidationError({ message: NOT_A_MANAGEMENT_KEY })
				}
				const accountId = data.organization_id ?? data.creator_user_id
				if (accountId === undefined || accountId === null) {
					return yield* new OpenRouterKeyValidationError({
						message: "OpenRouter did not say which account this key belongs to.",
					})
				}
				yield* asked(OpenRouterApi.getActivity({}))
				// A key scoped to one workspace reads only that one, and nothing in a pull would say so.
				const scoped = yield* OpenRouterApi.getWorkspaceActivity({
					workspaceId: NO_SUCH_WORKSPACE,
				}).pipe(
					Effect.as(false),
					Effect.catchTags({
						"@maple/backend/openrouter/NotFound": () => Effect.succeed(false),
						"@maple/backend/openrouter/Forbidden": () => Effect.succeed(true),
					}),
					asked,
				)
				if (scoped) return yield* new OpenRouterKeyValidationError({ message: WORKSPACE_SCOPED_KEY })
				return { keyLabel: data.label, accountId }
			}).pipe(
				OpenRouterApi.withKey(httpClient, {
					apiKey: Redacted.make(apiKey),
					apiBaseUrl: OpenRouterApi.OPENROUTER_MANAGEMENT_API_URL,
				}),
				Effect.timeoutOrElse({
					duration: VALIDATE_TIMEOUT,
					orElse: () =>
						Effect.fail(
							new OpenRouterKeyPersistenceError({
								message: "Could not reach OpenRouter to check this key. Try again.",
							}),
						),
				}),
				Effect.withSpan("OpenRouterCostConnectionService.validateWithOpenRouter"),
			)

		const set = Effect.fn("OpenRouterCostConnectionService.set")(function* (
			orgId: OrgId,
			userId: UserId,
			rawKey: string,
		) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const flags = yield* featureFlags.flags(orgId)
			if (!flags.cloudCost) {
				return yield* new CloudCostDisabledError({
					message: "Cloud cost is not enabled for this organization.",
				})
			}
			const apiKey = Str.trim(rawKey)
			if (!OpenRouterApi.isOpenRouterKey(apiKey)) {
				return yield* new OpenRouterKeyValidationError({
					message: "That is not an OpenRouter key. They start with sk-or-.",
				})
			}
			const { keyLabel, accountId } = yield* validateWithOpenRouter(apiKey)
			// The org binding: a row copied onto another org's id no longer opens.
			const encrypted = yield* sealSecret(
				keyring,
				openRouterCostKeySlot,
				{ orgId },
				apiKey,
				(message) => new OpenRouterKeyPersistenceError({ message }),
			)
			const now = yield* Clock.currentTimeMillis
			const next = {
				keyCiphertext: encrypted.ciphertext,
				keyIv: encrypted.iv,
				keyTag: encrypted.tag,
				keyLabel,
				updatedAt: now,
				updatedBy: userId,
			}
			const saved = yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						// A replaced key keeps the row's id, which the cost source points at. Another
						// account's key matches no row: its spend would overwrite the source's days.
						const rows = yield* db.run(
							PG.insertInto(OpenRouterCostConnections)
								.values({ id: randomUUID(), orgId, accountId, createdAt: now, ...next })
								.onConflictDoUpdate({
									target: ["orgId"],
									set: next,
									where: ($) => $.accountId.eq(accountId),
								})
								.returning(($) => ({ id: $.id })),
						)
						const [row] = rows
						if (row === undefined) return false
						// The source shows on the Cost page at once, not at the next sync tick.
						yield* reconcileOpenRouterCostSources(db, now, orgId)
						// A source held for its old key's failure is due again with the new one. A pull
						// still in flight on the old key loses its claim, so its failure writes no hold.
						yield* db.run(
							PG.update(CostSources)
								.set({
									leaseUntil: null,
									lastError: null,
									lastErrorReason: null,
									nextAttemptAt: null,
									consecutiveFailures: 0,
									updatedAt: now,
								})
								.where(($) => [
									$.orgId.eq(orgId),
									$.provider.eq("openrouter"),
									$.connectionRef.eq(row.id),
								]),
						)
						return true
					}),
				),
			)
			if (!saved) {
				return yield* new OpenRouterKeyValidationError({
					message:
						"This key belongs to another OpenRouter account than the source reads. Remove the source first to switch accounts.",
				})
			}
			return { keyLabel }
		})

		const remove = Effect.fn("OpenRouterCostConnectionService.remove")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const now = yield* Clock.currentTimeMillis
			yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						yield* db.run(
							PG.deleteFrom(OpenRouterCostConnections).where(($) => [$.orgId.eq(orgId)]),
						)
						yield* reconcileOpenRouterCostSources(db, now, orgId)
					}),
				),
			)
		})

		return { set, remove } satisfies OpenRouterCostConnectionServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(FetchHttpClient.layer, OrganizationFeatureFlagsService.layer)),
	)
}
