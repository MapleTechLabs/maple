import type * as Option from "effect/Option"
import * as Schema from "effect/Schema"

/** The app database's Hyperdrive binding name, on every Worker that binds it. */
export const MAPLE_DB_BINDING = "MAPLE_DB"

/** What a Worker reads off the `MAPLE_DB` binding: the runtime `Hyperdrive` object's connection facts. */
const MapleDbBinding = Schema.Struct({
	connectionString: Schema.String.check(Schema.isNonEmpty()),
	host: Schema.String,
	port: Schema.Number,
	database: Schema.String,
})
export type MapleDbBinding = typeof MapleDbBinding.Type

/** The `MAPLE_DB` binding off a Worker env, or `None` when absent or not a Hyperdrive object. */
export const readMapleDbBinding = (env: Record<string, unknown>): Option.Option<MapleDbBinding> =>
	Schema.decodeUnknownOption(MapleDbBinding)(env[MAPLE_DB_BINDING])
