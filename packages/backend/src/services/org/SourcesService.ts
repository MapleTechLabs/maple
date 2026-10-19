import { randomBytes } from "node:crypto"
import {
	type CreateSourceRequest,
	IngestKeyEncryptionError,
	IsoDateTimeString,
	type OrgId,
	Source,
	SOURCE_LIMITS,
	SourceNotFoundError,
	SourcePersistenceError,
	type SourceTokenStatus,
	SourceValidationError,
	SourceWithSecret,
	type UpdateSourceRequest,
	type UserId,
} from "@maple/domain/http"
import { SourceId, type SourceResourceAttribute, type SourceSignal } from "@maple/domain/primitives"
import { hashIngestKey, parseIngestKeyLookupHmacKey } from "@maple/db"
import * as Orm from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Sources, type SourceRow } from "@maple/db/tables"
import { Array as Arr, Clock, Context, Effect, Layer, Redacted, Schema } from "effect"
import { Database, type DatabaseError } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import { defaultSourceRow, newSourceId } from "./source-rows"

const SOURCE_TOKEN_PREFIX = "maple_src_"
const {
	maxSourcesPerOrg: MAX_SOURCES_PER_ORG,
	maxResourceAttributes: MAX_RESOURCE_ATTRIBUTES,
	maxRateLimitRps: MAX_RATE_LIMIT_RPS,
} = SOURCE_LIMITS
const MAX_NAME_LENGTH = 100
const MAX_DESCRIPTION_LENGTH = 500
const MAX_ATTRIBUTE_KEY_LENGTH = 255
const MAX_ATTRIBUTE_VALUE_LENGTH = 1024
// `maple_` attributes are stamped by the gateway and must never be overridable.
const RESERVED_ATTRIBUTE_KEYS = new Set(["org_id"])
const RESERVED_ATTRIBUTE_PREFIX = "maple_"

const toPersistenceError = (error: DatabaseError) => new SourcePersistenceError({ message: error.message })
const invalid = (message: string) => new SourceValidationError({ message })

const decodeIsoSync = Schema.decodeUnknownSync(IsoDateTimeString)
const toIso = (epochMs: number) => decodeIsoSync(new Date(epochMs).toISOString())

const generateSecret = () => `${SOURCE_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`
const displayPrefix = (secret: string) => secret.slice(0, SOURCE_TOKEN_PREFIX.length + 5)

// Mirrors the gateway: an expired token is rejected even while paused.
const statusOf = (row: SourceRow, now: number): SourceTokenStatus => {
	if (row.expiresAt !== null && row.expiresAt <= now) return "expired"
	if (row.pausedAt !== null && (row.pausedUntil === null || row.pausedUntil > now)) return "paused"
	return "active"
}

const isoOrNull = (epochMs: number | null) => (epochMs === null ? null : toIso(epochMs))

const rowToSource = (row: SourceRow, now: number): Source => {
	const status = statusOf(row, now)
	return new Source({
		id: row.id,
		name: row.name,
		description: row.description,
		platform: row.platform,
		isDefault: row.isDefault,
		keyPrefix: row.keyPrefix,
		status,
		allowedSignals: row.allowedSignals,
		rateLimitRps: row.rateLimitRps,
		resourceAttributes: row.resourceAttributes,
		expiresAt: isoOrNull(row.expiresAt),
		// A pause that already ended reads as not paused.
		pausedAt: status === "paused" ? isoOrNull(row.pausedAt) : null,
		pausedUntil: status === "paused" ? isoOrNull(row.pausedUntil) : null,
		lastUsedAt: isoOrNull(row.lastUsedAt),
		rolledAt: isoOrNull(row.rolledAt),
		createdAt: toIso(row.createdAt),
		updatedAt: toIso(row.updatedAt),
	})
}

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

