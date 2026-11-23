import { randomBytes, randomInt, randomUUID } from "node:crypto"
import {
	CliDeviceActionResponse,
	CliDeviceCompleteResponse,
	CliDeviceConflictError,
	CliDeviceDeniedResponse,
	CliDeviceExpiredError,
	CliDeviceExpiredResponse,
	CliDeviceInfoResponse,
	CliDeviceNotFoundError,
	CliDevicePendingResponse,
	CliDevicePersistenceError,
	CliDeviceRateLimitError,
	CliDeviceStartResponse,
	ApiKeyId,
	type OrgId,
	type RoleName,
	type UserId,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { ONBOARDING_HANDOFF_TTL_MS } from "@maple/domain/onboarding-agent-run"
import { generateApiKey, hashApiKey, hashLookupToken } from "../../platform/credential-tokens"
import {
	ApiKeys,
	CliDeviceAuthorizations,
	OnboardingAgentRuns,
	type CliDeviceAuthorizationRow,
} from "@maple/db/tables"
import { DateTime, Clock, Context, Effect, Layer, Option, Schema, String as Str } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { ingestKeyLookupHmacKey } from "@maple/backend/platform/Crypto"
import { Env } from "@maple/backend/platform/Env"
import { openSecret, sealSecret, secretKeyringFromEnv } from "@maple/backend/platform/SecretBox"
import { cliDeviceTokenSlot } from "@maple/backend/platform/secret-slots"
import { CliAuthRateLimit } from "@maple/backend/platform/bindings"

const DEVICE_TTL_SECONDS = 15 * 60
/**
 * How long the credential `maple auth login` mints is good for.
 *
 * It used to be forever: a `standard` key with no `expiresAt`, sitting in a
 * dotfile on a laptop, outliving the login, the laptop and the membership.
 * 90 days matches the MCP grant's absolute ceiling and is long enough that a
 * working developer re-runs `maple auth login` about once a quarter.
 */
const CLI_KEY_TTL_MS = 90 * 24 * 60 * 60 * 1000
const POLL_INTERVAL_SECONDS = 5
/** Marks a handoff code for people and secret scanners; the whole string is the device code. */
export const HANDOFF_CODE_PREFIX = "maple_ho_"
export const HANDOFF_DEVICE_NAME = "Coding agent (onboarding)"
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
/** A typed-in device name never takes the handoff's, which marks a row single-use. */
const deviceLabel = (deviceName: string) => {
	const label = Str.slice(0, 120)(Str.trim(deviceName))
	return label === "" || label === HANDOFF_DEVICE_NAME ? "Maple CLI" : label
}
const normalizeUserCode = (value: string) => Str.replace(/[^A-Z0-9]/g, "")(Str.toUpperCase(value))
const displayUserCode = (value: string) => `${Str.slice(0, 4)(value)}-${Str.slice(4, 8)(value)}`
const decodeApiKeyId = Schema.decodeUnknownSync(ApiKeyId)

/** A handoff's run closed or was replaced before the claim: the claim rolls back, the CLI hears expired. */
class HandoffRunClosed extends Schema.TaggedError<HandoffRunClosed>()(
	"@maple/backend/CliDeviceHandoffRunClosed",
	{ message: Schema.String },
) {}

const makeUserCode = () => {
	let value = ""
	for (let index = 0; index < 8; index += 1) {
		value += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]
	}
	return value
}

// These errors answer unauthenticated callers; `makeDbExecute` has already logged the driver's message.
const persistenceError = () =>
	new CliDevicePersistenceError({ message: "CLI device authorization is temporarily unavailable" })

type ApprovalIdentity = {
	readonly orgId: OrgId
	readonly userId: UserId
	readonly roles: ReadonlyArray<RoleName>
	readonly userEmail: string | null
}

type PollResponse =
	| CliDevicePendingResponse
	| CliDeviceCompleteResponse
	| CliDeviceDeniedResponse
	| CliDeviceExpiredResponse

