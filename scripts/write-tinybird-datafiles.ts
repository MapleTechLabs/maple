import { Effect } from "effect"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { buildTinybirdProjectManifest } from "../packages/domain/src/tinybird/project-manifest"

// `tb` deploys the datafiles under `tinybird.json`'s `folder`, in the layout its
// own TypeScript bridge writes: `datasources/*.datasource`, `pipes/*.pipe`.
export const TINYBIRD_PROJECT_DIR = fileURLToPath(new URL("../tinybird", import.meta.url))

export const writeTinybirdDatafiles = (): string => {
	const manifest = Effect.runSync(buildTinybirdProjectManifest)
	rmSync(TINYBIRD_PROJECT_DIR, { recursive: true, force: true })
	for (const [folder, suffix, resources] of [
		["datasources", ".datasource", manifest.datasources],
		["pipes", ".pipe", manifest.pipes],
	] as const) {
		mkdirSync(join(TINYBIRD_PROJECT_DIR, folder), { recursive: true })
		for (const resource of resources) {
			writeFileSync(join(TINYBIRD_PROJECT_DIR, folder, `${resource.name}${suffix}`), resource.content)
		}
	}
	return manifest.projectRevision
}

if (import.meta.main) {
	const revision = writeTinybirdDatafiles()
	console.log(`Wrote Tinybird datafiles (${revision}) to ${TINYBIRD_PROJECT_DIR}.`)
}