const normalizeSignals = Effect.fnUntraced(function* (signals: ReadonlyArray<SourceSignal> | null) {
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

const normalizeAttributes = Effect.fnUntraced(function* (attributes: ReadonlyArray<SourceResourceAttribute>) {
	if (attributes.length > MAX_RESOURCE_ATTRIBUTES) {
		return yield* invalid(`At most ${MAX_RESOURCE_ATTRIBUTES} resource attributes per source`)
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

// Rules are enforced by the gateway on a source's own token, so only token sources take them.
const RULE_FIELDS = ["allowedSignals", "rateLimitRps", "resourceAttributes", "expiresAtMs"] as const

const tokenSourceOnly = (row: SourceRow, action: string) =>
	row.isDefault
		? invalid(`The default source uses the organization's ingest keys and cannot ${action}`)
		: invalid(`${row.name} is collected by an integration and cannot ${action}`)

export class SourcesService extends Context.Service<SourcesService>()("@maple/api/services/SourcesService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const dbExecute = makeDbExecute(database, "SourcesService", toPersistenceError)
		const env = yield* Env
		const lookupHmacKey = yield* parseIngestKeyLookupHmacKey(
			Redacted.value(env.MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY),
			(message) => new IngestKeyEncryptionError({ message }),
		)

		const notFound = (sourceId: SourceId) =>
			new SourceNotFoundError({ sourceId, message: "Source not found" })

		const requireRow = Effect.fnUntraced(function* (orgId: OrgId, sourceId: SourceId) {
			const rows = yield* dbExecute((db) =>
				db.run(
					PG.from(Sources)
						.select()
						.where(($) => [$.orgId.eq(orgId), $.id.eq(sourceId)])
						.limit(1),
				),
			)
			const row = rows[0]
			if (row === undefined) return yield* notFound(sourceId)
			return row
		})

		const updateRow = Effect.fnUntraced(function* (
			orgId: OrgId,
			sourceId: SourceId,
			set: Partial<Omit<SourceRow, "id" | "orgId">>,
		) {
			const rows = yield* dbExecute((db) =>
				db.run(
					PG.update(Sources)
						.set(set)
						.where(($) => [$.orgId.eq(orgId), $.id.eq(sourceId)])
						.returning(),
				),
			)
			const row = rows[0]
			if (row === undefined) return yield* notFound(sourceId)
			return row
		})

		// Orgs created before sources existed get their default source on first list.
		const ensureDefault = (orgId: OrgId, now: number) =>
			dbExecute((db) =>
				db.run(PG.insertInto(Sources).values(defaultSourceRow(orgId, now)).onConflictDoNothing()),
			)

		const list = Effect.fn("SourcesService.list")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			const now = yield* Clock.currentTimeMillis
			const select = dbExecute((db) =>
				db.run(
					PG.from(Sources)
						.select()
						.where(($) => [$.orgId.eq(orgId)])
						.orderBy(($) => [
							[$.isDefault, "desc"],
							[$.createdAt, "desc"],
							[$.id, "desc"],
						]),
				),
			)
			const first = yield* select
			if (first.some((row) => row.isDefault)) return Arr.map(first, (row) => rowToSource(row, now))
			yield* ensureDefault(orgId, now)
			return Arr.map(yield* select, (row) => rowToSource(row, now))
		})

		const get = Effect.fn("SourcesService.get")(function* (orgId: OrgId, sourceId: SourceId) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.source.id": sourceId })
			const row = yield* requireRow(orgId, sourceId)
			return rowToSource(row, yield* Clock.currentTimeMillis)
		})

		const create = Effect.fn("SourcesService.create")(function* (
			orgId: OrgId,
			userId: UserId,
			request: CreateSourceRequest,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.source.platform": request.platform })
			const now = yield* Clock.currentTimeMillis
			const name = yield* normalizeName(request.name)
			const description = yield* normalizeDescription(request.description ?? null)
			const allowedSignals = yield* normalizeSignals(request.allowedSignals ?? null)
			const rateLimitRps = yield* normalizeRateLimit(request.rateLimitRps ?? null)
			const resourceAttributes = yield* normalizeAttributes(request.resourceAttributes ?? [])
			const expiresAt = yield* normalizeExpiry(request.expiresAtMs ?? null, now)

			const id = newSourceId()
			const secret = generateSecret()
			yield* Effect.annotateCurrentSpan("maple.source.id", id)
			// The per-org lock makes the source cap hold under concurrent creates.
			const rows = yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						yield* db.execute(
							Orm.sql`select pg_advisory_xact_lock(hashtext(${orgId}), hashtext('sources'))`,
						)
						const existing = yield* db.run(
							PG.from(Sources)
								.select(($) => ({ id: $.id }))
								.where(($) => [$.orgId.eq(orgId), $.keyHash.isNotNull()])
								.limit(MAX_SOURCES_PER_ORG),
						)
						if (existing.length >= MAX_SOURCES_PER_ORG) return null
						return yield* db.run(
							PG.insertInto(Sources)
								.values({
									id,
									orgId,
									name,
									description,
									platform: request.platform,
									isDefault: false,
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
				return yield* invalid(`An organization can have at most ${MAX_SOURCES_PER_ORG} sources`)
			}
			const row = rows[0]
			if (row === undefined) {
				return yield* new SourcePersistenceError({ message: "Failed to create source" })
			}
			return new SourceWithSecret({ source: rowToSource(row, now), secret })
		})

		const update = Effect.fn("SourcesService.update")(function* (
			orgId: OrgId,
			userId: UserId,
			sourceId: SourceId,
			request: UpdateSourceRequest,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.source.id": sourceId })
			const existing = yield* requireRow(orgId, sourceId)
			if (existing.keyHash === null && RULE_FIELDS.some((field) => request[field] !== undefined)) {
				return yield* tokenSourceOnly(existing, "take ingest rules")
			}
			const now = yield* Clock.currentTimeMillis
			const row = yield* updateRow(orgId, sourceId, {
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
			})
			return rowToSource(row, now)
		})

		// `untilMs` null pauses until resumed.
		const pause = Effect.fn("SourcesService.pause")(function* (
			orgId: OrgId,
			userId: UserId,
			sourceId: SourceId,
			untilMs: number | null,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.source.id": sourceId })
			const now = yield* Clock.currentTimeMillis
			if (untilMs !== null && untilMs <= now) return yield* invalid("A pause must end in the future")
			const existing = yield* requireRow(orgId, sourceId)
			if (existing.keyHash === null) return yield* tokenSourceOnly(existing, "be paused")
			const row = yield* updateRow(orgId, sourceId, {
				pausedAt: now,
				pausedUntil: untilMs,
				updatedAt: now,
				updatedBy: userId,
			})
			return rowToSource(row, now)
		})

		const resume = Effect.fn("SourcesService.resume")(function* (
			orgId: OrgId,
			userId: UserId,
			sourceId: SourceId,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.source.id": sourceId })
			const existing = yield* requireRow(orgId, sourceId)
			if (existing.keyHash === null) return yield* tokenSourceOnly(existing, "be resumed")
			const now = yield* Clock.currentTimeMillis
			const row = yield* updateRow(orgId, sourceId, {
				pausedAt: null,
				pausedUntil: null,
				updatedAt: now,
				updatedBy: userId,
			})
			return rowToSource(row, now)
		})

		const roll = Effect.fn("SourcesService.roll")(function* (
			orgId: OrgId,
			userId: UserId,
			sourceId: SourceId,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.source.id": sourceId })
			const existing = yield* requireRow(orgId, sourceId)
			if (existing.keyHash === null) return yield* tokenSourceOnly(existing, "be rolled here")
			const now = yield* Clock.currentTimeMillis
			const secret = generateSecret()
			const row = yield* updateRow(orgId, sourceId, {
				keyHash: hashIngestKey(secret, lookupHmacKey),
				keyPrefix: displayPrefix(secret),
				rolledAt: now,
				updatedAt: now,
				updatedBy: userId,
			})
			return new SourceWithSecret({ source: rowToSource(row, now), secret })
		})

		const remove = Effect.fn("SourcesService.delete")(function* (orgId: OrgId, sourceId: SourceId) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.source.id": sourceId })
			const existing = yield* requireRow(orgId, sourceId)
			if (existing.keyHash === null) return yield* tokenSourceOnly(existing, "be deleted here")
			const rows = yield* dbExecute((db) =>
				db.run(
					PG.deleteFrom(Sources)
						.where(($) => [$.orgId.eq(orgId), $.id.eq(sourceId)])
						.returning(),
				),
			)
			const row = rows[0]
			if (row === undefined) return yield* notFound(sourceId)
			return rowToSource(row, yield* Clock.currentTimeMillis)
		})

		return { list, get, create, update, pause, resume, roll, delete: remove }
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
