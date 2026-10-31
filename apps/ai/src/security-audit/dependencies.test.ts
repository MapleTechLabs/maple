import type { RepoSandboxServiceApi } from "@maple/backend/services/sandbox/RepoSandboxService"
import { OrgId } from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { inspectDependencies } from "./dependencies"

const ORG = Schema.decodeUnknownSync(OrgId)("org_a")
const TARGET = { repository: "acme/api", ref: "a".repeat(40) }
const NPMRC = "@acme:registry=https://npm.pkg.github.com\n"

/** A checkout tracking `package.json` and `.npmrc`, whose `.npmrc` read may come back cut. */
const sandbox = (npmrcTruncated: boolean): RepoSandboxServiceApi => {
	const result = (stdout: string, truncated = false) =>
		Effect.succeed({ exitCode: 0, stdout, stderr: "", wallTimeMs: 1, truncated })
	return {
		prepare: () => Effect.void,
		exec: (_org, _target, options) =>
			options.args.includes("ls-files")
				? result("package.json\n.npmrc")
				: options.args.includes("HEAD:.npmrc")
					? result(NPMRC, npmrcTruncated)
					: result("{}"),
		grep: () => result(""),
		listFiles: () => result(""),
		readFile: () => result(""),
	}
}

describe("inspectDependencies", () => {
	it("scans a config file read in full", async () => {
		const profile = await Effect.runPromise(inspectDependencies(sandbox(false), ORG, TARGET))
		expect([profile.privateDependencies, profile.reasons.some((r) => r.includes("too large"))]).toEqual([
			[".npmrc: private source npm.pkg.github.com"],
			false,
		])
	})

	it("labels a config file whose read was cut as uninspected instead of scanning its prefix", async () => {
		const profile = await Effect.runPromise(inspectDependencies(sandbox(true), ORG, TARGET))
		expect([profile.mode, profile.privateDependencies, profile.reasons.at(-1)]).toEqual([
			"source_only",
			[],
			"config files too large to inspect in full (.npmrc)",
		])
	})
})
