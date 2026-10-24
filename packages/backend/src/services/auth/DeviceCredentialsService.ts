import { randomUUID } from "node:crypto"
import * as PG from "@maple-dev/effect-orm/postgres"
import { DeviceCredentials, DeviceProofReplays, type DeviceCredentialRow } from "@maple/db/tables"
import {
	DeviceAttestationInvalidError,
	DeviceCredentialInvalidError,
	DeviceCredentialPersistenceError,
	DeviceKeyInUseError,
	DeviceKeyInvalidError,
	DeviceTokensUnavailableError,
	DpopProofInvalidError,
	type OrgId,
	type RoleName,
	type UserId,
} from "@maple/domain/http"
import { DeviceCredentialId } from "@maple/domain/primitives"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import { AppAttestTrustAnchor, verifyAppAttestation } from "./device/app-attest"
import {
	ATTEST_CHALLENGE_AUDIENCE,
	ATTEST_CHALLENGE_TYPE,
	DEVICE_TOKEN_AUDIENCE,
	DEVICE_TOKEN_TYPE,
	type DeviceTokenSigner,
	makeDeviceTokenSigner,
} from "./device/device-token-signer"
import {
	DPOP_MAX_SKEW_SECONDS,
	DpopProofRejected,
	type VerifiedDpopProof,
	verifyDpopProof,
} from "./device/dpop-proof"
import { base64url, EcPublicJwk, importEcPublicJwk, jwkThumbprint, sha256 } from "./device/jose"

/** Every ceiling is the server's: a registering client names a key and nothing else. */
export const DEVICE_CREDENTIAL_SCOPES = ["widget_summary:read"] as const
const ROLLING_TTL_MS = 30 * 24 * 60 * 60 * 1000
const HARD_CAP_MS = 90 * 24 * 60 * 60 * 1000
export const DEVICE_TOKEN_TTL_SECONDS = 60 * 60
const CHALLENGE_TTL_SECONDS = 5 * 60
/** A proof's jti stays recorded until no proof with that iat could be accepted any more. */
const REPLAY_RETENTION_SECONDS = DPOP_MAX_SKEW_SECONDS * 2
const LAST_USED_HEARTBEAT_MS = 5 * 60_000

/** A DPoP-authenticated request's credential, resolved and live. */
export interface ResolvedDeviceCredential {
	readonly credentialId: DeviceCredentialId
	readonly orgId: OrgId
	readonly userId: UserId
	readonly roles: ReadonlyArray<RoleName>
	readonly scopes: ReadonlyArray<string>
}

/** A resource request's access token is not one this server issued, or is no longer valid. */
export class DeviceTokenRejected extends Schema.TaggedError<DeviceTokenRejected>()(
	"@maple/backend/auth/device/DeviceTokenRejected",
	{ message: Schema.String, reason: Schema.String },
) {}

export interface DeviceAttestationParams {
	readonly keyId: string
	readonly attestationObject: string
	readonly challenge: string
}

export interface RegisterDeviceCredentialParams {
	readonly installationId: string
	readonly publicJwk: EcPublicJwk
	readonly attestation?: DeviceAttestationParams
}

export interface DpopRequest {
	readonly proof: string | undefined
	readonly method: string
	/** Path (and query) of the request; the origin is always Maple's configured API base URL. */
	readonly path: string
}

const AccessTokenClaims = Schema.Struct({
	sub: DeviceCredentialId,
	org_id: Schema.String,
	scope: Schema.String,
	cnf: Schema.Struct({ jkt: Schema.String }),
})
const ChallengeClaims = Schema.Struct({
	sub: Schema.String,
	org_id: Schema.String,
	installation_id: Schema.String,
	jti: Schema.String,
	exp: Schema.Number,
})
const decodeAccessTokenClaims = Schema.decodeUnknownOption(AccessTokenClaims)
const decodeChallengeClaims = Schema.decodeUnknownOption(ChallengeClaims)
const decodeCredentialId = Schema.decodeUnknownSync(DeviceCredentialId)

const replayKey = (kind: string, ...parts: ReadonlyArray<string>) =>
	base64url(sha256([kind, ...parts].join("\n")))

const isLive = (row: DeviceCredentialRow, now: number) =>
	row.revokedAt === null && row.expiresAt > now && row.hardExpiresAt > now

const liveForInstallation =
	(orgId: OrgId, installationId: string) => ($: PG.ColumnAccessor<typeof DeviceCredentials.columns>) => [
		$.orgId.eq(orgId),
		$.installationId.eq(installationId),
		$.revokedAt.isNull(),
	]

