import { execFileSync } from "node:child_process"
import { LEGACY_BASELINE_REF, repoRoot } from "./config.ts"
import { scenarios } from "./scenarios.ts"

/**
 * Every legacy route at the pinned baseline and the scenarios that visit it: the migration to-do
 * list. `/lab` pages are fixtures for the port, not screens to port, so they are left out.
 */
const EXCLUDED = /^\/lab(\/|$)/

export interface RouteCoverage {
	readonly route: string
	readonly scenarios: ReadonlyArray<string>
}

export const legacyRoutes = (ref = LEGACY_BASELINE_REF) => {
	const routeTree = execFileSync("git", ["show", `${ref}:apps/web/src/routeTree.gen.ts`], {
		cwd: repoRoot,
		encoding: "utf8",
	})
	const block = routeTree.match(/interface FileRoutesByFullPath \{([\s\S]*?)\n\}/)?.[1] ?? ""
	const routes = [...block.matchAll(/'([^']+)':/g)].flatMap((match) => (match[1] ? [match[1]] : []))
	return [...new Set(routes.map((route) => route.replace(/(.)\/$/, "$1")))].filter((route) => !EXCLUDED.test(route))
}

/** `$param` matches one segment, a trailing splat `$` matches the rest. */
const toPattern = (route: string) =>
	new RegExp(`^${route.replace(/\/\$$/, "(/.*)?").replace(/\$[^/]+/g, "[^/]+")}/?$`)

export const routeCoverage = (ref = LEGACY_BASELINE_REF): ReadonlyArray<RouteCoverage> =>
	legacyRoutes(ref).map((route) => ({
		route,
		scenarios: scenarios
			.filter((scenario) => toPattern(route).test(scenario.path.split("?")[0] ?? scenario.path))
			.map((scenario) => scenario.id),
	}))
