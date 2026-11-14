import { V2ApiKey } from "@maple/domain/http/v2"
import { Array as Arr, type Option, Schema } from "effect"
import { liveRowDecoder } from "./live-row"

/**
 * Safe browser projection of `api_keys`. This mirrors the pinned column list in
 * the Electric shape proxy; authentication material (`key_hash`) and internal
 * agent metadata (`metadata_json`) are intentionally absent.
 */
export const ApiKeyRowSchema = Schema.Struct({
	id: Schema.String,
	org_id: Schema.String,
	name: Schema.String,
	description: Schema.NullOr(Schema.String),
	key_prefix: Schema.String,
	revoked: Schema.Boolean,
	revoked_at: Schema.NullOr(Schema.String),
	last_used_at: Schema.NullOr(Schema.String),
	expires_at: Schema.NullOr(Schema.String),
	scopes: Schema.NullOr(Schema.Array(Schema.String)),
	kind: Schema.String,
	created_at: Schema.String,
	created_by: Schema.String,
	created_by_email: Schema.NullOr(Schema.String),
})

export type ApiKeyRow = typeof ApiKeyRowSchema.Type

// The type side: ids arrive raw, the `key_…` public id is the wire's encoding.
const decodeApiKey = liveRowDecoder("api_keys", Schema.toType(V2ApiKey))

/**
 * Maps the Electric row into the same decoded model returned by the v2 client; `None` for a
 * row this build cannot read (e.g. a key kind added after it was built).
 */
export const rowToV2ApiKey = (row: ApiKeyRow): Option.Option<V2ApiKey> =>
	decodeApiKey(row.id, {
		id: row.id,
		object: "api_key",
		name: row.name,
		description: row.description,
		key_prefix: row.key_prefix,
		kind: row.kind,
		scopes: row.scopes,
		revoked: row.revoked,
		revoked_at: row.revoked_at,
		last_used_at: row.last_used_at,
		expires_at: row.expires_at,
		created_at: row.created_at,
		created_by: row.created_by,
		created_by_email: row.created_by_email,
	})

/** The live keys, without rows this build cannot read. */
export const rowsToV2ApiKeys = (rows: ReadonlyArray<ApiKeyRow>): ReadonlyArray<V2ApiKey> =>
	Arr.getSomes(Arr.map(rows, rowToV2ApiKey))
