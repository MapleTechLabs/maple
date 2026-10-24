/**
 * Labelling only: which ecosystems a repository builds with, whether it depends on anything the
 * sandbox could not fetch without credentials, and so how the run may execute target code. Pure
 * over a list of tracked paths and the text of a few config files, so it tests on fixture trees.
 */
import { Option, Schema } from "effect"

export const Ecosystem = Schema.Literals(["node", "python", "go", "rust", "jvm"])
export type Ecosystem = typeof Ecosystem.Type

/** `executable` waits on an execution sandbox per ecosystem; every run is `source_only` until then. */
export const ExecutionMode = Schema.Literals(["source_only", "executable"])
export type ExecutionMode = typeof ExecutionMode.Type

export const ExecutionProfile = Schema.Struct({
	mode: ExecutionMode,
	ecosystems: Schema.Array(Ecosystem),
	/** Each private-dependency signal, as `<file>: <what>`. */
	privateDependencies: Schema.Array(Schema.String),
	/** Why the run executes nothing, one sentence each, for reports and the run page. */
	reasons: Schema.Array(Schema.String),
})
export type ExecutionProfile = typeof ExecutionProfile.Type

export const ECOSYSTEM_NAMES = {
	node: "Node.js",
	python: "Python",
	go: "Go",
	rust: "Rust",
	jvm: "JVM",
} satisfies Record<Ecosystem, string>

/** Manifests and lockfiles by file name; a `RegExp` matches names with a variable part. */
const MANIFESTS: ReadonlyArray<readonly [Ecosystem, string | RegExp]> = [
	["node", "package.json"],
	["node", "package-lock.json"],
	["node", "npm-shrinkwrap.json"],
	["node", "yarn.lock"],
	["node", "pnpm-lock.yaml"],
	["node", "bun.lock"],
	["node", "bun.lockb"],
	["python", "pyproject.toml"],
	["python", /^requirements[\w.-]*\.txt$/u],
	["python", "Pipfile"],
	["python", "Pipfile.lock"],
	["python", "poetry.lock"],
	["python", "uv.lock"],
	["python", "setup.py"],
	["python", "setup.cfg"],
	["go", "go.mod"],
	["go", "go.sum"],
	["go", "go.work"],
	["rust", "Cargo.toml"],
	["rust", "Cargo.lock"],
	["jvm", "pom.xml"],
	["jvm", "build.gradle"],
	["jvm", "build.gradle.kts"],
	["jvm", "settings.gradle"],
	["jvm", "settings.gradle.kts"],
	["jvm", "gradle.lockfile"],
	["jvm", "build.sbt"],
]

/** Files whose text can name a private registry, a private git source or a local module. */
const CONFIGS: ReadonlyArray<string | RegExp> = [
	".npmrc",
	".yarnrc",
	".yarnrc.yml",
	"bunfig.toml",
	"pip.conf",
	"pip.ini",
	/^requirements[\w.-]*\.txt$/u,
	"pyproject.toml",
	"Pipfile",
	"go.mod",
	".gitmodules",
	"settings.xml",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"settings.gradle",
	"settings.gradle.kts",
	"Cargo.toml",
	"config.toml",
	"config",
]

/**
 * Broad files that only sometimes carry a signal (git dependencies, GOPRIVATE). A monorepo has
 * hundreds, so they are read in their own tier and never crowd out a registry config.
 */
const BROAD_CONFIGS: ReadonlyArray<string> = ["package.json", "go.env", ".envrc", "Makefile", "Dockerfile"]

/** Registry and credential configs read, the shallowest first, where the repository-wide ones sit. */
export const MAX_REGISTRY_CONFIG_READS = 60
/** Broad files read after them, also shallowest first. */
export const MAX_BROAD_CONFIG_READS = 40

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1)

const matches = (name: string, pattern: string | RegExp) =>
	typeof pattern === "string" ? name === pattern : pattern.test(name)

const isWorkflow = (path: string) => /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(path)

/** Cargo's `config` files only count inside `.cargo/`. */
const isRegistryConfig = (path: string) => {
	const name = basename(path)
	if (name === "config" || name === "config.toml") return path.endsWith(`.cargo/${name}`)
	return CONFIGS.some((pattern) => matches(name, pattern))
}

