import { Schema } from "effect"
import { SourceMapFileId } from "@maple/primitives"
import { HttpTaggedError } from "./error-policy"

/**
 * Largest source map one upload may carry: also the largest symbolication loads, so an upload that
 * succeeds can always be used.
 */
export const SOURCE_MAP_MAX_BYTES = 10 * 1024 * 1024

/** The upload is not a usable source map, or its parameters do not identify one. */
export class SourceMapInvalidError extends HttpTaggedError<SourceMapInvalidError>()(
	"@maple/http/sourcemaps/SourceMapInvalidError",
	{
		message: Schema.String,
		param: Schema.optionalKey(Schema.String),
	},
	{
		status: 400,
		code: "source_map_invalid",
		title: "Invalid source map",
		param: (error) => error.param,
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

export class SourceMapTooLargeError extends HttpTaggedError<SourceMapTooLargeError>()(
	"@maple/http/sourcemaps/SourceMapTooLargeError",
	{
		message: Schema.String,
		sizeBytes: Schema.Number,
	},
	{
		status: 413,
		code: "source_map_too_large",
		title: "Source map is too large",
		message: "Source maps are limited to 10 MiB each, the largest Maple can symbolicate with.",
		retry: "never",
		recovery: "fix_request",
		exposure: "redacted",
	},
) {}

export class SourceMapNotFoundError extends HttpTaggedError<SourceMapNotFoundError>()(
	"@maple/http/sourcemaps/SourceMapNotFoundError",
	{
		message: Schema.String,
		sourceMapId: SourceMapFileId,
	},
	{
		status: 404,
		code: "source_map_not_found",
		title: "Source map not found",
		message: "No such source map.",
		param: "id",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}

/** Postgres or the object store failed; `cause` stays server-side. */
export class SourceMapStorageError extends HttpTaggedError<SourceMapStorageError>()(
	"@maple/http/sourcemaps/SourceMapStorageError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.String),
	},
	{
		status: 503,
		code: "source_maps_unavailable",
		title: "Source maps are temporarily unavailable",
		message: "Source maps are temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}
