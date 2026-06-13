#!/usr/bin/env bun
/**
 * Shared PlanetScale-CLI credential broker for the schema-apply and data-migrate
 * scripts. PlanetScale Postgres has no local proxy (unlike the MySQL
 * `pscale connect` flow) — you connect directly with a minted credential over
 * TLS. So `withBranchConnection` mints an EPHEMERAL password for the target
 * branch via `pscale`, hands a direct (port 5432, sslmode=require) connection
 * URL to the callback, and revokes the password afterward so nothing lingers.
 *
 * Auth + targeting (read by the `pscale` CLI from the environment):
 *   PLANETSCALE_ORG                          required — the PlanetScale org slug
 *   PLANETSCALE_DATABASE                     optional — defaults to "maple"
 *   PLANETSCALE_SERVICE_TOKEN_ID / _TOKEN    optional — non-interactive CI auth
 *                                            (otherwise an interactive `pscale auth login` session is used)
 */
import { spawnSync } from "node:child_process"

const FAILURE = 1

export const fail = (message: string): never => {
	console.error(`✗ ${message}`)
	process.exit(FAILURE)
}

// `--org` is appended only when PLANETSCALE_ORG is set; otherwise the `pscale`
// CLI uses its configured default org (`pscale org switch <org>`).
const orgArgs = (): string[] => {
	const value = process.env.PLANETSCALE_ORG?.trim()
	return value ? ["--org", value] : []
}

export const resolveDatabase = (): string => process.env.PLANETSCALE_DATABASE?.trim() || "maple"

interface CliResult {
	readonly exitCode: number
	readonly stdout: string
	readonly stderr: string
}

const runPscale = (args: string[], opts?: { secret?: boolean }): CliResult => {
	const proc = spawnSync("pscale", [...args, ...orgArgs()], { encoding: "utf8" })
	if (proc.error) {
		fail(`Failed to invoke \`pscale\` — is the PlanetScale CLI installed? (${proc.error.message})`)
	}
	const stdout = (proc.stdout ?? "").trim()
	const stderr = (proc.stderr ?? "").trim()
	console.log(`$ pscale ${args.join(" ")}`)
	// `secret` suppresses stdout — credential JSON must never reach the log.
	if (!opts?.secret) {
		if (stdout) console.log(stdout)
	}
	if (stderr) console.error(stderr)
	return { exitCode: proc.status ?? FAILURE, stdout, stderr }
}

interface Credential {
	/** Role id, needed to revoke it afterward. */
	readonly id: string
	/**
	 * Full connection string from the role. NB the connect-time Postgres
	 * database is `postgres` (the cluster default), NOT the PlanetScale database
	 * resource name — so we use the URL the CLI returns verbatim rather than
	 * reconstructing it.
	 */
	readonly url: string
	readonly password: string
}

/**
 * Mint an ephemeral branch ROLE. PlanetScale Postgres credentials are roles —
 * `pscale password` is Vitess/MySQL-only. The role inherits `postgres` by
 * default so it can run DDL (apply-schema) as well as DML (data import);
 * override via PLANETSCALE_MIGRATE_INHERITED_ROLES. A short --ttl is a safety
 * net so the credential auto-expires even if revoke fails. JSON field names
 * have drifted across `pscale` releases, so accept the known spellings; the
 * password plaintext is only ever returned on create.
 */
const createCredential = (database: string, branch: string): Credential => {
	const name = `migrate-${branch}-${process.pid}`
	const inheritedRoles = process.env.PLANETSCALE_MIGRATE_INHERITED_ROLES?.trim() || "postgres"
	const ttl = process.env.PLANETSCALE_MIGRATE_TTL?.trim() || "1h"
	const result = runPscale(
		[
			"role",
			"create",
			database,
			branch,
			name,
			"--inherited-roles",
			inheritedRoles,
			"--ttl",
			ttl,
			"--format",
			"json",
		],
		{ secret: true },
	)
	if (result.exitCode !== 0) {
		fail(`Could not mint a role for ${database}/${branch} — check PLANETSCALE_ORG + auth`)
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
	const id = pick("id", "name") ?? name
	const password = pick("plain_text", "password", "plaintext")
	// Prefer the ready-made URL (correct dbname=`postgres` + sslmode); fall back
	// to reconstructing it for older CLI builds that don't emit database_url.
	let url = pick("database_url", "connection_string")
	if (!url) {
		const host = pick("access_host_url", "host", "hostname")
		const username = pick("username", "user", "name")
		if (host && username && password) {
			url = `postgres://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:5432/postgres?sslmode=verify-full`
		}
	}
	if (!url || !password) {
		return fail(`role JSON missing connection fields (keys: ${Object.keys(parsed).join(", ")})`)
	}
	return { id, url, password }
}

const deleteCredential = (database: string, branch: string, id: string): void => {
	const result = runPscale(["role", "delete", database, branch, id, "--force", "--successor", "postgres"])
	if (result.exitCode !== 0) {
		console.error(
			`⚠ Failed to revoke role ${id} on ${database}/${branch} — it has a TTL and will auto-expire, but you may revoke it manually.`,
		)
	}
}

/**
 * Run `fn` with a direct (port 5432, the cluster `postgres` database)
 * connection URL to the given branch, then revoke the ephemeral credential.
 * DDL and bulk imports use the direct primary port, never the
 * PSBouncer/Hyperdrive poolers.
 */
export const withBranchConnection = async (
	branch: string,
	fn: (connectionUrl: string) => Promise<void>,
): Promise<void> => {
	const database = resolveDatabase()
	const credential = createCredential(database, branch)
	const host = (() => {
		try {
			return new URL(credential.url).host
		} catch {
			return "(unknown)"
		}
	})()
	console.log(`::add-mask::${credential.password}`)
	console.log(`✓ Minted ephemeral credential for ${database}/${branch} (host ${host})\n`)
	try {
		await fn(credential.url)
	} finally {
		console.log()
		deleteCredential(database, branch, credential.id)
	}
}
