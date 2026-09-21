#!/usr/bin/env bun
/**
 * Per-PR Tinybird branch lifecycle for the PR-preview deploy.
 *
 *   bun scripts/tinybird-pr-branch.ts up    <pr-number>
 *   bun scripts/tinybird-pr-branch.ts down  <pr-number>
 *   bun scripts/tinybird-pr-branch.ts sweep
 *
 * `up` creates (or reuses) an EMPTY ephemeral Tinybird branch `pr_<n>`, deploys
 * this PR's project schema into it, then exports the branch's TINYBIRD_HOST / TINYBIRD_TOKEN to
 * $GITHUB_ENV so the subsequent `alchemy:deploy:pr` binds the whole preview stack
 * (api/web/alerting/chat-agent + Rust ingest) to the branch instead of prod.
 *
 * `down` removes the branch (called on PR close, after `alchemy:destroy:pr`).
 *
 * `sweep` removes every `pr_<n>` branch whose PR is already closed. The
 * close-event teardown is best-effort only (GitHub creates no `closed` run for
 * conflicted PRs; close runs execute the PR branch's own old workflow version;
 * post-close redeploys recreate resources) — the scheduled
 * cleanup-preview-orphans workflow runs `sweep` as the safety net, mirroring
 * scripts/planetscale-pr-branch.ts.
 *
 * Auth: the PARENT (prod) workspace host+token arrive via the incoming
 * TINYBIRD_HOST / TINYBIRD_TOKEN (Infisical `dev` environment). They drive the
 * `tb` CLI for branch ops, then the same two vars are overwritten with the
 * branch's values. Every `tb` call is `--cloud --host --token`, never `--branch=`:
 * the CLI resolves that flag through the user-workspaces endpoint, which lists
 * branches only for a human login token, so under a workspace token every
 * branch is "not found". Branch-scoped work runs `--cloud` with the branch's own
 * admin token, read from the environments API.
 *
 * Branches share compute with production (Tinybird limitation), so `down` on PR
 * close is mandatory to avoid branch sprawl.
 */
import { spawnSync } from "node:child_process"
import { appendFileSync } from "node:fs"

type Subcommand = "up" | "down" | "sweep"

const FAILURE = 1

const parseArgs = (): { subcommand: Subcommand; branchName: string; prNumber: string } => {
	const [, , rawSubcommand, rawPr] = process.argv
	if (rawSubcommand !== "up" && rawSubcommand !== "down" && rawSubcommand !== "sweep") {
		fail(
			`Usage: bun scripts/tinybird-pr-branch.ts <up|down> <pr-number> | sweep (got "${rawSubcommand ?? ""}")`,
		)
	}
	if (rawSubcommand === "sweep") {
		return { subcommand: "sweep", branchName: "", prNumber: "" }
	}
	// PR numbers are digits only; this is also the only untrusted input that ends
	// up in a branch name, so keep it strictly numeric.
	const prNumber = (rawPr ?? "").trim()
	if (!/^\d+$/.test(prNumber)) {
		fail(`Expected a numeric PR number, got "${rawPr ?? ""}"`)
	}
	return { subcommand: rawSubcommand as Subcommand, branchName: `pr_${prNumber}`, prNumber }
}

const fail = (message: string): never => {
	console.error(`✗ ${message}`)
	process.exit(FAILURE)
}

const requireEnv = (key: string): string => {
	const value = process.env[key]?.trim()
	if (!value) {
		fail(`Missing required env: ${key}`)
	}
	return value as string
}

interface TbResult {
	readonly exitCode: number
	readonly stdout: string
	readonly stderr: string
}

/**
 * Run a `tb` command against Tinybird Cloud as `auth`. Returns the captured
 * output; never throws (callers decide how to treat failures).
 */
