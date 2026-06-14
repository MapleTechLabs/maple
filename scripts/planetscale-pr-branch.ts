#!/usr/bin/env bun
/**
 * Per-PR PlanetScale Postgres branch lifecycle for the PR-preview deploy.
 * Sibling of scripts/tinybird-pr-branch.ts with the same up/down contract.
 *
 *   bun scripts/planetscale-pr-branch.ts up   <pr-number>
 *   bun scripts/planetscale-pr-branch.ts down <pr-number>
 *
 * `up` creates (or reuses) an ephemeral PlanetScale branch `pr-<n>` (branches
 * are fully isolated Postgres databases, created EMPTY — exact parity with the
 * old per-PR empty D1), waits until it is ready, mints a branch credential,
 * and exports `MAPLE_PG_URL` (one connection string, direct 5432) to $GITHUB_ENV
 * — alchemy.run.ts parses it into the pr Hyperdrive origin, and the
 * `drizzle-kit migrate` workflow step uses it as-is.
 *
 * `down` deletes the branch (called on PR close, after `alchemy:destroy:pr`,
 * which removes the Hyperdrive config). Branch deletion also revokes its
 * credentials. PS-DEV branches bill for time used, so `down` on close is
 * mandatory.
 *
 * Auth: PLANETSCALE_SERVICE_TOKEN_ID / PLANETSCALE_SERVICE_TOKEN (the pscale
 * CLI reads both from the environment) + PLANETSCALE_ORG. The database name
 * comes from PLANETSCALE_DATABASE (default "maple").
 */
import { spawnSync } from "node:child_process"
import { appendFileSync } from "node:fs"

type Subcommand = "up" | "down"

const FAILURE = 1
const READY_TIMEOUT_MS = 10 * 60 * 1000
const READY_POLL_MS = 10_000

const fail = (message: string): never => {
	console.error(`✗ ${message}`)
	process.exit(FAILURE)
}

const parseArgs = (): { subcommand: Subcommand; branchName: string } => {
	const [, , rawSubcommand, rawPr] = process.argv
	if (rawSubcommand !== "up" && rawSubcommand !== "down") {
		fail(
			`Usage: bun scripts/planetscale-pr-branch.ts <up|down> <pr-number> (got "${rawSubcommand ?? ""}")`,
		)
	}
	const prNumber = (rawPr ?? "").trim()
	if (!/^\d+$/.test(prNumber)) {
		fail(`Expected a numeric PR number, got "${rawPr ?? ""}"`)
	}
	return { subcommand: rawSubcommand as Subcommand, branchName: `pr-${prNumber}` }
}

interface CliResult {
	readonly exitCode: number
	readonly stdout: string
	readonly stderr: string
}

const runPscale = (args: string[], opts?: { secret?: boolean }): CliResult => {
	// `--org` only when set; otherwise use the CLI's configured org (`pscale org switch`).
	const org = process.env.PLANETSCALE_ORG?.trim()
	const orgArgs = org ? ["--org", org] : []
	const proc = spawnSync("pscale", [...args, ...orgArgs], { encoding: "utf8" })
	if (proc.error) {
		fail(`Failed to invoke \`pscale\` — is the PlanetScale CLI installed? (${proc.error.message})`)
	}
	const stdout = (proc.stdout ?? "").trim()
	const stderr = (proc.stderr ?? "").trim()
	console.log(`$ pscale ${args.join(" ")}`)
	// `secret` suppresses stdout — credential JSON must never reach the CI log.
	if (!opts?.secret) {
		if (stdout) console.log(stdout)
		if (stderr) console.error(stderr)
	} else if (stderr) {
		console.error(stderr)
	}
	return { exitCode: proc.status ?? FAILURE, stdout, stderr }
}

const isAlreadyExists = (result: CliResult): boolean =>
	// PlanetScale's message is "Name has already been taken"; also tolerate other phrasings.
	/already exists|already been taken|name is taken|duplicate/i.test(`${result.stdout}\n${result.stderr}`)

