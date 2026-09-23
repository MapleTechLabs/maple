/**
 * `bun scripts/backfill-org-regions.ts [--apply --confirm-eu-marked]`: stamp every organization that has no data
 * region with `regions: ["us"]`.
 *
 * Run once against the production Clerk instance before the region step ships. Organizations
 * created before regions existed all live on the US instance but carry no `regions` key, and
 * onboarding lets an organization without one pick EU. Stamping them closes that door for
 * everything that already has data, leaving the choice to organizations created afterwards.
 *
 * Dry run by default: it lists what it would change. `--apply` writes. Clerk merges public
 * metadata by key, so rollout flags on the same organizations are left alone.
 */
const CLERK_API = "https://api.clerk.com/v1"
const PAGE_SIZE = 100
// Clerk's Backend API allows 100 requests per 10 seconds per key.
const WRITE_INTERVAL_MS = 120

const secretKey = process.env.CLERK_SECRET_KEY
if (!secretKey) {
	console.error("CLERK_SECRET_KEY is not set.")
	process.exit(2)
}
const apply = process.argv.includes("--apply")
// Nothing on an organization says which instance created it, so an EU organization that was not
// marked first would be stamped US here and could no longer choose. The flag makes that step explicit.
if (apply && !process.argv.includes("--confirm-eu-marked")) {
	console.error(
		'--apply also needs --confirm-eu-marked: set regions: ["eu"] on every organization created on the EU dashboard first.',
	)
	process.exit(2)
}

// The REST API directly, as `dev-signin.ts` does: `@clerk/backend` is not a root dependency.
const clerkFetch = async (path: string, init?: RequestInit) => {
	const response = await fetch(`${CLERK_API}${path}`, {
		...init,
		headers: {
			authorization: `Bearer ${secretKey}`,
			"content-type": "application/json",
			...init?.headers,
		},
	})
	if (!response.ok) {
		console.error(`Clerk ${init?.method ?? "GET"} ${path} failed: ${response.status}`)
		console.error(await response.text())
		process.exit(1)
	}
	return response.json()
}

interface ClerkOrganization {
	readonly id: string
	readonly name: string
	readonly public_metadata: Record<string, unknown> | null
}

// Mirrors `organizationRegionChosen` in `@maple/domain/organization-regions`, which the repo root
// cannot import.
const hasRegion = (metadata: Record<string, unknown> | null) => {
	const regions = metadata?.regions
	return Array.isArray(regions) && regions.some((region) => region === "us" || region === "eu")
}

const missing: ClerkOrganization[] = []
let total = 0
for (let offset = 0; ; offset += PAGE_SIZE) {
	const page = (await clerkFetch(`/organizations?limit=${PAGE_SIZE}&offset=${offset}`)) as {
		data: ClerkOrganization[]
		total_count: number
	}
	total += page.data.length
	missing.push(...page.data.filter((org) => !hasRegion(org.public_metadata)))
	if (page.data.length < PAGE_SIZE) break
}

console.log(`${total} organizations, ${missing.length} without a data region.`)

if (!apply) {
	for (const org of missing) console.log(`  would set regions: ["us"] on ${org.id} (${org.name})`)
	console.log("\nDry run. Re-run with --apply to write.")
	process.exit(0)
}

for (const [index, org] of missing.entries()) {
	await clerkFetch(`/organizations/${org.id}/metadata`, {
		method: "PATCH",
		body: JSON.stringify({ public_metadata: { regions: ["us"] } }),
	})
	console.log(`  [${index + 1}/${missing.length}] ${org.id} (${org.name})`)
	await new Promise((resolve) => setTimeout(resolve, WRITE_INTERVAL_MS))
}
console.log(`\nStamped ${missing.length} organizations with regions: ["us"].`)
