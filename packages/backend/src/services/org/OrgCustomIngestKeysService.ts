import { randomBytes, randomUUID } from "node:crypto"
import {
	type CreateCustomIngestKeyRequest,
	CustomIngestKey,
	CustomIngestKeyId,
	CustomIngestKeyNotFoundError,
	CustomIngestKeyValidationError,
	CustomIngestKeyWithSecret,
	IngestKeyEncryptionError,
	IngestKeyPersistenceError,
	IsoDateTimeString,
	type OrgId,
	type UpdateCustomIngestKeyRequest,
	type UserId,
} from "@maple/domain/http"
import type { IngestKeyResourceAttribute, IngestKeySignal } from "@maple/domain/primitives"
import { hashIngestKey, parseIngestKeyLookupHmacKey } from "@maple/db"
import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgIngestCustomKeys, type OrgIngestCustomKeyRow } from "@maple/db/tables"
import { Array as Arr, Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { Database, type DatabaseError } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"

export const CUSTOM_INGEST_KEY_PREFIX = "maple_ik_"
const MAX_KEYS_PER_ORG = 50
const MAX_RESOURCE_ATTRIBUTES = 20
const MAX_RATE_LIMIT_RPS = 100_000
const MAX_NAME_LENGTH = 100
const MAX_ATTRIBUTE_KEY_LENGTH = 255
const MAX_ATTRIBUTE_VALUE_LENGTH = 1024
// `maple_` attributes are stamped by the gateway and must never be overridable.
const RESERVED_ATTRIBUTE_KEYS = new Set(["org_id"])
const RESERVED_ATTRIBUTE_PREFIX = "maple_"

const toPersistenceError = (error: DatabaseError) => new IngestKeyPersistenceError({ message: error.message })
const invalid = (message: string) => new CustomIngestKeyValidationError({ message })

const decodeKeyIdSync = Schema.decodeUnknownSync(CustomIngestKeyId)
const decodeIsoSync = Schema.decodeUnknownSync(IsoDateTimeString)
const toIso = (epochMs: number) => decodeIsoSync(new Date(epochMs).toISOString())

const generateSecret = () => `${CUSTOM_INGEST_KEY_PREFIX}${randomBytes(24).toString("base64url")}`
const displayPrefix = (secret: string) => secret.slice(0, CUSTOM_INGEST_KEY_PREFIX.length + 5)

const rowToKey = (row: OrgIngestCustomKeyRow): CustomIngestKey =>
	new CustomIngestKey({
		id: row.id,
		name: row.name,
		description: row.description,
		keyPrefix: row.keyPrefix,
		enabled: row.enabled,
		allowedSignals: row.allowedSignals,
		rateLimitRps: row.rateLimitRps,
		resourceAttributes: row.resourceAttributes,
		expiresAt: row.expiresAt === null ? null : toIso(row.expiresAt),
		rolledAt: toIso(row.rolledAt),
		createdAt: toIso(row.createdAt),
		updatedAt: toIso(row.updatedAt),
	})

const normalizeName = Effect.fnUntraced(function* (name: string) {
	const trimmed = name.trim()
	if (trimmed.length === 0) return yield* invalid("Name must not be empty")
	if (trimmed.length > MAX_NAME_LENGTH) {
		return yield* invalid(`Name must be at most ${MAX_NAME_LENGTH} characters`)
	}
	return trimmed
})

const normalizeDescription = (description: string | null) => {
	const trimmed = description?.trim() ?? ""
	return trimmed.length === 0 ? null : trimmed
}

const normalizeSignals = Effect.fnUntraced(function* (signals: ReadonlyArray<IngestKeySignal> | null) {
	if (signals === null) return null
	const unique = Arr.dedupe(signals)
	if (unique.length === 0) return yield* invalid("Allow at least one signal, or null for every signal")
	return unique
})

const normalizeRateLimit = Effect.fnUntraced(function* (rps: number | null) {
	if (rps === null) return null
	if (rps < 1 || rps > MAX_RATE_LIMIT_RPS) {
		return yield* invalid(`Rate limit must be between 1 and ${MAX_RATE_LIMIT_RPS} requests per second`)
	}
	return rps
})

const normalizeAttributes = Effect.fnUntraced(function* (
	attributes: ReadonlyArray<IngestKeyResourceAttribute>,
) {
	if (attributes.length > MAX_RESOURCE_ATTRIBUTES) {
		return yield* invalid(`At most ${MAX_RESOURCE_ATTRIBUTES} resource attributes per key`)
	}
	const normalized = Arr.map(attributes, (attribute) => ({
		key: attribute.key.trim(),
		value: attribute.value,
		mode: attribute.mode,
	}))
	yield* Effect.forEach(normalized, (attribute) =>
		Effect.gen(function* () {
			if (attribute.key.length === 0) return yield* invalid("Attribute keys must not be empty")
			if (attribute.key.length > MAX_ATTRIBUTE_KEY_LENGTH) {
				return yield* invalid(`Attribute keys must be at most ${MAX_ATTRIBUTE_KEY_LENGTH} characters`)
			}
			if (attribute.value.length > MAX_ATTRIBUTE_VALUE_LENGTH) {
				return yield* invalid(
					`Attribute values must be at most ${MAX_ATTRIBUTE_VALUE_LENGTH} characters`,
				)
			}
			if (
				RESERVED_ATTRIBUTE_KEYS.has(attribute.key) ||
				attribute.key.startsWith(RESERVED_ATTRIBUTE_PREFIX)
			) {
				return yield* invalid(`"${attribute.key}" is reserved by Maple and cannot be overridden`)
			}
		}),
	)
	const keys = Arr.map(normalized, (attribute) => attribute.key)
	if (Arr.dedupe(keys).length !== keys.length)
		return yield* invalid("Each attribute key can only be listed once")
	return normalized
})

const normalizeExpiry = Effect.fnUntraced(function* (expiresAtMs: number | null, now: number) {
	if (expiresAtMs === null) return null
	if (expiresAtMs <= now) return yield* invalid("Expiry must be in the future")
	return expiresAtMs
})

export class OrgCustomIngestKeysService extends Context.Service<OrgCustomIngestKeysService>()(
	"@maple/api/services/OrgCustomIngestKeysService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const dbExecute = makeDbExecute(database, "OrgCustomIngestKeysService", toPersistenceError)
			const env = yield* Env
			const lookupHmacKey = yield* parseIngestKeyLookupHmacKey(
				Redacted.value(env.MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY),
				(message) => new IngestKeyEncryptionError({ message }),
			)

			const selectRow = Effect.fnUntraced(function* (orgId: OrgId, keyId: CustomIngestKeyId) {
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.from(OrgIngestCustomKeys)
							.select()
							.where(($) => [$.orgId.eq(orgId), $.id.eq(keyId)])
							.limit(1),
					),
				)
				return Option.fromNullishOr(rows[0])
			})

			const requireRow = Effect.fnUntraced(function* (orgId: OrgId, keyId: CustomIngestKeyId) {
				const row = yield* selectRow(orgId, keyId)
				if (Option.isSome(row)) return row.value
				return yield* new CustomIngestKeyNotFoundError({ keyId, message: "Ingest key not found" })
			})

			const list = Effect.fn("OrgCustomIngestKeysService.list")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan("orgId", orgId)
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.from(OrgIngestCustomKeys)
							.select()
							.where(($) => [$.orgId.eq(orgId)])
							.orderBy(($) => [
								[$.createdAt, "desc"],
								[$.id, "desc"],
							]),
					),
				)
				return Arr.map(rows, rowToKey)
			})

			const get = Effect.fn("OrgCustomIngestKeysService.get")(function* (
				orgId: OrgId,
				keyId: CustomIngestKeyId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.ingest_key.id": keyId })
				return rowToKey(yield* requireRow(orgId, keyId))
			})

			const create = Effect.fn("OrgCustomIngestKeysService.create")(function* (
				orgId: OrgId,
				userId: UserId,
				request: CreateCustomIngestKeyRequest,
			) {
				yield* Effect.annotateCurrentSpan("orgId", orgId)
				const now = yield* Clock.currentTimeMillis
				const name = yield* normalizeName(request.name)
				const allowedSignals = yield* normalizeSignals(request.allowedSignals ?? null)
				const rateLimitRps = yield* normalizeRateLimit(request.rateLimitRps ?? null)
				const resourceAttributes = yield* normalizeAttributes(request.resourceAttributes ?? [])
				const expiresAt = yield* normalizeExpiry(request.expiresAtMs ?? null, now)

				const existing = yield* dbExecute((db) =>
					db.run(
						PG.from(OrgIngestCustomKeys)
							.select(($) => ({ id: $.id }))
							.where(($) => [$.orgId.eq(orgId)])
							.limit(MAX_KEYS_PER_ORG),
					),
				)
				if (existing.length >= MAX_KEYS_PER_ORG) {
					return yield* invalid(
						`An organization can have at most ${MAX_KEYS_PER_ORG} custom ingest keys`,
					)
				}

				const id = decodeKeyIdSync(randomUUID())
				const secret = generateSecret()
				yield* Effect.annotateCurrentSpan("maple.ingest_key.id", id)
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.insertInto(OrgIngestCustomKeys)
							.values({
								id,
								orgId,
								name,
								description: normalizeDescription(request.description ?? null),
								keyHash: hashIngestKey(secret, lookupHmacKey),
								keyPrefix: displayPrefix(secret),
								enabled: request.enabled ?? true,
								allowedSignals,
								rateLimitRps,
								resourceAttributes,
								expiresAt,
								rolledAt: now,
								createdAt: now,
								updatedAt: now,
								createdBy: userId,
								updatedBy: userId,
							})
							.returning(),
					),
				)
				const row = rows[0]
				if (row === undefined) {
					return yield* new IngestKeyPersistenceError({ message: "Failed to create ingest key" })
				}
				return new CustomIngestKeyWithSecret({ key: rowToKey(row), secret })
			})

			const update = Effect.fn("OrgCustomIngestKeysService.update")(function* (
				orgId: OrgId,
				userId: UserId,
				keyId: CustomIngestKeyId,
				request: UpdateCustomIngestKeyRequest,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.ingest_key.id": keyId })
				yield* requireRow(orgId, keyId)
				const now = yield* Clock.currentTimeMillis
				const updates = {
					updatedAt: now,
					updatedBy: userId,
					name: request.name === undefined ? undefined : yield* normalizeName(request.name),
					description:
						request.description === undefined
							? undefined
							: normalizeDescription(request.description),
					enabled: request.enabled,
					allowedSignals:
						request.allowedSignals === undefined
							? undefined
							: yield* normalizeSignals(request.allowedSignals),
					rateLimitRps:
						request.rateLimitRps === undefined
							? undefined
							: yield* normalizeRateLimit(request.rateLimitRps),
					resourceAttributes:
						request.resourceAttributes === undefined
							? undefined
							: yield* normalizeAttributes(request.resourceAttributes),
					expiresAt:
						request.expiresAtMs === undefined
							? undefined
							: yield* normalizeExpiry(request.expiresAtMs, now),
				}
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.update(OrgIngestCustomKeys)
							.set(updates)
							.where(($) => [$.orgId.eq(orgId), $.id.eq(keyId)])
							.returning(),
					),
				)
				const row = rows[0]
				if (row === undefined) {
					return yield* new CustomIngestKeyNotFoundError({ keyId, message: "Ingest key not found" })
				}
				return rowToKey(row)
			})

			const roll = Effect.fn("OrgCustomIngestKeysService.roll")(function* (
				orgId: OrgId,
				userId: UserId,
				keyId: CustomIngestKeyId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.ingest_key.id": keyId })
				const now = yield* Clock.currentTimeMillis
				const secret = generateSecret()
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.update(OrgIngestCustomKeys)
							.set({
								keyHash: hashIngestKey(secret, lookupHmacKey),
								keyPrefix: displayPrefix(secret),
								rolledAt: now,
								updatedAt: now,
								updatedBy: userId,
							})
							.where(($) => [$.orgId.eq(orgId), $.id.eq(keyId)])
							.returning(),
					),
				)
				const row = rows[0]
				if (row === undefined) {
					return yield* new CustomIngestKeyNotFoundError({ keyId, message: "Ingest key not found" })
				}
				return new CustomIngestKeyWithSecret({ key: rowToKey(row), secret })
			})

			const remove = Effect.fn("OrgCustomIngestKeysService.delete")(function* (
				orgId: OrgId,
				keyId: CustomIngestKeyId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.ingest_key.id": keyId })
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.deleteFrom(OrgIngestCustomKeys)
							.where(($) => [$.orgId.eq(orgId), $.id.eq(keyId)])
							.returning(),
					),
				)
				const row = rows[0]
				if (row === undefined) {
					return yield* new CustomIngestKeyNotFoundError({ keyId, message: "Ingest key not found" })
				}
				return rowToKey(row)
			})

			return { list, get, create, update, roll, delete: remove }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