export class CliDeviceAuthService extends Context.Service<
	CliDeviceAuthService,
	{
		readonly start: (
			deviceName: string,
			requesterKey: string,
		) => Effect.Effect<CliDeviceStartResponse, CliDevicePersistenceError | CliDeviceRateLimitError>
		readonly poll: (
			deviceCode: string,
		) => Effect.Effect<
			| CliDevicePendingResponse
			| CliDeviceCompleteResponse
			| CliDeviceDeniedResponse
			| CliDeviceExpiredResponse,
			CliDevicePersistenceError | CliDeviceRateLimitError
		>
		readonly inspect: (
			userCode: string,
		) => Effect.Effect<
			CliDeviceInfoResponse,
			CliDeviceNotFoundError | CliDeviceExpiredError | CliDevicePersistenceError
		>
		readonly approve: (
			userCode: string,
			identity: ApprovalIdentity,
		) => Effect.Effect<
			CliDeviceActionResponse,
			| CliDeviceNotFoundError
			| CliDeviceExpiredError
			| CliDeviceConflictError
			| CliDevicePersistenceError
		>
		readonly deny: (
			userCode: string,
		) => Effect.Effect<
			CliDeviceActionResponse,
			| CliDeviceNotFoundError
			| CliDeviceExpiredError
			| CliDeviceConflictError
			| CliDevicePersistenceError
		>
		/**
		 * A device login the signed-in person approves in advance, for a coding agent. The code
		 * is the device code: `maple auth login` with `MAPLE_HANDOFF` polls it like any other.
		 */
		readonly createHandoff: (
			identity: ApprovalIdentity,
		) => Effect.Effect<
			{ readonly code: string; readonly codeHash: string; readonly expiresAt: number },
			CliDevicePersistenceError | CliDeviceRateLimitError
		>
	}
