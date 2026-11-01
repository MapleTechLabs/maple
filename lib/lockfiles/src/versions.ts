import type { Ecosystem } from "./types.ts"

interface SemVer {
	readonly major: string
	readonly minor: string
	readonly patch: string
	readonly prerelease: ReadonlyArray<string>
}

const NUM = "0|[1-9]\\d*"
const PRE_ID = `(?:${NUM}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`
const PRE = `(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?`
const BUILD = "(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?"
const SEMVER = new RegExp(`^(${NUM})\\.(${NUM})\\.(${NUM})${PRE}${BUILD}$`)
// Go allows `v1` and `v1.2` (meaning .0), but only a full major.minor.patch may carry a prerelease or build.
const GO_SEMVER = new RegExp(`^v?(${NUM})(?:\\.(${NUM})(?:\\.(${NUM})${PRE}${BUILD})?)?$`)

const isNumeric = (id: string): boolean => /^\d+$/.test(id)

/** Numeric strings of any length, compared without overflow. */
const compareNumeric = (a: string, b: string): number => {
	const x = a.replace(/^0+(?=\d)/, "")
	const y = b.replace(/^0+(?=\d)/, "")
	return x.length !== y.length ? x.length - y.length : x < y ? -1 : x > y ? 1 : 0
}

/** SemVer 2.0 rule 11: numeric < alphanumeric, numbers numerically, text by ASCII, more fields wins. */
const compareIdentifier = (a: string, b: string): number => {
	const an = isNumeric(a)
	const bn = isNumeric(b)
	if (an && bn) return compareNumeric(a, b)
	if (an !== bn) return an ? -1 : 1
	return a < b ? -1 : a > b ? 1 : 0
}

const comparePrerelease = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): number => {
	if (a.length === 0 || b.length === 0) return b.length - a.length
	const differing = a.findIndex((id, i) => i < b.length && compareIdentifier(id, b[i] ?? "") !== 0)
	return differing === -1 ? a.length - b.length : compareIdentifier(a[differing] ?? "", b[differing] ?? "")
}

const compareParsed = (a: SemVer, b: SemVer): number =>
	compareNumeric(a.major, b.major) ||
	compareNumeric(a.minor, b.minor) ||
	compareNumeric(a.patch, b.patch) ||
	comparePrerelease(a.prerelease, b.prerelease)

const toSemVer = (m: RegExpExecArray): SemVer => ({
	major: m[1] ?? "0",
	minor: m[2] ?? "0",
	patch: m[3] ?? "0",
	prerelease: m[4] === undefined ? [] : m[4].split("."),
})

const parseSemVer = (version: string): SemVer | undefined => {
	const m = SEMVER.exec(version.trim().replace(/^=?\s*v?/, ""))
	return m === null ? undefined : toSemVer(m)
}

const parseGo = (version: string): SemVer | undefined => {
	const m = GO_SEMVER.exec(version.trim())
	return m === null ? undefined : toSemVer(m)
}

/** Invalid versions sort below valid ones; two invalid ones fall back to `ifBothInvalid`. */
const compareWith =
	(parse: (v: string) => SemVer | undefined, ifBothInvalid: (a: string, b: string) => number) =>
	(a: string, b: string): number => {
		const x = parse(a)
		const y = parse(b)
		if (x === undefined || y === undefined) {
			return x === undefined && y === undefined ? ifBothInvalid(a, b) : x === undefined ? -1 : 1
		}
		return Math.sign(compareParsed(x, y))
	}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** SemVer 2.0 precedence; build metadata ignored, a leading `v` or `=` tolerated. */
export const compareNpmVersions: (a: string, b: string) => number = compareWith(parseSemVer, byString)

/** Go module versions (golang.org/x/mod/semver): pseudo-versions are prereleases, `+incompatible` is build metadata. All invalid versions compare equal. */
export const compareGoVersions: (a: string, b: string) => number = compareWith(parseGo, () => 0)

/** Cargo uses SemVer 2.0 precedence like npm. */
export const compareCargoVersions: (a: string, b: string) => number = compareWith(parseSemVer, byString)

export const compareVersions = (ecosystem: Ecosystem, a: string, b: string): number =>
	ecosystem === "Go"
		? compareGoVersions(a, b)
		: ecosystem === "crates.io"
			? compareCargoVersions(a, b)
			: compareNpmVersions(a, b)
