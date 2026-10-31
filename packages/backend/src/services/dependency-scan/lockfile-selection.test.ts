import { describe, expect, it } from "vitest"
import {
	MAX_LOCKFILES,
	manifestsFor,
	type SelectedLockfile,
	sameLockfiles,
	selectLockfiles,
} from "./lockfile-selection"

const file = (path: string, sha = `sha-${path}`) => ({ path, sha, size: 100 })

describe("selectLockfiles", () => {
	it("keeps lockfiles shallowest first and skips vendored, fixture and go.sum-beside-go.mod paths", () => {
		const { selected, skipped } = selectLockfiles([
			file("services/api/go.sum"),
			file("services/api/go.mod"),
			file("tools/go.sum"),
			file("README.md"),
			file("web/node_modules/left-pad/package-lock.json"),
			file("crates/core/Cargo.lock"),
			file("package-lock.json"),
			file("test/fixtures/yarn.lock"),
			file("vendor/github.com/x/go.mod"),
		])
		expect(selected.map((lockfile) => [lockfile.file.path, lockfile.kind])).toEqual([
			["package-lock.json", "package-lock"],
			["tools/go.sum", "go-sum"],
			["crates/core/Cargo.lock", "cargo-lock"],
			["services/api/go.mod", "go-mod"],
		])
		expect(skipped).toBe(0)
	})

	it("caps the lockfiles a scan reads and counts the rest", () => {
		const many = Array.from({ length: MAX_LOCKFILES + 3 }, (_, i) => file(`pkg${i}/bun.lock`))
		const { selected, skipped } = selectLockfiles(many)
		expect(selected).toHaveLength(MAX_LOCKFILES)
		expect(skipped).toBe(3)
	})
})

describe("manifestsFor", () => {
	const tree = [
		file("web/yarn.lock"),
		file("web/package.json"),
		file("web/packages/ui/package.json"),
		file("web/node_modules/react/package.json"),
		file("api/package.json"),
	]
	const lockfile = (path: string, kind: SelectedLockfile["kind"]): SelectedLockfile => ({
		file: file(path),
		kind,
	})

	it("hands a yarn lockfile the package.json files under its directory, relative to it", () => {
		expect(manifestsFor(lockfile("web/yarn.lock", "yarn-v1"), tree).map((m) => m.relativePath)).toEqual([
			"package.json",
			"packages/ui/package.json",
		])
	})

	it("reads no manifests for formats that record direct and dev dependencies themselves", () => {
		expect(manifestsFor(lockfile("web/package-lock.json", "package-lock"), tree)).toEqual([])
	})
})

describe("sameLockfiles", () => {
	const previous = [
		{
			path: "a/bun.lock",
			kind: "bun-lock",
			blobSha: "1",
			packageCount: 3,
			status: "parsed",
			message: null,
		},
	] as const
	it("matches only the same paths at the same blobs", () => {
		const selected = (sha: string, path = "a/bun.lock"): ReadonlyArray<SelectedLockfile> => [
			{ file: { path, sha, size: 1 }, kind: "bun-lock" },
		]
		expect(sameLockfiles(previous, selected("1"))).toBe(true)
		expect(sameLockfiles(previous, selected("2"))).toBe(false)
		expect(sameLockfiles(previous, selected("1", "b/bun.lock"))).toBe(false)
		expect(sameLockfiles(previous, [])).toBe(false)
	})
})
