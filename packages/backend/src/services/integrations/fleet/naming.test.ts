import { assert, describe, it } from "@effect/vitest"
import { Array as Arr } from "effect"
import { fleetServerName } from "./naming"

describe("fleetServerName", () => {
	it("uses the organization Fleet reports, else the server's host", () => {
		assert.deepStrictEqual(
			Arr.map(
				[
					{ organizationName: "Acme", baseUrl: "https://fleet.acme.dev" },
					{ organizationName: null, baseUrl: "https://fleet.acme.dev/fleet" },
					{ organizationName: " ", baseUrl: "https://devices.acme.dev" },
				],
				fleetServerName,
			),
			["Acme", "fleet.acme.dev", "devices.acme.dev"],
		)
	})
})
