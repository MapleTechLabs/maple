#!/usr/bin/env bun
/**
 * Per-PR Tinybird branch lifecycle for the PR-preview deploy.
 *
 *   bun scripts/tinybird-pr-branch.ts create <pr-number> <handoff-file>   (trusted)
 *   bun scripts/tinybird-pr-branch.ts deploy <pr-number> <handoff-file>   (PR job)
 *   bun scripts/tinybird-pr-branch.ts down   <pr-number>                  (trusted)
 *   bun scripts/tinybird-pr-branch.ts sweep                               (maintenance)
 *
 * The parent workspace credentials never reach a job that runs PR code.
 * `create` and `down` run in preview-tinybird-branch.yml, which executes main's
 * workflow and code only. `create` creates (or reuses) an EMPTY branch `pr_<n>` and
 * writes the branch's host, id and token to `<handoff-file>`, sealed with
 * PREVIEW_HANDOFF_KEY (AES-256-GCM, bound to the branch name). The PR deploy job
 * opens it with `deploy`, which deploys this PR's schema into the branch and exports
 * the branch's TINYBIRD_HOST / TINYBIRD_TOKEN / TINYBIRD_SIGNING_KEY /
 * TINYBIRD_WORKSPACE_ID to $GITHUB_ENV, so `alchemy:deploy:pr` binds the preview to it.
 *
 * `sweep` removes every `pr_<n>` branch whose PR is already closed. The
 * close-event teardown is best-effort only (GitHub creates no `closed` run for
 * conflicted PRs; post-close redeploys recreate resources), so the scheduled
 * cleanup-preview-orphans workflow runs `sweep` as the safety net.
 *
 * Auth: `create`, `down` and `sweep` take the PARENT workspace host+token from
 * TINYBIRD_HOST / TINYBIRD_TOKEN. Every `tb` call is `--cloud --host --token`,
 * never `--branch=`: the CLI resolves that flag through the user-workspaces
 * endpoint, which lists branches only for a human login token, so under a
 * workspace token every branch is "not found". Branch-scoped work runs `--cloud`
 * with the branch's own admin token, read from the environments API.
 *
 * Branches share compute with production (Tinybird limitation), so `down` on PR
 * close is mandatory to avoid branch sprawl.
 */
import { spawnSync } from "node:child_process"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { fetchPreviewState, hasPrStateCredentials } from "./lib/pr-state.ts"
import { openHandoff, sealHandoff } from "./lib/preview-handoff.ts"

type Subcommand = "create" | "deploy" | "down" | "sweep"

const FAILURE = 1

