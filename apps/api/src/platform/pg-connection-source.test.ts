import { MAPLE_DB_BINDING } from "@maple/infra/cloudflare"
import { Option } from "effect"
import { describe, expect, it } from "vitest"
import { mapleDbConnectionFromEnv } from "./pg-connection-source"

const hyperdriveBinding = {
	connectionString: "postgres://user:pw@ad4c487838594b89810b23e5fb14e129.hyperdrive.local:5432/postgres",
	host: "ad4c487838594b89810b23e5fb14e129.hyperdrive.local",
	port: 5432,
	database: "ad4c487838594b89810b23e5fb14e129",
}

describe("mapleDbConnectionFromEnv", () => {
	it("emits the binding's identity attributes, never its credentials", () => {
		const connection = mapleDbConnectionFromEnv({ [MAPLE_DB_BINDING]: hyperdriveBinding })
		expect(connection).toStrictEqual(
			Option.some({
				connectionString: hyperdriveBinding.connectionString,
				attributes: {
					"db.namespace": hyperdriveBinding.database,
					"server.address": hyperdriveBinding.host,
					"server.port": hyperdriveBinding.port,
				},
			}),
		)
		expect(JSON.stringify(Option.getOrThrow(connection).attributes)).not.toContain("pw")
	})

	it("reports an absent database for an empty env", () => {
		expect(mapleDbConnectionFromEnv({})).toStrictEqual(Option.none())
	})

	it("synthesizes a connection from MAPLE_PG_URL without leaking credentials", () => {
		const connection = mapleDbConnectionFromEnv({
			MAPLE_PG_URL: "postgres://maple:s3cret@127.0.0.1:5499/maple",
		})

		expect(connection).toStrictEqual(
			Option.some({
				connectionString: "postgres://maple:s3cret@127.0.0.1:5499/maple",
				attributes: {
					"db.namespace": "maple",
					"server.address": "127.0.0.1",
					"server.port": 5499,
				},
			}),
		)
		expect(JSON.stringify(Option.getOrThrow(connection).attributes)).not.toContain("s3cret")
	})

	it("ignores MAPLE_PG_URL when a Hyperdrive binding is present", () => {
		const connection = mapleDbConnectionFromEnv({
			[MAPLE_DB_BINDING]: hyperdriveBinding,
			MAPLE_PG_URL: "postgres://maple:maple@127.0.0.1:5499/maple",
		})

		expect(connection).toStrictEqual(
			Option.some({
				connectionString: hyperdriveBinding.connectionString,
				attributes: {
					"db.namespace": hyperdriveBinding.database,
					"server.address": hyperdriveBinding.host,
					"server.port": hyperdriveBinding.port,
				},
			}),
		)
	})

	it("falls through to MAPLE_PG_URL when MAPLE_DB is a string rather than a Hyperdrive object", () => {
		const connection = mapleDbConnectionFromEnv({
			[MAPLE_DB_BINDING]: "postgres://maple:maple@127.0.0.1:5499/maple",
			MAPLE_PG_URL: "postgres://maple:maple@127.0.0.1:5499/maple",
		})

		expect(Option.getOrThrow(connection).connectionString).toBe(
			"postgres://maple:maple@127.0.0.1:5499/maple",
		)
	})

	it.each(["not-a-url", "http://127.0.0.1:5499/maple", "postgres://"])(
		"reports absent when MAPLE_PG_URL is %s",
		(pgUrl) => {
			expect(mapleDbConnectionFromEnv({ MAPLE_PG_URL: pgUrl })).toStrictEqual(Option.none())
		},
	)
})
