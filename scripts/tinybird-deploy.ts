/**
 * Deploy the Tinybird project to the production workspaces (US and EU).
 *
 *   bun run tinybird:deploy check     # plan per region, changes nothing
 *   bun run tinybird:deploy start     # create a deployment per region, NOT promoted
 *   bun run tinybird:deploy status    # list each region's deployments
 *   bun run tinybird:deploy promote   # make each region's staged deployment live
 *   bun run tinybird:deploy discard   # drop each region's staged deployment
 *
 * `--region us` or `--region eu` limits any command to one region. `start` runs
 * the check first and stops on any failure, so no region gets a deployment the
 * other refused. Tinybird allows one non-live deployment per workspace.
 *
 * `--allow-destructive-operations` lets `check` and `start` delete datasources
 * and materialized views the project no longer defines; they are refused without it.
 *
 * Credentials come from `TINYBIRD_<US|EU>_HOST` / `_TOKEN`, else from Infisical
 * (`prod` for US, `prod-eu` for EU; needs `infisical login`). Tokens are passed
 * to `tb` but never printed.
 */
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { writeTinybirdDatafiles } from "./write-tinybird-datafiles"

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url))

const COMMANDS = ["check", "start", "status", "promote", "discard"] as const
type Command = (typeof COMMANDS)[number]

const REGIONS = [
	{ id: "us", infisicalEnv: "prod" },
	{ id: "eu", infisicalEnv: "prod-eu" },
] as const
type Region = (typeof REGIONS)[number]

interface Auth {
	readonly host: string
	readonly token: string
}

const fail = (message: string): never => {
	console.error(`✗ ${message}`)
	process.exit(1)
}

const isCommand = (value: string | undefined): value is Command =>
	COMMANDS.some((command) => command === value)

const DESTRUCTIVE_FLAG = "--allow-destructive-operations"

const parseArgs = (): {
	command: Command
	regions: ReadonlyArray<Region>
	destructive: ReadonlyArray<string>
} => {
	const [, , rawCommand, ...rest] = process.argv
	const usage = `Usage: bun run tinybird:deploy <${COMMANDS.join("|")}> [--region us|eu] [${DESTRUCTIVE_FLAG}]`
	if (!isCommand(rawCommand)) return fail(usage)
	const destructive = rest.includes(DESTRUCTIVE_FLAG) ? [DESTRUCTIVE_FLAG] : []
	const flag = rest.indexOf("--region")
	if (flag === -1) return { command: rawCommand, regions: REGIONS, destructive }
	const region = REGIONS.find((r) => r.id === rest[flag + 1])
	return region === undefined ? fail(usage) : { command: rawCommand, regions: [region], destructive }
}

const infisicalSecrets = (env: string): Auth => {
	const proc = spawnSync(
		"infisical",
		["secrets", "get", "TINYBIRD_HOST", "TINYBIRD_TOKEN", `--env=${env}`, "--plain", "--silent"],
		{ cwd: REPO_ROOT, encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] },
	)
	const [host = "", token = ""] = (proc.stdout ?? "").trim().split("\n")
	if (proc.status !== 0 || host === "" || token === "") {
		return fail(
			`Could not read TINYBIRD_HOST/TINYBIRD_TOKEN from Infisical env "${env}". Run \`infisical login\`.`,
		)
	}
	return { host: host.trim(), token: token.trim() }
}

const authFor = (region: Region): Auth => {
	const prefix = `TINYBIRD_${region.id.toUpperCase()}`
	const host = process.env[`${prefix}_HOST`]?.trim()
	const token = process.env[`${prefix}_TOKEN`]?.trim()
	return host && token ? { host, token } : infisicalSecrets(region.infisicalEnv)
}

/** Runs `tb --cloud` against `auth` from the repo root, where `tinybird.json` points at the datafiles. */
const runTb = (region: Region, auth: Auth, args: ReadonlyArray<string>): boolean => {
	console.log(`\n[${region.id}] ${auth.host}\n$ tb --cloud ${args.join(" ")}`)
	const proc = spawnSync("tb", ["--cloud", "--host", auth.host, "--token", auth.token, ...args], {
		cwd: REPO_ROOT,
		stdio: "inherit",
		env: { ...process.env, TB_VERSION_WARNING: "0" },
	})
	if (proc.error) fail(`Failed to invoke \`tb\`; is the Tinybird CLI installed? (${proc.error.message})`)
	return proc.status === 0
}

const { command, regions, destructive } = parseArgs()

const ARGS = {
	check: ["deploy", "--check", ...destructive],
	status: ["deployment", "ls"],
	promote: ["deployment", "promote"],
	discard: ["deployment", "discard"],
} as const satisfies Record<Exclude<Command, "start">, ReadonlyArray<string>>
const targets = regions.map((region) => ({ region, auth: authFor(region) }))
const revision = writeTinybirdDatafiles()
console.log(`Tinybird project ${revision}, regions: ${regions.map((r) => r.id).join(", ")}`)

if (command === "start") {
	const refused = targets.filter(({ region, auth }) => !runTb(region, auth, ARGS.check))
	if (refused.length > 0) {
		fail(`Check failed for ${refused.map((t) => t.region.id).join(", ")}; no deployment was created.`)
	}
	const failed = targets.filter(
		({ region, auth }) =>
			!runTb(region, auth, ["deployment", "create", "--no-auto", "--no-wait", ...destructive]),
	)
	if (failed.length > 0)
		fail(`Could not create a deployment for ${failed.map((t) => t.region.id).join(", ")}.`)
	console.log(
		"\nStaged. Watch with `bun run tinybird:deploy status`, then `bun run tinybird:deploy promote`.",
	)
} else {
	const failed = targets.filter(({ region, auth }) => !runTb(region, auth, ARGS[command]))
	if (failed.length > 0) fail(`\`${command}\` failed for ${failed.map((t) => t.region.id).join(", ")}.`)
}
