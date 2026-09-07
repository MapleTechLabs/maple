import { MAPLE_DB_BINDING } from "@maple/infra/cloudflare"
import { Option } from "effect"
import { describe, expect, it } from "vitest"
import { databaseConnection, mapleDbConnectionFromEnv } from "./pg-connection-source"

const hyperdriveBinding = {
	connectionString: "postgres://user:pw@ad4c487838594b89810b23e5fb14e129.hyperdrive.local:5432/postgres",
	host: "ad4c487838594b89810b23e5fb14e129.hyperdrive.local",
	port: 5432,
	database: "ad4c487838594b89810b23e5fb14e129",
}

describe("databaseConnection", () => {
	it("emits the binding's identity attributes", () => {
		expect(databaseConnection(hyperdriveBinding)).toStrictEqual({
			connectionString: hyperdriveBinding.connectionString,
			attributes: {
				"db.namespace": hyperdriveBinding.database,
				"server.address": hyperdriveBinding.host,
				"server.port": hyperdriveBinding.port,
			},
		})
	})

	it("never leaks credentials into span attributes", () => {
		expect(JSON.stringify(databaseConnection(hyperdriveBinding).attributes)).not.toContain("pw")
	})
})

describe("mapleDbConnectionFromEnv", () => {
	it("reads the binding off the env", () => {
		expect(Option.isSome(mapleDbConnectionFromEnv({ [MAPLE_DB_BINDING]: hyperdriveBinding }))).toBe(true)
	})

	it("reports an absent database for an empty env", () => {
		expect(mapleDbConnectionFromEnv({})).toStrictEqual(Option.none())
	})
})
