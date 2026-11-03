import { spawnSync } from "node:child_process"
import path from "node:path"
import { String as Str } from "effect"

const git = (cwd: string, ...args: string[]): string | undefined => {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" })
	if (result.error || result.status !== 0) return undefined
	const value = Str.trim(result.stdout)
	return value === "" ? undefined : value
}

const DEFAULT_BRANCHES = new Set(["main", "master"])

/** Portless's own rule: the branch's last segment as a hostname label, nothing for main/master. */
const branchToPrefix = (branch: string | undefined): string => {
	if (!branch || branch === "HEAD" || DEFAULT_BRANCHES.has(branch)) return ""
	const label = Str.replaceAll(
		/^-+|-+$/g,
		"",
	)(Str.replaceAll(/[^a-z0-9-]+/g, "-")(Str.toLowerCase(Str.split("/")(branch).pop() ?? "")))
	return label ? `${label}.` : ""
}

/** Empty in the main worktree, `<branch label>.` in a linked one, the way portless names them. */
export const worktreePrefix = (cwd: string = process.cwd()): string => {
	const gitDir = git(cwd, "rev-parse", "--git-dir")
	const commonDir = git(cwd, "rev-parse", "--git-common-dir")
	if (!gitDir || !commonDir || path.resolve(cwd, gitDir) === path.resolve(cwd, commonDir)) return ""
	return branchToPrefix(git(cwd, "rev-parse", "--abbrev-ref", "HEAD"))
}

/** The portless hostname a route is registered under. */
export const routeHostname = (name: string, prefix: string = worktreePrefix()): string => `${prefix}${name}`

/** The route's URL through the portless proxy; a plain string, usable at plan time. */
export const routeUrl = (name: string, prefix?: string): string =>
	`https://${routeHostname(name, prefix)}.localhost`
