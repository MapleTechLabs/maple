import { parseWarehouseDateTime } from "@maple/query-engine"
import { Effect, Predicate, Schema } from "effect"
import { SourceNotFoundError } from "@maple/domain/http"
import { SourceId } from "@maple/domain/primitives"
import { encodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import type { FixtureArea } from "../areas.ts"
import type { EndpointHandler, EndpointRequest } from "../dataset.ts"
import { DAY, fixtureUuid, HOUR, MINUTE } from "../identity.ts"
import { isAcme } from "./integrations.ts"

/**
 * `/sources`: Acme has its default source, two token sources (one paused), a browser source that
 * never sent and a stale Prometheus integration. Every other org has only its default source.
 * Writes answer from the canned list; the store is not mutated, so a re-read is unchanged.
 */

const at = (request: EndpointRequest, agoMs: number) =>
	new Date(parseWarehouseDateTime(request.dataset.now) - agoMs).toISOString()
const list = (data: ReadonlyArray<unknown>) => ({ object: "list", data, has_more: false, next_cursor: null })

/** The raw UUIDs the API decodes `src_` ids into, so `params.id` compares against them. */
export const SOURCE_UUIDS = {
	default: fixtureUuid(0xe1, 1),
	checkout: fixtureUuid(0xe1, 2),
	cluster: fixtureUuid(0xe1, 3),
	browser: fixtureUuid(0xe1, 4),
	prometheus: fixtureUuid(0xe1, 5),
} as const

const health = (status: string, lastDataAt: string | null, problem: string | null = null) => ({
	status,
	last_data_at: lastDataAt,
	problem,
})

interface SourceFields {
	readonly uuid: string
	readonly name: string
	readonly platform: string
	readonly createdAgoMs: number
	readonly keyPrefix?: string | null
	readonly isDefault?: boolean
	readonly description?: string | null
	readonly status?: "active" | "paused" | "expired"
	readonly allowedSignals?: ReadonlyArray<string> | null
	readonly rateLimitRps?: number | null
	readonly resourceAttributes?: ReadonlyArray<{ key: string; value: string; mode: "set" | "default" }>
	readonly expiresAt?: string | null
	readonly pausedUntil?: string | null
	readonly pausedAt?: string | null
	readonly lastUsedAt?: string | null
	readonly health: ReturnType<typeof health>
}

const source = (request: EndpointRequest, fields: SourceFields) => ({
	id: encodePublicId(PublicIdPrefixes.source, fields.uuid),
	object: "source",
	name: fields.name,
	description: fields.description ?? null,
	platform: fields.platform,
	is_default: fields.isDefault ?? false,
	key_prefix: fields.keyPrefix ?? null,
	status: fields.status ?? "active",
	allowed_signals: fields.allowedSignals ?? null,
	rate_limit_rps: fields.rateLimitRps ?? null,
	resource_attributes: fields.resourceAttributes ?? [],
	expires_at: fields.expiresAt ?? null,
	paused_at: fields.pausedAt ?? null,
	paused_until: fields.pausedUntil ?? null,
	last_used_at: fields.lastUsedAt ?? null,
	rolled_at: fields.keyPrefix === undefined || fields.keyPrefix === null ? null : at(request, fields.createdAgoMs),
	created_at: at(request, fields.createdAgoMs),
	updated_at: at(request, fields.createdAgoMs - HOUR),
	health: fields.health,
})

const defaultSource = (request: EndpointRequest, lastDataAt: string | null) =>
	source(request, {
		uuid: SOURCE_UUIDS.default,
		name: "Default",
		platform: "opentelemetry",
		isDefault: true,
		createdAgoMs: 60 * DAY,
		lastUsedAt: lastDataAt,
		health: health(lastDataAt === null ? "pending" : "healthy", lastDataAt),
	})

const acmeSources = (request: EndpointRequest) => [
	defaultSource(request, at(request, 2 * MINUTE)),
	source(request, {
		uuid: SOURCE_UUIDS.checkout,
		name: "Checkout API",
		description: "Production checkout service",
		platform: "nodejs",
		keyPrefix: "maple_src_Q7xZa",
		createdAgoMs: 12 * DAY,
		allowedSignals: ["traces", "logs"],
		rateLimitRps: 200,
		resourceAttributes: [
			{ key: "deployment.environment", value: "production", mode: "set" },
			{ key: "service.namespace", value: "shop", mode: "default" },
		],
		expiresAt: at(request, -30 * DAY),
		lastUsedAt: at(request, 4 * MINUTE),
		health: health("healthy", at(request, 4 * MINUTE)),
	}),
	source(request, {
		uuid: SOURCE_UUIDS.cluster,
		name: "Staging cluster",
		platform: "kubernetes",
		keyPrefix: "maple_src_K3pLm",
		createdAgoMs: 5 * DAY,
		status: "paused",
		pausedAt: at(request, 3 * HOUR),
		pausedUntil: null,
		lastUsedAt: at(request, 3 * HOUR),
		health: health("paused", at(request, 3 * HOUR), "Paused until resumed. Data sent now is dropped."),
	}),
	source(request, {
		uuid: SOURCE_UUIDS.browser,
		name: "Storefront browser",
		platform: "browser",
		keyPrefix: "maple_src_B8wRt",
		createdAgoMs: 2 * HOUR,
		allowedSignals: ["sessions", "events"],
		health: health("pending", null),
	}),
	source(request, {
		uuid: SOURCE_UUIDS.prometheus,
		name: "Prometheus",
		platform: "prometheus",
		createdAgoMs: 20 * DAY,
		lastUsedAt: at(request, 2 * DAY),
		health: health("stale", at(request, 2 * DAY), "No successful scrape in 2 days."),
	}),
]

/** Newest first after the default source, as the API orders them. */
export const sourcesOf = (request: EndpointRequest) =>
	isAcme(request) ? acmeSources(request) : [defaultSource(request, null)]

const idOf = (request: EndpointRequest) =>
	Predicate.hasProperty(request.params, "id") && typeof request.params.id === "string" ? request.params.id : ""

const CREATED_UUID = fixtureUuid(0xe1, 0x10)

/**
 * A listed source, or the one a create just answered. Read back, it has already sent data, so the
 * connect flow's 5 s poll stops after its first answer and a capture logs exactly one read.
 */
const found = (request: EndpointRequest) => {
	const id = idOf(request)
	const match =
		id === CREATED_UUID
			? { ...createdSource(request, "Source", "opentelemetry"), last_used_at: at(request, 0) }
			: sourcesOf(request).find((row) => row.id === encodePublicId(PublicIdPrefixes.source, id))
	return match === undefined
		? Effect.flatMap(Schema.decodeUnknownEffect(SourceId)(id), (sourceId) =>
				Effect.fail(new SourceNotFoundError({ sourceId, message: "Source not found" })),
			)
		: Effect.succeed(match)
}

const createdSource = (request: EndpointRequest, name: string, platform: string) =>
	source(request, {
		uuid: CREATED_UUID,
		name,
		platform,
		keyPrefix: "maple_src_Q7xZa",
		createdAgoMs: 0,
		health: health("pending", null),
	})

const SECRET = "maple_src_Q7xZa8Kt7pQ2wR5vN0sL3dJ6hM4gY9dW1"

/** A create answers a fresh source on the requested platform, with its one-time token. */
const created: EndpointHandler = (request) => {
	const payload = Predicate.isObject(request.payload) ? request.payload : {}
	const name = Predicate.hasProperty(payload, "name") && typeof payload.name === "string" ? payload.name : "Source"
	const platform =
		Predicate.hasProperty(payload, "platform") && typeof payload.platform === "string" ? payload.platform : "opentelemetry"
	return Effect.succeed({ ...createdSource(request, name, platform), secret: SECRET })
}

/** 24 hourly buckets ending at the frozen clock, quieter overnight; hours without data are omitted. */
const usage: EndpointHandler = (request) => {
	const nowMs = parseWarehouseDateTime(request.dataset.now)
	const end = Math.floor(nowMs / HOUR) * HOUR + HOUR
	const id = idOf(request)
	const isQuiet = id !== SOURCE_UUIDS.checkout && id !== SOURCE_UUIDS.default
	const buckets = isQuiet
		? []
		: Array.from({ length: 24 }, (_, index) => ({
				hour: new Date(end - (24 - index) * HOUR).toISOString(),
				spans: 4_000 + ((index * 7919) % 13) * 900,
				logs: 1_200 + ((index * 104_729) % 11) * 310,
			})).filter((_, index) => index % 9 !== 4)
	return Effect.succeed({
		object: "source_usage",
		window_start: new Date(end - DAY).toISOString(),
		window_end: new Date(end).toISOString(),
		buckets,
	})
}


export const fixtureArea: FixtureArea = {
	area: "sources",
	endpoints: () => ({
		"sources.list": (request) => Effect.succeed(list(sourcesOf(request))),
		"sources.retrieve": found,
		"sources.usage": usage,
		"sources.create": created,
		"sources.update": found,
		"sources.pause": found,
		"sources.resume": found,
		"sources.roll": (request) => Effect.map(found(request), (row) => ({ ...row, secret: SECRET })),
		"sources.delete": (request) =>
			Effect.map(found(request), (row) => ({ id: row.id, object: "source", deleted: true })),
	}),
}
