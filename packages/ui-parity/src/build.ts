import { $ } from "bun"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import {
	type AuthMode,
	BUILD_STAMP_FILE,
	type BuildStamp,
	buildDir,
	buildEnv,
	LEGACY_BASELINE_REF,
	outDir,
	PORT_BASE,
	repoRoot,
	STRIPPED_ENV,
	targets,
	type TargetName,
	worktreesDir,
} from "./config.ts"
import { viteWrapperConfig } from "./runtime/vite-wrapper.ts"

/** Written once a pinned worktree finished installing, so a half-done setup is redone. */
const SETUP_DONE_FILE = ".parity-setup-done"

/** A detached worktree at `ref`, installed and with the libs the web build imports from `dist/`. */
const pinnedWorktree = async (name: TargetName, ref: string) => {
	const sha = (await $`git -C ${repoRoot} rev-parse ${`${ref}^{commit}`}`.text()).trim()
	const root = resolve(worktreesDir, `${name}-${sha.slice(0, 12)}`)
	if (!existsSync(root)) await $`git -C ${repoRoot} worktree add --detach ${root} ${sha}`
	if (!existsSync(resolve(root, SETUP_DONE_FILE))) {
		await $`bun install --frozen-lockfile`.cwd(root)
		await $`bun run --cwd packages/effect-sdk build`.cwd(root)
		writeFileSync(resolve(root, SETUP_DONE_FILE), sha)
	}
	return { root, sha }
}

export interface BuildOptions {
	/** Git ref for pinned targets (default `LEGACY_BASELINE_REF`). */
	readonly ref?: string
	readonly authMode?: AuthMode
	/** Output name under `.parity/builds/`, for a second build of the same target (default: the target). */
	readonly out?: string
}

/**
 * Builds a target into `.parity/builds/<out>` (`builds-<base>/` for a non-default `PARITY_PORT_BASE`,
 * `<out>--clerk` for the Clerk flavor). `legacy` is built from a pinned commit so the reference UI
 * never drifts while the Foldkit app is being written.
 */
export const buildTarget = async (name: TargetName, options: BuildOptions = {}) => {
	const target = targets[name]
	const authMode = options.authMode ?? "self_hosted"
	const pinned = target.pinned ? await pinnedWorktree(name, options.ref ?? LEGACY_BASELINE_REF) : undefined
	const root = pinned?.root ?? repoRoot
	const appDir = resolve(root, target.appDir)
	if (!existsSync(resolve(appDir, "package.json")))
		throw new Error(`ui-parity: ${appDir} is not an app (target "${name}")`)

	const dest = buildDir(options.out ?? name, authMode)
	rmSync(dest, { recursive: true, force: true })
	const config = viteWrapperConfig(appDir, resolve(outDir, "empty-env"))
	console.log(`[build] ${name}${pinned ? ` @ ${pinned.sha.slice(0, 12)}` : ""} (${authMode}) -> ${dest}`)

	const stripped = new Set<string>(STRIPPED_ENV)
	const env = Object.fromEntries(
		Object.entries({ ...process.env, ...buildEnv(authMode), NODE_ENV: "production" }).filter(
			([key]) => !stripped.has(key),
		),
	)
	await $`${resolve(appDir, "node_modules/.bin/vite")} build --config ${config} --outDir ${dest} --emptyOutDir`
		.cwd(appDir)
		.env(env)

	mkdirSync(dest, { recursive: true })
	const stamp: BuildStamp = { target: name, portBase: PORT_BASE, ref: pinned?.sha ?? null, authMode }
	writeFileSync(resolve(dest, BUILD_STAMP_FILE), JSON.stringify(stamp))
	return dest
}