/** CI workflows can set GOPRIVATE too. */
const isBroadConfig = (path: string) => isWorkflow(path) || BROAD_CONFIGS.includes(basename(path))

const isConfig = (path: string) => isRegistryConfig(path) || isBroadConfig(path)

/** The git pathspecs that list every manifest and config file this module reads. */
export const DEPENDENCY_PATHSPECS: ReadonlyArray<string> = [
	...new Set(
		[...MANIFESTS.map(([, pattern]) => pattern), ...CONFIGS, ...BROAD_CONFIGS].map((pattern) =>
			typeof pattern === "string" ? `:(glob)**/${pattern}` : ":(glob)**/requirements*.txt",
		),
	),
	":(glob).github/workflows/*.yml",
	":(glob).github/workflows/*.yaml",
]

const shallowestFirst = (a: string, b: string) =>
	a.split("/").length - b.split("/").length || (a < b ? -1 : 1)

/** The config files worth reading: registry configs first, then broad files, each tier capped. */
export const configFilesToRead = (paths: ReadonlyArray<string>): ReadonlyArray<string> => [
	...paths.filter(isRegistryConfig).sort(shallowestFirst).slice(0, MAX_REGISTRY_CONFIG_READS),
	...paths
		.filter((path) => !isRegistryConfig(path) && isBroadConfig(path))
		.sort(shallowestFirst)
		.slice(0, MAX_BROAD_CONFIG_READS),
]

/** Registries and hosts anyone can fetch from without credentials. */
const PUBLIC_HOSTS = new Set([
	"registry.npmjs.org",
	"registry.yarnpkg.com",
	"registry.npmmirror.com",
	"pypi.org",
	"pypi.python.org",
	"files.pythonhosted.org",
	"download.pytorch.org",
	"repo.maven.apache.org",
	"repo1.maven.org",
	"central.sonatype.com",
	"plugins.gradle.org",
	"maven.google.com",
	"dl.google.com",
	"jcenter.bintray.com",
	"crates.io",
	"index.crates.io",
	"static.crates.io",
	"proxy.golang.org",
	"github.com",
	"gitlab.com",
	"bitbucket.org",
])

