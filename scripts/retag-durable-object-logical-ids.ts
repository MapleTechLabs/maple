#!/usr/bin/env bun
/**
 * One-shot migration for #787: rewrite the api Worker's `alchemy:dos:` script
 * tag so its Durable Object classes are keyed by their own class name.
 *
 *   bun scripts/retag-durable-object-logical-ids.ts <script-name>
 *
 * Alchemy tracks which logical id hosts which Durable Object class in a
 * script tag (`alchemy:dos:<logicalId>=<className>;…`), written on upload and
 * read back on the next deploy to decide the class migrations. The chat
 * Durable Object used to be the `CHAT_SESSION` binding, so the deployed tag
 * says `CHAT_SESSION=ChatSession`; the class form registers the same class
 * under the logical id `ChatSession`. Alchemy therefore plans BOTH a delete of
 * `ChatSession` (its old logical id is gone) and a fresh create of `ChatSession`
 * (its new logical id is unknown) — Cloudflare rejects that upload with
 * "class 'ChatSession' cannot be the target of more than one migration", and
 * had it accepted it the namespace's data would have been destroyed.
 *
 * Re-keying the pair to `ChatSession` (elided form, logical id == class name)
 * makes the next deploy a no-op migration on a class that already exists.
 * Idempotent: a tag that already has the elided form is left alone and no
 * PATCH is sent. Remove the workflow step and this script once stg and prd
 * have deployed past #787.
 *
 * Auth: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (the deploy workflow's
 * own credentials).
 */

const PACKED_DO_TAG_PREFIX = "alchemy:dos:"

/** Classes whose logical id must equal the class name after #787. */
const CLASS_FORM_CLASSES: ReadonlySet<string> = new Set(["ChatSession"])

const FAILURE = 1

const fail = (message: string): never => {
	console.error(`✗ ${message}`)
	process.exit(FAILURE)
}

const requireEnv = (key: string): string => {
	const value = process.env[key]?.trim()
	if (!value) return fail(`Missing required env: ${key}`)
	return value
}

/** Re-key every `<logicalId>=<className>` pair whose class is class-form now. Pure; exported for a dry check. */
export const rewriteDurableObjectTags = (tags: ReadonlyArray<string>): string[] =>
	tags.map((tag) => {
		if (!tag.startsWith(PACKED_DO_TAG_PREFIX)) return tag
		const pairs = tag
			.slice(PACKED_DO_TAG_PREFIX.length)
			.split(";")
			.filter((pair) => pair !== "")
			.map((pair) => {
				const eq = pair.indexOf("=")
				const logicalId = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq))
				const className = decodeURIComponent(eq === -1 ? pair : pair.slice(eq + 1))
				return CLASS_FORM_CLASSES.has(className)
					? { logicalId: className, className }
					: { logicalId, className }
			})
			.sort((a, b) => a.logicalId.localeCompare(b.logicalId))
			.map(({ logicalId, className }) =>
				logicalId === className
					? encodeURIComponent(className)
					: `${encodeURIComponent(logicalId)}=${encodeURIComponent(className)}`,
			)
		return `${PACKED_DO_TAG_PREFIX}${pairs.join(";")}`
	})

const main = async () => {
	const scriptName = process.argv[2]?.trim()
	if (!scriptName) return fail("Usage: bun scripts/retag-durable-object-logical-ids.ts <script-name>")
	const token = requireEnv("CLOUDFLARE_API_TOKEN")
	const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID")
	const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/script-settings`
	const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }

	const current = await fetch(url, { headers })
	if (current.status === 404) {
		console.log(`ℹ ${scriptName} does not exist yet — nothing to retag`)
		return
	}
	if (!current.ok) return fail(`GET script-settings for ${scriptName}: HTTP ${current.status}`)
	const settings = (await current.json()) as { result?: { tags?: string[] | null } }
	const tags = settings.result?.tags ?? []
	const rewritten = rewriteDurableObjectTags(tags)
	if (rewritten.join("\n") === tags.join("\n")) {
		console.log(`✓ ${scriptName}: Durable Object tags already keyed by class name — no change`)
		return
	}
	console.log(`${scriptName}: rewriting Durable Object tags`)
	console.log(`  before: ${JSON.stringify(tags)}`)
	console.log(`  after:  ${JSON.stringify(rewritten)}`)
	const patched = await fetch(url, { method: "PATCH", headers, body: JSON.stringify({ tags: rewritten }) })
	if (!patched.ok)
		return fail(`PATCH script-settings for ${scriptName}: HTTP ${patched.status} ${await patched.text()}`)
	console.log(`✓ ${scriptName}: tags updated`)
}

if (import.meta.main) await main()
