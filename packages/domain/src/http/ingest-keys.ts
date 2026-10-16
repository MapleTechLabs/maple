import { Schema } from "effect"
import {
	CustomIngestKeyId,
	IngestKeyResourceAttribute,
	IngestKeySignal,
	IsoDateTimeString,
} from "../primitives"
import { HttpTaggedError } from "./error-policy"

export class IngestKeysResponse extends Schema.Class<IngestKeysResponse>("IngestKeysResponse")({
	publicKey: Schema.String,
	privateKey: Schema.String,
	publicRotatedAt: IsoDateTimeString,
	privateRotatedAt: IsoDateTimeString,
}) {}

export class IngestKeyPersistenceError extends HttpTaggedError<IngestKeyPersistenceError>()(
	"@maple/http/errors/IngestKeyPersistenceError",
	{
		message: Schema.String,
	},
	{
		status: 503,
		code: "ingest_keys_unavailable",
		title: "Ingest keys are temporarily unavailable",
		message: "Ingest keys are temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

export class IngestKeyEncryptionError extends HttpTaggedError<IngestKeyEncryptionError>()(
	"@maple/http/errors/IngestKeyEncryptionError",
	{
		message: Schema.String,
	},
	{
		status: 500,
		code: "ingest_key_encryption_failed",
		title: "Ingest key could not be secured",
		message: "Maple could not securely process the ingest key.",
		retry: "never",
		recovery: "contact_support",
		exposure: "redacted",
	},
) {}

/** `paused` keys are accepted but their data is dropped; `expired` keys are rejected. */
export const CustomIngestKeyStatus = Schema.Literals(["active", "paused", "expired"])
export type CustomIngestKeyStatus = Schema.Schema.Type<typeof CustomIngestKeyStatus>

export class CustomIngestKey extends Schema.Class<CustomIngestKey>("CustomIngestKey")({
	id: CustomIngestKeyId,
	name: Schema.String,
	description: Schema.NullOr(Schema.String),
	keyPrefix: Schema.String,
	status: CustomIngestKeyStatus,
	allowedSignals: Schema.NullOr(Schema.Array(IngestKeySignal)),
	rateLimitRps: Schema.NullOr(Schema.Int),
	resourceAttributes: Schema.Array(IngestKeyResourceAttribute),
	expiresAt: Schema.NullOr(IsoDateTimeString),
	pausedAt: Schema.NullOr(IsoDateTimeString),
	pausedUntil: Schema.NullOr(IsoDateTimeString),
	lastUsedAt: Schema.NullOr(IsoDateTimeString),
	rolledAt: IsoDateTimeString,
	createdAt: IsoDateTimeString,
	updatedAt: IsoDateTimeString,
}) {}

/** Returned only by create and roll: the one time the raw key is visible. */
export class CustomIngestKeyWithSecret extends Schema.Class<CustomIngestKeyWithSecret>(
	"CustomIngestKeyWithSecret",
)({
	key: CustomIngestKey,
	secret: Schema.String,
}) {}

export class CreateCustomIngestKeyRequest extends Schema.Class<CreateCustomIngestKeyRequest>(
	"CreateCustomIngestKeyRequest",
)({
	name: Schema.String,
	description: Schema.optionalKey(Schema.NullOr(Schema.String)),
	allowedSignals: Schema.optionalKey(Schema.NullOr(Schema.Array(IngestKeySignal))),
	rateLimitRps: Schema.optionalKey(Schema.NullOr(Schema.Int)),
	resourceAttributes: Schema.optionalKey(Schema.Array(IngestKeyResourceAttribute)),
	expiresAtMs: Schema.optionalKey(Schema.NullOr(Schema.Number)),
}) {}

/** Omitted fields are unchanged; `null` clears a nullable field. */
export class UpdateCustomIngestKeyRequest extends Schema.Class<UpdateCustomIngestKeyRequest>(
	"UpdateCustomIngestKeyRequest",
)({
	name: Schema.optionalKey(Schema.String),
	description: Schema.optionalKey(Schema.NullOr(Schema.String)),
	allowedSignals: Schema.optionalKey(Schema.NullOr(Schema.Array(IngestKeySignal))),
	rateLimitRps: Schema.optionalKey(Schema.NullOr(Schema.Int)),
	resourceAttributes: Schema.optionalKey(Schema.Array(IngestKeyResourceAttribute)),
	expiresAtMs: Schema.optionalKey(Schema.NullOr(Schema.Number)),
}) {}

/** Hourly span and log counts for one key; `hour` is the bucket start in epoch ms. */
export class CustomIngestKeyUsageBucket extends Schema.Class<CustomIngestKeyUsageBucket>(
	"CustomIngestKeyUsageBucket",
)({
	hour: Schema.Number,
	spans: Schema.Number,
	logs: Schema.Number,
}) {}

export class CustomIngestKeyUsage extends Schema.Class<CustomIngestKeyUsage>("CustomIngestKeyUsage")({
	windowStart: Schema.Number,
	windowEnd: Schema.Number,
	buckets: Schema.Array(CustomIngestKeyUsageBucket),
}) {}

export class CustomIngestKeyNotFoundError extends HttpTaggedError<CustomIngestKeyNotFoundError>()(
	"@maple/http/errors/CustomIngestKeyNotFoundError",
	{
		keyId: CustomIngestKeyId,
		message: Schema.String,
	},
	{
		status: 404,
		code: "custom_ingest_key_not_found",
		title: "Ingest key not found",
		message: "No such ingest key.",
		param: "id",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}

export class CustomIngestKeyValidationError extends HttpTaggedError<CustomIngestKeyValidationError>()(
	"@maple/http/errors/CustomIngestKeyValidationError",
	{
		message: Schema.String,
	},
	{
		status: 400,
		code: "custom_ingest_key_invalid",
		title: "Invalid ingest key settings",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}
