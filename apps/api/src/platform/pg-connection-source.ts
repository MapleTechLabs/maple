/**
 * The application database as the `MapleDbConnection` port: the `MAPLE_DB`
 * binding read off a Worker env (`readMapleDbBinding`, the one place its shape
 * is checked) and turned into what the Postgres layers need. Keep Workers on
 * Hyperdrive: request-scoped sockets make direct PSBouncer connections pay a
 * handshake per execute (measured 679ms + 158ms versus Hyperdrive's 11ms + 14ms).
 *
 * celld has no Hyperdrive binding. `MAPLE_PG_URL` synthesizes the same
 * `{ connectionString, host, port, database }` shape and postgres.js dials it
 * over TCP (`cloudflare:sockets` on celld). A string `MAPLE_DB` is still
 * absent on purpose — that binding is an object or it is absent.
 */
import { readMapleDbBinding } from "@maple/infra/cloudflare"
import { Layer, Option } from "effect"
import { type DatabaseConnection, MapleDbConnection } from "./bindings"

export const MAPLE_PG_URL_VAR = "MAPLE_PG_URL"

const readNonEmptyString = (value: unknown): string | undefined => {
	if (typeof value !== "string") return undefined
	const trimmed = value.trim()
	return trimmed.length > 0 ? trimmed : undefined
}

const parsePostgresUrl = (
	raw: string,
):
	| {
			readonly connectionString: string
			readonly host: string
			readonly port: number
			readonly database: string
	  }
	| undefined => {
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		return undefined
	}
	if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return undefined
	const host = url.hostname
	if (host.length === 0) return undefined
	const port = url.port.length === 0 ? 5432 : Number(url.port)
	if (!Number.isFinite(port) || port <= 0) return undefined
	const path = decodeURIComponent(url.pathname.replace(/^\/+/, ""))
	const database = path.split("/")[0] ?? ""
	return {
		connectionString: raw,
		host,
		port,
		database: database.length > 0 ? database : "postgres",
	}
}

const connectionFromPostgresUrl = (raw: string): Option.Option<DatabaseConnection> => {
	const parsed = parsePostgresUrl(raw)
	if (parsed === undefined) return Option.none()
	return Option.some({
		connectionString: parsed.connectionString,
		attributes: {
			"db.namespace": parsed.database,
			"server.address": parsed.host,
			"server.port": parsed.port,
		},
	})
}

/** The port's value for one Worker env record: `None` on a stage without a database. */
export const mapleDbConnectionFromEnv = (env: Record<string, unknown>): Option.Option<DatabaseConnection> => {
	const binding = readMapleDbBinding(env)
	if (Option.isSome(binding)) {
		return Option.some({
			connectionString: binding.value.connectionString,
			attributes: {
				// The read path normalizes Hyperdrive's opaque host/database to its sentinel node.
				"db.namespace": binding.value.database,
				"server.address": binding.value.host,
				"server.port": binding.value.port,
			},
		})
	}

	const pgUrl = readNonEmptyString(env[MAPLE_PG_URL_VAR])
	if (pgUrl !== undefined) return connectionFromPostgresUrl(pgUrl)
	return Option.none()
}

/** The port over an env record in hand — a Worker's, a Durable Object's, a Workflow run's, a cron fire's. */
export const mapleDbConnectionLayer = (env: Record<string, unknown>): Layer.Layer<MapleDbConnection> =>
	Layer.succeed(MapleDbConnection, mapleDbConnectionFromEnv(env))
