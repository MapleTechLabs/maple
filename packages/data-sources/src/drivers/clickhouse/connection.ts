import { Effect, Option, Result, String as Str } from "effect"
import { parseExternalUrl } from "@maple/safe-fetch"
import {
	type ClickHouseDataSourceConfig,
	type DataSourceConnectionInput,
	DataSourceValidationError,
} from "@maple/domain/data-sources"
import type { ValidatedConnection } from "../../port"

const invalid = (field: string, message: string) => new DataSourceValidationError({ field, message })

/** An absolute http(s) URL to a public host, with no credentials, query or fragment. */
export const parseClickHouseUrl = (raw: string): Result.Result<URL, DataSourceValidationError> =>
	Result.flatMap(
		Result.mapError(parseExternalUrl(raw), (error) => invalid("url", error.message)),
		(url) =>
			url.search !== "" || url.hash !== ""
				? Result.fail(
						invalid(
							"url",
							"Use the bare HTTP interface URL, without query parameters or a fragment.",
						),
					)
				: Result.succeed(url),
	)

const field = (raw: string, fallback: string) => {
	const value = Str.trim(raw)
	return value.length === 0 ? fallback : value
}

/**
 * Form input -> stored config + secret. On create an omitted password stores "" (ClickHouse users
 * may have none). On update an omitted password keeps the stored one when only the user, database
 * or path changes; moving to another origin needs it again, so an admin who cannot read the
 * password cannot send it to a host of their choosing.
 */
export const validateClickHouseConnection = (
	input: DataSourceConnectionInput,
	previous: ClickHouseDataSourceConfig | null,
): Effect.Effect<ValidatedConnection<ClickHouseDataSourceConfig>, DataSourceValidationError> =>
	Effect.gen(function* () {
		if (input._tag !== "clickhouse") {
			return yield* invalid(
				"connection",
				`A ${input._tag} connection cannot configure a ClickHouse source`,
			)
		}
		const url = yield* Effect.fromResult(parseClickHouseUrl(input.url))
		const user = field(input.user, "default")
		if (Str.includes(":")(user)) return yield* invalid("user", "The user name cannot contain ':'.")
		const database = field(input.database, "default")
		const config: ClickHouseDataSourceConfig = { _tag: "clickhouse", url: url.toString(), user, database }
		if (input.password !== undefined) return { config, secret: input.password }
		if (previous === null) return { config, secret: "" }
		const previousOrigin = Option.getOrNull(Result.getSuccess(parseClickHouseUrl(previous.url)))?.origin
		if (previousOrigin !== url.origin) {
			return yield* invalid(
				"password",
				"Enter the password again when moving the source to another host.",
			)
		}
		return { config, secret: null }
	})
