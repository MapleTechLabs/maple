import { Array as Arr, Effect, Option, Record as Rec, String as Str } from "effect"
import type { HttpClient } from "effect/http"
import type { ClickHouseDataSourceConfig, DataSourceDriverError } from "@maple/domain/data-sources"
import { DEFAULT_LIMITS } from "../../limits"
import type { ConnectionTest, DriverConnection } from "../../port"
import { mapClickHouseError } from "./errors"
import { openSession, readOnlySettings } from "./session"

const WRITE_PRIVILEGES = [
	"ALL",
	"INSERT",
	"ALTER",
	"CREATE",
	"DROP",
	"TRUNCATE",
	"OPTIMIZE",
	"DELETE",
	"UPDATE",
	"KILL",
	"SYSTEM",
	"BACKUP",
	"UNDROP",
]
const GRANT_RE = /^GRANT\s+(.+?)\s+ON\s+(\S+)\s+TO\b/i
const ROLE_GRANT_RE = /^GRANT\s+(?!.*\sON\s)(.+?)\s+TO\b/i

export interface GrantFindings {
	/** `INSERT on shop.*`, one per write privilege found. */
	readonly writes: ReadonlyArray<string>
	readonly roles: ReadonlyArray<string>
}

/** Reads `SHOW GRANTS` lines. Column lists (`SELECT(a, b)`) are dropped before splitting. */
export const parseGrants = (lines: ReadonlyArray<string>): GrantFindings => {
	const grants = Arr.flatMap(lines, (line) => {
		const match = GRANT_RE.exec(Str.trim(line))
		if (match === null) return []
		const privileges = Arr.map(Str.split(",")(Str.replace(/\([^)]*\)/g, "")(match[1] ?? "")), Str.trim)
		return Arr.map(privileges, (privilege) => ({
			privilege: Str.toUpperCase(privilege),
			target: match[2] ?? "",
		}))
	})
	const writes = Arr.filter(grants, ({ privilege }) =>
		Arr.some(WRITE_PRIVILEGES, (write) => privilege === write || Str.startsWith(`${write} `)(privilege)),
	)
	const roles = Arr.flatMap(lines, (line) => {
		const match = ROLE_GRANT_RE.exec(Str.trim(line))
		return match === null ? [] : Arr.map(Str.split(",")(match[1] ?? ""), Str.trim)
	})
	return { writes: Arr.map(writes, ({ privilege, target }) => `${privilege} on ${target}`), roles }
}

export const grantWarnings = (findings: GrantFindings): ReadonlyArray<string> => {
	if (findings.writes.length > 0) {
		const shown = Arr.join(Arr.take(findings.writes, 3), ", ")
		const more = findings.writes.length > 3 ? ` and ${findings.writes.length - 3} more` : ""
		return [`This user can write (${shown}${more}). Maple only reads, but a read-only user is safer.`]
	}
	if (findings.roles.length > 0) {
		return [
			`This user has roles (${Arr.join(findings.roles, ", ")}) whose grants Maple cannot see. If any can write, a read-only user is safer.`,
		]
	}
	return []
}

export const READ_ONLY_PROFILE =
	"This user's profile is read-only, so ClickHouse refuses Maple's per-query time and memory limits. Maple still caps rows, bytes and time on its side; set max_execution_time and max_memory_usage on the profile so long queries also stop on the server."

export const PLAIN_HTTP =
	"This URL uses http, so the password travels unencrypted. Use https (usually port 8443)."

const UNKNOWN_GRANTS =
	"Maple could not read this user's grants to check whether it can write. Maple only reads, but a read-only user is safer."

const firstString = (row: Readonly<Record<string, unknown>>): string =>
	Option.getOrElse(
		Arr.findFirst(Rec.values(row), (value): value is string => typeof value === "string"),
		() => "",
	)

/** `SELECT 1`, then whether the user could write: by its `readonly` setting, then its grants. */
export const testClickHouse = (
	connection: DriverConnection<ClickHouseDataSourceConfig>,
): Effect.Effect<ConnectionTest, DataSourceDriverError, HttpClient.HttpClient> =>
	Effect.gen(function* () {
		const limits = DEFAULT_LIMITS.interactive
		const session = yield* openSession(connection)
		const mapError = Effect.mapError((error: Parameters<typeof mapClickHouseError>[0]) =>
			mapClickHouseError(error, { host: session.host, timeoutMs: limits.timeoutMs }),
		)
		yield* mapError(
			session.rows("SELECT 1", { take: 1, maxBytes: 65_536, settings: readOnlySettings(limits) }),
		)
		// Read without our own settings, which would always report readonly=1.
		const readonly = yield* mapError(
			session.rows("SELECT toString(getSetting('readonly')) AS readonly", {
				take: 1,
				maxBytes: 65_536,
			}),
		)
		const transport = Str.startsWith("http:")(Str.toLowerCase(connection.config.url)) ? [PLAIN_HTTP] : []
		if (Arr.some(readonly, (row) => firstString(row) !== "0")) {
			return { warnings: [...transport, READ_ONLY_PROFILE] }
		}
		const grants = yield* Effect.option(session.rows("SHOW GRANTS", { take: 1_000, maxBytes: 1_000_000 }))
		return {
			warnings: [
				...transport,
				...Option.match(grants, {
					onNone: () => [UNKNOWN_GRANTS],
					onSome: (rows) => grantWarnings(parseGrants(Arr.map(rows, firstString))),
				}),
			],
		}
	}).pipe(
		Effect.withSpan("ClickHouseDriver.test", {
			kind: "client",
			attributes: { "maple.data_source.kind": "clickhouse", "db.system.name": "clickhouse" },
		}),
	)
