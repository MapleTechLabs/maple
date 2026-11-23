// Runtime, hosting provider and OS platform detection. Same rules and order as
// std-env 4.3 (`runtime`, `provider`, `platform`), kept in-house so the SDK has
// no runtime dependencies. Pure over its input (a globals object and an env record).

import { Array as Arr, Option, Record as Rec, Schema, String as Str } from "effect"

export type EnvRecord = Readonly<Record<string, string | undefined>>

/** The global object to probe: `globalThis`, or a stand-in record in tests. */
export type RuntimeGlobals = typeof globalThis | Readonly<Record<string, unknown>>

export interface DetectInput {
	/** The global object (`globalThis` in production). Only the probed keys are read. */
	readonly globals: RuntimeGlobals
	/** Environment variables (`process.env` in production). */
	readonly env: EnvRecord
}

export interface DetectedEnvironment {
	/** "netlify" | "edge-light" | "workerd" | "fastly" | "deno" | "bun" | "node", or "". */
	readonly runtime: string
	/** Hosting / CI provider, lowercased ("vercel", "cloudflare_workers", ...), or "". */
	readonly provider: string
	/** `process.platform` ("linux", "darwin", "win32", ...), or "". */
	readonly platform: string
}

// Globals no lib type declares, each parsed on its own so one odd-shaped value
// cannot hide the others.
const stringAt = <A>(schema: Schema.Codec<A>, pick: (a: A) => string) => {
	const decode = Schema.decodeUnknownOption(schema)
	return (globals: RuntimeGlobals): string => Option.getOrElse(Option.map(decode(globals), pick), () => "")
}
const nodeVersion = stringAt(
	Schema.Struct({ process: Schema.Struct({ versions: Schema.Struct({ node: Schema.String }) }) }),
	(g) => g.process.versions.node,
)
const webcontainer = stringAt(
	Schema.Struct({ process: Schema.Struct({ versions: Schema.Struct({ webcontainer: Schema.String }) }) }),
	(g) => g.process.versions.webcontainer,
)
const processPlatform = stringAt(
	Schema.Struct({ process: Schema.Struct({ platform: Schema.String }) }),
	(g) => g.process.platform,
)
const userAgent = stringAt(
	Schema.Struct({ navigator: Schema.Struct({ userAgent: Schema.String }) }),
	(g) => g.navigator.userAgent,
)

// [provider, env var (defaults to the provider name)]. First set variable wins,
// so the order is load-bearing (CI systems shadow hosts listed after them).
const PROVIDERS: ReadonlyArray<readonly [string, string?]> = [
	["APPVEYOR"],
	["AWS_AMPLIFY", "AWS_APP_ID"],
	["AZURE_PIPELINES", "SYSTEM_TEAMFOUNDATIONCOLLECTIONURI"],
	["AZURE_STATIC", "INPUT_AZURE_STATIC_WEB_APPS_API_TOKEN"],
	["APPCIRCLE", "AC_APPCIRCLE"],
	["BAMBOO", "bamboo_planKey"],
	["BITBUCKET", "BITBUCKET_COMMIT"],
	["BITRISE", "BITRISE_IO"],
	["BUDDY", "BUDDY_WORKSPACE_ID"],
	["BUILDKITE"],
	["CIRCLE", "CIRCLECI"],
	["CIRRUS", "CIRRUS_CI"],
	["CLOUDFLARE_PAGES", "CF_PAGES"],
	["CLOUDFLARE_WORKERS", "WORKERS_CI"],
	["GOOGLE_CLOUDRUN", "K_SERVICE"],
	["GOOGLE_CLOUDRUN_JOB", "CLOUD_RUN_JOB"],
	["CODEBUILD", "CODEBUILD_BUILD_ARN"],
	["CODEFRESH", "CF_BUILD_ID"],
	["DRONE"],
	["DRONE", "DRONE_BUILD_EVENT"],
	["DSARI"],
	["GITHUB_ACTIONS"],
	["GITLAB", "GITLAB_CI"],
	["GITLAB", "CI_MERGE_REQUEST_ID"],
	["GOCD", "GO_PIPELINE_LABEL"],
	["LAYERCI"],
	["JENKINS", "JENKINS_URL"],
	["HUDSON", "HUDSON_URL"],
	["MAGNUM"],
	["NETLIFY"],
	["NETLIFY", "NETLIFY_LOCAL"],
	["NEVERCODE"],
	["RENDER"],
	["SAIL", "SAILCI"],
	["SEMAPHORE"],
	["SCREWDRIVER"],
	["SHIPPABLE"],
	["SOLANO", "TDDIUM"],
	["STRIDER"],
	["TEAMCITY", "TEAMCITY_VERSION"],
	["TRAVIS"],
	["VERCEL", "NOW_BUILDER"],
	["VERCEL", "VERCEL"],
	["VERCEL", "VERCEL_ENV"],
	["APPCENTER", "APPCENTER_BUILD_ID"],
	["CODESANDBOX", "CODESANDBOX_SSE"],
	["CODESANDBOX", "CODESANDBOX_HOST"],
	["STACKBLITZ"],
	["STORMKIT"],
	["CLEAVR"],
	["ZEABUR"],
	["CODESPHERE", "CODESPHERE_APP_ID"],
	["RAILWAY", "RAILWAY_PROJECT_ID"],
	["RAILWAY", "RAILWAY_SERVICE_ID"],
	["DENO-DEPLOY", "DENO_DEPLOY"],
	["DENO-DEPLOY", "DENO_DEPLOYMENT_ID"],
	["FIREBASE_APP_HOSTING", "FIREBASE_APP_HOSTING"],
	["EDGEONE_PAGES", "EO_PAGES_CI"],
]