const runTb = (
	auth: { host: string; token: string },
	args: string[],
	opts?: { secret?: boolean },
): TbResult => {
	const proc = spawnSync("tb", ["--cloud", "--host", auth.host, "--token", auth.token, ...args], {
		encoding: "utf8",
		// tinybird.json resolves `${TINYBIRD_TOKEN}` while generating resources, so
		// the env token has to match the workspace the command targets.
		env: { ...process.env, TINYBIRD_HOST: auth.host, TINYBIRD_TOKEN: auth.token },
	})
	if (proc.error) {
		fail(`Failed to invoke \`tb\` — is the Tinybird CLI installed? (${proc.error.message})`)
	}
	const stdout = (proc.stdout ?? "").trim()
	const stderr = (proc.stderr ?? "").trim()
	// Log the subcommand only — never the auth flags/token.
	console.log(`$ tb --cloud ${args.join(" ")}`)
	// `secret` suppresses the captured output entirely, for anything that could
	// print a token value.
	if (!opts?.secret) {
		if (stdout) console.log(stdout)
		if (stderr) console.error(stderr)
	}
	return { exitCode: proc.status ?? FAILURE, stdout, stderr }
}

const isAlreadyExists = (result: TbResult): boolean =>
	/already (exist|being used)|already a branch|duplicated|name is taken|names should be unique|select another name/i.test(
		`${result.stdout}\n${result.stderr}`,
	)

const isNotFound = (result: TbResult): boolean =>
	/not found|does not exist|no branch|unknown branch/i.test(`${result.stdout}\n${result.stderr}`)

/**
 * The branch's admin token, from the environments API: each entry carries the
 * branch's own `token`, and the workspace admin token may read the list.
 * `tb token ls --branch=…` used to do this, but see the auth note above.
 */
const resolveBranchAdminToken = async (
	parent: { host: string; token: string },
	branchName: string,
): Promise<string> => {
	const response = await fetch(`${parent.host}/v1/environments`, {
		headers: { Authorization: `Bearer ${parent.token}` },
	})
	if (!response.ok) {
		fail(`Could not list Tinybird branches (HTTP ${response.status}).`)
	}
	const parsed = (await response.json()) as { environments?: { name?: string; token?: string }[] }
	const token = parsed.environments?.find((entry) => entry.name === branchName)?.token?.trim()
	if (!token) {
		fail(`Branch ${branchName} is not in the environments list, or has no token.`)
	}
	return token as string
}

const exportToGithubEnv = (vars: Record<string, string>): void => {
	const githubEnv = process.env.GITHUB_ENV?.trim()
	const lines = Object.entries(vars).map(([key, value]) => `${key}=${value}`)
	if (!githubEnv) {
		// Local run: just print so a developer can copy them.
		console.log("\nResolved branch env (GITHUB_ENV unset — printing instead):")
		for (const line of lines) console.log(`  ${line}`)
		return
	}
	appendFileSync(githubEnv, `${lines.join("\n")}\n`)
}

const up = async (branchName: string): Promise<void> => {
	const parent = { host: requireEnv("TINYBIRD_HOST"), token: requireEnv("TINYBIRD_TOKEN") }

	// 1. Create the branch EMPTY. Idempotent across `synchronize` events: a
	//    pre-existing branch is fine.
	//
	//    Deliberately no `--last-partition`: that attached the latest production
	//    partition of every datasource, which put live customer telemetry in an
	//    environment anyone with the preview URL can read, kept only until a
	//    best-effort teardown removed it. A preview that needs rows seeds its own
	//    — see docs/tinybird-pr-branches.md § Getting data in.
	const created = runTb(parent, ["branch", "create", branchName])
	if (created.exitCode !== 0 && !isAlreadyExists(created)) {
		fail(`Failed to create Tinybird branch ${branchName}.`)
	}

	// 2. The branch's admin token (read + append scopes): the deploy below runs as
	//    the branch, and the workers bind to it afterwards.
	const branch = { host: parent.host, token: await resolveBranchAdminToken(parent, branchName) }

	// 3. Deploy this PR's datasources/MVs into the branch. The branch is ephemeral,
	//    so destructive schema iteration is acceptable.
	const deployed = runTb(branch, ["deploy", "--allow-destructive-operations"])
	if (deployed.exitCode !== 0) {
		fail(`Failed to deploy project schema to Tinybird branch ${branchName}.`)
	}

	// Mask the token in CI logs before it can appear anywhere downstream.
	console.log(`::add-mask::${branch.token}`)

	// 4. Hand the branch creds to the rest of the workflow. The branch is reached on
	//    the same regional host as its parent — the branch-scoped token does the
	//    routing — so only the token changes.
	exportToGithubEnv({ TINYBIRD_HOST: branch.host, TINYBIRD_TOKEN: branch.token })
	console.log(`✓ Tinybird branch ${branchName} ready; preview stack will bind to it.`)
}

