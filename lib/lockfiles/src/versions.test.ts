import fc from "fast-check"
import semver from "semver"
import { describe, expect, it } from "vitest"
import { compareCargoVersions, compareGoVersions, compareNpmVersions, compareVersions } from "./index.ts"

const numeric = fc.oneof(fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 2 ** 40 })).map(String)
const alnumId = fc.stringMatching(/^[0-9a-zA-Z-]{1,6}$/).filter((s) => !/^\d+$/.test(s))
const preId = fc.oneof(numeric, alnumId, fc.constantFrom("alpha", "beta", "rc", "0", "1"))
const build = fc.array(fc.stringMatching(/^[0-9a-zA-Z-]{1,4}$/), { minLength: 1, maxLength: 2 })

/** Valid SemVer 2.0 strings, small parts weighted so equal cores and prerelease ties are common. */
const semverString = fc
	.record({
		core: fc.tuple(numeric, numeric, numeric),
		pre: fc.option(fc.array(preId, { minLength: 1, maxLength: 3 }), { nil: undefined }),
		build: fc.option(build, { nil: undefined }),
	})
	.map(
		({ core, pre, build }) =>
			`${core.join(".")}${pre === undefined ? "" : `-${pre.join(".")}`}${build === undefined ? "" : `+${build.join(".")}`}`,
	)

describe("compareNpmVersions", () => {
	it("agrees in sign with node-semver", () => {
		fc.assert(
			fc.property(semverString, semverString, (a, b) => {
				expect(compareNpmVersions(a, b)).toBe(Math.sign(semver.compare(a, b)))
			}),
			{ numRuns: 5000 },
		)
	})

	it("is antisymmetric and ignores build metadata", () => {
		fc.assert(
			fc.property(semverString, semverString, (a, b) => {
				expect(compareNpmVersions(a, b)).toBe(-compareNpmVersions(b, a) || 0)
				expect(compareNpmVersions(`${a.split("+")[0]}+zzz`, a)).toBe(0)
			}),
		)
	})

	it.each([
		["v1.2.3", "1.2.3", 0],
		["=1.2.3", "1.2.3", 0],
		["1.0.0-alpha", "1.0.0-alpha.1", -1],
		["1.0.0-alpha.beta", "1.0.0-beta", -1],
		["1.0.0-beta.11", "1.0.0-rc.1", -1],
		["1.0.0-beta.2", "1.0.0-beta.11", -1],
		["1.0.0-rc.1", "1.0.0", -1],
		["10.0.0", "9.99.99", 1],
		["not-a-version", "0.0.0", -1],
	])("%s vs %s is %i", (a, b, expected) => {
		expect(compareNpmVersions(a, b)).toBe(expected)
		expect(compareVersions("npm", a, b)).toBe(expected)
	})
})

describe("compareCargoVersions", () => {
	it.each([
		["0.3.16", "0.3.17", -1],
		["1.0.0-alpha.1", "1.0.0-alpha", 1],
		["1.0.0+build.5", "1.0.0", 0],
		["0.1.43", "0.1.5", 1],
		["1.0.0-0.3.7", "1.0.0-x.7.z.92", -1],
	])("%s vs %s is %i", (a, b, expected) => {
		expect(compareCargoVersions(a, b)).toBe(expected)
		expect(compareVersions("crates.io", a, b)).toBe(expected)
	})
})

/** golang.org/x/mod/semver semver_test.go: ascending order, "" marks invalid, equal canonical forms tie. */
const GO_TESTS: ReadonlyArray<readonly [string, string]> = [
	["bad", ""],
	["v1-alpha.beta.gamma", ""],
	["v1-pre", ""],
	["v1+meta", ""],
	["v1-pre+meta", ""],
	["v1.2-pre", ""],
	["v1.2-pre+meta", ""],
	["v1.0.0-alpha", "v1.0.0-alpha"],
	["v1.0.0-alpha.1", "v1.0.0-alpha.1"],
	["v1.0.0-alpha.beta", "v1.0.0-alpha.beta"],
	["v1.0.0-beta", "v1.0.0-beta"],
	["v1.0.0-beta.2", "v1.0.0-beta.2"],
	["v1.0.0-beta.11", "v1.0.0-beta.11"],
	["v1.0.0-rc.1", "v1.0.0-rc.1"],
	["v1", "v1.0.0"],
	["v1.0", "v1.0.0"],
	["v1.0.0", "v1.0.0"],
	["v1.2", "v1.2.0"],
	["v1.2.0", "v1.2.0"],
	["v1.2.3-456", "v1.2.3-456"],
	["v1.2.3-456.789", "v1.2.3-456.789"],
	["v1.2.3-456-789", "v1.2.3-456-789"],
	["v1.2.3-456a", "v1.2.3-456a"],
	["v1.2.3-pre", "v1.2.3-pre"],
	["v1.2.3-pre+meta", "v1.2.3-pre"],
	["v1.2.3-pre.1", "v1.2.3-pre.1"],
	["v1.2.3-zzz", "v1.2.3-zzz"],
	["v1.2.3", "v1.2.3"],
	["v1.2.3+meta", "v1.2.3"],
	["v1.2.3+meta-pre", "v1.2.3"],
	["v1.2.3+meta-pre.sha.256a", "v1.2.3"],
]

describe("compareGoVersions", () => {
	it("orders Go's own semver test table", () => {
		GO_TESTS.forEach(([a, canonA], i) =>
			GO_TESTS.forEach(([b, canonB], j) => {
				const expected = canonA === canonB ? 0 : i < j ? -1 : 1
				expect({ a, b, cmp: compareGoVersions(a, b) }).toEqual({ a, b, cmp: expected })
			}),
		)
	})

	it.each([
		["v0.0.0-20191109021931-daa7c04131f5", "v0.0.1", -1],
		["v0.0.0-20191109021931-daa7c04131f5", "v0.0.0-20200101000000-aaaaaaaaaaaa", -1],
		["v1.2.3", "v1.2.4-0.20191109021931-daa7c04131f5", -1],
		["v1.2.4-0.20191109021931-daa7c04131f5", "v1.2.4", -1],
		["v1.2.4-pre", "v1.2.4-pre.0.20191109021931-daa7c04131f5", -1],
		["v1.2.4-pre.0.20191109021931-daa7c04131f5", "v1.2.4-pre.1", -1],
		["v2.0.0+incompatible", "v2.0.0", 0],
		["v2.0.1+incompatible", "v2.0.0", 1],
		["1.2.3", "v1.2.3", 0],
		["v1.02.3", "v0.0.1", -1],
		["v1.2.3-01", "v0.0.1", -1],
	])("%s vs %s is %i", (a, b, expected) => {
		expect(compareGoVersions(a, b)).toBe(expected)
		expect(compareVersions("Go", a, b)).toBe(expected)
	})
})
