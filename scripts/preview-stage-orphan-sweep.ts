#!/usr/bin/env bun
/**
 * Tear down whole PR-preview stages whose PR is closed.
 *
 *   bun scripts/preview-stage-orphan-sweep.ts [--dry-run]
 *
 * A PR-preview stage `pr-<n>` spans Cloudflare (Workers, Queues, Hyperdrive, R2), a Neon
 * branch and an AWS stack (ingest + Electric on ECS, ALBs, VPC, secrets, S3). The
 * close-event teardown is best-effort (see cleanup-preview-orphans.yml), and the
 * Cloudflare-only sibling sweeps never reach AWS: closed PR #937's AWS stack kept running.
 *
 * Candidate PRs come from three name-pinned markers:
 *   - Workers named `maple-<base>-pr-<n>` (packages/infra/src/cloudflare/stage.ts),
 *   - Neon branches named `pr-<n>` in NEON_PROJECT_ID (alchemy.run.ts, declarePreviewDb),
 *   - R2 buckets named `maple-replay-blobs-pr-<n>`, which alchemy RETAINS on destroy
 *     (apps/api/src/resources/replay-blobs.ts), so every deployed stage keeps one.
 * For each PR the GitHub API affirmatively reports closed (unknown/open → keep), it runs
 * `alchemy destroy --yes --stage pr-<n>`, then deletes the Neon branch and empties and
 * deletes the R2 bucket. If the destroy fails, the branch and bucket stay so the next run
 * rediscovers the stage and retries. Stages run one at a time; a failure does not stop
 * the rest, but the run exits non-zero.
 *
 * Runs BEFORE the Worker/Hyperdrive sweeps: alchemy destroy wants its resources present.
 * Needs `bun run alchemy:build-deps` once beforehand, and the alchemy deploy env
 * (Infisical secrets, AWS OIDC credentials, AWS_ACCOUNT_ID).
 *
 * Auth: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, NEON_API_KEY + NEON_PROJECT_ID
 * (both optional: without them that marker is skipped), GITHUB_REPOSITORY +
 * GITHUB_TOKEN/GH_TOKEN for the PR-state gate.
 */

import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { fetchPrState, hasPrStateCredentials } from "./lib/pr-state.ts"

const FAILURE = 1
const DRY_RUN = process.argv.includes("--dry-run")
const REPO_ROOT = join(import.meta.dirname, "..")
const DESTROY_TIMEOUT_MS = 30 * 60 * 1000

const fail = (message: string): never => {
	console.error(`✗ ${message}`)
	process.exit(FAILURE)
}

const requireEnv = (key: string): string => {
	const value = process.env[key]?.trim()
	if (!value) {
		return fail(`Missing required env: ${key}`)
	}
	return value
}

const WORKER_PATTERN = /^maple-((?:(?!-dev-).)+)-pr-(\d+)$/
const NEON_BRANCH_PATTERN = /^pr-(\d+)$/
const REPLAY_BUCKET_PATTERN = /^maple-replay-blobs-pr-(\d+)$/

interface WorkerScript {
	readonly id?: string
}

interface R2Bucket {
	readonly name?: string
}

interface R2Object {
	readonly key?: string
}

interface NeonBranch {
	readonly id?: string
	readonly name?: string
}

const cfRequest = async (
	token: string,
	path: string,
	init?: RequestInit,
): Promise<{ ok: boolean; status: number; result: unknown; errors: unknown }> => {
	const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			...init?.headers,
		},
	})
	const body = (await response.json().catch(() => ({}))) as {
		success?: boolean
		result?: unknown
		errors?: unknown
	}
	return {
		ok: response.ok && body.success !== false,
		status: response.status,
		result: body.result,
		errors: body.errors,
	}
}