const URL_PATTERN = /\b(?:https?|ssh|git\+ssh|git\+https|sparse\+https):\/\/[^\s"'<>)]+/giu

const hostOf = (url: string): string | undefined => {
	const match = /^[a-z+]+:\/\/(?:[^@/]*@)?([^/:?#]+)/iu.exec(url)
	return match?.[1]?.toLowerCase()
}

/** URLs in `text` whose host is not a public registry. */
const privateUrls = (text: string): ReadonlyArray<string> =>
	[...text.matchAll(URL_PATTERN)]
		.map((m) => m[0])
		.filter((url) => {
			const host = hostOf(url)
			return host !== undefined && !PUBLIC_HOSTS.has(host)
		})

const lines = (text: string) => text.split(/\r?\n/u).map((line) => line.trim())

/** Lines that set one of `keys` (`key = value`, `key: value` or `key "value"`). */
const keyed = (text: string, keys: ReadonlyArray<string>) =>
	lines(text)
		.filter((line) => keys.some((key) => new RegExp(`^["']?${key}["']?\\s*[=:"\\s]`, "u").test(line)))
		.join("\n")

/** The text inside the XML elements a Maven file declares repositories with. */
const REPOSITORY_TAGS = ["repository", "pluginRepository", "snapshotRepository", "mirror"] as const

/** Scanned with `indexOf`, not a lazy regex: repository text must not cost quadratic time. */
const repositoryBlocks = (xml: string) =>
	REPOSITORY_TAGS.flatMap((tag) =>
		xml
			.split(`<${tag}>`)
			.slice(1)
			.flatMap((rest) => {
				const end = rest.indexOf(`</${tag}>`)
				return end === -1 ? [] : [`<${tag}>${rest.slice(0, end)}</${tag}>`]
			}),
	).join("\n")

/** The part of a config file that can name where dependencies come from; never homepages or docs. */
const sourceText = (name: string, text: string): string => {
	switch (name) {
		case ".npmrc":
		case ".yarnrc":
			return lines(text)
				.filter((line) => line.includes("registry"))
				.join("\n")
		case ".yarnrc.yml":
			return keyed(text, ["npmRegistryServer", "npmScopes", "url"])
		case "pyproject.toml":
		case "Pipfile":
			return keyed(text, ["url", "index-url", "extra-index-url", "index_url", "extra_index_url"])
		case "pom.xml":
		case "settings.xml":
			return repositoryBlocks(text)
		case "build.gradle":
		case "build.gradle.kts":
		case "settings.gradle":
		case "settings.gradle.kts":
			return lines(text)
				.filter((line) => /\burl\b|maven\s*\(/u.test(line))
				.join("\n")
		case "Cargo.toml":
			return [...text.matchAll(/\bgit\s*=\s*"([^"]+)"/gu)].map((m) => m[1]).join("\n")
		default:
			return text
	}
}

/**
 * A package.json dependency fetched from git over SSH (`git+ssh://`, `git@host:`). A plain
 * `github:owner/repo` shorthand is usually public, so it is not a signal.
 */
const GIT_DEPENDENCY = /^(?:git\+ssh:\/\/|git@)/u

const DependencyMap = Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))
const PackageJson = Schema.fromJsonString(
	Schema.Struct({
		dependencies: DependencyMap,
		devDependencies: DependencyMap,
		optionalDependencies: DependencyMap,
		peerDependencies: DependencyMap,
	}),
)
const decodePackageJson = Schema.decodeUnknownOption(PackageJson)

/** The git-over-SSH entries of a package.json's dependency maps, never its metadata. */
const gitDependencies = (text: string): ReadonlyArray<{ readonly name: string; readonly spec: string }> =>
	Option.match(decodePackageJson(text), {
		onNone: () => [],
		onSome: (manifest) =>
			[
				manifest.dependencies,
				manifest.devDependencies,
				manifest.optionalDependencies,
				manifest.peerDependencies,
			]
				.flatMap((deps) => Object.entries(deps ?? {}))
				.flatMap(([name, spec]) =>
					typeof spec === "string" && GIT_DEPENDENCY.test(spec) ? [{ name, spec }] : [],
				),
	})

/** A submodule URL anyone can clone: http(s) or git protocol on a public host. */
const isPublicSubmodule = (url: string) => {
	const host = /^(?:https?|git):\/\//iu.test(url) ? hostOf(url) : undefined
	return host !== undefined && PUBLIC_HOSTS.has(host)
}

/** The Go settings that mark modules as private, as a shell, Makefile or workflow sets them. */
const GO_PRIVATE = /\b(GOPRIVATE|GONOSUMDB|GONOPROXY)\s*[=:]\s*["']?([^\s"']+)/gu

const REQUIREMENTS = /^requirements[\w.-]*\.txt$/u

/** requirements files without their comments: a commented-out index is not a source. */
const uncommented = (text: string) =>
	lines(text)
		.filter((line) => !line.startsWith("#"))
		.map((line) => {
			const comment = line.search(/\s#/u)
			return comment === -1 ? line : line.slice(0, comment).trimEnd()
		})
		.join("\n")

/** The private-dependency signals one config file carries. */
const signalsIn = (path: string, text: string): ReadonlyArray<string> => {
	const name = basename(path)
	const at = (what: string) => `${path}: ${what}`
	const sources = privateUrls(sourceText(name, text)).map((url) => at(`private source ${hostOf(url)}`))
	const goPrivate = [...text.matchAll(GO_PRIVATE)].map((m) => at(`${m[1]} set to ${m[2]}`))
	if (isWorkflow(path)) return goPrivate
	switch (name) {
		case "package.json":
			return gitDependencies(text).map(({ name: dep, spec }) => at(`git dependency ${dep} (${spec})`))
		case "go.env":
		case ".envrc":
		case "Makefile":
		case "Dockerfile":
			return goPrivate
		case ".npmrc":
			return [
				...sources,
				...(/_authToken|_auth\s*=|always-auth/u.test(text) ? [at("registry credentials")] : []),
			]
		case "settings.xml":
			return [...sources, ...(/<server>/u.test(text) ? [at("repository credentials")] : [])]
		case "Cargo.toml":
			return [...sources, ...(/^\s*registry\s*=/mu.test(text) ? [at("alternate registry")] : [])]
		case ".gitmodules":
			return lines(text)
				.filter((line) => /^url\s*=/u.test(line))
				.map((line) => line.slice(line.indexOf("=") + 1).trim())
				.filter((url) => !isPublicSubmodule(url))
				.map((url) =>
					at(
						`git submodule ${url}${url.startsWith("git@") || url.startsWith("ssh://") ? " over SSH" : ""}, not checked out`,
					),
				)
		case "go.mod":
			return lines(text)
				.filter((line) => !line.startsWith("//"))
				.filter((line) => line.includes("=>"))
				.map((line) => line.slice(line.indexOf("=>") + 2).trim())
				.filter((target) => target.startsWith(".") || target.startsWith("/"))
				.map((target) => at(`replace directive to the local module ${target.split(/\s/u)[0]}`))
		default:
			if (!REQUIREMENTS.test(name)) return sources
			// requirements*.txt also names dependencies fetched over SSH.
			return [
				...privateUrls(uncommented(text)).map((url) => at(`private source ${hostOf(url)}`)),
				...lines(uncommented(text))
					.filter((line) => line.includes("git+ssh://") || line.includes("git+git@"))
					.map(() => at("git dependency over SSH")),
			]
	}
}

export interface DependencyScan {
	readonly ecosystems: ReadonlyArray<Ecosystem>
	readonly privateDependencies: ReadonlyArray<string>
}

/** The ecosystems the tracked paths build with, and the private-dependency signals in `configs`. */
export const scanDependencies = (
	paths: ReadonlyArray<string>,
	configs: ReadonlyMap<string, string>,
): DependencyScan => {
	const names = new Set(paths.map(basename))
	const ecosystems = Ecosystem.literals.filter((ecosystem) =>
		MANIFESTS.some(
			([owner, pattern]) => owner === ecosystem && [...names].some((name) => matches(name, pattern)),
		),
	)
	const privateDependencies = [
		...new Set([...configs].flatMap(([path, text]) => (isConfig(path) ? signalsIn(path, text) : []))),
	]
	return { ecosystems, privateDependencies }
}

/** At most this many signals are spelled out in a reason; the profile keeps them all. */
const SIGNALS_IN_REASON = 3

/**
 * How the run may execute target code. With no sandbox for any ecosystem (today), every run is
 * source-only; the shape already says which ecosystems a future `executable` run would need.
 */
export const executionProfile = (
	scan: DependencyScan,
	hasSandbox: (ecosystem: Ecosystem) => boolean = () => false,
): ExecutionProfile => {
	const missing = scan.ecosystems.filter((ecosystem) => !hasSandbox(ecosystem))
	const reasons = [
		...(scan.ecosystems.length === 0
			? ["no execution sandbox for this repository's languages yet"]
			: missing.length === 0
				? []
				: [`no execution sandbox for ${missing.map((e) => ECOSYSTEM_NAMES[e]).join(", ")} yet`]),
		...(scan.privateDependencies.length === 0
			? []
			: [
					`private dependencies detected, which cannot be installed without credentials (${scan.privateDependencies.slice(0, SIGNALS_IN_REASON).join("; ")}${scan.privateDependencies.length > SIGNALS_IN_REASON ? `; ${scan.privateDependencies.length - SIGNALS_IN_REASON} more` : ""})`,
				]),
	]
	return {
		mode: reasons.length === 0 ? "executable" : "source_only",
		ecosystems: scan.ecosystems,
		privateDependencies: scan.privateDependencies,
		reasons,
	}
}

/** The one line a report or the run page shows, e.g. "Source-only review: no execution sandbox for Go yet". */
export const executionModeLine = (profile: ExecutionProfile): string =>
	profile.mode === "executable"
		? "Executable review: target code ran in the execution sandbox"
		: `Source-only review: ${profile.reasons.join("; ") || "target code was not executed"}`
