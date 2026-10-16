import { randomBytes, randomUUID } from "node:crypto"
import {
	type CreateCustomIngestKeyRequest,
	CustomIngestKey,
	CustomIngestKeyId,
	type CustomIngestKeyStatus,
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
import * as Orm from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgIngestCustomKeys, type OrgIngestCustomKeyRow } from "@maple/db/tables"
import { Array as Arr, Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { Database, type DatabaseError } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"

const CUSTOM_INGEST_KEY_PREFIX = "maple_ik_"
const MAX_KEYS_PER_ORG = 50
const MAX_RESOURCE_ATTRIBUTES = 20
const MAX_RATE_LIMIT_RPS = 100_000
const MAX_NAME_LENGTH = 100
const MAX_DESCRIPTION_LENGTH = 500
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

// Mirrors the gateway: an expired key is rejected even while paused.
const statusOf = (row: OrgIngestCustomKeyRow, now: number): CustomIngestKeyStatus => {
	if (row.expiresAt !== null && row.expiresAt <= now) return "expired"
	if (row.pausedAt !== null && (row.pausedUntil === null || row.pausedUntil > now)) return "paused"
	return "active"
}

const isoOrNull = (epochMs: number | null) => (epochMs === null ? null : toIso(epochMs))

const rowToKey = (row: OrgIngestCustomKeyRow, now: number): CustomIngestKey =>
	new CustomIngestKey({
		id: row.id,
		name: row.name,
		description: row.description,
		keyPrefix: row.keyPrefix,
		status: statusOf(row, now),
		allowedSignals: row.allowedSignals,
		rateLimitRps: row.rateLimitRps,
		resourceAttributes: row.resourceAttributes,
		expiresAt: isoOrNull(row.expiresAt),
		// A pause that already ended reads as not paused.
		pausedAt: statusOf(row, now) === "paused" ? isoOrNull(row.pausedAt) : null,
		pausedUntil: statusOf(row, now) === "paused" ? isoOrNull(row.pausedUntil) : null,
		lastUsedAt: isoOrNull(row.lastUsedAt),
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

const normalizeDescription = Effect.fnUntraced(function* (description: string | null) {
	const trimmed = description?.trim() ?? ""
	if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
		return yield* invalid(`Description must be at most ${MAX_DESCRIPTION_LENGTH} characters`)
	}
	return trimmed.length === 0 ? null : trimmed
})

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
			if (attribute.value.length === 0)
				return yield* invalid(`Attribute "${attribute.key}" needs a value`)
			if (attribute.value.length > MAX_ATTRIBUTE_VALUE_LENGTH) {
				return yield* invalid(
					`Attribute values must be at most ${MAX_ATTRIBUTE_VALUE_LENGTH} characters`,
				)
			}
			const lower = attribute.key.toLowerCase()
			if (RESERVED_ATTRIBUTE_KEYS.has(lower) || lower.startsWith(RESERVED_ATTRIBUTE_PREFIX)) {
				return yield* invalid(`"${attribute.key}" is reserved by Maple and cannot be overridden`)
			}
		}),
	)
	const keys = Arr.map(normalized, (attribute) => attribute.key)
	if (Arr.dedupe(keys).length !== keys.length)
		return yield* invalid("Each attribute key can only be listed once")
	return normalized
})

