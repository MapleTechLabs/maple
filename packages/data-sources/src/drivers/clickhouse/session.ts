import { Array as Arr, Effect, Option, Record as Rec, Redacted, Stream } from "effect"
import type { HttpClient } from "effect/http"
import { type ClickHouseError, type Row, make } from "@maple-dev/effect-clickhouse-http"
import { type ClickHouseDataSourceConfig, DataSourceValidationError } from "@maple/domain/data-sources"
import type { DriverConnection, QueryLimits } from "../../port"
import { parseClickHouseUrl } from "./connection"

/** Generous for analytics on a customer's cluster, low enough that one query cannot take a node. */
export const MAX_MEMORY_BYTES = 2_000_000_000

/**
 * What every query sends. Verified on ClickHouse 26.2: `readonly=1` in the URL still lets the
 * other URL settings apply, and then refuses writes and any `SETTINGS` override in the query.
 */
export const readOnlySettings = (limits: QueryLimits): Readonly<Record<string, string | number>> => ({
	readonly: 1,
	max_execution_time: Math.max(1, Math.ceil(limits.timeoutMs / 1000)),
	max_result_rows: limits.maxRows + 1,
	max_result_bytes: limits.maxBytes,
	result_overflow_mode: "break",
	max_memory_usage: MAX_MEMORY_BYTES,
	// 26.2 defaults both to 0, and JSON.parse rounds a bare 64-bit integer before Maple sees it.
	output_format_json_quote_64bit_integers: 1,
	output_format_json_quote_decimals: 1,
})

/** What a read-only profile answers to any setting; a query's own `SETTINGS readonly = 0` answers the same. */
const isCannotModify = (error: ClickHouseError): boolean =>
	error._tag === "@effect-clickhouse-http/ServerError" &&
	error.code === "164" &&
	/Cannot modify '/.test(error.message)

/** Maple's settings minus `readonly`, for a profile that is already read-only with readonly=2. */
export const settingsWithoutReadonly = (
	settings: Readonly<Record<string, string | number>> | undefined,
): Readonly<Record<string, string | number>> =>
	Rec.filter(settings ?? {}, (_value, key) => key !== "readonly")

export interface Session {
	readonly host: string
	/**
	 * Up to `take` rows with `settings`. A user whose profile is read-only refuses every setting;
	 * only after the server confirms that profile does the query run again without them.
	 */
	readonly rows: (
		sql: string,
		options: {
			readonly take: number
			readonly maxBytes: number
			readonly settings?: Readonly<Record<string, string | number>>
		},
	) => Effect.Effect<ReadonlyArray<Row>, ClickHouseError>
}

export const openSession = (
	connection: DriverConnection<ClickHouseDataSourceConfig>,
): Effect.Effect<Session, DataSourceValidationError, HttpClient.HttpClient> =>
	Effect.gen(function* () {
		// Checked again on every use: the stored URL may predate a tightened rule.
		const url = yield* Effect.fromResult(parseClickHouseUrl(connection.config.url))
		const client = yield* make({
			url: url.toString(),
			database: connection.config.database,
			username: connection.config.user,
			password: connection.secret ?? Redacted.make(""),
		}).pipe(
			Effect.mapError(
				() =>
					new DataSourceValidationError({
						field: "url",
						message: "The ClickHouse URL or user is invalid.",
					}),
			),
		)
		const collect = (
			sql: string,
			take: number,
			maxBytes: number,
			settings?: Readonly<Record<string, string | number>>,
		) =>
			Stream.runCollect(
				Stream.take(
					client.stream(
						// Without settings the 64-bit quoting cannot be asked for, so every value comes as a string.
						settings === undefined
							? { sql, limits: { maxBytes }, format: "JSONStringsEachRow" }
							: { sql, settings, limits: { maxBytes } },
					),
					take,
				),
			)
		// Asked without settings, so the answer is the profile's own `readonly` ("0", "1" or "2").
		const profileReadOnly = Effect.map(
			collect("SELECT toString(getSetting('readonly')) AS readonly", 1, 65_536),
			(rows) =>
				Arr.findFirst(rows, (row) => typeof row["readonly"] === "string").pipe(
					Option.map((row) => String(row["readonly"])),
					Option.getOrElse(() => "0"),
				),
		)
		return {
			host: url.host,
			rows: (sql, options) =>
				collect(sql, options.take, options.maxBytes, options.settings).pipe(
					Effect.catchIf(
						(error) => options.settings !== undefined && isCannotModify(error),
						(error) =>
							Effect.flatMap(profileReadOnly, (readOnly) =>
								// readonly=2 refuses only a change to `readonly` itself: keep every limit.
								// readonly=1 refuses any setting, so the query runs under the profile's own.
								readOnly === "2"
									? collect(
											sql,
											options.take,
											options.maxBytes,
											settingsWithoutReadonly(options.settings),
										)
									: readOnly === "1"
										? collect(sql, options.take, options.maxBytes)
										: Effect.fail(error),
							),
					),
				),
		}
	})