const neonRequest = async (
	apiKey: string,
	path: string,
	init?: RequestInit,
): Promise<{ ok: boolean; status: number; body: unknown }> => {
	const response = await fetch(`https://console.neon.tech/api/v2${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
			...init?.headers,
		},
	})
	const body: unknown = await response.json().catch(() => ({}))
	return { ok: response.ok, status: response.status, body }
}

/** PR number → marker names found for it, for the log line. */
type Candidates = Map<string, string[]>

const addCandidate = (candidates: Candidates, prNumber: string, marker: string): void => {
	candidates.set(prNumber, [...(candidates.get(prNumber) ?? []), marker])
}

const listPreviewWorkers = async (token: string, accountId: string, candidates: Candidates) => {
	const listed = await cfRequest(token, `/accounts/${accountId}/workers/scripts`)
	if (!listed.ok) {
		fail(`Could not list Worker scripts (HTTP ${listed.status}): ${JSON.stringify(listed.errors)}`)
	}
	// A success response whose `result` isn't an array means the API shape
	// changed under us: fail loudly rather than green-no-op'ing the safety net.
	if (!Array.isArray(listed.result)) {
		fail(`Unexpected Worker list response shape (result is ${typeof listed.result}, expected array)`)
	}
	const scripts = listed.result as ReadonlyArray<WorkerScript>
	let matched = 0
	for (const script of scripts) {
		const match = WORKER_PATTERN.exec(script.id ?? "")
		if (!match) continue
		matched++
		addCandidate(candidates, match[2] as string, script.id as string)
	}
	console.log(`Found ${scripts.length} Worker script(s), ${matched} maple-*-pr-*`)
}

const listReplayBuckets = async (token: string, accountId: string, candidates: Candidates) => {
	const listed = await cfRequest(
		token,
		`/accounts/${accountId}/r2/buckets?name_contains=maple-replay-blobs-pr-&per_page=1000`,
	)
	if (!listed.ok) {
		fail(`Could not list R2 buckets (HTTP ${listed.status}): ${JSON.stringify(listed.errors)}`)
	}
	const buckets = (listed.result as { buckets?: unknown } | undefined)?.buckets
	if (!Array.isArray(buckets)) {
		fail(`Unexpected R2 bucket list response shape (result.buckets is ${typeof buckets}, expected array)`)
	}
	let matched = 0
	for (const bucket of buckets as ReadonlyArray<R2Bucket>) {
		const match = REPLAY_BUCKET_PATTERN.exec(bucket.name ?? "")
		if (!match) continue
		matched++
		addCandidate(candidates, match[1] as string, bucket.name as string)
	}
	console.log(`Found ${matched} maple-replay-blobs-pr-* R2 bucket(s)`)
}

const listNeonBranches = async (
	apiKey: string,
	projectId: string,
	candidates: Candidates,
): Promise<Map<string, string>> => {
	const listed = await neonRequest(apiKey, `/projects/${projectId}/branches`)
	if (!listed.ok) {
		fail(`Could not list Neon branches (HTTP ${listed.status}): ${JSON.stringify(listed.body)}`)
	}
	const branches = (listed.body as { branches?: ReadonlyArray<NeonBranch> }).branches
	if (!Array.isArray(branches)) {
		fail(`Unexpected Neon branch list response shape (branches is ${typeof branches}, expected array)`)
	}
	// PR number → branch id, for the delete after destroy.
	const branchIdByPr = new Map<string, string>()
	for (const branch of branches ?? []) {
		const match = NEON_BRANCH_PATTERN.exec(branch.name ?? "")
		if (!match || !branch.id) continue
		branchIdByPr.set(match[1] as string, branch.id)
		addCandidate(candidates, match[1] as string, `neon:${branch.name}`)
	}
	console.log(`Found ${branches?.length ?? 0} Neon branch(es), ${branchIdByPr.size} pr-*`)
	return branchIdByPr
}

const destroyStage = (prNumber: string): boolean => {
	const stage = `pr-${prNumber}`
	console.log(`… alchemy destroy --stage ${stage}`)
	const result = spawnSync(
		join(REPO_ROOT, "node_modules/.bin/alchemy"),
		["destroy", "--yes", "--stage", stage],
		{
			cwd: REPO_ROOT,
			env: { ...process.env, PR_NUMBER: prNumber },
			stdio: "inherit",
			timeout: DESTROY_TIMEOUT_MS,
		},
	)
	if (result.error) {
		console.log(`✗ alchemy destroy --stage ${stage} did not run: ${result.error.message}`)
		return false
	}
	if (result.status !== 0) {
		console.log(`✗ alchemy destroy --stage ${stage} exited ${result.status ?? result.signal}`)
		return false
	}
	return true
}

const deleteNeonBranch = async (apiKey: string, projectId: string, branchId: string): Promise<boolean> => {
	const removed = await neonRequest(apiKey, `/projects/${projectId}/branches/${branchId}`, {
		method: "DELETE",
	})
	if (!removed.ok && removed.status !== 404) {
		console.log(`✗ Neon branch delete failed (HTTP ${removed.status}): ${JSON.stringify(removed.body)}`)
		return false
	}
	return true
}

/** R2 refuses to delete a non-empty bucket, so delete objects page by page first. */
const emptyAndDeleteBucket = async (token: string, accountId: string, bucket: string): Promise<boolean> => {
	const objectsPath = `/accounts/${accountId}/r2/buckets/${bucket}/objects`
	let deleted = 0
	// Each pass re-lists from the start: deleted keys drop out, so no cursor is needed.
	for (let page = 0; page < 10_000; page++) {
		const listed = await cfRequest(token, `${objectsPath}?per_page=1000`)
		if (listed.status === 404) return true
		if (!listed.ok || !Array.isArray(listed.result)) {
			console.log(
				`✗ could not list objects in ${bucket} (HTTP ${listed.status}): ${JSON.stringify(listed.errors)}`,
			)
			return false
		}
		const keys = (listed.result as ReadonlyArray<R2Object>)
			.map((object) => object.key ?? "")
			.filter((key) => key.length > 0)
		if (keys.length === 0) break
		const removed = await cfRequest(token, objectsPath, { method: "DELETE", body: JSON.stringify(keys) })
		if (!removed.ok) {
			console.log(
				`✗ could not delete objects in ${bucket} (HTTP ${removed.status}): ${JSON.stringify(removed.errors)}`,
			)
			return false
		}
		deleted += keys.length
	}
	if (deleted > 0) console.log(`… deleted ${deleted} object(s) from ${bucket}`)
	const removed = await cfRequest(token, `/accounts/${accountId}/r2/buckets/${bucket}`, {
		method: "DELETE",
	})
	if (!removed.ok && removed.status !== 404) {
		console.log(`✗ bucket delete failed (HTTP ${removed.status}): ${JSON.stringify(removed.errors)}`)
		return false
	}
	return true
}

const main = async (): Promise<void> => {
	// Same guard as the sibling sweeps: without the PR-state gate every stage
	// resolves to "unknown" and the run green-no-ops forever.
	if (!hasPrStateCredentials()) {
		fail("sweep requires GITHUB_REPOSITORY and GITHUB_TOKEN (or GH_TOKEN) to check PR state")
	}
	const token = requireEnv("CLOUDFLARE_API_TOKEN")
	const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID")
	const neonApiKey = process.env.NEON_API_KEY?.trim()
	const neonProjectId = process.env.NEON_PROJECT_ID?.trim()
	if (DRY_RUN) console.log("Dry run: nothing will be destroyed or deleted")

	const candidates: Candidates = new Map()
	await listPreviewWorkers(token, accountId, candidates)
	await listReplayBuckets(token, accountId, candidates)
	let neonBranchIdByPr = new Map<string, string>()
	if (neonApiKey && neonProjectId) {
		neonBranchIdByPr = await listNeonBranches(neonApiKey, neonProjectId, candidates)
	} else {
		console.log("⚠ NEON_API_KEY / NEON_PROJECT_ID unset: skipping Neon branch discovery and cleanup")
	}

	const prNumbers = [...candidates.keys()].sort((a, b) => Number(a) - Number(b))
	console.log(`Candidate preview stage(s): ${prNumbers.map((n) => `pr-${n}`).join(", ") || "none"}`)

	const failures: string[] = []
	for (const prNumber of prNumbers) {
		const stage = `pr-${prNumber}`
		const markers = candidates.get(prNumber) ?? []
		const state = await fetchPrState(prNumber)
		if (state === "open") {
			console.log(`… keeping ${stage} (PR #${prNumber} is open)`)
			continue
		}
		if (state === "unknown") {
			console.log(`⚠ skipping ${stage} (PR #${prNumber} state unknown)`)
			continue
		}
		const bucket = markers.find((marker) => REPLAY_BUCKET_PATTERN.test(marker))
		const branchId = neonBranchIdByPr.get(prNumber)
		console.log(`… tearing down ${stage} (PR #${prNumber} is closed; found ${markers.join(", ")})`)
		if (DRY_RUN) {
			console.log(
				`  would destroy ${stage}${branchId ? `, delete Neon branch ${branchId}` : ""}${bucket ? `, empty and delete ${bucket}` : ""}`,
			)
			continue
		}
		if (!destroyStage(prNumber)) {
			// Keep the branch and bucket: they are how the next run finds this stage again.
			failures.push(stage)
			continue
		}
		if (branchId && neonApiKey && neonProjectId) {
			console.log(`… deleting Neon branch ${stage} (${branchId})`)
			if (!(await deleteNeonBranch(neonApiKey, neonProjectId, branchId))) {
				failures.push(`neon:${stage}`)
			}
		}
		if (bucket) {
			console.log(`… emptying and deleting R2 bucket ${bucket}`)
			if (!(await emptyAndDeleteBucket(token, accountId, bucket))) {
				failures.push(bucket)
			}
		}
	}

	if (failures.length > 0) {
		fail(`Failed to tear down orphan preview stage(s): ${failures.join(", ")}`)
	}
	console.log(DRY_RUN ? "✓ Dry run complete" : "✓ Sweep complete")
}

await main()
