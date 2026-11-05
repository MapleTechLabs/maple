/**
 * Labelling only: which ecosystems a repository builds with, whether it depends on anything the
 * sandbox could not fetch without credentials, and so how the run may execute target code. Pure
 * over a list of tracked paths and the text of a few config files, so it tests on fixture trees.
 */
import { Option, Schema, Array as Arr, Record as Rec, String as Str } from "effect"

export const Ecosystem = Schema.Literals(["node", "python", "go", "rust", "jvm"])
export type Ecosystem = typeof Ecosystem.Type

/** `executable` when the execution sandbox covers at least one of the repository's ecosystems. */
export const ExecutionMode = Schema.Literals(["source_only", "executable"])
export type ExecutionMode = typeof ExecutionMode.Type

export const ExecutionProfile = Schema.Struct({
	mode: ExecutionMode,
	ecosystems: Schema.Array(Ecosystem),
	/** Each private-dependency signal, as `<file>: <what>`. */
	privateDependencies: Schema.Array(Schema.String),
	/** What the run cannot execute, and why, one sentence each, for reports and the run page. */
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

const basename = (path: string) =>
	Str.slice(Option.match(Str.lastIndexOf("/")(path), { onNone: () => 0, onSome: (at) => at + 1 }))(path)

const matches = (name: string, pattern: string | RegExp) =>
	typeof pattern === "string" ? name === pattern : pattern.test(name)

const isWorkflow = (path: string) => /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(path)

/** Cargo's `config` files only count inside `.cargo/`. */
const isRegistryConfig = (path: string) => {
	const name = basename(path)
	if (name === "config" || name === "config.toml") return Str.endsWith(`.cargo/${name}`)(path)
	return Arr.some(CONFIGS, (pattern) => matches(name, pattern))
}

/** CI workflows can set GOPRIVATE too. */
const isBroadConfig = (path: string) => isWorkflow(path) || BROAD_CONFIGS.includes(basename(path))

const isConfig = (path: string) => isRegistryConfig(path) || isBroadConfig(path)

/** The git pathspecs that list every manifest and config file this module reads. */
export const DEPENDENCY_PATHSPECS: ReadonlyArray<string> = [
	...new Set(
		Arr.map([...Arr.map(MANIFESTS, ([, pattern]) => pattern), ...CONFIGS, ...BROAD_CONFIGS], (pattern) =>
			typeof pattern === "string" ? `:(glob)**/${pattern}` : ":(glob)**/requirements*.txt",
		),
	),
	":(glob).github/workflows/*.yml",
	":(glob).github/workflows/*.yaml",
]

const shallowestFirst = (a: string, b: string) => {
	const byDepth = Str.split("/")(a).length - Str.split("/")(b).length
	return byDepth !== 0 ? byDepth : a < b ? -1 : 1
}

/** The config files worth reading: registry configs first, then broad files, each tier capped. */
export const configFilesToRead = (paths: ReadonlyArray<string>): ReadonlyArray<string> => [
	...Arr.filter(paths, isRegistryConfig).sort(shallowestFirst).slice(0, MAX_REGISTRY_CONFIG_READS),
	...Arr.filter(paths, (path) => !isRegistryConfig(path) && isBroadConfig(path))
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
	const host = match?.[1]
	return host === undefined ? undefined : Str.toLowerCase(host)
}

/** URLs in `text` whose host is not a public registry. */
const privateUrls = (text: string): ReadonlyArray<string> =>
	Arr.filter(
		Arr.map([...Str.matchAll(URL_PATTERN)(text)], (m) => m[0]),
		(url) => {
			const host = hostOf(url)
			return host !== undefined && !PUBLIC_HOSTS.has(host)
		},
	)

const lines = (text: string) => Arr.map(Str.split(/\r?\n/u)(text), (line) => Str.trim(line))

/** Lines that set one of `keys` (`key = value`, `key: value` or `key "value"`). */
const keyed = (text: string, keys: ReadonlyArray<string>) =>
	Arr.join(
		Arr.filter(lines(text), (line) =>
			Arr.some(keys, (key) => new RegExp(`^["']?${key}["']?\\s*[=:"\\s]`, "u").test(line)),
		),
		"\n",
	)

/** Config text without whole-line `//` and `#` comments: commented-out config is not a source. */
const withoutLineComments = (text: string) =>
	Arr.join(
		Arr.filter(lines(text), (line) => !Str.startsWith("//")(line) && !Str.startsWith("#")(line)),
		"\n",
	)

/** XML without `<!-- -->` comments; an unterminated comment runs to the end, as XML reads it. */
const withoutXmlComments = (xml: string) =>
	Arr.join(
		Arr.map(Str.split("<!--")(xml), (part, index) => {
			if (index === 0) return part
			return Option.match(Str.indexOf("-->")(part), {
				onNone: () => "",
				onSome: (end) => Str.slice(end + 3)(part),
			})
		}),
		"",
	)

/** The text inside the XML elements a Maven file declares repositories with. */
const REPOSITORY_TAGS = ["repository", "pluginRepository", "snapshotRepository", "mirror"] as const

/** Scanned with `indexOf`, not a lazy regex: repository text must not cost quadratic time. */
const repositoryBlocks = (xml: string) =>
	Arr.join(
		Arr.flatMap(REPOSITORY_TAGS, (tag) =>
			Arr.flatMap(Str.split(`<${tag}>`)(xml).slice(1), (rest) => {
				return Option.match(Str.indexOf(`</${tag}>`)(rest), {
					onNone: () => [],
					onSome: (end) => [`<${tag}>${Str.slice(0, end)(rest)}</${tag}>`],
				})
			}),
		),
		"\n",
	)

/** The part of a config file that can name where dependencies come from; never homepages or docs. */
const sourceText = (name: string, text: string): string => {
	switch (name) {
		case ".npmrc":
		case ".yarnrc":
			return Arr.join(
				Arr.filter(lines(text), (line) => Str.includes("registry")(line)),
				"\n",
			)
		case ".yarnrc.yml":
			return keyed(text, ["npmRegistryServer", "npmScopes", "url"])
		case "pyproject.toml":
		case "Pipfile":
			return keyed(text, ["url", "index-url", "extra-index-url", "index_url", "extra_index_url"])
		case "pom.xml":
		case "settings.xml":
			return repositoryBlocks(withoutXmlComments(text))
		case "build.gradle":
		case "build.gradle.kts":
		case "settings.gradle":
		case "settings.gradle.kts":
			return Arr.join(
				Arr.filter(lines(withoutLineComments(text)), (line) => /\burl\b|maven\s*\(/u.test(line)),
				"\n",
			)
		case "Cargo.toml":
			return Arr.join(
				Arr.map([...Str.matchAll(/\bgit\s*=\s*"([^"]+)"/gu)(text)], (m) => m[1]),
				"\n",
			)
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
			Arr.flatMap(
				Arr.flatMap(
					[
						manifest.dependencies,
						manifest.devDependencies,
						manifest.optionalDependencies,
						manifest.peerDependencies,
					],
					(deps) => Rec.toEntries(deps ?? {}),
				),
				([name, spec]) =>
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
	Arr.join(
		Arr.map(
			Arr.filter(lines(text), (line) => !Str.startsWith("#")(line)),
			(line) => {
				return Option.match(Str.search(/\s#/u)(line), {
					onNone: () => line,
					onSome: (comment) => Str.trimEnd(Str.slice(0, comment)(line)),
				})
			},
		),
		"\n",
	)

/** The private-dependency signals one config file carries. */
const signalsIn = (path: string, text: string): ReadonlyArray<string> => {
	const name = basename(path)
	const at = (what: string) => `${path}: ${what}`
	const sources = Arr.map(privateUrls(sourceText(name, text)), (url) => at(`private source ${hostOf(url)}`))
	const goPrivate = Arr.map([...Str.matchAll(GO_PRIVATE)(withoutLineComments(text))], (m) =>
		at(`${m[1]} set to ${m[2]}`),
	)
	if (isWorkflow(path)) return goPrivate
	switch (name) {
		case "package.json":
			return Arr.map(gitDependencies(text), ({ name: dep, spec }) =>
				at(`git dependency ${dep} (${spec})`),
			)
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
			return Arr.map(
				Arr.filter(
					Arr.map(
						Arr.filter(lines(text), (line) => /^url\s*=/u.test(line)),
						(line) =>
							Str.trim(
								Str.slice(
									Option.match(Str.indexOf("=")(line), {
										onNone: () => 0,
										onSome: (at) => at + 1,
									}),
								)(line),
							),
					),
					(url) => !isPublicSubmodule(url),
				),
				(url) =>
					at(
						`git submodule ${url}${Str.startsWith("git@")(url) || Str.startsWith("ssh://")(url) ? " over SSH" : ""}, not checked out`,
					),
			)
		case "go.mod":
			return Arr.map(
				Arr.filter(
					Arr.map(
						Arr.filter(
							Arr.filter(lines(text), (line) => !Str.startsWith("//")(line)),
							(line) => Str.includes("=>")(line),
						),
						(line) =>
							Str.trim(
								Str.slice(
									Option.match(Str.indexOf("=>")(line), {
										onNone: () => 1,
										onSome: (at) => at + 2,
									}),
								)(line),
							),
					),
					(target) => Str.startsWith(".")(target) || Str.startsWith("/")(target),
				),
				(target) => at(`replace directive to the local module ${Str.split(/\s/u)(target)[0]}`),
			)
		default:
			if (!REQUIREMENTS.test(name)) return sources
			// requirements*.txt also names dependencies fetched over SSH.
			return [
				...Arr.map(privateUrls(uncommented(text)), (url) => at(`private source ${hostOf(url)}`)),
				...Arr.map(
					Arr.filter(
						lines(uncommented(text)),
						(line) => Str.includes("git+ssh://")(line) || Str.includes("git+git@")(line),
					),
					() => at("git dependency over SSH"),
				),
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
	const names = new Set(Arr.map(paths, basename))
	const ecosystems = Arr.filter(Ecosystem.literals, (ecosystem) =>
		Arr.some(
			MANIFESTS,
			([owner, pattern]) =>
				owner === ecosystem && Arr.some([...names], (name) => matches(name, pattern)),
		),
	)
	const privateDependencies = [
		...new Set(
			Arr.flatMap([...configs], ([path, text]) => (isConfig(path) ? signalsIn(path, text) : [])),
		),
	]
	return { ecosystems, privateDependencies }
}

/** At most this many signals are spelled out in a reason; the profile keeps them all. */
const SIGNALS_IN_REASON = 3

/**
 * How the run may execute target code: executable when the sandbox covers any of its ecosystems,
 * with the rest (and any private dependency the install cannot fetch) named as what stays
 * source-only.
 */
export const executionProfile = (
	scan: DependencyScan,
	hasSandbox: (ecosystem: Ecosystem) => boolean = () => false,
): ExecutionProfile => {
	const missing = Arr.filter(scan.ecosystems, (ecosystem) => !hasSandbox(ecosystem))
	const reasons = [
		...(scan.ecosystems.length === 0
			? ["no execution sandbox for this repository's languages yet"]
			: missing.length === 0
				? []
				: [
						`no execution sandbox for ${Arr.join(
							Arr.map(missing, (e) => ECOSYSTEM_NAMES[e]),
							", ",
						)} yet`,
					]),
		...(scan.privateDependencies.length === 0
			? []
			: [
					`private dependencies detected, which cannot be installed without credentials (${Arr.join(scan.privateDependencies.slice(0, SIGNALS_IN_REASON), "; ")}${scan.privateDependencies.length > SIGNALS_IN_REASON ? `; ${scan.privateDependencies.length - SIGNALS_IN_REASON} more` : ""})`,
				]),
	]
	return {
		mode: Arr.some(scan.ecosystems, hasSandbox) ? "executable" : "source_only",
		ecosystems: scan.ecosystems,
		privateDependencies: scan.privateDependencies,
		reasons,
	}
}

/** The one line a report or the run page shows, e.g. "Source-only review: no execution sandbox for Go yet". */
export const executionModeLine = (profile: ExecutionProfile): string =>
	profile.mode === "executable"
		? `Executable review: hunters and verifiers could run target code in the execution sandbox${profile.reasons.length === 0 ? "" : ` (${Arr.join(profile.reasons, "; ")})`}`
		: `Source-only review: ${Arr.join(profile.reasons, "; ") || "target code was not executed"}`
