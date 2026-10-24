import { HttpServerRequest } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant } from "@maple/domain/http"
import { MapleApiV2, isoTimestamp, V2RateLimited } from "@maple/domain/http/v2"
import type { DeviceCredentialRow } from "@maple/db/tables"
import { Effect } from "effect"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import {
	API_V2_RATE_LIMIT_PERIOD_SECONDS,
	ApiV2RateLimiter,
	deviceRateLimitKey,
} from "@maple/backend/services/auth/ApiV2RateLimiter"
import { DeviceCredentialsService } from "@maple/backend/services/auth/DeviceCredentialsService"

const toWire = (row: DeviceCredentialRow) => ({
	object: "device_credential" as const,
	id: row.id,
	organization_id: row.orgId,
	installation_id: row.installationId,
	jkt: row.jkt,
	scopes: row.scopes,
	attested: row.attested,
	created_at: isoTimestamp(row.createdAt),
	expires_at: isoTimestamp(row.expiresAt),
	hard_expires_at: isoTimestamp(row.hardExpiresAt),
})

export const HttpV2DeviceCredentialsLive = HttpApiBuilder.group(MapleApiV2, "deviceCredentials", (handlers) =>
	Effect.gen(function* () {
		const devices = yield* DeviceCredentialsService

		return handlers
			.handle("register", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const row = yield* devices.register(tenant, {
						installationId: params.installation_id,
						publicJwk: payload.public_jwk,
						...(payload.attestation === undefined
							? undefined
							: {
									attestation: {
										keyId: payload.attestation.key_id,
										attestationObject: payload.attestation.attestation_object,
										challenge: payload.attestation.challenge,
									},
								}),
					})
					yield* recordHttpAudit("device_credential.registered", {
						resourceId: row.id,
						metadata: {
							installation_id: row.installationId,
							attested: row.attested,
							scopes: row.scopes,
						},
					})
					return toWire(row)
				}),
			)
			.handle("revoke", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					// Idempotent like the widget credential revoke: this is the sign-out path.
					yield* devices.revoke(tenant.orgId, params.installation_id)
					yield* recordHttpAudit("device_credential.revoked", {
						metadata: { installation_id: params.installation_id },
					})
					return { object: "device_credential" as const, deleted: true as const }
				}),
			)
			.handle("attestationChallenge", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const issued = yield* devices.attestationChallenge(
						tenant.orgId,
						tenant.userId,
						params.installation_id,
					)
					return {
						object: "attestation_challenge" as const,
						challenge: issued.challenge,
						expires_at: isoTimestamp(issued.expiresAt),
					}
				}),
			)
	}),
)

export const HttpV2DeviceTokensLive = HttpApiBuilder.group(MapleApiV2, "deviceTokens", (handlers) =>
	Effect.gen(function* () {
		const devices = yield* DeviceCredentialsService
		const rateLimiter = yield* ApiV2RateLimiter

		return handlers.handle("issue", ({ headers }) =>
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest
				// The same per-credential budget its requests draw from, checked before issuance.
				const admit = (credentialId: string) =>
					rateLimiter.check(deviceRateLimitKey(credentialId)).pipe(
						Effect.tap((outcome) =>
							Effect.annotateCurrentSpan("maple.rate_limit.outcome", outcome),
						),
						Effect.flatMap((outcome) =>
							outcome === "limited"
								? Effect.fail(
										V2RateLimited.make(undefined, {
											retryAfterSeconds: API_V2_RATE_LIMIT_PERIOD_SECONDS,
										}),
									)
								: Effect.void,
						),
					)
				const issued = yield* devices.issueToken(
					{ proof: headers.dpop, method: request.method, path: request.url },
					admit,
				)
				return {
					object: "device_token" as const,
					access_token: issued.accessToken,
					token_type: "DPoP" as const,
					expires_in: issued.expiresIn,
					scope: issued.scope,
				}
			}),
		)
	}),
)
