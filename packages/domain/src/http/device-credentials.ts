import { Schema } from "effect"
import { HttpTaggedError } from "./error-policy"

/**
 * Failures of device-bound (DPoP, RFC 9449) credentials: registration, App Attest verification,
 * token issuance and proof checks. Messages are Maple-authored and never carry key material.
 */

export class DeviceCredentialPersistenceError extends HttpTaggedError<DeviceCredentialPersistenceError>()(
	"@maple/http/errors/DeviceCredentialPersistenceError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.String),
	},
	{
		status: 503,
		code: "device_credentials_unavailable",
		title: "Device credentials are temporarily unavailable",
		message: "Device credentials are temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

/** The submitted public key is not an EC P-256 JWK with valid coordinates. */
export class DeviceKeyInvalidError extends HttpTaggedError<DeviceKeyInvalidError>()(
	"@maple/http/errors/DeviceKeyInvalidError",
	{ message: Schema.String },
	{
		status: 400,
		code: "device_key_invalid",
		title: "Invalid device key",
		param: "public_jwk",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

/** The key is already registered elsewhere, or was retired: a key is never registered twice. */
export class DeviceKeyInUseError extends HttpTaggedError<DeviceKeyInUseError>()(
	"@maple/http/errors/DeviceKeyInUseError",
	{ message: Schema.String },
	{
		status: 409,
		code: "device_key_in_use",
		title: "Device key already used",
		message: "This key is already registered or was retired. Generate a new key and register it.",
		param: "public_jwk",
		retry: "never",
		recovery: "fix_request",
		exposure: "redacted",
	},
) {}

/** The App Attest attestation (or its challenge) did not verify. */
export class DeviceAttestationInvalidError extends HttpTaggedError<DeviceAttestationInvalidError>()(
	"@maple/http/errors/DeviceAttestationInvalidError",
	{
		message: Schema.String,
		/** Which check failed, for logs and spans (`chain`, `nonce`, `app_id`, ...). */
		reason: Schema.String,
	},
	{
		status: 400,
		code: "device_attestation_invalid",
		title: "Device attestation failed",
		param: "attestation",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

/** A `DPoP` proof at the token endpoint is missing, malformed, stale, replayed or mis-signed. */
export class DpopProofInvalidError extends HttpTaggedError<DpopProofInvalidError>()(
	"@maple/http/errors/DpopProofInvalidError",
	{
		message: Schema.String,
		reason: Schema.String,
	},
	{
		status: 400,
		code: "invalid_dpop_proof",
		title: "Invalid DPoP proof",
		param: "DPoP",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

/** No live credential holds the proof's key: unknown, revoked, or expired. */
export class DeviceCredentialInvalidError extends HttpTaggedError<DeviceCredentialInvalidError>()(
	"@maple/http/errors/DeviceCredentialInvalidError",
	{
		message: Schema.String,
		reason: Schema.String,
	},
	{
		status: 401,
		code: "invalid_device_credential",
		title: "Device credential not valid",
		message:
			"This device is not registered, or its registration was revoked or expired. Register it again.",
		retry: "never",
		recovery: "reauthenticate",
		exposure: "redacted",
	},
) {}

/** This deployment has no device-token signing key, so it cannot issue tokens. */
export class DeviceTokensUnavailableError extends HttpTaggedError<DeviceTokensUnavailableError>()(
	"@maple/http/errors/DeviceTokensUnavailableError",
	{ message: Schema.String },
	{
		status: 503,
		code: "device_tokens_unavailable",
		title: "Device tokens are unavailable",
		message: "This Maple deployment cannot issue device tokens.",
		retry: "never",
		recovery: "contact_support",
		exposure: "redacted",
	},
) {}
