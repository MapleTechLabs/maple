import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { LEGACY_BASELINE_REF, repoRoot } from "../config.ts"
import type { AreaModule, Scenario } from "./types.ts"

/**
 * Every page in `apps/web/src/lab/registry.ts`, plus the `/lab` index, at desktop in
 * light and dark. Read from the registry source so a new lab page is covered without editing this
 * file; once `apps/web` is gone it is read from the pinned baseline instead.
 */
const REGISTRY = "apps/web/src/lab/registry.ts"

const registrySource = () => {
	const path = resolve(repoRoot, REGISTRY)
	if (existsSync(path)) return readFileSync(path, "utf8")
	return execFileSync("git", ["show", `${LEGACY_BASELINE_REF}:${REGISTRY}`], { cwd: repoRoot, encoding: "utf8" })
}

export interface LabRegistryEntry {
	readonly path: string
	readonly title: string
	readonly session: "none" | "required"
}

export const labRegistry = (): ReadonlyArray<LabRegistryEntry> => {
	const body = registrySource().split("LAB_ENTRIES")[1] ?? ""
	const entries: LabRegistryEntry[] = []
	for (const block of body.split(/\n\t\{\n/).slice(1)) {
		const path = block.match(/path: "([^"]+)"/)?.[1]
		const title = block.match(/title: "([^"]+)"/)?.[1]
		const session = block.match(/session: "(none|required)"/)?.[1]
		if (path && title && (session === "none" || session === "required")) entries.push({ path, title, session })
	}
	if (entries.length === 0) throw new Error(`ui-parity: no lab entries parsed from ${REGISTRY}`)
	return entries
}

const scenario = (path: string, title: string): Scenario => ({
	id: path === "/lab" ? "lab-index" : `lab-${path.slice("/lab/".length).replaceAll("/", "-")}`,
	title: `Lab: ${title}`,
	path,
	viewports: ["desktop"],
	themes: ["light", "dark"],
	area: "lab",
	// Signed in: the root shell still calls the API on lab pages, and some pages need a session.
	dataset: "default",
})

export const labArea: AreaModule = {
	area: "lab",
	scenarios: [
		scenario("/lab", "Index"),
		...labRegistry().map((entry) => scenario(entry.path, entry.title)),
	],
}
