// Bundles the TypeScript anti-slop plugin into plugins/anti-slop.mjs. Node will not strip types
// from a file under node_modules, so the installed package must ship JavaScript.
import { execFileSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(dirname(fileURLToPath(import.meta.url)))
const out = join(here, "plugins/anti-slop.mjs")
execFileSync(
	"bun",
	[
		"build",
		join(here, "plugins/anti-slop/index.ts"),
		"--target",
		"node",
		"--format",
		"esm",
		"--external",
		"@oxlint/plugins",
		"--outfile",
		out,
	],
	{ stdio: "inherit" },
)
