import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import type { ClickHouseDataSourceConfig } from "@maple/domain/data-sources"
import { validateClickHouseConnection } from "./connection"

const input = (url: string, extra: { user?: string; database?: string } = {}) => ({
	_tag: "clickhouse" as const,
	url,
	user: extra.user ?? "",
	database: extra.database ?? "",
})
const stored: ClickHouseDataSourceConfig = {
	_tag: "clickhouse",
	url: "https://ch.example.com:8443/",
	user: "maple",
	database: "shop",
}

const failure = (effect: ReturnType<typeof validateClickHouseConnection>) =>
	Effect.runSync(Effect.exit(effect)).pipe((exit) =>
		Exit.isFailure(exit) ? JSON.stringify(exit.cause) : "succeeded",
	)

describe("validateClickHouseConnection", () => {
	it("trims, defaults user and database, and stores an empty password on create", () => {
		const result = Effect.runSync(
			validateClickHouseConnection(input("  https://ch.example.com:8443  "), null),
		)
		expect(result).toEqual({
			config: {
				_tag: "clickhouse",
				url: "https://ch.example.com:8443/",
				user: "default",
				database: "default",
			},
			secret: "",
		})
	})

	it.each([
		"http://localhost:8123",
		"http://127.0.0.1:8123",
		"http://10.0.0.5:8123",
		"http://169.254.169.254/",
		"http://[::1]:8123",
		"ftp://ch.example.com",
		"ch.example.com:8123",
		"https://user:pw@ch.example.com",
		"https://ch.example.com/?user=x",
	])("refuses %s on the url field", (url) => {
		const message = failure(validateClickHouseConnection(input(url), null))
		expect(message).toContain('"field":"url"')
	})

	it("refuses a user name with ':' since it would split Basic auth", () => {
		expect(
			failure(validateClickHouseConnection(input("https://ch.example.com", { user: "a:b" }), null)),
		).toContain('"field":"user"')
	})

	it("keeps the stored password on update within the same origin", () => {
		const result = Effect.runSync(
			validateClickHouseConnection(
				input("https://ch.example.com:8443/proxy", { user: "other", database: "x" }),
				stored,
			),
		)
		expect(result.secret).toBeNull()
		expect(result.config.user).toBe("other")
	})

	it("asks for the password again when the host changes, and takes a new one when sent", () => {
		expect(failure(validateClickHouseConnection(input("https://evil.example.com"), stored))).toContain(
			'"field":"password"',
		)
		const result = Effect.runSync(
			validateClickHouseConnection({ ...input("https://evil.example.com"), password: "pw" }, stored),
		)
		expect(result.secret).toBe("pw")
	})
})