export const detectProvider = ({ globals, env }: DetectInput): string =>
	Option.match(
		Arr.findFirst(PROVIDERS, ([name, key]) => Boolean(env[key ?? name])),
		{
			onSome: ([name]) => Str.toLowerCase(name),
			onNone: () => (env.SHELL === "/bin/jsh" && webcontainer(globals) !== "" ? "stackblitz" : ""),
		},
	)

// Checked in order: edge runtimes first, since several also expose a Node-like `process`.
const RUNTIMES: ReadonlyArray<readonly [string, (globals: RuntimeGlobals) => boolean]> = [
	["netlify", (g) => "Netlify" in g],
	["edge-light", (g) => "EdgeRuntime" in g],
	["workerd", (g) => userAgent(g) === "Cloudflare-Workers"],
	["fastly", (g) => "fastly" in g],
	["deno", (g) => "Deno" in g],
	["bun", (g) => "Bun" in g],
	["node", (g) => nodeVersion(g) !== ""],
]

export const detectRuntime = (globals: RuntimeGlobals): string =>
	Option.getOrElse(
		Option.map(
			Arr.findFirst(RUNTIMES, ([, matches]) => matches(globals)),
			([name]) => name,
		),
		() => "",
	)

export const detectEnvironment = (input: DetectInput): DetectedEnvironment => ({
	runtime: detectRuntime(input.globals),
	provider: detectProvider(input),
	platform: processPlatform(input.globals),
})

/** Env var names detection reads, besides the caller's own. */
export const DETECT_ENV_KEYS: ReadonlyArray<string> = [
	...Arr.map(PROVIDERS, ([name, key]) => key ?? name),
	"SHELL",
]

/**
 * The given keys of `process.env` on `globals`, read one by one (never
 * enumerated), or `{}` where there is no `process.env` (browsers, plain workerd).
 */
export const readProcessEnv = (globals: RuntimeGlobals, keys: ReadonlyArray<string>): EnvRecord => {
	const fields = Rec.fromIterableWith(keys, (key) => [key, Schema.optionalKey(Schema.String)] as const)
	const decode = Schema.decodeUnknownOption(
		Schema.Struct({ process: Schema.Struct({ env: Schema.Struct(fields) }) }),
	)
	return Option.getOrElse(
		Option.map(decode(globals), (g) => g.process.env),
		() => ({}),
	)
}
