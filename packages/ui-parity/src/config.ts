import { homedir } from "node:os"
import { resolve } from "node:path"

export const repoRoot = resolve(import.meta.dir, "../../..")
export const parityRoot = resolve(import.meta.dir, "..")
/** Gitignored working area: builds, captures, reports. */
export const outDir = resolve(parityRoot, ".parity")
/** Pinned checkouts live outside the repo so root tooling (vitest, oxlint, tsc) never crawls them. */
export const worktreesDir = resolve(homedir(), ".cache/maple-ui-parity/worktrees")

/**
 * Every port is an offset from `PARITY_PORT_BASE` (default 4790), so parallel worktrees can run
 * the harness at once (e.g. 4900, 5100). Builds embed the backend URLs, so they are kept per base.
 */
export const DEFAULT_PORT_BASE = 4790
/** Ports Chromium refuses to load (net::ERR_UNSAFE_PORT), plus 5000 and 7000 (macOS AirPlay Receiver). */
const CHROMIUM_UNSAFE_PORTS = new Set([
	5000, 7000, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
	6669, 6679, 6697, 10080,
])
const PORT_OFFSETS = [0, 1, 2, 3, 4] as const

export const PORT_BASE = (() => {
	const raw = process.env.PARITY_PORT_BASE
	if (!raw) return DEFAULT_PORT_BASE
	const base = Number(raw)
	if (!Number.isInteger(base) || base < 1024 || base > 65000)
		throw new Error(`ui-parity: PARITY_PORT_BASE must be an integer port base, got "${raw}"`)
	const unsafe = PORT_OFFSETS.map((offset) => base + offset).filter((port) => CHROMIUM_UNSAFE_PORTS.has(port))
	if (unsafe.length)
		throw new Error(`ui-parity: PARITY_PORT_BASE=${base} reaches blocked port ${unsafe.join(", ")}`)
	return base
})()

export const FIXTURE_BACKEND_PORT = PORT_BASE
/** Electric gets its own origin so shape polling never competes with API calls for connections. */
export const FIXTURE_ELECTRIC_PORT = PORT_BASE + 3
export const fixtureBackendOrigin = `http://localhost:${FIXTURE_BACKEND_PORT}`
export const fixtureElectricOrigin = `http://localhost:${FIXTURE_ELECTRIC_PORT}`

/**
 * Every target is loaded through this origin. Playwright fulfils it in-browser from the build
 * directory and nothing binds it, so it stays fixed for every base and captures match across worktrees.
 */
export const CANONICAL_ORIGIN = "http://localhost:4800"

/**
 * The pinned reference UI: `bun run parity build legacy` builds this commit unless `--ref` is given.
 * Move it only in a dedicated re-pin commit, with legacy-vs-legacy parity showing what changed.
 */
export const LEGACY_BASELINE_REF = "a9a051e6a797420823bcd2715306ecb188cc0f41"

export type TargetName = "legacy" | "legacy-head" | "foldkit"
export type AuthMode = "self_hosted" | "clerk"

export interface Target {
	readonly name: TargetName
	/** Port `parity serve` binds for side-by-side browsing. Captures never use it. */
	readonly port: number
	/** App directory relative to the repo root (inside the pinned worktree for `legacy`). */
	readonly appDir: string
	/** Built from `LEGACY_BASELINE_REF` in a detached worktree instead of the working tree. */
	readonly pinned: boolean
}

export const targets = {
	legacy: { name: "legacy", port: PORT_BASE + 1, appDir: "apps/web", pinned: true },
	foldkit: { name: "foldkit", port: PORT_BASE + 2, appDir: "apps/web-foldkit", pinned: false },
	"legacy-head": { name: "legacy-head", port: PORT_BASE + 4, appDir: "apps/web", pinned: false },
} as const satisfies Readonly<Record<TargetName, Target>>

export const isTargetName = (value: string): value is TargetName => Object.hasOwn(targets, value)

/** A fake but well-formed Clerk key: `pk_test_` + base64("parity.clerk.invalid$"). */
export const FAKE_CLERK_PUBLISHABLE_KEY = "pk_test_cGFyaXR5LmNsZXJrLmludmFsaWQk"

/**
 * Env every app is built with: each backend URL points at the fixture server, telemetry off.
 * Every key here is also in `apps/web/vite.config.ts`'s `define` override list, so it beats `.env*`.
 */
export const buildEnv = (authMode: AuthMode): Readonly<Record<string, string>> => ({
	VITE_API_BASE_URL: fixtureBackendOrigin,
	VITE_API_PUBLIC_URL: fixtureBackendOrigin,
	VITE_INGEST_URL: fixtureBackendOrigin,
	VITE_MAPLE_SELF_INGEST_URL: fixtureBackendOrigin,
	VITE_ELECTRIC_SYNC_URL: fixtureElectricOrigin,
	VITE_MAPLE_REPLAY: "off",
	VITE_MAPLE_CAPTURE: "off",
	VITE_MAPLE_AUTH_MODE: authMode,
	VITE_CLERK_PUBLISHABLE_KEY: FAKE_CLERK_PUBLISHABLE_KEY,
	VITE_MAPLE_INGEST_KEY: "parity-ingest-key",
	VITE_MAPLE_REGION: "us",
	// Foldkit boots `/lab/*` programs only in dev or with this flag (legacy uses the lab-gate plugin).
	VITE_MAPLE_LAB: "on",
})

/** Env a build must never inherit from the shell (stack URLs, deploy stamps). */
export const STRIPPED_ENV = ["PORTLESS_URL", "VITE_COMMIT_SHA", "VITE_MAPLE_REGION_APP_URLS", "VITE_MCP_URL"]

/** `<build>` for the default `self_hosted` flavor, `<build>--clerk` for the Clerk one. */
export const buildName = (build: string, authMode: AuthMode) =>
	authMode === "clerk" ? `${build}--clerk` : build

export const buildsRoot = resolve(outDir, PORT_BASE === DEFAULT_PORT_BASE ? "builds" : `builds-${PORT_BASE}`)
export const buildDir = (build: string, authMode: AuthMode = "self_hosted") =>
	resolve(buildsRoot, buildName(build, authMode))

/** Written into every build so a build is never served against a backend on another base. */
export const BUILD_STAMP_FILE = ".parity-build.json"

export interface BuildStamp {
	readonly target: TargetName
	readonly portBase: number
	readonly ref: string | null
	readonly authMode: AuthMode
}
