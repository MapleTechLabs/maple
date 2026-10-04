import { describe, expect, it } from "vitest"
import { parseMapleDeployment } from "./cloudflare/stage.ts"
import { resolveMapleProfile } from "./profile.ts"

const profile = (raw: string) => resolveMapleProfile(parseMapleDeployment(raw))
const DEPLOYMENTS = ["prd", "prd-eu", "pr-12", "dev-alice", "dev-alice-eu"]

describe("resolveMapleProfile", () => {
	// The whole table, pinned. A change here changes what a live stage deploys or how big it is.
	it("pins every deployment's profile", () => {
		expect(Object.fromEntries(DEPLOYMENTS.map((raw) => [raw, profile(raw)]))).toMatchSnapshot()
	})

	it("only runs what the deployment can support", () => {
		for (const raw of DEPLOYMENTS) {
			const { deploys, database, migratesDatabase } = profile(raw)
			// The collector and the replay writer live beside the gateway.
			if (deploys.collector || deploys.replayBlobs) expect(deploys.ingest).toBe(true)
			// Electric and the sandbox need a database; previews have none.
			if (deploys.electric || deploys.sandbox) expect(migratesDatabase).toBe(true)
			expect(migratesDatabase).toBe(database === "ref" || database === "declared")
		}
	})

	it("keeps the shared apps and dev stages' gateway off where they do not belong", () => {
		expect(profile("prd").deploys.sharedApps).toBe(true)
		expect(profile("prd-eu").deploys.sharedApps).toBe(false)
		expect(profile("dev-alice").deploys.ingest).toBe(false)
	})
})
