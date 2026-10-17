import { existsSync, readFileSync, statSync } from "node:fs"
import { join, normalize, resolve } from "node:path"
import type { FixtureBackend, StartBackend } from "./contract.ts"
import {
	type AuthMode,
	BUILD_STAMP_FILE,
	type BuildStamp,
	buildDir,
	buildName,
	FIXTURE_BACKEND_PORT,
	FIXTURE_ELECTRIC_PORT,
	isTargetName,
	PORT_BASE,
} from "./config.ts"

export interface StaticBuild {
	/** Build name (`legacy`, `foldkit`, or a custom `--out`), without the auth flavor suffix. */
	readonly name: string
	readonly authMode: AuthMode
	readonly dir: string
	readonly stamp: BuildStamp
	readonly indexHtml: string
}

const isStamp = (value: unknown): value is BuildStamp =>
	typeof value === "object" &&
	value !== null &&
	"target" in value &&
	typeof value.target === "string" &&
	isTargetName(value.target) &&
	"portBase" in value &&
	typeof value.portBase === "number"

export const buildExists = (name: string, authMode: AuthMode = "self_hosted") =>
	existsSync(join(buildDir(name, authMode), "index.html"))

/** Loads a build, refusing one made for another `PARITY_PORT_BASE` (it would talk to someone else's backend). */
export const loadBuild = (name: string, authMode: AuthMode = "self_hosted"): StaticBuild => {
	const dir = buildDir(name, authMode)
	const flag = authMode === "clerk" ? " --auth clerk" : ""
	if (!existsSync(join(dir, "index.html")))
		throw new Error(`No build "${buildName(name, authMode)}". Run: bun run parity build <target>${flag}`)
	const stampFile = join(dir, BUILD_STAMP_FILE)
	const stamp: unknown = existsSync(stampFile) ? JSON.parse(readFileSync(stampFile, "utf8")) : undefined
	if (!isStamp(stamp)) throw new Error(`Build "${name}" has no valid ${BUILD_STAMP_FILE}; rebuild it.`)
	if (stamp.portBase !== PORT_BASE)
		throw new Error(`Build "${name}" targets PARITY_PORT_BASE=${stamp.portBase}, not ${PORT_BASE}. Rebuild it.`)
	return { name, authMode, dir, stamp, indexHtml: readFileSync(join(dir, "index.html"), "utf8") }
}

export type StaticResponse =
	| { readonly kind: "file"; readonly path: string }
	| { readonly kind: "html"; readonly body: string }
	| { readonly kind: "not-found" }

/** SPA resolution: real files as is, client routes get index.html (with `headScript` first in `<head>`). */
export const resolveStatic = (build: StaticBuild, pathname: string, headScript = ""): StaticResponse => {
	// Never serve the service worker: it would cache across runs.
	if (pathname === "/sw.js" || pathname.startsWith("/workbox-")) return { kind: "not-found" }
	const filePath = normalize(join(build.dir, decodeURIComponent(pathname)))
	const isAsset =
		pathname !== "/" && filePath.startsWith(build.dir) && existsSync(filePath) && statSync(filePath).isFile()
	if (isAsset && !filePath.endsWith("index.html")) return { kind: "file", path: filePath }
	// A missing hashed asset is a 404, not index.html, so a stale chunk fails loudly.
	if (pathname.startsWith("/assets/")) return { kind: "not-found" }
	return { kind: "html", body: build.indexHtml.replace("<head>", `<head>${headScript}`) }
}

/** Static server for side-by-side browsing (`parity serve`). Captures fulfil in-browser instead. */
export const serveStatic = (build: StaticBuild, port: number, headScript: string) =>
	Bun.serve({
		port,
		fetch(request) {
			const resolved = resolveStatic(build, new URL(request.url).pathname, headScript)
			if (resolved.kind === "file") return new Response(Bun.file(resolved.path))
			if (resolved.kind === "html")
				return new Response(resolved.body, { headers: { "content-type": "text/html; charset=utf-8" } })
			return new Response("", { status: 404 })
		},
	})

const BACKEND_MODULE = resolve(import.meta.dir, "backend/index.ts")

const isStartBackend = (value: unknown): value is StartBackend => typeof value === "function"

/**
 * The fixture backend from `src/backend/index.ts`, or `null` while it does not exist yet (or with
 * `PARITY_NULL_BACKEND=1`). Captures then answer every API and Electric request with 404 and report it as unmocked.
 */
export const startBackendIfPresent = async (): Promise<FixtureBackend | null> => {
	if (process.env.PARITY_NULL_BACKEND === "1") {
		console.log("[backend] PARITY_NULL_BACKEND=1: running with a null backend (API calls 404)")
		return null
	}
	if (!existsSync(BACKEND_MODULE)) {
		console.log("[backend] src/backend/index.ts not found: running with a null backend (API calls 404)")
		return null
	}
	const { startBackend: start }: { readonly startBackend?: unknown } = await import(BACKEND_MODULE)
	if (!isStartBackend(start)) throw new Error("ui-parity: src/backend/index.ts must export startBackend")
	return start({ apiPort: FIXTURE_BACKEND_PORT, electricPort: FIXTURE_ELECTRIC_PORT })
}
