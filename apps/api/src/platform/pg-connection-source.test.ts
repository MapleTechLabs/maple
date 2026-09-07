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
})
