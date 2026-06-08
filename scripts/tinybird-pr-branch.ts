#!/usr/bin/env bun
/**
 * Per-PR Tinybird branch lifecycle for the PR-preview deploy.
 *
 *   bun scripts/tinybird-pr-branch.ts up   <pr-number>
 *   bun scripts/tinybird-pr-branch.ts down <pr-number>
 *
 * `up` creates (or reuses) an ephemeral Tinybird branch `pr_<n>` seeded with the
 * latest production partition (`--last-partition`), deploys this PR's project
 * schema into it, then exports the branch's TINYBIRD_HOST / TINYBIRD_TOKEN to
 * $GITHUB_ENV so the subsequent `alchemy:deploy:pr` binds the whole preview stack
 * (api/web/alerting/chat-agent + Rust ingest) to the branch instead of prod.
 *
 * `down` removes the branch (called on PR close, after `alchemy:destroy:pr`).
 *
 * Auth: the PARENT (prod) workspace host+token arrive via the incoming
 * TINYBIRD_HOST / TINYBIRD_TOKEN (Doppler `pr` config). We use them to drive the
 * `tb` CLI for branch ops, then overwrite the same two vars with the branch's
 * values. `tb` is invoked flag-first (`--cloud --host --token`), matching
 * .github/workflows/tinybird-ci.yml — no `.tinyb` state needed.
 *
 * Branches share compute with production (Tinybird limitation), so `down` on PR
 * close is mandatory to avoid branch sprawl.
 */
import { spawnSync } from "node:child_process"
import { appendFileSync } from "node:fs"

type Subcommand = "up" | "down"

const FAILURE = 1

const parseArgs = (): { subcommand: Subcommand; branchName: string; prNumber: string } => {
	const [, , rawSubcommand, rawPr] = process.argv
	if (rawSubcommand !== "up" && rawSubcommand !== "down") {
		fail(`Usage: bun scripts/tinybird-pr-branch.ts <up|down> <pr-number> (got "${rawSubcommand ?? ""}")`)
	}
	// PR numbers are digits only; this is also the only untrusted input that ends
	// up in a branch name, so keep it strictly numeric.
	const prNumber = (rawPr ?? "").trim()
	if (!/^\d+$/.test(prNumber)) {
		fail(`Expected a numeric PR number, got "${rawPr ?? ""}"`)
	}
	return { subcommand: rawSubcommand, branchName: `pr_${prNumber}`, prNumber }
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
 * Run a `tb` command with the right environment + auth flags prepended. Returns
 * the captured output; never throws (callers decide how to treat failures).
 *
 * `--cloud` and `--branch` are mutually exclusive environment flags, so:
 *  - workspace-level ops (branch create/rm) use `--cloud`;
 *  - branch-scoped ops (deploy, token) use `--branch=<name>` instead.
 * Auth flags (`--host`/`--token`) apply to both.
 */
const runTb = (
	parent: { host: string; token: string },
	args: string[],
	opts?: { branch?: string },
): TbResult => {
	const envFlag = opts?.branch ? `--branch=${opts.branch}` : "--cloud"
	const proc = spawnSync(
		"tb",
		[envFlag, "--host", parent.host, "--token", parent.token, ...args],
		{ encoding: "utf8" },
	)
	if (proc.error) {
		fail(`Failed to invoke \`tb\` — is the Tinybird CLI installed? (${proc.error.message})`)
	}
	const stdout = (proc.stdout ?? "").trim()
	const stderr = (proc.stderr ?? "").trim()
	// Log the env flag + subcommand only — never the auth flags/token.
	console.log(`$ tb ${envFlag} ${args.join(" ")}`)
	if (stdout) console.log(stdout)
	if (stderr) console.error(stderr)
	return { exitCode: proc.status ?? FAILURE, stdout, stderr }
}

const isAlreadyExists = (result: TbResult): boolean =>
	/already exist|already a branch|duplicated|name is taken/i.test(`${result.stdout}\n${result.stderr}`)

const isNotFound = (result: TbResult): boolean =>
	/not found|does not exist|no branch|unknown branch/i.test(`${result.stdout}\n${result.stderr}`)

/**
 * Resolve the branch's admin token name. Token names mirror the workspace, so the
 * branch carries an "admin*" token. Allow an explicit override for CLIs whose
 * `token ls` formatting the heuristic can't parse.
 */
const resolveAdminTokenName = (parent: { host: string; token: string }, branchName: string): string => {
	const override = process.env.TB_BRANCH_ADMIN_TOKEN_NAME?.trim()
	if (override) return override

	const listed = runTb(parent, ["token", "ls"], { branch: branchName })
	if (listed.exitCode !== 0) {
		fail(`Could not list tokens for branch ${branchName}. Set TB_BRANCH_ADMIN_TOKEN_NAME to pin it.`)
	}
	// Token names appear in the listing; prefer the workspace admin token. Match
	// the conventional names ("admin token", "admin <email>") case-insensitively.
	const match = listed.stdout.match(/admin(?: token| [^\s]+@[^\s]+|[^\n]*)/i)
	if (!match) {
		fail(
			`No admin token found in branch ${branchName} token listing. ` +
				`Set TB_BRANCH_ADMIN_TOKEN_NAME to the exact token name.`,
		)
	}
	return match[0].trim()
}

const copyBranchToken = (
	parent: { host: string; token: string },
	branchName: string,
	tokenName: string,
): string => {
	const copied = runTb(parent, ["token", "copy", tokenName], { branch: branchName })
	if (copied.exitCode !== 0 || !copied.stdout) {
		fail(`Failed to copy token "${tokenName}" from branch ${branchName}.`)
	}
	// `token copy` prints the raw token value; take the last non-empty line so any
	// preamble the CLI emits is ignored.
	const lines = copied.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
	const value = lines.at(-1)
	if (!value) {
		fail(`Empty token value returned for "${tokenName}" on branch ${branchName}.`)
	}
	return value as string
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

const up = (branchName: string): void => {
	const parent = { host: requireEnv("TINYBIRD_HOST"), token: requireEnv("TINYBIRD_TOKEN") }

	// 1. Create the branch with the latest production partition. Idempotent across
	//    `synchronize` events: a pre-existing branch is fine.
	const created = runTb(parent, ["branch", "create", branchName, "--last-partition"])
	if (created.exitCode !== 0 && !isAlreadyExists(created)) {
		fail(`Failed to create Tinybird branch ${branchName}.`)
	}

	// 2. Deploy this PR's datasources/MVs into the branch. The branch is ephemeral,
	//    so destructive schema iteration is acceptable.
	const deployed = runTb(parent, ["deploy", "--allow-destructive-operations"], { branch: branchName })
	if (deployed.exitCode !== 0) {
		fail(`Failed to deploy project schema to Tinybird branch ${branchName}.`)
	}

	// 3. Resolve the branch's admin token (read + append scopes) for the workers.
	const tokenName = resolveAdminTokenName(parent, branchName)
	const branchToken = copyBranchToken(parent, branchName, tokenName)

	// Mask the token in CI logs before it can appear anywhere downstream.
	console.log(`::add-mask::${branchToken}`)

	// 4. Hand the branch creds to the rest of the workflow. The branch is reached on
	//    the same regional host as its parent — the branch-scoped token does the
	//    routing — so only the token changes.
	exportToGithubEnv({ TINYBIRD_HOST: parent.host, TINYBIRD_TOKEN: branchToken })
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

const { subcommand, branchName } = parseArgs()
if (subcommand === "up") {
	up(branchName)
} else {
	down(branchName)
}
