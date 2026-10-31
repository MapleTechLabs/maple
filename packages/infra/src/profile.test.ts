import { describe, expect, it } from "vitest"
import { parseMapleDeployment } from "./cloudflare/stage.ts"
import { resolveMapleProfile } from "./profile.ts"

const profile = (raw: string) => resolveMapleProfile(parseMapleDeployment(raw))
const DEPLOYMENTS = ["prd", "prd-eu", "pr-12", "dev-alice", "dev-alice-eu"]

describe("resolveMapleProfile", () => {
	it("only runs what the deployment can support", () => {
		for (const raw of DEPLOYMENTS) {
			const { deploys, database, migratesDatabase } = profile(raw)
			// The collector and the replay writer live beside the gateway.
			if (deploys.collector || deploys.replayBlobs) expect(deploys.ingest).toBe(true)
			// Electric and the sandbox need a declared database; dev's is docker-compose.
			if (deploys.electric || deploys.sandbox) expect(migratesDatabase).toBe(true)
			expect(migratesDatabase).toBe(database !== "managed")
		}
	})

	it("keeps the shared apps and dev stages' gateway off where they do not belong", () => {
		expect(profile("prd").deploys.sharedApps).toBe(true)
		expect(profile("prd-eu").deploys.sharedApps).toBe(false)
		expect(profile("dev-alice").deploys.ingest).toBe(false)
	})

	it("runs a `preview:web` PR on its own database without the AWS services", () => {
		const full = profile("pr-12")
		const web = resolveMapleProfile(parseMapleDeployment("pr-12"), { webOnlyPreview: true })
		expect(web.deploys).toEqual({ ...full.deploys, sharedApps: false, ingest: false, electric: false })
		expect(web.database).toBe("preview")
		expect(web.migratesDatabase).toBe(true)
	})

	it("ignores the web-only flag outside PR stages", () => {
		const prd = parseMapleDeployment("prd")
		expect(resolveMapleProfile(prd, { webOnlyPreview: true })).toEqual(resolveMapleProfile(prd))
	})

	// Every stage deploys into the same AWS account: one owner per account-region control.
	it("puts the AWS security baseline on the prd instances alone, with one account trail", () => {
		expect(
			Object.fromEntries(DEPLOYMENTS.map((raw) => [raw, profile(raw).deploys.awsSecurityBaseline])),
		).toEqual({
			prd: "account",
			"prd-eu": "regional",
			"pr-12": "none",
			"dev-alice": "none",
			"dev-alice-eu": "none",
		})
	})
})