const down = (branchName: string): void => {
	const parent = { host: requireEnv("TINYBIRD_HOST"), token: requireEnv("TINYBIRD_TOKEN") }
	const removed = runTb(parent, ["branch", "rm", branchName, "--yes"])
	if (removed.exitCode !== 0 && !isNotFound(removed)) {
		fail(`Failed to remove Tinybird branch ${branchName}.`)
	}
	console.log(`✓ Tinybird branch ${branchName} removed (or already gone).`)
}

/**
 * PR state via the GitHub REST API. Returns "unknown" when no token/repo is
 * available (local runs) or the API call fails — callers must treat "unknown"
 * as "don't block", never as "closed". Same contract as
 * scripts/planetscale-pr-branch.ts.
 */
const fetchPrState = async (prNumber: string): Promise<"open" | "closed" | "unknown"> => {
	const repo = process.env.GITHUB_REPOSITORY?.trim()
	const token = (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN)?.trim()
	if (!repo || !token) return "unknown"
	try {
		const response = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		})
		if (!response.ok) {
			console.log(`⚠ Could not look up PR #${prNumber} state (HTTP ${response.status})`)
			return "unknown"
		}
		const parsed = (await response.json()) as { state?: string }
		return parsed.state === "open" ? "open" : parsed.state === "closed" ? "closed" : "unknown"
	} catch (error) {
		console.log(
			`⚠ Could not look up PR #${prNumber} state (${error instanceof Error ? error.message : String(error)})`,
		)
		return "unknown"
	}
}

/**
 * Remove every `pr_<n>` branch whose PR is closed. `tb branch ls` prints a
 * human-readable table (no JSON mode), so candidate names are extracted by the
 * exact `pr_<digits>` token shape — `main` and any other branch name are never
 * candidates. Branches whose PR state cannot be determined are skipped
 * (deleting on uncertainty risks tearing down a live preview).
 */
const sweep = async (): Promise<void> => {
	// The PR-state lookup is the sweep's only guard against deleting a LIVE
	// preview; without a token every branch resolves to "unknown" and the run
	// green-no-ops forever. Fail loudly instead — this is the safety net.
	if (
		!process.env.GITHUB_REPOSITORY?.trim() ||
		!(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN)?.trim()
	) {
		fail("sweep requires GITHUB_REPOSITORY and GITHUB_TOKEN (or GH_TOKEN) to check PR state")
	}
	const parent = { host: requireEnv("TINYBIRD_HOST"), token: requireEnv("TINYBIRD_TOKEN") }
	const listed = runTb(parent, ["branch", "ls"])
	if (listed.exitCode !== 0) {
		fail("Failed to list Tinybird branches.")
	}
	const candidates = [
		...new Map(
			[...listed.stdout.matchAll(/\bpr_(\d+)\b/g)].map((match) => [
				match[0],
				{ name: match[0], prNumber: match[1] as string },
			]),
		).values(),
	]
	console.log(
		`Found ${candidates.length} pr_* branch(es): ${candidates.map((c) => c.name).join(", ") || "—"}`,
	)

	const failures: string[] = []
	for (const candidate of candidates) {
		const state = await fetchPrState(candidate.prNumber)
		if (state === "open") {
			console.log(`… keeping ${candidate.name} (PR #${candidate.prNumber} is open)`)
			continue
		}
		if (state === "unknown") {
			console.log(`⚠ skipping ${candidate.name} (PR #${candidate.prNumber} state unknown)`)
			continue
		}
		console.log(`… deleting orphan ${candidate.name} (PR #${candidate.prNumber} is closed)`)
		const removed = runTb(parent, ["branch", "rm", candidate.name, "--yes"])
		if (removed.exitCode !== 0 && !isNotFound(removed)) {
			failures.push(candidate.name)
		}
	}
	if (failures.length > 0) {
		fail(`Failed to remove orphan branch(es): ${failures.join(", ")}`)
	}
	console.log("✓ Sweep complete")
}

const { subcommand, branchName } = parseArgs()
if (subcommand === "up") {
	await up(branchName)
} else if (subcommand === "sweep") {
	await sweep()
} else {
	down(branchName)
}
