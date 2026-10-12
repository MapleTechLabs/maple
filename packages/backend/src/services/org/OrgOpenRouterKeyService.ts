import { customerHasFlag, OPENROUTER_BYOK_FEATURE_ID } from "@maple/domain/billing"
import {
	IsoDateTimeString,
	OPENROUTER_KEY_MAX_LENGTH,
	OpenRouterKeyAddOnRequiredError,
	OpenRouterKeyDocument,
	OpenRouterKeyPersistenceError,
	OpenRouterKeyValidationError,
	type OrgId,
	type UserId,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgOpenRouterKeys, type OrgOpenRouterKeyRow } from "@maple/db/tables"
import { EdgeCacheService } from "@maple/cache"
import { Clock, Context, Duration, Effect, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { decryptAes256Gcm, encryptAes256Gcm, parseBase64Aes256GcmKey } from "@maple/backend/platform/Crypto"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import { ensureOk, readCustomerCached } from "@maple/backend/services/billing/autumn-client"
import { AutumnClient } from "@maple/backend/services/billing/autumn-http"

/**
 * OpenRouter's "who is this key" endpoint: 200 for a live key, 401 for anything else. The EU
 * instance asks the in-region host its turns use, so a key that host refuses never saves.
 */
const OPENROUTER_KEY_URLS = {
	us: "https://openrouter.ai/api/v1/key",
	eu: "https://eu.openrouter.ai/api/v1/key",
} as const
const VALIDATE_TIMEOUT = Duration.seconds(10)

const decodeIso = Schema.decodeUnknownSync(IsoDateTimeString)

const toPersistenceError = makePersistenceErrorMapper(
	OpenRouterKeyPersistenceError,
	"OpenRouter key persistence failure",
)

/** Binds the ciphertext to its org: a row copied onto another org's id no longer decrypts. */
const keyAad = (orgId: OrgId) => Buffer.from(`org_openrouter_keys:v1:${orgId}`, "utf8")

/**
 * Whether the org holds the add-on. `unknown` is Autumn failing to answer, which callers settle
 * their own way: a write refuses, a run trusts the key it already has.
 */
type Entitlement = "entitled" | "not_entitled" | "unknown"

export interface OrgOpenRouterKeyServiceApi {
	readonly get: (orgId: OrgId) => Effect.Effect<OpenRouterKeyDocument, OpenRouterKeyPersistenceError>
	readonly set: (
		orgId: OrgId,
		userId: UserId,
		apiKey: string,
	) => Effect.Effect<
		OpenRouterKeyDocument,
		OpenRouterKeyPersistenceError | OpenRouterKeyAddOnRequiredError | OpenRouterKeyValidationError
	>
	readonly remove: (orgId: OrgId) => Effect.Effect<OpenRouterKeyDocument, OpenRouterKeyPersistenceError>
	/**
	 * The key an AI turn for this org should run on, or `None` for Maple's own. Never fails: an
	 * unreadable key falls back to Maple's, which still meters the turn.
	 */
	readonly resolveForRun: (orgId: OrgId) => Effect.Effect<Option.Option<Redacted.Redacted<string>>>
}

export class OrgOpenRouterKeyService extends Context.Service<
	OrgOpenRouterKeyService,
	OrgOpenRouterKeyServiceApi
>()("@maple/api/services/OrgOpenRouterKeyService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		const edgeCache = yield* EdgeCacheService
		const autumn = yield* AutumnClient
		const httpClient = yield* HttpClient.HttpClient
		const encryptionKey = yield* parseBase64Aes256GcmKey(
			Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
			(message) => new OpenRouterKeyPersistenceError({ message }),
		)
		const dbExecute = makeDbExecute(database, "OrgOpenRouterKeyService", toPersistenceError)

		const loadRow = (orgId: OrgId) =>
			dbExecute((db) =>
				db.run(
					PG.from(OrgOpenRouterKeys)
						.select()
						.where(($) => [$.orgId.eq(orgId)])
						.limit(1),
				),
			).pipe(Effect.map((rows) => Option.fromUndefinedOr(rows[0])))

		// Billing that is not configured (self-hosted, local dev) has no add-ons to sell: everything is on.
		const entitlement = (orgId: OrgId): Effect.Effect<Entitlement> =>
			readCustomerCached(
				edgeCache,
				orgId,
				autumn.getOrCreateCustomer(orgId, { expand: ["subscriptions.plan"] }),
			).pipe(
				Effect.flatMap(({ result }) => ensureOk(result)),
				Effect.map((customer): Entitlement =>
					customerHasFlag(customer, OPENROUTER_BYOK_FEATURE_ID) ? "entitled" : "not_entitled",
				),
				Effect.catchTags({
					"@maple/http/errors/BillingNotConfiguredError": () =>
						Effect.succeed<Entitlement>("entitled"),
					"@maple/http/errors/BillingUpstreamError": (error) =>
						Effect.logWarning("Could not read the OpenRouter add-on entitlement").pipe(
							Effect.annotateLogs({ orgId, error: error.message }),
							Effect.as<Entitlement>("unknown"),
						),
				}),
			)

		const toDocument = (row: Option.Option<OrgOpenRouterKeyRow>, entitled: Entitlement) =>
			new OpenRouterKeyDocument({
				// An outage reads as entitled: the page should not flash an upsell at a paying org.
				entitled: entitled !== "not_entitled",
				configured: Option.isSome(row),
				keyHint: Option.match(row, { onNone: () => null, onSome: (r) => r.keyHint }),
				updatedAt: Option.match(row, {
					onNone: () => null,
					onSome: (r) => decodeIso(new Date(r.updatedAt).toISOString()),
				}),
				updatedBy: Option.match(row, { onNone: () => null, onSome: (r) => r.updatedBy }),
			})

		const keyUrl = env.MAPLE_REGION === "eu" ? OPENROUTER_KEY_URLS.eu : OPENROUTER_KEY_URLS.us

		const validateWithOpenRouter = (apiKey: string) =>
			httpClient
				.execute(HttpClientRequest.get(keyUrl).pipe(HttpClientRequest.bearerToken(apiKey)))
				.pipe(
					// A redirect is not OpenRouter vouching for the key, so it is not followed.
					Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
					Effect.timeout(VALIDATE_TIMEOUT),
					Effect.mapError(
						() =>
							new OpenRouterKeyPersistenceError({
								message: "Could not reach OpenRouter to check this key. Try again.",
							}),
					),
					Effect.flatMap(
						(
							response,
						): Effect.Effect<
							void,
							OpenRouterKeyPersistenceError | OpenRouterKeyValidationError
						> =>
							response.status === 200
								? Effect.void
								: response.status === 401 || response.status === 403
									? Effect.fail(
											new OpenRouterKeyValidationError({
												message: "OpenRouter rejected this key.",
											}),
										)
									: Effect.fail(
											new OpenRouterKeyPersistenceError({
												message: `OpenRouter answered ${response.status} while checking this key. Try again.`,
											}),
										),
					),
					Effect.withSpan("OrgOpenRouterKeyService.validateWithOpenRouter"),
				)

		const get = Effect.fn("OrgOpenRouterKeyService.get")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const [row, entitled] = yield* Effect.all([loadRow(orgId), entitlement(orgId)], {
				concurrency: "unbounded",
			})
			return toDocument(row, entitled)
		})

		const set = Effect.fn("OrgOpenRouterKeyService.set")(function* (
			orgId: OrgId,
			userId: UserId,
			rawKey: string,
		) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const apiKey = rawKey.trim()
			if (
				!apiKey.startsWith("sk-or-") ||
				apiKey.length < 20 ||
				apiKey.length > OPENROUTER_KEY_MAX_LENGTH
			) {
				return yield* new OpenRouterKeyValidationError({
					message: "That is not an OpenRouter API key. They start with sk-or-.",
				})
			}
			const entitled = yield* entitlement(orgId)
			if (entitled === "not_entitled") {
				return yield* new OpenRouterKeyAddOnRequiredError({
					message: "Add the Bring Your Own OpenRouter Key add-on to use your own key.",
				})
			}
			if (entitled === "unknown") {
				return yield* new OpenRouterKeyPersistenceError({
					message: "Could not confirm your add-on with billing. Try again.",
				})
			}
			yield* validateWithOpenRouter(apiKey)
			const encrypted = yield* encryptAes256Gcm(
				apiKey,
				encryptionKey,
				(message) => new OpenRouterKeyPersistenceError({ message }),
				keyAad(orgId),
			)
			const now = yield* Clock.currentTimeMillis
			const next = {
				keyCiphertext: encrypted.ciphertext,
				keyIv: encrypted.iv,
				keyTag: encrypted.tag,
				keyHint: apiKey.slice(-4),
				updatedAt: now,
				updatedBy: userId,
			}
			yield* dbExecute((db) =>
				db.run(
					PG.insertInto(OrgOpenRouterKeys)
						.values({ orgId, createdAt: now, ...next })
						.onConflictDoUpdate({ target: ["orgId"], set: next }),
				),
			)
			return toDocument(yield* loadRow(orgId), entitled)
		})

		const remove = Effect.fn("OrgOpenRouterKeyService.remove")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			yield* dbExecute((db) =>
				db.run(PG.deleteFrom(OrgOpenRouterKeys).where(($) => [$.orgId.eq(orgId)])),
			)
			return toDocument(Option.none(), yield* entitlement(orgId))
		})

		const resolveForRun = Effect.fn("OrgOpenRouterKeyService.resolveForRun")(
			function* (orgId: OrgId) {
				const row = yield* loadRow(orgId)
				if (Option.isNone(row)) return Option.none<Redacted.Redacted<string>>()
				// A lapsed add-on stops the key being used; Autumn being down does not.
				if ((yield* entitlement(orgId)) === "not_entitled") {
					yield* Effect.annotateCurrentSpan("maple.llm.byok_lapsed", true)
					return Option.none<Redacted.Redacted<string>>()
				}
				const apiKey = yield* decryptAes256Gcm(
					{ ciphertext: row.value.keyCiphertext, iv: row.value.keyIv, tag: row.value.keyTag },
					encryptionKey,
					(message) => new OpenRouterKeyPersistenceError({ message }),
					keyAad(orgId),
				)
				return Option.some(Redacted.make(apiKey))
			},
			(effect, orgId) =>
				effect.pipe(
					Effect.catchCause((cause) =>
						Effect.logError("Could not read the org's OpenRouter key; using Maple's").pipe(
							Effect.annotateLogs({ orgId, cause }),
							Effect.as(Option.none<Redacted.Redacted<string>>()),
						),
					),
				),
		)

		return { get, set, remove, resolveForRun } satisfies OrgOpenRouterKeyServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(AutumnClient.layer),
		Layer.provide(FetchHttpClient.layer),
	)
}