const isNotFound = (result: CliResult): boolean =>
	/not found|does not exist/i.test(`${result.stdout}\n${result.stderr}`)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const waitUntilReady = async (database: string, branchName: string): Promise<void> => {
	const deadline = Date.now() + READY_TIMEOUT_MS
	while (Date.now() < deadline) {
		const show = runPscale(["branch", "show", database, branchName, "--format", "json"], { secret: true })
		if (show.exitCode === 0) {
			try {
				const parsed = JSON.parse(show.stdout) as { ready?: boolean; state?: string }
				if (parsed.ready === true || parsed.state === "ready") {
					console.log(`✓ Branch ${branchName} is ready`)
					return
				}
				console.log(`… branch ${branchName} not ready yet (state=${parsed.state ?? "unknown"})`)
			} catch {
				console.log("… could not parse branch state; retrying")
			}
		}
		await sleep(READY_POLL_MS)
	}
	fail(`Timed out waiting for branch ${branchName} to become ready`)
}

interface BranchCredential {
	readonly host: string
	readonly username: string
	readonly password: string
	/** Ready-made connection URL (connect dbname is `postgres`, not the PS resource name). */
	readonly url: string
}

/**
 * Mint a Postgres ROLE for the preview branch (`pscale password` is Vitess-only).
 * The CI credential runs migrations (DDL) AND backs the preview app, so it
 * inherits `postgres`. The branch is deleted on PR close, which revokes the
 * role — but a TTL is a safety net in case `down` never runs. JSON field names
 * have drifted across CLI releases, so accept the known spellings.
 */
const createCredential = (database: string, branchName: string): BranchCredential => {
	// Unique per run — the branch is reused across PR pushes, so a fixed role
	// name would collide on the second synchronize. Roles carry a 24h TTL and
	// are revoked when the branch is deleted on PR close.
	const roleName = `ci-${branchName}-${process.pid}-${Date.now()}`
	const result = runPscale(
		[
			"role",
			"create",
			database,
			branchName,
			roleName,
			"--inherited-roles",
			"postgres",
			"--ttl",
			"24h",
			"--format",
			"json",
		],
		{ secret: true },
	)
	if (result.exitCode !== 0) {
		fail(`Could not mint a role for branch ${branchName}`)
	}
	let parsed: Record<string, unknown>
	try {
		parsed = JSON.parse(result.stdout) as Record<string, unknown>
	} catch {
		return fail("Could not parse `pscale role create --format json` output")
	}
	const pick = (...keys: string[]): string | undefined => {
		for (const key of keys) {
			const value = parsed[key]
			if (typeof value === "string" && value.length > 0) return value
		}
		return undefined
	}
	const host = pick("access_host_url", "host", "hostname")
	const username = pick("username", "user", "name")
	const password = pick("plain_text", "password", "plaintext")
	if (!host || !username || !password) {
		return fail(`role JSON missing connection fields (got keys: ${Object.keys(parsed).join(", ")})`)
	}
	// Connect-time dbname is `postgres` (cluster default), NOT the PS resource
	// name — prefer the URL the CLI returns, else build one with dbname=postgres.
	const url =
		pick("database_url", "connection_string") ??
		`postgres://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:5432/postgres?sslmode=verify-full`
	return { host, username, password, url }
}

const maskAndExport = (entries: Record<string, string>, secrets: ReadonlyArray<string>) => {
	for (const secret of secrets) {
		console.log(`::add-mask::${secret}`)
	}
	const githubEnv = process.env.GITHUB_ENV
	if (!githubEnv) {
		fail("GITHUB_ENV is not set — this script is meant to run in GitHub Actions")
	}
	const lines = Object.entries(entries)
		.map(([key, value]) => `${key}=${value}`)
		.join("\n")
	appendFileSync(githubEnv as string, `${lines}\n`)
	console.log(`✓ Exported ${Object.keys(entries).join(", ")} to GITHUB_ENV`)
}

const main = async () => {
	const { subcommand, branchName } = parseArgs()
	const database = process.env.PLANETSCALE_DATABASE?.trim() || "maple"

	if (subcommand === "up") {
		const create = runPscale(["branch", "create", database, branchName, "--wait"])
		if (create.exitCode !== 0 && !isAlreadyExists(create)) {
			fail(`Failed to create branch ${branchName}`)
		}
		await waitUntilReady(database, branchName)

		const credential = createCredential(database, branchName)
		// One connection string — alchemy.run.ts parses it into the Hyperdrive
		// origin, the migrate step + scripts use it as-is.
		maskAndExport({ MAPLE_PG_URL: credential.url }, [credential.password])
		return
	}

	const remove = runPscale(["branch", "delete", database, branchName, "--force"])
	if (remove.exitCode !== 0 && !isNotFound(remove)) {
		fail(`Failed to delete branch ${branchName}`)
	}
	console.log(`✓ Branch ${branchName} removed (or already gone)`)
}

await main()