// `current` is the stored expiry: sending it back unchanged is allowed even once it has passed.
const normalizeExpiry = Effect.fnUntraced(function* (
	expiresAtMs: number | null,
	now: number,
	current: number | null = null,
) {
	if (expiresAtMs === null || expiresAtMs === current) return expiresAtMs
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
				const now = yield* Clock.currentTimeMillis
				return Arr.map(rows, (row) => rowToKey(row, now))
			})

			const get = Effect.fn("OrgCustomIngestKeysService.get")(function* (
				orgId: OrgId,
				keyId: CustomIngestKeyId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.ingest_key.id": keyId })
				const row = yield* requireRow(orgId, keyId)
				return rowToKey(row, yield* Clock.currentTimeMillis)
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

				const description = yield* normalizeDescription(request.description ?? null)
				const id = decodeKeyIdSync(randomUUID())
				const secret = generateSecret()
				yield* Effect.annotateCurrentSpan("maple.ingest_key.id", id)
				// The per-org lock makes the key cap hold under concurrent creates.
				const rows = yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							yield* db.execute(
								Orm.sql`select pg_advisory_xact_lock(hashtext(${orgId}), hashtext('custom_ingest_keys'))`,
							)
							const existing = yield* db.run(
								PG.from(OrgIngestCustomKeys)
									.select(($) => ({ id: $.id }))
									.where(($) => [$.orgId.eq(orgId)])
									.limit(MAX_KEYS_PER_ORG),
							)
							if (existing.length >= MAX_KEYS_PER_ORG) return null
							return yield* db.run(
								PG.insertInto(OrgIngestCustomKeys)
									.values({
										id,
										orgId,
										name,
										description,
										keyHash: hashIngestKey(secret, lookupHmacKey),
										keyPrefix: displayPrefix(secret),
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
							)
						}),
					),
				)
				if (rows === null) {
					return yield* invalid(
						`An organization can have at most ${MAX_KEYS_PER_ORG} custom ingest keys`,
					)
				}
				const row = rows[0]
				if (row === undefined) {
					return yield* new IngestKeyPersistenceError({ message: "Failed to create ingest key" })
				}
				return new CustomIngestKeyWithSecret({ key: rowToKey(row, now), secret })
			})

			const update = Effect.fn("OrgCustomIngestKeysService.update")(function* (
				orgId: OrgId,
				userId: UserId,
				keyId: CustomIngestKeyId,
				request: UpdateCustomIngestKeyRequest,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.ingest_key.id": keyId })
				const existing = yield* requireRow(orgId, keyId)
				const now = yield* Clock.currentTimeMillis
				const updates = {
					updatedAt: now,
					updatedBy: userId,
					name: request.name === undefined ? undefined : yield* normalizeName(request.name),
					description:
						request.description === undefined
							? undefined
							: yield* normalizeDescription(request.description),
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
							: yield* normalizeExpiry(request.expiresAtMs, now, existing.expiresAt),
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
				return rowToKey(row, now)
			})

			const setPause = Effect.fnUntraced(function* (
				orgId: OrgId,
				userId: UserId,
				keyId: CustomIngestKeyId,
				now: number,
				pause: { readonly pausedAt: number | null; readonly pausedUntil: number | null },
			) {
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.update(OrgIngestCustomKeys)
							.set({ ...pause, updatedAt: now, updatedBy: userId })
							.where(($) => [$.orgId.eq(orgId), $.id.eq(keyId)])
							.returning(),
					),
				)
				const row = rows[0]
				if (row === undefined) {
					return yield* new CustomIngestKeyNotFoundError({ keyId, message: "Ingest key not found" })
				}
				return row
			})

			// `untilMs` null pauses until resumed.
			const pause = Effect.fn("OrgCustomIngestKeysService.pause")(function* (
				orgId: OrgId,
				userId: UserId,
				keyId: CustomIngestKeyId,
				untilMs: number | null,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.ingest_key.id": keyId })
				const now = yield* Clock.currentTimeMillis
				if (untilMs !== null && untilMs <= now)
					return yield* invalid("A pause must end in the future")
				const row = yield* setPause(orgId, userId, keyId, now, {
					pausedAt: now,
					pausedUntil: untilMs,
				})
				return rowToKey(row, now)
			})

			const resume = Effect.fn("OrgCustomIngestKeysService.resume")(function* (
				orgId: OrgId,
				userId: UserId,
				keyId: CustomIngestKeyId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.ingest_key.id": keyId })
				const now = yield* Clock.currentTimeMillis
				const row = yield* setPause(orgId, userId, keyId, now, { pausedAt: null, pausedUntil: null })
				return rowToKey(row, now)
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
				return new CustomIngestKeyWithSecret({ key: rowToKey(row, now), secret })
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
				return rowToKey(row, yield* Clock.currentTimeMillis)
			})

			return { list, get, create, update, pause, resume, roll, delete: remove }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
