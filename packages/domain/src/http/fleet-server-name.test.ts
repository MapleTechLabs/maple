import { assert, describe, it } from "@effect/vitest"
import { Array as Arr } from "effect"
import { fleetServerName } from "./integrations"

describe("fleetServerName", () => {
	it("uses the organization Fleet reports, trimmed, else the server's host", () => {
		assert.deepStrictEqual(
			Arr.map(
				[
					{ organizationName: "Acme", baseUrl: "https://fleet.acme.dev" },
					{ organizationName: null, baseUrl: "https://fleet.acme.dev/fleet" },
					{ organizationName: " ", baseUrl: "https://devices.acme.dev" },
					{ organizationName: " Acme EU ", baseUrl: "https://eu.acme.dev" },
				],
				fleetServerName,
			),
			["Acme", "fleet.acme.dev", "devices.acme.dev", "Acme EU"],
		)
	})
})
