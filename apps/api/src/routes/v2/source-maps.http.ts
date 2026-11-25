import { HttpApiBuilder } from "effect/http-api"
import type { HttpServerRequest } from "effect/http"
import { HttpIncomingMessage } from "effect/http"
import {
	CurrentTenant,
	SOURCE_MAP_MAX_BYTES,
	SourceMapInvalidError,
	SourceMapTooLargeError,
} from "@maple/domain/http"
import { isoTimestamp, isoTimestampOrNull, MapleApiV2, paginateOffsetQuery } from "@maple/domain/http/v2"
import { V2InsufficientPermissions, type V2SourceMap } from "@maple/domain/http/v2"
import type { SourceMapFileRow } from "@maple/db/tables"
import { Array as Arr, ByteSize, Effect, Option } from "effect"
import * as Policy from "@maple/domain/policy"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { SourceMapService } from "@maple/backend/services/sourcemaps/SourceMapService"

const toV2SourceMap = (row: SourceMapFileRow): V2SourceMap => ({
	object: "source_map",
	id: row.id,
	debug_id: row.debugId,
	service: row.serviceName,
	version: row.version,
	minified_path: row.minifiedPath,
	size_bytes: row.sizeBytes,
	has_sources_content: row.hasSourcesContent,
	created_at: isoTimestamp(row.createdAt),
	last_used_at: isoTimestampOrNull(row.lastUsedAt),
})

// Uploads decide what every member sees in stack traces, so they take the role that manages
// ingest keys; listing stays open to members.
const requireUpload = (tenant: CurrentTenant.TenantSchema) =>
	Policy.check(tenant.permissions, "source_maps:upload", (denial) =>
		V2InsufficientPermissions.make(denial.message),
	)

const tooLarge = (sizeBytes: number) =>
	new SourceMapTooLargeError({
		message: `Source map is ${sizeBytes} bytes; the limit is ${SOURCE_MAP_MAX_BYTES} (10 MiB), the largest map Maple can symbolicate with.`,
		sizeBytes,
	})

/**
 * The body, refused by its `Content-Length` before any of it is read, and cut off at the limit
 * while reading when the header is absent or wrong.
 */
const readLimitedBody = (
	request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<Uint8Array, SourceMapTooLargeError | SourceMapInvalidError> =>
	Effect.gen(function* () {
		const declared = Option.filter(
			Option.fromNullishOr(request.headers["content-length"]).pipe(Option.map(Number)),
			Number.isFinite,
		)
		if (Option.isSome(declared) && declared.value > SOURCE_MAP_MAX_BYTES) {
			return yield* tooLarge(declared.value)
		}
		const buffer = yield* request.arrayBuffer.pipe(
			Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(SOURCE_MAP_MAX_BYTES)),
			Effect.mapError((error): SourceMapTooLargeError | SourceMapInvalidError =>
				error.reason._tag === "RequestParseError" && error.reason.reason === "BodyTooLarge"
					? tooLarge(SOURCE_MAP_MAX_BYTES + 1)
					: new SourceMapInvalidError({ message: "The request body could not be read." }),
			),
		)
		return new Uint8Array(buffer)
	})

export const HttpV2SourceMapsLive = HttpApiBuilder.group(MapleApiV2, "sourceMaps", (handlers) =>
	Effect.gen(function* () {
		const sourceMaps = yield* SourceMapService

		return (
			handlers
				// Raw, so an oversized body is refused before it is buffered into the isolate.
				.handleRaw("upload", ({ query, request }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* requireUpload(tenant)
						const bytes = yield* readLimitedBody(request)
						const row = yield* sourceMaps.upload(tenant.orgId, {
							bytes,
							minifiedPath: query.minified_path,
							debugId: query.debug_id,
							serviceName: query.service,
							version: query.version,
						})
						yield* recordHttpAudit("source_map.uploaded", {
							resourceId: row.id,
							metadata: {
								minified_path: row.minifiedPath,
								...(row.debugId === null ? undefined : { debug_id: row.debugId }),
								...(row.serviceName === null ? undefined : { service: row.serviceName }),
								...(row.version === null ? undefined : { version: row.version }),
							},
						})
						return toV2SourceMap(row)
					}),
				)
				.handle("list", ({ query }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const page = yield* paginateOffsetQuery(query, ({ limit, offset }) =>
							sourceMaps.list(tenant.orgId, {
								serviceName: query.service,
								version: query.version,
								debugId: query.debug_id,
								limit,
								offset,
							}),
						)
						return { object: "list" as const, ...page, data: Arr.map(page.data, toV2SourceMap) }
					}),
				)
				.handle("delete", ({ params }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* requireUpload(tenant)
						const row = yield* sourceMaps.remove(tenant.orgId, params.id)
						yield* recordHttpAudit("source_map.deleted", {
							resourceId: row.id,
							metadata: { minified_path: row.minifiedPath },
						})
						return toV2SourceMap(row)
					}),
				)
		)
	}),
)