export class DeviceCredentialsService extends Context.Service<DeviceCredentialsService>()(
	"@maple/backend/services/auth/DeviceCredentialsService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			const dbExecute = makeDbExecute(
				database,
				"DeviceCredentialsService",
				makePersistenceErrorMapper(
					DeviceCredentialPersistenceError,
					"Device credential persistence failed",
				),
			)
			const issuer = env.MAPLE_API_BASE_URL.replace(/\/+$/u, "")
			// No key, or one that does not load: registration works, token issuance answers 503.
			const signer: Option.Option<DeviceTokenSigner> = yield* Option.match(
				env.MAPLE_DEVICE_TOKEN_SIGNING_KEY,
				{
					onNone: () => Effect.succeedNone,
					onSome: (key) =>
						makeDeviceTokenSigner(issuer, key).pipe(
							Effect.tapError((error) =>
								Effect.logWarning(`Device tokens disabled: ${error.message}`),
							),
							Effect.option,
						),
				},
			)
			const appId = Option.map(env.APNS_TEAM_ID, (team) => `${team}.${env.MAPLE_IOS_BUNDLE_ID}`)
			const lastUsedMemo = new Map<string, number>()
			const trustAnchor = yield* AppAttestTrustAnchor

			const requireSigner = Option.match(signer, {
				onNone: () =>
					Effect.fail(
						new DeviceTokensUnavailableError({
							message: "MAPLE_DEVICE_TOKEN_SIGNING_KEY is not configured",
						}),
					),
				onSome: Effect.succeed,
			})

			/** Record a single-use value; false when it was already recorded (a replay). */
			const consumeOnce = (key: string, expiresAt: number) =>
				dbExecute((db) =>
					db.run(
						PG.insertInto(DeviceProofReplays)
							.values({ key, expiresAt })
							.onConflictDoNothing()
							.returning(($) => ({ key: $.key })),
					),
				).pipe(Effect.map((rows) => rows.length > 0))

			const attestationChallenge = Effect.fn("DeviceCredentialsService.attestationChallenge")(
				function* (orgId: OrgId, userId: UserId, installationId: string) {
					yield* Effect.annotateCurrentSpan({
						orgId,
						"tenant.userId": userId,
						"maple.device.installation_id": installationId,
					})
					const found = yield* requireSigner
					const now = yield* Clock.currentTimeMillis
					const challenge = yield* found
						.sign(
							ATTEST_CHALLENGE_TYPE,
							ATTEST_CHALLENGE_AUDIENCE,
							{
								sub: userId,
								org_id: orgId,
								installation_id: installationId,
								jti: randomUUID(),
							},
							now,
							CHALLENGE_TTL_SECONDS,
						)
						.pipe(
							Effect.mapError(
								(error) => new DeviceTokensUnavailableError({ message: error.message }),
							),
						)
					return {
						challenge,
						expiresAt: Math.floor(now / 1000) * 1000 + CHALLENGE_TTL_SECONDS * 1000,
					}
				},
			)

			const attestationFailure = (reason: string, message: string) =>
				Effect.fail(new DeviceAttestationInvalidError({ reason, message }))

			const verifyAttestation = Effect.fn("DeviceCredentialsService.verifyAttestation")(function* (
				orgId: OrgId,
				userId: UserId,
				installationId: string,
				jkt: string,
				attestation: DeviceAttestationParams,
				now: number,
			) {
				if (Option.isNone(appId)) {
					return yield* attestationFailure(
						"unconfigured",
						"This deployment does not verify App Attest attestations.",
					)
				}
				const found = yield* Option.match(signer, {
					onNone: () =>
						attestationFailure(
							"unconfigured",
							"This deployment cannot issue attestation challenges.",
						),
					onSome: Effect.succeed,
				})
				const payload = yield* found
					.verify(attestation.challenge, ATTEST_CHALLENGE_TYPE, ATTEST_CHALLENGE_AUDIENCE, now)
					.pipe(
						Effect.mapError(
							() =>
								new DeviceAttestationInvalidError({
									reason: "challenge",
									message: "The challenge is invalid or expired.",
								}),
						),
					)
				const claims = decodeChallengeClaims(payload)
				if (
					Option.isNone(claims) ||
					claims.value.sub !== userId ||
					claims.value.org_id !== orgId ||
					claims.value.installation_id !== installationId
				) {
					return yield* attestationFailure(
						"challenge",
						"The challenge was issued for another registration.",
					)
				}
				const result = yield* verifyAppAttestation({
					attestationObject: new Uint8Array(Buffer.from(attestation.attestationObject, "base64")),
					keyId: new Uint8Array(Buffer.from(attestation.keyId, "base64")),
					clientDataHash: sha256(`${attestation.challenge}.${jkt}`),
					appId: appId.value,
					allowDevelopment: env.MAPLE_APP_ATTEST_ALLOW_DEVELOPMENT,
					nowMs: now,
					rootCertificate: trustAnchor,
				})
				// Consumed only once it verified, so a failed attempt can retry with the same challenge.
				const fresh = yield* consumeOnce(
					replayKey("attest", claims.value.jti),
					claims.value.exp * 1000,
				).pipe(
					Effect.mapError(
						() =>
							new DeviceAttestationInvalidError({
								reason: "challenge",
								message: "The challenge could not be recorded.",
							}),
					),
				)
				if (!fresh) return yield* attestationFailure("challenge", "The challenge was already used.")
				return {
					keyId: attestation.keyId,
					environment: result.environment,
					counter: result.counter,
					...(result.receipt === undefined
						? undefined
						: { receipt: Buffer.from(result.receipt).toString("base64") }),
					verifiedAt: now,
				}
			})

			/**
			 * Register (or refresh) the installation's key. A new key retires the installation's
			 * previous credential in the same transaction; the same key again extends the rolling
			 * expiry, never past the hard cap, and re-pins the session's current roles.
			 */
			const register = Effect.fn("DeviceCredentialsService.register")(function* (
				tenant: {
					readonly orgId: OrgId
					readonly userId: UserId
					readonly roles: ReadonlyArray<RoleName>
				},
				params: RegisterDeviceCredentialParams,
			) {
				yield* Effect.annotateCurrentSpan({
					orgId: tenant.orgId,
					"tenant.userId": tenant.userId,
					"maple.device.installation_id": params.installationId,
					"maple.device.attestation_present": params.attestation !== undefined,
				})
				yield* importEcPublicJwk(params.publicJwk).pipe(
					Effect.mapError((error) => new DeviceKeyInvalidError({ message: error.message })),
				)
				const jkt = jwkThumbprint(params.publicJwk)
				const now = yield* Clock.currentTimeMillis
				const attestation =
					params.attestation === undefined
						? undefined
						: yield* verifyAttestation(
								tenant.orgId,
								tenant.userId,
								params.installationId,
								jkt,
								params.attestation,
								now,
							).pipe(
								Effect.tapError((error) =>
									Effect.annotateCurrentSpan(
										"maple.device.attestation_rejected_reason",
										error.reason,
									),
								),
							)

				const row = yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							const [existing] = yield* db.run(
								PG.from(DeviceCredentials)
									.select()
									.where(($) => [$.jkt.eq(jkt)])
									.limit(1),
							)
							if (existing !== undefined) {
								const sameRegistration =
									existing.orgId === tenant.orgId &&
									existing.userId === tenant.userId &&
									existing.installationId === params.installationId &&
									isLive(existing, now)
								if (!sameRegistration)
									return yield* new DeviceKeyInUseError({
										message: "The key is already registered.",
									})
								const [refreshed] = yield* db.run(
									PG.update(DeviceCredentials)
										.set({
											expiresAt: Math.min(now + ROLLING_TTL_MS, existing.hardExpiresAt),
											roles: [...tenant.roles],
											...(attestation === undefined
												? undefined
												: { attested: true, attestation }),
										})
										.where(($) => [$.id.eq(existing.id), $.revokedAt.isNull()])
										.returning(),
								)
								return (
									refreshed ??
									(yield* new DeviceKeyInUseError({ message: "The key was revoked." }))
								)
							}
							yield* db.run(
								PG.update(DeviceCredentials)
									.set({ revokedAt: now })
									.where(liveForInstallation(tenant.orgId, params.installationId)),
							)
							const [inserted] = yield* db.run(
								PG.insertInto(DeviceCredentials)
									.values({
										id: decodeCredentialId(randomUUID()),
										orgId: tenant.orgId,
										userId: tenant.userId,
										installationId: params.installationId,
										publicJwk: params.publicJwk,
										jkt,
										roles: [...tenant.roles],
										scopes: [...DEVICE_CREDENTIAL_SCOPES],
										attested: attestation !== undefined,
										attestation: attestation ?? null,
										createdAt: now,
										lastUsedAt: null,
										expiresAt: now + ROLLING_TTL_MS,
										hardExpiresAt: now + HARD_CAP_MS,
										revokedAt: null,
									})
									.returning(),
							)
							return (
								inserted ??
								(yield* new DeviceCredentialPersistenceError({
									message: "Insert returned no row",
								}))
							)
						}),
					),
				)
				yield* Effect.annotateCurrentSpan({
					"maple.device.credential_id": row.id,
					"maple.device.attested": row.attested,
				})
				return row
			})

			const revoke = Effect.fn("DeviceCredentialsService.revoke")(function* (
				orgId: OrgId,
				installationId: string,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.device.installation_id": installationId })
				const now = yield* Clock.currentTimeMillis
				const revoked = yield* dbExecute((db) =>
					db.run(
						PG.update(DeviceCredentials)
							.set({ revokedAt: now })
							.where(liveForInstallation(orgId, installationId))
							.returning("id"),
					),
				)
				yield* Effect.annotateCurrentSpan("maple.device.revoked_count", revoked.length)
				return revoked.length
			})

			const proofFailure = (error: DpopProofRejected) =>
				Effect.annotateCurrentSpan("maple.dpop.rejected_reason", error.reason).pipe(
					Effect.andThen(Effect.fail(error)),
				)

			/** Verify a proof's signature and claims for `request`; replay is checked separately. */
			const checkProof = (request: DpopRequest, now: number, accessToken?: string) => {
				if (request.proof === undefined || request.proof.length === 0) {
					return proofFailure(
						new DpopProofRejected({
							reason: "missing",
							message: "A DPoP proof header is required.",
						}),
					)
				}
				return verifyDpopProof({
					proof: request.proof,
					method: request.method,
					url: `${issuer}${request.path}`,
					nowMs: now,
					...(accessToken === undefined ? undefined : { accessToken }),
				}).pipe(Effect.catchTag("@maple/backend/auth/device/DpopProofRejected", proofFailure))
			}

			/**
			 * Record the proof's jti; a reused one is a replay. Called only once the key is known to
			 * belong to a live credential, so proofs from arbitrary keys never reach the write path.
			 */
			const consumeProof = (proof: VerifiedDpopProof) =>
				consumeOnce(
					replayKey("dpop", proof.jkt, proof.jti),
					(proof.iat + REPLAY_RETENTION_SECONDS) * 1000,
				).pipe(
					Effect.flatMap((fresh) =>
						fresh
							? Effect.void
							: proofFailure(
									new DpopProofRejected({
										reason: "replay",
										message: "The proof jti was already used.",
									}),
								),
					),
				)

			const loadLive = (credentialId: DeviceCredentialId, now: number) =>
				dbExecute((db) =>
					db.run(
						PG.from(DeviceCredentials)
							.select()
							.where(($) => [$.id.eq(credentialId)])
							.limit(1),
					),
				).pipe(
					Effect.map(([row]) =>
						row !== undefined && isLive(row, now) ? Option.some(row) : Option.none(),
					),
				)

			const touchLastUsed = (row: DeviceCredentialRow, now: number) => {
				const touched = lastUsedMemo.get(row.id) ?? row.lastUsedAt ?? 0
				if (touched > now - LAST_USED_HEARTBEAT_MS) return Effect.void
				lastUsedMemo.set(row.id, now)
				return dbExecute((db) =>
					db.run(
						PG.update(DeviceCredentials)
							.set({ lastUsedAt: now })
							.where(($) => [
								$.id.eq(row.id),
								PG.or($.lastUsedAt.isNull(), $.lastUsedAt.lt(now - LAST_USED_HEARTBEAT_MS)),
							]),
					),
				).pipe(Effect.ignore)
			}

			/** `POST /v2/device_tokens`: a proof signed by a registered key earns a bound token. */
			/**
			 * `admit` runs once the key is known to belong to a live credential and before any
			 * write or signing, so the caller's rate limit bounds the expensive half of issuance.
			 */
			const issueToken = Effect.fn("DeviceCredentialsService.issueToken")(function* <E>(
				request: DpopRequest,
				admit: (credentialId: DeviceCredentialId) => Effect.Effect<void, E>,
			) {
				const found = yield* requireSigner
				const now = yield* Clock.currentTimeMillis
				const toInvalidProof = (error: DpopProofRejected) =>
					new DpopProofInvalidError({ message: error.message, reason: error.reason })
				const proof = yield* checkProof(request, now).pipe(Effect.mapError(toInvalidProof))

				const [row] = yield* dbExecute((db) =>
					db.run(
						PG.from(DeviceCredentials)
							.select()
							.where(($) => [$.jkt.eq(proof.jkt)])
							.limit(1),
					),
				)
				if (row === undefined || !isLive(row, now)) {
					const reason =
						row === undefined ? "unknown" : row.revokedAt !== null ? "revoked" : "expired"
					yield* Effect.annotateCurrentSpan("maple.device.token_request_rejected_reason", reason)
					return yield* new DeviceCredentialInvalidError({
						message: `Device credential ${reason}`,
						reason,
					})
				}
				yield* admit(row.id)
				yield* consumeProof(proof).pipe(
					Effect.catchTag("@maple/backend/auth/device/DpopProofRejected", (error) =>
						Effect.fail(toInvalidProof(error)),
					),
				)
				// Best-effort housekeeping: expired single-use rows are inert, just clutter.
				yield* dbExecute((db) =>
					db.run(PG.deleteFrom(DeviceProofReplays).where(($) => [$.expiresAt.lt(now)])),
				).pipe(Effect.ignore)
				const scope = row.scopes.join(" ")
				const accessToken = yield* found
					.sign(
						DEVICE_TOKEN_TYPE,
						DEVICE_TOKEN_AUDIENCE,
						{ sub: row.id, org_id: row.orgId, scope, cnf: { jkt: row.jkt }, jti: randomUUID() },
						now,
						DEVICE_TOKEN_TTL_SECONDS,
					)
					.pipe(
						Effect.mapError(
							(error) => new DeviceTokensUnavailableError({ message: error.message }),
						),
					)
				yield* touchLastUsed(row, now)
				yield* Effect.annotateCurrentSpan({ orgId: row.orgId, "maple.device.credential_id": row.id })
				return { accessToken, expiresIn: DEVICE_TOKEN_TTL_SECONDS, scope, row }
			})

			/**
			 * A `DPoP`-scheme resource request: the token must be ours and unexpired, the proof must
			 * hash the token and be signed by its `cnf.jkt` key, and the credential must still be live.
			 * The credential read is one primary-key lookup, so revocation takes effect immediately.
			 */
			const authenticate = Effect.fn("DeviceCredentialsService.authenticate")(function* (
				accessToken: string,
				request: DpopRequest,
			) {
				const tokenRejected = (reason: string, message: string) =>
					Effect.annotateCurrentSpan("maple.dpop.token_rejected_reason", reason).pipe(
						Effect.andThen(Effect.fail(new DeviceTokenRejected({ reason, message }))),
					)
				const found = yield* Option.match(signer, {
					onNone: () => tokenRejected("unconfigured", "This deployment issues no device tokens."),
					onSome: Effect.succeed,
				})
				const now = yield* Clock.currentTimeMillis
				const payload = yield* found
					.verify(accessToken, DEVICE_TOKEN_TYPE, DEVICE_TOKEN_AUDIENCE, now)
					.pipe(Effect.catch((error) => tokenRejected(error.reason, error.message)))
				const claims = decodeAccessTokenClaims(payload)
				if (Option.isNone(claims))
					return yield* tokenRejected("claims", "The token claims are malformed.")

				const proof = yield* checkProof(request, now, accessToken)
				if (proof.jkt !== claims.value.cnf.jkt) {
					return yield* proofFailure(
						new DpopProofRejected({
							reason: "key",
							message: "The proof is not signed by the token's key.",
						}),
					)
				}
				yield* consumeProof(proof)

				const row = yield* loadLive(claims.value.sub, now)
				if (
					Option.isNone(row) ||
					row.value.jkt !== claims.value.cnf.jkt ||
					row.value.orgId !== claims.value.org_id
				) {
					return yield* tokenRejected("credential", "The device credential was revoked or expired.")
				}
				yield* touchLastUsed(row.value, now)
				yield* Effect.annotateCurrentSpan({
					orgId: row.value.orgId,
					"maple.device.credential_id": row.value.id,
				})
				return {
					credentialId: row.value.id,
					orgId: row.value.orgId,
					userId: row.value.userId,
					roles: row.value.roles,
					scopes: row.value.scopes,
				} satisfies ResolvedDeviceCredential
			})

			return { register, revoke, attestationChallenge, issueToken, authenticate }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