const parseArgs = (): {
	subcommand: Subcommand
	branchName: string
	prNumber: string
	handoffFile: string
} => {
	const [, , rawSubcommand, rawPr, rawFile] = process.argv
	if (
		rawSubcommand !== "create" &&
		rawSubcommand !== "deploy" &&
		rawSubcommand !== "down" &&
		rawSubcommand !== "sweep"
	) {
		fail(
			`Usage: bun scripts/tinybird-pr-branch.ts <create|deploy> <pr-number> <handoff-file> | down <pr-number> | sweep (got "${rawSubcommand ?? ""}")`,
		)
	}
	if (rawSubcommand === "sweep") {
		return { subcommand: "sweep", branchName: "", prNumber: "", handoffFile: "" }
	}
	// PR numbers are digits only; this is also the only untrusted input that ends
	// up in a branch name, so keep it strictly numeric.
	const prNumber = (rawPr ?? "").trim()
	if (!/^\d+$/.test(prNumber)) {
		fail(`Expected a numeric PR number, got "${rawPr ?? ""}"`)
	}
	const handoffFile = (rawFile ?? "").trim()
	if (rawSubcommand !== "down" && !handoffFile) {
		fail(`${rawSubcommand} needs a handoff file path`)
	}
	return {
		subcommand: rawSubcommand as Subcommand,
		branchName: `pr_${prNumber}`,
		prNumber,
		handoffFile,
	}
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
 * The branch's id and admin token, from the environments API: each entry carries
 * the branch's own `token`, and the workspace admin token may read the list.
 * `tb token ls --branch=…` used to do this, but see the auth note above.
 */
const resolveBranch = async (
	parent: { host: string; token: string },
	branchName: string,
): Promise<{ id: string; token: string }> => {
	const response = await fetch(`${parent.host}/v1/environments`, {
		headers: { Authorization: `Bearer ${parent.token}` },
	})
	if (!response.ok) {
		fail(`Could not list Tinybird branches (HTTP ${response.status}).`)
	}
	const parsed = (await response.json()) as {
		environments?: { id?: string; name?: string; token?: string }[]
	}
	const entry = parsed.environments?.find((candidate) => candidate.name === branchName)
	const id = entry?.id?.trim()
	const token = entry?.token?.trim()
	if (!id || !token) {
		fail(`Branch ${branchName} is not in the environments list, or has no id or token.`)
	}
	return { id: id as string, token: token as string }
}

/**
 * The branch's "workspace admin token". Tinybird verifies self-signed JWTs only against
 * that token; the environments list hands out a per-user admin token, which it rejects.
 */
const resolveSigningKey = async (
	branch: { host: string; token: string },
	branchName: string,
): Promise<string> => {
	const response = await fetch(`${branch.host}/v0/tokens`, {
		headers: { Authorization: `Bearer ${branch.token}` },
	})
	if (!response.ok)
		fail(`Could not list Tinybird tokens for branch ${branchName} (HTTP ${response.status}).`)
	const parsed = (await response.json()) as {
		tokens?: { name?: string; token?: string; scopes?: { type?: string }[] }[]
	}
	const admin = parsed.tokens?.find(
		(candidate) =>
			candidate.name === "workspace admin token" &&
			candidate.scopes?.some((scope) => scope.type === "ADMIN"),
	)
	const token = admin?.token?.trim()
	if (!token) fail(`Branch ${branchName} has no workspace admin token to sign raw-SQL JWTs with.`)
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

/** Trusted side: create the branch with the parent credentials and seal its own for the PR job. */
const create = async (branchName: string, handoffFile: string): Promise<void> => {
	const parent = { host: requireEnv("TINYBIRD_HOST"), token: requireEnv("TINYBIRD_TOKEN") }

	// Created EMPTY. Idempotent across `synchronize` events: a pre-existing branch is fine.
	//
	// Deliberately no `--last-partition`: that attached the latest production
	// partition of every datasource, which put live customer telemetry in an
	// environment anyone with the preview URL can read, kept only until a
	// best-effort teardown removed it. A preview that needs rows seeds its own
	// — see docs/tinybird-pr-branches.md § Getting data in.
	const created = runTb(parent, ["branch", "create", branchName])
	if (created.exitCode !== 0 && !isAlreadyExists(created)) {
		fail(`Failed to create Tinybird branch ${branchName}.`)
	}

	const { id, token } = await resolveBranch(parent, branchName)
	console.log(`::add-mask::${token}`)
	// The branch is reached on the same regional host as its parent: the
	// branch-scoped token does the routing, so only the token changes.
	const sealed = await sealHandoff(requireEnv("PREVIEW_HANDOFF_KEY"), branchName, { host: parent.host, id, token })
	writeFileSync(handoffFile, sealed, { mode: 0o600 })
	console.log(`✓ Tinybird branch ${branchName} ready; sealed its credentials for the deploy job.`)
}

/** PR side: deploy this PR's schema into the branch, then bind the rest of the job to it. */
const deploy = async (branchName: string, handoffFile: string): Promise<void> => {
	const handoff = await openHandoff(requireEnv("PREVIEW_HANDOFF_KEY"), branchName, readFileSync(handoffFile, "utf8"))
	if (!handoff) {
		return fail(`The Tinybird handoff for ${branchName} did not open: wrong key, wrong PR or damaged.`)
	}
	// Mask the tokens in CI logs before they can appear anywhere downstream.
	console.log(`::add-mask::${handoff.token}`)
	const branch = { host: handoff.host, token: handoff.token }

	// The branch is ephemeral, so destructive schema iteration is acceptable.
	const { writeTinybirdDatafiles } = await import("./write-tinybird-datafiles")
	writeTinybirdDatafiles()
	const deployed = runTb(branch, ["deploy", "--allow-destructive-operations"])
	if (deployed.exitCode !== 0) {
		fail(`Failed to deploy project schema to Tinybird branch ${branchName}.`)
	}

	const signingKey = await resolveSigningKey(branch, branchName)
	console.log(`::add-mask::${signingKey}`)

	// Raw-SQL JWTs are signed with the branch's workspace admin token and name the
	// branch, or they would query the parent.
	exportToGithubEnv({
		TINYBIRD_HOST: branch.host,
		TINYBIRD_TOKEN: branch.token,
		TINYBIRD_SIGNING_KEY: signingKey,
		TINYBIRD_WORKSPACE_ID: handoff.id,
	})
	console.log(`✓ Tinybird branch ${branchName} deployed; preview stack will bind to it.`)
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
 * Remove every `pr_<n>` branch whose PR is closed or lost its `preview` label. `tb branch ls` prints a
 * human-readable table (no JSON mode), so candidate names are extracted by the
 * exact `pr_<digits>` token shape — `main` and any other branch name are never
 * candidates. Branches whose PR state cannot be determined are skipped
 * (deleting on uncertainty risks tearing down a live preview).
 */
const sweep = async (): Promise<void> => {
	// The PR-state lookup is the sweep's only guard against deleting a LIVE
	// preview; without a token every branch resolves to "unknown" and the run
	// green-no-ops forever. Fail loudly instead — this is the safety net.
	if (!hasPrStateCredentials()) {
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
				{ name: match[0], prNumber: match[1] },
			]),
		).values(),
	]
	console.log(
		`Found ${candidates.length} pr_* branch(es): ${candidates.map((c) => c.name).join(", ") || "—"}`,
	)

	const failures: string[] = []
	for (const candidate of candidates) {
		const state = await fetchPreviewState(candidate.prNumber)
		if (state === "live") {
			console.log(`… keeping ${candidate.name} (PR #${candidate.prNumber} has a live preview)`)
			continue
		}
		if (state === "unknown") {
			console.log(`⚠ skipping ${candidate.name} (PR #${candidate.prNumber} state unknown)`)
			continue
		}
		console.log(`… deleting orphan ${candidate.name} (PR #${candidate.prNumber} is closed or unlabelled)`)
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

const { subcommand, branchName, handoffFile } = parseArgs()
if (subcommand === "create") {
	await create(branchName, handoffFile)
} else if (subcommand === "deploy") {
	await deploy(branchName, handoffFile)
} else if (subcommand === "sweep") {
	await sweep()
} else {
	down(branchName)
}
