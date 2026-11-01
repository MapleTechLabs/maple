// Captures real OSV.dev answers for the dependency scanner's tests: one querybatch plus every
// vulnerability it names, trimmed to the fields the scanner reads.
// Run: bun packages/backend/scripts/capture-osv-fixtures.ts
const OUT = new URL("../src/services/security/__fixtures__/osv.json", import.meta.url)

const queries = [
	{ package: { ecosystem: "npm", name: "lodash" }, version: "4.17.15" },
	{ package: { ecosystem: "npm", name: "minimist" }, version: "1.2.5" },
	{ package: { ecosystem: "npm", name: "left-pad" }, version: "1.3.0" },
	{ package: { ecosystem: "Go", name: "golang.org/x/net" }, version: "v0.7.0" },
	{ package: { ecosystem: "crates.io", name: "time" }, version: "0.1.43" },
	{ package: { ecosystem: "crates.io", name: "h2" }, version: "0.3.16" },
]

interface BatchResult {
	readonly vulns?: ReadonlyArray<{ readonly id: string }>
}

const batch: { results: ReadonlyArray<BatchResult> } = await fetch("https://api.osv.dev/v1/querybatch", {
	method: "POST",
	body: JSON.stringify({ queries }),
}).then((response) => response.json())

const ids = [...new Set(batch.results.flatMap((result) => (result.vulns ?? []).map((vuln) => vuln.id)))]
const vulns = await Promise.all(
	ids.map((id) => fetch(`https://api.osv.dev/v1/vulns/${id}`).then((response) => response.json())),
)
const trimmed = vulns.map((vuln) => ({
	id: vuln.id,
	aliases: vuln.aliases,
	summary: vuln.summary,
	published: vuln.published,
	withdrawn: vuln.withdrawn,
	severity: vuln.severity,
	database_specific:
		vuln.database_specific?.severity === undefined
			? undefined
			: { severity: vuln.database_specific.severity },
	affected: (vuln.affected ?? []).map((affected: { package: unknown; ranges?: unknown }) => ({
		package: affected.package,
		ranges: affected.ranges,
	})),
}))
await Bun.write(OUT, `${JSON.stringify({ queries, batch, vulns: trimmed }, null, "\t")}\n`)
console.log(`${queries.length} queries, ${ids.length} vulnerabilities -> ${OUT.pathname}`)
