import { Option } from "effect"
import { describe, expect, it } from "vitest"
import { MAPLE_DB_BINDING, readMapleDbBinding } from "./maple-db.ts"

const hyperdrive = {
	connectionString: "postgres://user:pw@ad4c487838594b89810b23e5fb14e129.hyperdrive.local:5432/postgres",
	host: "ad4c487838594b89810b23e5fb14e129.hyperdrive.local",
	port: 5432,
	database: "ad4c487838594b89810b23e5fb14e129",
}

describe("readMapleDbBinding", () => {
	it("reads the binding's connection facts", () => {
		expect(readMapleDbBinding({ [MAPLE_DB_BINDING]: hyperdrive })).toStrictEqual(Option.some(hyperdrive))
	})

	it("reports an absent database for an empty env", () => {
		expect(readMapleDbBinding({})).toStrictEqual(Option.none())
	})

	it.each([
		["a string", "postgres://somewhere/maple"],
		["null", null],
		["undefined", undefined],
		["an object missing connectionString", { host: "h", port: 5432, database: "d" }],
		[
			"an object with a blank connectionString",
			{ connectionString: "", host: "h", port: 5432, database: "d" },
		],
		[
			"an object with a non-numeric port",
			{ connectionString: "postgres://x", host: "h", port: "5432", database: "d" },
		],
	])("reads absent when MAPLE_DB is %s, rather than throwing", (_label, binding) => {
		expect(readMapleDbBinding({ [MAPLE_DB_BINDING]: binding })).toStrictEqual(Option.none())
	})
})
