import { SECURITY_AUDIT_LIMIT_DEFAULTS } from "@maple/backend/services/security-audit/limits"
import { Option } from "effect"
import { describe, expect, it } from "vitest"
import { parseRepoSize, repoLimitViolations } from "./repo-size"

const limits = { ...SECURITY_AUDIT_LIMIT_DEFAULTS, maxCheckoutBytes: 10 * 1024 * 1024 }

describe("parseRepoSize", () => {
	it("reads the probe's four counts, and nothing else", () => {
		expect([
			parseRepoSize("1200 340 2048000 0\n"),
			parseRepoSize(""),
			parseRepoSize("fatal: not a git repository"),
			parseRepoSize("12 34 56"),
		]).toEqual([
			Option.some({ commits: 1200, files: 340, bytes: 2_048_000, lfsFiles: 0 }),
			Option.none(),
			Option.none(),
			Option.none(),
		])
	})
})

describe("repoLimitViolations", () => {
	it("passes a repository within every limit", () => {
		expect(
			repoLimitViolations({ commits: 900, files: 400, bytes: 4_000_000, lfsFiles: 0 }, limits),
		).toEqual([])
	})

	it("names each limit a repository is over", () => {
		expect(
			repoLimitViolations(
				{ commits: 2_000_000, files: 150_000, bytes: 64 * 1024 * 1024, lfsFiles: 2 },
				limits,
			),
		).toEqual([
			"its tracked files are 64 MiB, over the 10 MiB limit",
			"it tracks 150000 files, over the 100000 limit",
			"its history has 2000000 commits, over the 1000000 limit",
			"it stores 2 files in Git LFS, whose content the checkout does not hold (limit 0)",
		])
	})
})
