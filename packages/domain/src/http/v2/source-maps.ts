import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import { Schema } from "effect"
import { SourceMapFileId } from "@maple/primitives"
import {
	SourceMapInvalidError,
	SourceMapNotFoundError,
	SourceMapStorageError,
	SourceMapTooLargeError,
} from "../source-maps"
import { EndpointAccess, requires } from "../endpoint-access"
import { AuthorizationV2 } from "./auth"
import { wireExample, ListOf, ListQuery, Timestamp } from "./envelopes"
import { V2InsufficientPermissions, V2ParameterInvalid } from "./errors"
import { publicErrors } from "./public-error"
import { PublicId, PublicIdPrefixes } from "./public-id"

/** `smap_…` public ID ⇄ internal `SourceMapFileId` (raw UUID). */
export const SourceMapPublicId = PublicId(PublicIdPrefixes.sourceMap, SourceMapFileId)

const DebugId = Schema.String.check(Schema.isGUID()).annotate({
	description:
		"The file's debug id, as `maple sourcemaps inject` (or a bundler plugin) wrote it into the JavaScript file and its map.",
	examples: ["6c5e2b1a-1f2e-4d3c-8b7a-0123456789ab"],
})

const Label = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))

const sourceMapExample = {
	object: "source_map",
	id: "smap_YofPTrK9782DWwcnXhpcCw",
	debug_id: "6c5e2b1a-1f2e-4d3c-8b7a-0123456789ab",
	service: "web",
	version: "1.4.2",
	minified_path: "assets/index-Bx81.js",
	size_bytes: 482113,
	has_sources_content: true,
	created_at: "2026-11-24T12:00:00.000Z",
	last_used_at: null,
} as const

export const V2SourceMap = Schema.Struct({
	object: Schema.Literal("source_map").annotate({
		description: 'The object type, always `"source_map"`.',
		examples: ["source_map"],
	}),
	id: SourceMapPublicId,
	debug_id: Schema.NullOr(DebugId),
	service: Schema.NullOr(Schema.String).annotate({
		description: "The service the map was uploaded for, or `null` when matched by debug id only.",
		examples: ["web"],
	}),
	version: Schema.NullOr(Schema.String).annotate({
		description: "The release (`service.version`) the map was uploaded for, or `null`.",
		examples: ["1.4.2"],
	}),
	minified_path: Schema.String.annotate({
		description:
			"Path of the JavaScript file the map belongs to, relative to the deploy root. A stack frame URL matches it when the URL's path equals it or ends with `/` followed by it, so `assets/app.js` matches `https://cdn.example.com/static/assets/app.js` but `app.js` does not match `assets/myapp.js`.",
		examples: ["assets/index-Bx81.js"],
	}),
	size_bytes: Schema.Number.annotate({
		description: "Size of the stored map in bytes.",
		examples: [482113],
	}),
	has_sources_content: Schema.Boolean.annotate({
		description:
			"Whether the map embeds the original sources, which lets errors show code around each frame.",
		examples: [true],
	}),
	created_at: Timestamp.annotate({ description: "When the map was uploaded." }),
	last_used_at: Schema.NullOr(Timestamp).annotate({
		description:
			"When the map last resolved a stack trace, to the day, or `null`. Maps unused for 90 days are deleted.",
	}),
}).annotate({
	identifier: "SourceMap",
	title: "Source Map",
	description:
		"A JavaScript source map Maple uses to turn minified browser stack traces back into your original code. Matched to a stack frame by debug id, else by service, version and file path.",
	examples: [wireExample(sourceMapExample)],
})
export type V2SourceMap = Schema.Schema.Type<typeof V2SourceMap>