>()("@maple/backend/services/CliDeviceAuthService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const dbExecute = makeDbExecute(database, "CliDeviceAuthService", persistenceError)
		const env = yield* Env
		// Absent outside the api Worker (tests, the CLI): the check then passes.
		const rateLimit = yield* Effect.serviceOption(CliAuthRateLimit)
		const apiKeyHmacKey = yield* ingestKeyLookupHmacKey(
			env,
			(message) => new CliDevicePersistenceError({ message }),
		)
		const keyring = yield* secretKeyringFromEnv(
			env,
			(message) => new CliDevicePersistenceError({ message }),
		)

		const purgeExpired = Effect.fn("CliDeviceAuthService.purgeExpired")(function* (now: number) {
			yield* dbExecute((db) =>
				db.run(PG.deleteFrom(CliDeviceAuthorizations).where(($) => [$.expiresAt.lt(now)])),
			)
		})

		const checkRateLimit = Effect.fn("CliDeviceAuthService.checkRateLimit")(function* (key: string) {
			if (Option.isNone(rateLimit)) return
			// A limiter outage fails open: the login is not refused for it.
			const outcome = yield* rateLimit.value
				.limit(`${env.MAPLE_ENVIRONMENT}:cli-auth:${key}`)
				.pipe(Effect.orElseSucceed(() => undefined))
			if (outcome && !outcome.success) {
				return yield* new CliDeviceRateLimitError({
					message: "Too many CLI login attempts. Wait a minute and try again.",
				})
			}
		})

		const findByUserCode = Effect.fn("CliDeviceAuthService.findByUserCode")(function* (userCode: string) {
			const normalized = normalizeUserCode(userCode)
			if (normalized.length !== 8) {
				return yield* new CliDeviceNotFoundError({ message: "CLI login code not found" })
			}
			const rows = yield* dbExecute((db) =>
				db.run(
					PG.from(CliDeviceAuthorizations)
						.select()
						.where(($) => [
							$.userCodeHash.eq(
								hashLookupToken("cli-device/user-code", normalized, apiKeyHmacKey),
							),
						])
						.limit(1),
				),
			)
			const row = Option.fromNullishOr(rows[0])
			if (Option.isNone(row)) {
				return yield* new CliDeviceNotFoundError({ message: "CLI login code not found" })
			}
			return { row: row.value, normalized }
		})

		const requireActive = Effect.fn("CliDeviceAuthService.requireActive")(function* (userCode: string) {
			const found = yield* findByUserCode(userCode)
			const now = yield* Clock.currentTimeMillis
			if (found.row.expiresAt <= now) {
				return yield* new CliDeviceExpiredError({ message: "CLI login code has expired" })
			}
			return found
		})

		const start = Effect.fn("CliDeviceAuthService.start")(function* (
			deviceName: string,
			requesterKey: string,
		) {
			yield* checkRateLimit(`start:${requesterKey}`)
			const now = yield* Clock.currentTimeMillis
			yield* purgeExpired(now)
			const deviceCode = randomBytes(32).toString("base64url")
			const userCode = makeUserCode()
			const verificationUri = `${Str.replace(/\/+$/, "")(env.MAPLE_APP_BASE_URL)}/cli-login`
			yield* dbExecute((db) =>
				db.run(
					PG.insertInto(CliDeviceAuthorizations).values({
						deviceCodeHash: hashLookupToken("cli-device/device-code", deviceCode, apiKeyHmacKey),
						userCodeHash: hashLookupToken("cli-device/user-code", userCode, apiKeyHmacKey),
						deviceName: deviceLabel(deviceName),
						createdAt: now,
						expiresAt: now + DEVICE_TTL_SECONDS * 1000,
					}),
				),
			)
			const displayed = displayUserCode(userCode)
			return new CliDeviceStartResponse({
				deviceCode,
				userCode: displayed,
				verificationUri,
				verificationUriComplete: `${verificationUri}?user_code=${encodeURIComponent(displayed)}`,
				expiresIn: DEVICE_TTL_SECONDS,
				interval: POLL_INTERVAL_SECONDS,
			})
		})

		const inspect = Effect.fn("CliDeviceAuthService.inspect")(function* (userCode: string) {
			const { row, normalized } = yield* requireActive(userCode)
			const status =
				row.deniedAt !== null
					? ("denied" as const)
					: row.apiKeyId
						? ("complete" as const)
						: row.approvedAt !== null
							? ("approved" as const)
							: ("pending" as const)
			return new CliDeviceInfoResponse({
				userCode: displayUserCode(normalized),
				deviceName: row.deviceName,
				expiresAt: DateTime.formatIso(DateTime.makeUnsafe(row.expiresAt)),
				status,
			})
		})

		const approve = Effect.fn("CliDeviceAuthService.approve")(function* (
			userCode: string,
			identity: ApprovalIdentity,
		) {
			const { row } = yield* requireActive(userCode)
			if (row.approvedAt !== null || row.deniedAt !== null) {
				return yield* new CliDeviceConflictError({ message: "CLI login code was already used" })
			}
			const now = yield* Clock.currentTimeMillis
			const updated = yield* dbExecute((db) =>
				db.run(
					PG.update(CliDeviceAuthorizations)
						.set({
							approvedOrgId: identity.orgId,
							approvedUserId: identity.userId,
							approvedRoles: [...identity.roles],
							approvedUserEmail: identity.userEmail,
							approvedAt: now,
						})
						.where(($) => [
							$.deviceCodeHash.eq(row.deviceCodeHash),
							$.approvedAt.isNull(),
							$.deniedAt.isNull(),
						])
						.returning("deviceCodeHash"),
				),
			)
			if (updated.length === 0) {
				return yield* new CliDeviceConflictError({ message: "CLI login code was already used" })
			}
			return new CliDeviceActionResponse({ status: "approved" })
		})

		const deny = Effect.fn("CliDeviceAuthService.deny")(function* (userCode: string) {
			const { row } = yield* requireActive(userCode)
			if (row.approvedAt !== null || row.deniedAt !== null) {
				return yield* new CliDeviceConflictError({ message: "CLI login code was already used" })
			}
			const now = yield* Clock.currentTimeMillis
			const updated = yield* dbExecute((db) =>
				db.run(
					PG.update(CliDeviceAuthorizations)
						.set({ deniedAt: now })
						.where(($) => [
							$.deviceCodeHash.eq(row.deviceCodeHash),
							$.approvedAt.isNull(),
							$.deniedAt.isNull(),
						])
						.returning("deviceCodeHash"),
				),
			)
			if (updated.length === 0) {
				return yield* new CliDeviceConflictError({ message: "CLI login code was already used" })
			}
			return new CliDeviceActionResponse({ status: "denied" })
		})

		const loadByDeviceCode = Effect.fn("CliDeviceAuthService.loadByDeviceCode")(function* (
			deviceCode: string,
		) {
			return yield* loadByDeviceCodeHash(
				hashLookupToken("cli-device/device-code", deviceCode, apiKeyHmacKey),
			)
		})

		const loadByDeviceCodeHash = Effect.fn("CliDeviceAuthService.loadByDeviceCodeHash")(function* (
			deviceCodeHash: string,
		) {
			const rows = yield* dbExecute((db) =>
				db.run(
					PG.from(CliDeviceAuthorizations)
						.select()
						.where(($) => [$.deviceCodeHash.eq(deviceCodeHash)])
						.limit(1),
				),
			)
			return Option.fromNullishOr(rows[0])
		})

		const completeFromRow: (
			row: CliDeviceAuthorizationRow,
		) => Effect.Effect<PollResponse, CliDevicePersistenceError> = Effect.fn(
			"CliDeviceAuthService.completeFromRow",
		)(function* (row: CliDeviceAuthorizationRow) {
			const { approvedOrgId, approvedUserId, approvedRoles } = row
			if (!approvedOrgId || !approvedUserId || !approvedRoles) {
				return new CliDevicePendingResponse({ status: "pending", interval: POLL_INTERVAL_SECONDS })
			}
			if (row.tokenCiphertext && row.tokenIv && row.tokenTag) {
				const token = yield* openSecret(
					keyring,
					cliDeviceTokenSlot,
					{ deviceCodeHash: row.deviceCodeHash },
					{ ciphertext: row.tokenCiphertext, iv: row.tokenIv, tag: row.tokenTag },
					(message) => new CliDevicePersistenceError({ message }),
				)
				return new CliDeviceCompleteResponse({
					status: "complete",
					token,
					orgId: approvedOrgId,
					userId: approvedUserId,
				})
			}

			const apiKeyId = decodeApiKeyId(randomUUID())
			const rawToken = generateApiKey()
			// Sealed for the row the claiming UPDATE below targets.
			const encrypted = yield* sealSecret(
				keyring,
				cliDeviceTokenSlot,
				{ deviceCodeHash: row.deviceCodeHash },
				rawToken,
				(message) => new CliDevicePersistenceError({ message }),
			)
			const now = yield* Clock.currentTimeMillis
			const isHandoff = row.deviceName === HANDOFF_DEVICE_NAME
			const won = yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						const claimed = yield* db.run(
							PG.update(CliDeviceAuthorizations)
								.set({
									apiKeyId,
									tokenCiphertext: encrypted.ciphertext,
									tokenIv: encrypted.iv,
									tokenTag: encrypted.tag,
								})
								.where(($) => [
									$.deviceCodeHash.eq(row.deviceCodeHash),
									$.apiKeyId.isNull(),
									// A handoff lapses at its own deadline, checked again at the claim.
									...(isHandoff ? [$.expiresAt.gt(now)] : []),
								])
								.returning("deviceCodeHash"),
						)
						if (claimed.length === 0) return false
						// A handoff's key is the only credential that reports to the run it started,
						// and only while that run is open: a replaced or closed run rolls the claim back.
						if (isHandoff) {
							const bound = yield* db.run(
								PG.update(OnboardingAgentRuns)
									.set({ apiKeyId })
									.where(($) => [
										$.orgId.eq(approvedOrgId),
										$.handoffCodeHash.eq(row.deviceCodeHash),
										$.apiKeyId.isNull(),
										$.status.neq("completed"),
										$.status.neq("failed"),
										$.status.neq("expired"),
										$.expiresAt.gt(now),
									])
									.returning("id"),
							)
							if (bound.length !== 1) {
								return yield* new HandoffRunClosed({ message: "The handoff's run is closed" })
							}
						}
						yield* db.run(
							PG.insertInto(ApiKeys).values({
								id: apiKeyId,
								orgId: approvedOrgId,
								name: row.deviceName,
								description: "Created by maple auth login",
								keyHash: hashApiKey(rawToken, apiKeyHmacKey),
								keyPrefix: Str.slice(0, 12)(rawToken) + "...",
								kind: "standard",
								scopes: null,
								metadataJson: {
									source: "maple_cli",
									roles: [...approvedRoles],
									deviceName: row.deviceName,
								},
								expiresAt: now + CLI_KEY_TTL_MS,
								createdAt: now,
								createdBy: approvedUserId,
								createdByEmail: row.approvedUserEmail,
							}),
						)
						return true
					}),
				),
			).pipe(Effect.catchTag("@maple/backend/CliDeviceHandoffRunClosed", () => Effect.succeed(false)))
			// A handoff is single use: a concurrent claim that lost gets nothing, not the winner's key.
			if (!won && isHandoff) {
				return new CliDeviceExpiredResponse({ status: "expired" })
			}
			if (!won) {
				const winner = yield* loadByDeviceCodeHash(row.deviceCodeHash)
				if (
					Option.isSome(winner) &&
					winner.value.tokenCiphertext &&
					winner.value.tokenIv &&
					winner.value.tokenTag
				) {
					const token = yield* openSecret(
						keyring,
						cliDeviceTokenSlot,
						{ deviceCodeHash: winner.value.deviceCodeHash },
						{
							ciphertext: winner.value.tokenCiphertext,
							iv: winner.value.tokenIv,
							tag: winner.value.tokenTag,
						},
						(message) => new CliDevicePersistenceError({ message }),
					)
					return new CliDeviceCompleteResponse({
						status: "complete",
						token,
						orgId: approvedOrgId,
						userId: approvedUserId,
					})
				}
				return yield* new CliDevicePersistenceError({ message: "CLI credential issuance raced" })
			}
			return new CliDeviceCompleteResponse({
				status: "complete",
				token: rawToken,
				orgId: approvedOrgId,
				userId: approvedUserId,
			})
		})

		const poll = Effect.fn("CliDeviceAuthService.poll")(function* (deviceCode: string) {
			yield* checkRateLimit(
				`poll:${hashLookupToken("cli-device/device-code", deviceCode, apiKeyHmacKey)}`,
			)
			const row = yield* loadByDeviceCode(deviceCode)
			if (Option.isNone(row)) return new CliDeviceExpiredResponse({ status: "expired" })
			const now = yield* Clock.currentTimeMillis
			if (row.value.expiresAt <= now) {
				yield* purgeExpired(now)
				return new CliDeviceExpiredResponse({ status: "expired" })
			}
			if (row.value.deniedAt !== null) return new CliDeviceDeniedResponse({ status: "denied" })
			// A handoff code travels through an agent's transcript: it signs in once, never again.
			if (row.value.deviceName === HANDOFF_DEVICE_NAME && row.value.apiKeyId !== null) {
				return new CliDeviceExpiredResponse({ status: "expired" })
			}
			if (row.value.approvedAt === null) {
				return new CliDevicePendingResponse({ status: "pending", interval: POLL_INTERVAL_SECONDS })
			}
			return yield* completeFromRow(row.value)
		})

		const createHandoff = Effect.fn("CliDeviceAuthService.createHandoff")(function* (
			identity: ApprovalIdentity,
		) {
			yield* checkRateLimit(`handoff:${identity.orgId}:${identity.userId}`)
			const now = yield* Clock.currentTimeMillis
			yield* purgeExpired(now)
			const code = `${HANDOFF_CODE_PREFIX}${randomBytes(32).toString("base64url")}`
			const expiresAt = now + ONBOARDING_HANDOFF_TTL_MS
			const codeHash = hashLookupToken("cli-device/device-code", code, apiKeyHmacKey)
			yield* dbExecute((db) =>
				db.run(
					PG.insertInto(CliDeviceAuthorizations).values({
						deviceCodeHash: codeHash,
						// Never typed: a random user code keeps the unique index without a usable value.
						userCodeHash: hashLookupToken("cli-device/user-code", randomUUID(), apiKeyHmacKey),
						deviceName: HANDOFF_DEVICE_NAME,
						approvedOrgId: identity.orgId,
						approvedUserId: identity.userId,
						approvedRoles: [...identity.roles],
						approvedUserEmail: identity.userEmail,
						approvedAt: now,
						createdAt: now,
						expiresAt,
					}),
				),
			)
			return { code, codeHash, expiresAt }
		})

		return { start, poll, inspect, approve, deny, createHandoff }
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
