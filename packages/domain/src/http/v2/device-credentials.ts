import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Schema } from "effect"
import {
	DeviceAttestationInvalidError,
	DeviceCredentialInvalidError,
	DeviceCredentialPersistenceError,
	DeviceKeyInUseError,
	DeviceKeyInvalidError,
	DeviceTokensUnavailableError,
	DpopProofInvalidError,
} from "../device-credentials"
import { OrgId } from "../../primitives"
import { AuthorizationV2 } from "./auth"
import { wireExample, Timestamp } from "./envelopes"
import { V2RateLimited } from "./errors"
import { publicError } from "./public-error"
import { DeviceCredentialPublicId } from "./resource-ids"
import { InstallationId } from "./widget-credentials"

/**
 * Device-bound credentials (DPoP, RFC 9449) for the mobile Home Screen widgets.
 *
 * The app generates a P-256 key in the Secure Enclave and registers its public half from a
 * signed-in session. Afterwards the widget trades a signed `DPoP` proof for a one-hour access
 * token bound to that key, and signs a fresh proof for every request. Nothing it stores is a
 * bearer secret: a copy of the widget's storage, without the device's key, authenticates nothing.
 */

const Base64UrlCoordinate = Schema.String.check(
	Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u, { description: "a base64url P-256 coordinate (32 bytes)" }),
)

export const V2DevicePublicJwk = Schema.Struct({
	kty: Schema.Literal("EC"),
	crv: Schema.Literal("P-256"),
	x: Base64UrlCoordinate,
	y: Base64UrlCoordinate,
}).annotate({
	identifier: "DevicePublicJwk",
	title: "Device public key",
	description:
		"The public half of the installation's signing key as an RFC 7517 JWK. EC P-256 only; members other than `kty`, `crv`, `x` and `y` are rejected rather than stored.",
})

export const V2DeviceAttestation = Schema.Struct({
	key_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)).annotate({
		description: "The App Attest key identifier (`generateKey`), base64.",
	}),
	attestation_object: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_768)).annotate({
		description: "The attestation object `attestKey` returned, base64.",
	}),
	challenge: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)).annotate({
		description:
			"The `challenge` from `GET /v2/device_credentials/{installation_id}/attestation_challenge`, unchanged. The `clientDataHash` passed to `attestKey` must be SHA-256 of the UTF-8 string `<challenge>.<jkt>`, where `jkt` is the RFC 7638 thumbprint of `public_jwk`.",
	}),
}).annotate({
	identifier: "DeviceAttestation",
	title: "App Attest attestation",
	description:
		"Optional proof that the key was registered by a genuine instance of the Maple app. Verified against Apple's App Attest root; a failure rejects the registration.",
})

export const V2DeviceCredentialRegisterParams = Schema.Struct({
	public_jwk: V2DevicePublicJwk,
	attestation: Schema.optionalKey(V2DeviceAttestation),
}).annotate({
	identifier: "DeviceCredentialRegisterParams",
	title: "Register a device credential",
})

export const V2DeviceCredential = Schema.Struct({
	object: Schema.Literal("device_credential").annotate({
		description: 'The object type, always `"device_credential"`.',
	}),
	id: DeviceCredentialPublicId,
	organization_id: OrgId,
	installation_id: InstallationId,
	jkt: Schema.String.annotate({
		description: "RFC 7638 SHA-256 thumbprint of the registered key; the `cnf.jkt` of every token.",
	}),
	scopes: Schema.Array(Schema.String).annotate({
		description: "Fixed by the server. Today, exactly `widget_summary:read`.",
	}),
	attested: Schema.Boolean.annotate({
		description: "Whether an App Attest attestation for this installation verified.",
	}),
	created_at: Timestamp,
	expires_at: Timestamp.annotate({
		description:
			"Rolling expiry: registering the same key again moves it out by 30 days, up to `hard_expires_at`.",
	}),
	hard_expires_at: Timestamp.annotate({
		description: "90 days after creation. Past it the app must register a new key.",
	}),
}).annotate({
	identifier: "DeviceCredential",
	title: "Device credential",
	description:
		"A public key registered for one installation and organization. Tokens are issued only to requests signed by its private key.",
	examples: [
		wireExample({
			object: "device_credential",
			id: "dcred_3mJr7AoUXx2Wqd8bGFd1KZ",
			organization_id: "org_2abcDEF",
			installation_id: "F9E1B4C0-8F2A-4C6D-9E1B-4C08F2A4C6D9",
			jkt: "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I",
			scopes: ["widget_summary:read"],
			attested: true,
			created_at: "2026-10-24T09:10:00.000Z",
			expires_at: "2026-11-23T09:10:00.000Z",
			hard_expires_at: "2027-01-22T09:10:00.000Z",
		}),
	],
})
export type V2DeviceCredential = Schema.Schema.Type<typeof V2DeviceCredential>

