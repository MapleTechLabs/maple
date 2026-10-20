// Sizes CI test lanes from tracked test files and keeps only the suites a diff can reach.
// Vitest stays the authority on discovery and shard assignment; see docs/ci-performance.md.
import { $ } from "bun"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "../..")

// Vitest seconds/file at two workers, measured on CI run 35725366619. Unknown suites
// get the default, fitted to the slowest cold small-suite lanes of 2026-10.
const SECONDS_PER_FILE = new Map([
	["@maple/api", 2.3],
	["@maple/backend", 1.6],
	["@maple/ai", 1.1],
	["@maple/query-engine", 0.45],
	["@maple/ui", 0.45],
	["@maple/domain", 0.4],
])
const DEFAULT_SECONDS_PER_FILE = 0.6
// Each lane pays ~30s of setup plus a runner slot, so fewer, fuller lanes win.
export const TARGET_SECONDS = 140
// Per Vitest invocation: Vite startup and Turbo overhead, paid once per suite.
const STARTUP_SECONDS = 4
export const MAX_LANES = 256

// Changes no test reads. Tests that read files outside their workspace declare
// them as `$TURBO_ROOT$` inputs in turbo.json.
const INERT = [/^docs\//, /^[^/]+\.md$/]

export interface Workspace {
	readonly name: string
	readonly directory: string
	readonly dependencies: ReadonlyArray<string>
	readonly testScript: string | undefined
	readonly browser: boolean
}

export interface Suite {
	readonly name: string
	readonly files: number
	readonly vitest: boolean
	readonly browserWorkspace: string
}

export interface Lane {
	readonly name: string
	readonly filters: Array<string>
	readonly args: ReadonlyArray<string>
	readonly "bun-filters": Array<string>
	"estimated-seconds": number
	"browser-workspace": string
}

interface PackageJson {
	readonly name: string
	readonly workspaces?: ReadonlyArray<string>
	readonly scripts?: Readonly<Record<string, string>>
	readonly dependencies?: Readonly<Record<string, string>>
	readonly devDependencies?: Readonly<Record<string, string>>
	readonly peerDependencies?: Readonly<Record<string, string>>
	readonly optionalDependencies?: Readonly<Record<string, string>>
}

const readJson = async <A>(file: string): Promise<A> => Bun.file(path.join(ROOT, file)).json()

export const trackedFiles = async (): Promise<ReadonlyArray<string>> =>
	(await $`git ls-files -z`.cwd(ROOT).text()).split("\0").filter(Boolean)

export const discoverWorkspaces = async (files: ReadonlyArray<string>): Promise<ReadonlyArray<Workspace>> => {
	const patterns = (await readJson<PackageJson>("package.json")).workspaces ?? []
	const include = patterns.filter((p) => !p.startsWith("!")).map((p) => new Bun.Glob(p))
	const exclude = patterns.filter((p) => p.startsWith("!")).map((p) => new Bun.Glob(p.slice(1)))
	const manifests = files.filter((file) => /^[^/]+\/[^/]+\/package\.json$/.test(file))
	const workspaces = await Promise.all(
		manifests
			.map((file) => file.slice(0, -"/package.json".length))
			.filter((dir) => include.some((g) => g.match(dir)) && !exclude.some((g) => g.match(dir)))
			.map(async (directory) => {
				const pkg = await readJson<PackageJson>(`${directory}/package.json`)
				return {
					name: pkg.name,
					directory,
					dependencies: [
						pkg.dependencies,
						pkg.devDependencies,
						pkg.peerDependencies,
						pkg.optionalDependencies,
					].flatMap((deps) => Object.keys(deps ?? {})),
					testScript: pkg.scripts?.test,
					browser: "@vitest/browser-playwright" in (pkg.devDependencies ?? {}),
				}
			}),
	)
	return workspaces
}

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/

export const suitesOf = (workspaces: ReadonlyArray<Workspace>, files: ReadonlyArray<string>): Array<Suite> =>
	workspaces
		// apps/ingest is Rust and has its own workflow.
		.filter((w) => w.testScript !== undefined && w.directory !== "apps/ingest")
		.map((w) => ({
			name: w.name,
			files: files.filter((f) => f.startsWith(`${w.directory}/`) && TEST_FILE.test(f)).length,
			vitest: w.testScript?.includes("vitest run") ?? false,
			browserWorkspace: w.browser ? w.directory : "",
		}))

/**
 * Workspaces whose tests a diff can change: the owners of changed files, the
 * `$TURBO_ROOT$` inputs a test task declares, and everything depending on them.
 * `undefined` means "all": a changed file outside every workspace may be read by any.
 */
export const affectedWorkspaces = (
	workspaces: ReadonlyArray<Workspace>,
	changed: ReadonlyArray<string>,
	rootInputs: ReadonlyArray<readonly [workspace: string, glob: string]>,
): ReadonlySet<string> | undefined => {
	const owners = new Set<string>()
	for (const file of changed) {
		if (INERT.some((re) => re.test(file))) continue
		for (const [workspace, glob] of rootInputs) if (new Bun.Glob(glob).match(file)) owners.add(workspace)
		const owner = workspaces.find((w) => file.startsWith(`${w.directory}/`))
		if (owner === undefined) return undefined
		owners.add(owner.name)
	}
	const dependents = new Map<string, Array<string>>()
	for (const w of workspaces)
		for (const dep of w.dependencies) dependents.set(dep, [...(dependents.get(dep) ?? []), w.name])
	const queue = [...owners]
	for (const name of queue) {
		for (const next of dependents.get(name) ?? []) {
			if (owners.has(next)) continue
			owners.add(next)
			queue.push(next)
		}
	}
	return owners
}

/** `<pkg>#test` task inputs under the repo root, from turbo.json. */
export const turboRootInputs = async (): Promise<Array<readonly [string, string]>> => {
	const turbo = Bun.JSONC.parse(await Bun.file(path.join(ROOT, "turbo.json")).text())
	const tasks =
		turbo instanceof Object && "tasks" in turbo && turbo.tasks instanceof Object ? turbo.tasks : {}
	return Object.entries(tasks).flatMap(([task, config]) => {
		const [workspace, name] = task.split("#")
		if (workspace === undefined || name !== "test") return []
		const inputs: ReadonlyArray<unknown> =
			config instanceof Object && "inputs" in config && Array.isArray(config.inputs)
				? config.inputs
				: []
		return inputs
			.map(String)
			.filter((input) => input.startsWith("$TURBO_ROOT$/"))
			.map((input) => [workspace, input.slice("$TURBO_ROOT$/".length)] as const)
	})
}

const pack = (
	suites: ReadonlyArray<readonly [string, number, boolean]>,
	args: ReadonlyArray<string>,
): Array<Lane> => {
	const groups: Array<Lane> = []
	const sorted = [...suites].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
	for (const [name, weight, vitest] of sorted) {
		let group = groups.find((g) => g["estimated-seconds"] + weight <= TARGET_SECONDS)
		if (group === undefined) {
			group = {
				name: `small-${groups.length + 1}`,
				filters: [],
				args,
				"bun-filters": [],
				"estimated-seconds": 0,
				"browser-workspace": "",
			}
			groups.push(group)
		}
		group.filters.push(name)
		if (!vitest) group["bun-filters"].push(name)
		group["estimated-seconds"] += weight
	}
	return groups
}

export const plan = (suites: ReadonlyArray<Suite>): { include: Array<Lane> } => {
	const lanes: Array<Lane> = []
	const small: Array<readonly [string, number, boolean]> = []
	for (const suite of [...suites].sort((a, b) => (a.name < b.name ? -1 : 1))) {
		const weight =
			Math.max(1, suite.files) * (SECONDS_PER_FILE.get(suite.name) ?? DEFAULT_SECONDS_PER_FILE)
		// Bun suites pack with the small Vitest suites but run without Vitest flags.
		if (!suite.vitest) {
			small.push([suite.name, weight + STARTUP_SECONDS, false])
			continue
		}
		const shards = Math.ceil(weight / (TARGET_SECONDS - STARTUP_SECONDS))
		if (shards === 1) {
			small.push([suite.name, weight + STARTUP_SECONDS, true])
			continue
		}
		for (let index = 1; index <= shards; index++) {
			lanes.push({
				name: `${suite.name}-${index}-of-${shards}`,
				filters: [suite.name],
				args: [`--shard=${index}/${shards}`, "--maxWorkers=2"],
				"bun-filters": [],
				"estimated-seconds": weight / shards + STARTUP_SECONDS,
				"browser-workspace": "",
			})
		}
	}
	// First-fit decreasing; a lane never runs two test runners at once (Turbo concurrency=1).
	lanes.push(...pack(small, ["--maxWorkers=2"]))
	const browser = new Map(suites.map((s) => [s.name, s.browserWorkspace]))
	for (const lane of lanes)
		lane["browser-workspace"] = lane.filters.map((n) => browser.get(n) ?? "").find(Boolean) ?? ""
	if (lanes.length > MAX_LANES)
		throw new Error(`Test matrix exceeds GitHub's ${MAX_LANES}-job limit; revise the runner budget`)
	return { include: lanes }
}

// CHANGED_FILES is a JSON array of paths; unset plans every suite.
if (import.meta.main) {
	const files = await trackedFiles()
	const workspaces = await discoverWorkspaces(files)
	const raw = process.env.CHANGED_FILES
	const affected = raw
		? affectedWorkspaces(workspaces, JSON.parse(raw), await turboRootInputs())
		: undefined
	const suites = suitesOf(workspaces, files).filter((s) => affected === undefined || affected.has(s.name))
	console.error(
		affected === undefined
			? "Planning every suite"
			: `Affected suites: ${suites.map((s) => s.name).join(", ") || "none"}`,
	)
	console.log(JSON.stringify(plan(suites)))
}