export const V2SourceMapUploadQuery = Schema.Struct({
	minified_path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)).annotate({
		description:
			"Path of the JavaScript file the map belongs to, relative to the deploy root, such as `assets/index-Bx81.js`.",
		examples: ["assets/index-Bx81.js"],
	}),
	debug_id: Schema.optional(DebugId),
	service: Schema.optional(
		Label.annotate({
			description: "The service the JavaScript belongs to (OTel `service.name`).",
			examples: ["web"],
		}),
	),
	version: Schema.optional(
		Label.annotate({
			description: "The release the JavaScript belongs to (OTel `service.version`).",
			examples: ["1.4.2"],
		}),
	),
}).annotate({
	identifier: "SourceMapUploadQuery",
	title: "Source map upload parameters",
	description: "Identify the uploaded map with `debug_id`, or with both `service` and `version`.",
})
export type V2SourceMapUploadQuery = Schema.Schema.Type<typeof V2SourceMapUploadQuery>

export const V2SourceMapListQuery = Schema.Struct({
	...ListQuery.fields,
	service: Schema.optional(Label),
	version: Schema.optional(Label),
	debug_id: Schema.optional(DebugId),
}).annotate({
	identifier: "SourceMapListQuery",
	title: "Source map list query",
	description: "Pagination plus optional filters on service, version and debug id.",
})
export type V2SourceMapListQuery = Schema.Schema.Type<typeof V2SourceMapListQuery>

/** The raw map bytes, sent as either content type. */
const SourceMapBody = [
	Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array({ contentType: "application/octet-stream" })),
	Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array({ contentType: "application/json" })),
] as const

const SourceMapList = ListOf(V2SourceMap).annotate({
	identifier: "SourceMapList",
	title: "Source map list",
	description: "A cursor-paginated page of source maps.",
})

const [sourceMapInvalid, sourceMapTooLarge, sourceMapNotFound, sourceMapStorage] = publicErrors(
	SourceMapInvalidError,
	SourceMapTooLargeError,
	SourceMapNotFoundError,
	SourceMapStorageError,
)

export class V2SourceMapsApiGroup extends HttpApiGroup.make("sourceMaps")
	.add(
		HttpApiEndpoint.post("upload", "/", {
			query: V2SourceMapUploadQuery,
			payload: SourceMapBody,
			success: V2SourceMap,
			error: [V2InsufficientPermissions.schema, sourceMapInvalid, sourceMapTooLarge, sourceMapStorage],
		})
			.annotate(EndpointAccess, requires("source_maps:upload"))
			.annotateMerge(
				OpenApi.annotations({
					identifier: "uploadSourceMap",
					summary: "Upload a source map",
					description:
						"Stores one source map (the raw JSON as the request body, at most 10 MiB, the largest map Maple can symbolicate with; larger is a 413). Index maps (with `sections`) are refused with a 400; emit a regular map. With a `debug_id`, only the map with that `debug_id` is replaced, so builds sharing a release path keep their own maps. Without one, the map without a debug id at the same `service`, `version` and `minified_path` is replaced. Requires an engineer or admin role and the `source_maps:write` scope.",
				}),
			),
	)
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: V2SourceMapListQuery,
			success: SourceMapList,
			error: [V2ParameterInvalid.schema, sourceMapStorage],
		})
			.annotate(EndpointAccess, requires("telemetry:read"))
			.annotateMerge(
				OpenApi.annotations({
					identifier: "listSourceMaps",
					summary: "List source maps",
					description:
						"Returns your organization's source maps, newest first. Cursor-paginated. Requires the `source_maps:read` scope.",
				}),
			),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/:id", {
			params: { id: SourceMapPublicId },
			success: V2SourceMap,
			error: [V2InsufficientPermissions.schema, sourceMapNotFound, sourceMapStorage],
		})
			.annotate(EndpointAccess, requires("source_maps:upload"))
			.annotateMerge(
				OpenApi.annotations({
					identifier: "deleteSourceMap",
					summary: "Delete a source map",
					description:
						"Deletes a source map and returns it as it was. Requires an engineer or admin role and the `source_maps:write` scope.",
				}),
			),
	)
	.prefix("/v2/source_maps")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Source Maps",
			description:
				"JavaScript source maps for symbolicating browser errors. Upload one per built file from CI (`maple sourcemaps upload`), list them, or delete them. Any member may list; uploading and deleting take an engineer or admin.",
		}),
	) {}
