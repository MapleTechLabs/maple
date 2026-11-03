/**
 * `bun dev [app ...]`: args → MAPLE_DEV_APPS, then one `alchemy dev` for the
 * whole stack. Everything else lives in alchemy.run.ts.
 */
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { DEV_APPS, DEV_APPS_ENV_KEY, isDevApp, type DevApp } from "../packages/infra/src/dev-urls.ts"
import { Array as Arr, Record as Rec } from "effect"

const args = process.argv.slice(2)
if (args.includes("--help") || args.includes("-h")) {
	console.log(`usage: bun dev [app ...]\n\napps: ${Arr.join(DEV_APPS, ", ")}\n\nNo app = all of them.`)
	process.exit(0)
}
const unknown = Arr.filter(args, (name) => !isDevApp(name))
if (unknown.length > 0) {
	console.error(`unknown app(s): ${Arr.join(unknown, ", ")}\nknown: ${Arr.join(DEV_APPS, ", ")}`)
	process.exit(2)
}
const selected: ReadonlyArray<DevApp> =
	args.length > 0 ? Arr.filter(DEV_APPS, (app) => args.includes(app)) : DEV_APPS

// `.env.screenshots` (from `bun run seed:demo:env`) runs the isolated screenshot stack.
const envFile = process.env.MAPLE_DEV_ENV_FILE ?? ".env.local"

// mise loads `.env.local` into the shell, and a blank value in an env file counts as
// absent, so with any other env file those keys would leak through. Drop them.
const localKeys = new Set(
	envFile === ".env.local" || !existsSync(".env.local")
		? []
		: readFileSync(".env.local", "utf8").match(/^[A-Z0-9_]+(?==)/gm),
)
const inherited = Rec.fromEntries(Arr.filter(Rec.toEntries(process.env), ([key]) => !localKeys.has(key)))

// A spawned child does not inherit the `node_modules/.bin` PATH entry `bun run` adds.
const alchemyBin = path.join(import.meta.dirname, "..", "node_modules", ".bin", "alchemy")

const child = spawn(
	alchemyBin,
	[
		"dev",
		"--stage",
		process.env.MAPLE_DEV_STAGE ?? `dev_${process.env.USER ?? "local"}`,
		"--env-file",
		envFile,
	],
	{
		stdio: "inherit",
		// Own process group: a signal to alchemy's CLI process alone stops nothing.
		detached: true,
		env: {
			...inherited,
			[DEV_APPS_ENV_KEY]: Arr.join(selected, ","),
			// Dev stacks never touch the shared account state store.
			ALCHEMY_LOCAL_STATE: process.env.ALCHEMY_LOCAL_STATE ?? "1",
		},
	},
)

child.on("exit", (code) => process.exit(code ?? 1))
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
	process.on(signal, () => {
		if (child.pid !== undefined && child.exitCode === null) process.kill(-child.pid, signal)
	})
}
