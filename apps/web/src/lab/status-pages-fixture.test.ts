import { statusPageOrgKey } from "@maple/domain/status-page"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { LAB_ORG, LAB_ORG_KEY } from "./status-pages-fixture"

describe("status pages lab fixture", () => {
	it("seeds the org key the app derives for the lab org, so lab addresses match real ones", async () => {
		expect(await Effect.runPromise(statusPageOrgKey(LAB_ORG))).toBe(LAB_ORG_KEY)
	})
})
