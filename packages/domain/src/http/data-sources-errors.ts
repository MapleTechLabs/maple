import { Schema } from "effect"
import { HttpTaggedError } from "./error-policy"

// HTTP errors for `/v2/data_sources`. A source is the caller's own system, so what it said
// (connection refused, a bad password, a rejected query) is safe to show and is the fix hint.

/** No data source with that id in this organization. */
export class DataSourceNotFoundHttpError extends HttpTaggedError<DataSourceNotFoundHttpError>()(
	"@maple/http/data-sources/DataSourceNotFoundError",
	{ message: Schema.String, rawRef: Schema.String },
	{
		status: 404,
		code: "data_source_not_found",
		title: "Data source not found",
		param: () => "id",
		retry: "never",
		recovery: "none",
		exposure: "public_message",
	},
) {}

/** A catalog entry by that name does not exist on the source. */
export class DataSourceCatalogEntryNotFoundError extends HttpTaggedError<DataSourceCatalogEntryNotFoundError>()(
	"@maple/http/data-sources/CatalogEntryNotFoundError",
	{ message: Schema.String },
	{
		status: 404,
		code: "data_source_catalog_entry_not_found",
		title: "Catalog entry not found",
		param: () => "entry",
		retry: "never",
		recovery: "refresh",
		exposure: "public_message",
	},
) {}

/** The request is wrong before anything reached the source; `field` names the input. */
export class DataSourceInvalidError extends HttpTaggedError<DataSourceInvalidError>()(
	"@maple/http/data-sources/DataSourceInvalidError",
	{ message: Schema.String, field: Schema.optionalKey(Schema.String) },
	{
		status: 400,
		code: "data_source_invalid",
		title: "Invalid data source",
		param: (error) => error.field,
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

/** Maple reached for the source and it refused, timed out, or rejected what Maple sent. */
export class DataSourceUnreachableError extends HttpTaggedError<DataSourceUnreachableError>()(
	"@maple/http/data-sources/DataSourceUnreachableError",
	{
		message: Schema.String,
		reason: Schema.Literals(["network", "tls", "auth", "refused", "config", "timeout", "query", "limit"]),
	},
	{
		status: 422,
		code: "data_source_unreachable",
		title: "The data source did not answer",
		publicDetails: { reason: "reason" },
		retry: "never",
		recovery: "reconnect",
		exposure: "public_message",
	},
) {}

/** Maple's share of the source's rate limit is used up, or the source answered 429. */
export class DataSourceRateLimitedHttpError extends HttpTaggedError<DataSourceRateLimitedHttpError>()(
	"@maple/http/data-sources/DataSourceRateLimitedError",
	{ message: Schema.String, retryAfterSeconds: Schema.optionalKey(Schema.Number) },
	{
		status: 429,
		code: "data_source_rate_limited",
		title: "The data source is rate limited",
		retryAfterSeconds: (error) => error.retryAfterSeconds,
		retry: "after",
		recovery: "retry",
		exposure: "public_message",
	},
) {}

/** Maple could not load or save the organization's data sources. */
export class DataSourceStorageUnavailableError extends HttpTaggedError<DataSourceStorageUnavailableError>()(
	"@maple/http/data-sources/DataSourceStorageUnavailableError",
	{ message: Schema.String },
	{
		status: 503,
		code: "data_sources_unavailable",
		title: "Data sources temporarily unavailable",
		message: "Maple couldn't load or save this organization's data sources. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}