export const V2DeviceCredentialDeleteResponse = Schema.Struct({
	object: Schema.Literal("device_credential"),
	deleted: Schema.Literal(true),
}).annotate({
	identifier: "DeviceCredentialDeleteResponse",
	title: "Device credential delete response",
})

export const V2AttestationChallenge = Schema.Struct({
	object: Schema.Literal("attestation_challenge"),
	challenge: Schema.String.annotate({
		description: "Opaque and single-use. Pass it back unchanged in `attestation.challenge`.",
	}),
	expires_at: Timestamp,
}).annotate({
	identifier: "AttestationChallenge",
	title: "App Attest challenge",
	description:
		"A server challenge that binds an App Attest attestation to this server, user and installation.",
})

export const V2DeviceToken = Schema.Struct({
	object: Schema.Literal("device_token"),
	access_token: Schema.String.annotate({
		description:
			"A JWT bound to the device key. Send it as `Authorization: DPoP <access_token>` with a fresh `DPoP` proof whose `ath` is its hash.",
	}),
	token_type: Schema.Literal("DPoP"),
	expires_in: Schema.Int.annotate({ description: "Seconds until the token expires." }),
	scope: Schema.String.annotate({ description: "Space-delimited granted scopes." }),
}).annotate({
	identifier: "DeviceToken",
	title: "Device access token",
	description: "An RFC 9449 DPoP-bound access token response.",
})

const DpopHeader = Schema.Struct({
	dpop: Schema.optional(Schema.String).annotate({
		description: "The DPoP proof JWT (RFC 9449 section 4.2) for this request.",
	}),
})

const persistence = publicError(DeviceCredentialPersistenceError)

export class V2DeviceCredentialsApiGroup extends HttpApiGroup.make("deviceCredentials")
	.add(
		HttpApiEndpoint.put("register", "/:installation_id", {
			params: { installation_id: InstallationId },
			payload: V2DeviceCredentialRegisterParams,
			success: V2DeviceCredential,
			error: [
				publicError(DeviceKeyInvalidError),
				publicError(DeviceKeyInUseError),
				publicError(DeviceAttestationInvalidError),
				persistence,
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "registerDeviceCredential",
				summary: "Register this installation's device key",
				description:
					"Registers the public half of a device-held P-256 key for this installation and organization, revoking the key it had before in the same transaction. Registering the same key again refreshes it: the rolling 30-day expiry moves out (never past 90 days from creation) and the roles are re-pinned to the caller's. Requires the `device_credentials:write` scope, which a device token never has, so registration always comes from a signed-in session.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("revoke", "/:installation_id", {
			params: { installation_id: InstallationId },
			success: V2DeviceCredentialDeleteResponse,
			error: [persistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "revokeDeviceCredential",
				summary: "Revoke this installation's device key",
				description:
					"Revokes the installation's device credential for this organization. Tokens already issued for it stop working on their next request. Idempotent. Requires the `device_credentials:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("attestationChallenge", "/:installation_id/attestation_challenge", {
			params: { installation_id: InstallationId },
			success: V2AttestationChallenge,
			error: [publicError(DeviceTokensUnavailableError)],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getDeviceAttestationChallenge",
				summary: "Get an App Attest challenge",
				description:
					"Returns a single-use challenge, valid for five minutes, for an App Attest attestation of this installation's registration. Requires the `device_credentials:read` scope.",
			}),
		),
	)
	.prefix("/v2/device_credentials")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Device Credentials",
			description:
				"Device-held keys for the Maple mobile Home Screen widgets. A signed-in app registers a key; the widget then authenticates with DPoP (RFC 9449) proofs signed by it.",
		}),
	) {}

export class V2DeviceTokensApiGroup extends HttpApiGroup.make("deviceTokens")
	.add(
		HttpApiEndpoint.post("issue", "/", {
			headers: DpopHeader,
			success: V2DeviceToken,
			error: [
				publicError(DpopProofInvalidError),
				publicError(DeviceCredentialInvalidError),
				publicError(DeviceTokensUnavailableError),
				V2RateLimited.schema,
				publicError(DeviceCredentialPersistenceError),
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "issueDeviceToken",
				summary: "Issue a DPoP-bound access token",
				description:
					"Exchanges a `DPoP` proof (RFC 9449: `typ` `dpop+jwt`, `alg` `ES256`, the registered key as `jwk`, `htm` `POST`, `htu` this URL, a unique `jti` and an `iat` within 60 seconds) for a one-hour access token bound to that key. Takes no bearer credential: the proof is the credential. Fails with `invalid_device_credential` when the key is unknown, revoked or expired.",
			}),
		),
	)
	.prefix("/v2/device_tokens")
	.annotateMerge(
		OpenApi.annotations({
			title: "Device Tokens",
			description:
				"The DPoP token endpoint for device credentials. Unauthenticated apart from the proof.",
		}),
	) {}
