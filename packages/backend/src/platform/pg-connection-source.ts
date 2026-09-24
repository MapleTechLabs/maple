/**
 * The application database as the `MapleDbConnection` port: the `MAPLE_DB`
 * binding read off a Worker env (`readMapleDbBinding`, the one place its shape
 * is checked) and turned into what the Postgres layers need. Keep Workers on
 * Hyperdrive: request-scoped sockets make direct PSBouncer connections pay a
 * handshake per execute (measured 679ms + 158ms versus Hyperdrive's 11ms + 14ms).
 */
import { readMapleDbBinding } from "@maple/infra/cloudflare"
import { Layer, Option } from "effect"
import { type DatabaseConnection, MapleDbConnection } from "./bindings"

/** The port's value for one Worker env record: `None` on a stage without a database. */
export const mapleDbConnectionFromEnv = (env: Record<string, unknown>): Option.Option<DatabaseConnection> =>
	Option.map(readMapleDbBinding(env), (binding) => ({
		connectionString: binding.connectionString,
		attributes: {
			// The read path normalizes Hyperdrive's opaque host/database to its sentinel node.
			"db.namespace": binding.database,
			"server.address": binding.host,
			"server.port": binding.port,
		},
	}))

/** The port over an env record in hand — a Worker's, a Durable Object's, a Workflow run's, a cron fire's. */
export const mapleDbConnectionLayer = (env: Record<string, unknown>): Layer.Layer<MapleDbConnection> =>
	Layer.succeed(MapleDbConnection, mapleDbConnectionFromEnv(env))
