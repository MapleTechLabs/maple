import { describe, expect, it } from "vitest"
import { parseMapleDeployment, resolveMapleDomains } from "./cloudflare/stage.ts"
import { deployedDomains, resolveMapleProfile } from "./profile.ts"
import { Array as Arr, Record as Rec } from "effect"

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
			Rec.fromEntries(Arr.map(DEPLOYMENTS, (raw) => [raw, profile(raw).deploys.awsSecurityBaseline])),
		).toEqual({
			prd: "account",
			"prd-eu": "regional",
			"pr-12": "none",
			"dev-alice": "none",
			"dev-alice-eu": "none",
		})
	})

	it("forces the collector for one deploy only where the gateway runs", () => {
		const pr = parseMapleDeployment("pr-12")
		expect(resolveMapleProfile(pr, { forceCollector: true }).deploys.collector).toBe(true)
		const web = resolveMapleProfile(pr, { webOnlyPreview: true, forceCollector: true })
		expect(web.deploys.collector).toBe(false)
	})
})

describe("deployedDomains", () => {
	it("hands a `preview:web` PR no hostname for the services it skips", () => {
		const pr = parseMapleDeployment("pr-12")
		const web = resolveMapleProfile(pr, { webOnlyPreview: true })
		const all = resolveMapleDomains(pr)
		expect(deployedDomains(all, web)).toEqual({
			web: all.web,
			api: all.api,
			sync: all.sync,
			status: all.status,
		})
	})

	it("keeps every hostname of a deployment that runs everything", () => {
		for (const raw of ["prd", "prd-eu", "pr-12"]) {
			const deployment = parseMapleDeployment(raw)
			const domains = resolveMapleDomains(deployment)
			expect(deployedDomains(domains, resolveMapleProfile(deployment))).toEqual(domains)
		}
	})
})
