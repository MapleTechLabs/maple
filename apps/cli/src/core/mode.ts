import { Context, Duration, Effect, Layer, Option, Predicate, Redacted, Schema } from "effect"
import { FileSystem } from "effect/FileSystem"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as os from "node:os"
import * as path from "node:path"
import { MapleConfig } from "./config"

/**
 * Mode resolution failure, surfaced to the user with an actionable hint. Only
 * raised when a command actually needs a backend (i.e. touches the
 * WarehouseExecutor); `login`/`logout`/`whoami` never trigger it.
 */
export class ModeError extends Schema.TaggedError<ModeError>()("@maple/cli/ModeError", {
	message: Schema.String,
	hint: Schema.optionalKey(Schema.String),
}) {}

type ResolvedMode =
	| { readonly _tag: "local"; readonly baseUrl: string }
	| {
			readonly _tag: "remote"
			readonly apiUrl: string
			readonly token: string
			readonly orgId: string | undefined
	  }

// `--remote` / `--local` are declared as shared flags on the root command (so
// parsing accepts them and `--help` lists them); the decision reads argv here
// because the executor layer is constructed outside the parsed-flag context.
const hasFlag = (name: string): boolean =>
	typeof process !== "undefined" && Array.isArray(process.argv) && process.argv.includes(name)

/** What answered at the local URL. */
export type ProbeResult = "maple" | "busy" | "absent" | "foreign"

/** chDB runs queries synchronously, so a busy server can take a while to answer. */
export const PROBE_TIMEOUT = Duration.millis(1500)

const LocalStatus = Schema.Struct({ service: Schema.String })
const decodeLocalStatus = Schema.decodeUnknownOption(Schema.fromJsonString(LocalStatus))

/**
 * Identify the server at `baseUrl` by `GET /local/status`, which only a Maple
 * binary answers with `service: "maple-local"`. A 404 there means a binary
 * that predates the route, so `/health` answering exactly `OK` is accepted.
 * Refused is `absent`; no answer in time is `busy`, not absent.
 *
 * Untraced: "no local server" is the normal answer for remote users, and
 * recording it as an `Error` span buried real failures.
 */
export const probeLocal = (
	client: HttpClient.HttpClient,
	baseUrl: string,
	timeout: Duration.Duration = PROBE_TIMEOUT,
): Effect.Effect<ProbeResult> => {
	const base = baseUrl.replace(/\/$/, "")
	const get = (route: string) =>
		client.execute(HttpClientRequest.get(`${base}${route}`)).pipe(
			Effect.flatMap((response) =>
				Effect.map(response.text.pipe(Effect.orElseSucceed(() => "")), (body) => ({
					status: response.status,
					body,
				})),
			),
		)
	const ok = (status: number) => status >= 200 && status < 300
	const legacyHealth = get("/health").pipe(
		Effect.map(
			({ status, body }): ProbeResult => (ok(status) && body.trim() === "OK" ? "maple" : "foreign"),
		),
	)
	return get("/local/status").pipe(
		Effect.flatMap(({ status, body }) => {
			if (status === 404) return legacyHealth
			const parsed = decodeLocalStatus(body)
			return Effect.succeed<ProbeResult>(
				ok(status) && Option.isSome(parsed) && parsed.value.service === "maple-local"
					? "maple"
					: "foreign",
			)
		}),
		Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.succeed<ProbeResult>("busy") }),
		Effect.orElseSucceed((): ProbeResult => "absent"),
		Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
	)
}

/** Where `maple start` advertises itself: `maple-server.json` for the default
 * store, `<name>.maple-server.json` beside any other store in this directory. */
export const MAPLE_DIR = path.join(os.homedir(), ".maple")
export const SERVER_DISCOVERY_FILE = path.join(MAPLE_DIR, "maple-server.json")

const ServerDiscovery = Schema.Struct({ pid: Schema.Number, url: Schema.String })
const decodeServerDiscovery = Schema.decodeUnknownOption(Schema.fromJsonString(ServerDiscovery))

const errorCode = (cause: unknown): string | undefined =>
	Predicate.hasProperty(cause, "code") && Predicate.isString(cause.code) ? cause.code : undefined

/** Signal 0 checks existence; EPERM means it exists under another user. */
const pidAlive = (pid: number): Effect.Effect<boolean> =>
	Effect.try({ try: () => process.kill(pid, 0), catch: errorCode }).pipe(
		Effect.as(true),
		Effect.catch((code) => Effect.succeed(code === "EPERM")),
	)

/** The running server's URL from one discovery file, when its pid is alive. */
export const discoverLocalUrl = (fs: FileSystem, file: string = SERVER_DISCOVERY_FILE) =>
	fs.readFileString(file).pipe(
		Effect.map(decodeServerDiscovery),
		Effect.flatMap(
			Option.match({
				onNone: () => Effect.succeed(Option.none<string>()),
				onSome: (found) =>
					Effect.map(pidAlive(found.pid), (alive) =>
						alive ? Option.some(found.url) : Option.none<string>(),
					),
			}),
		),
		Effect.orElseSucceed(() => Option.none<string>()),
	)

export interface DiscoveredServers {
	/** The server to use: the default store's, else the only other one running. */
	readonly url: Option.Option<string>
	/** Set when several non-default servers run and none could be picked. */
	readonly ambiguous: ReadonlyArray<string>
}

/** Find a running `maple start` through the discovery files in `dir`. */
export const discoverServers = (fs: FileSystem, dir: string = MAPLE_DIR): Effect.Effect<DiscoveredServers> =>
	Effect.gen(function* () {
		const primary = yield* discoverLocalUrl(fs, path.join(dir, "maple-server.json"))
		if (Option.isSome(primary)) return { url: primary, ambiguous: [] }
		const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed((): Array<string> => []))
		const found = yield* Effect.forEach(
			names.filter((name) => name.endsWith(".maple-server.json")).sort(),
			(name) => discoverLocalUrl(fs, path.join(dir, name)),
		)
		const urls = found.flatMap((url) => (Option.isSome(url) ? [url.value] : []))
		const only = urls.length === 1 ? urls[0] : undefined
		return only === undefined
			? { url: Option.none(), ambiguous: urls }
			: { url: Option.some(only), ambiguous: [] }
	})

const LOCAL_URL_HINT =
	"start one with `maple start`, set MAPLE_LOCAL_URL if it runs elsewhere, or run `maple login` for a remote workspace"

/** The ModeError for a probe that did not find a usable Maple server. */
export const probeFailure = (result: Exclude<ProbeResult, "maple">, url: string): ModeError => {
	switch (result) {
		case "busy":
			return new ModeError({
				message: `the Maple server at ${url} did not answer within ${Duration.toMillis(PROBE_TIMEOUT) / 1000}s; it may be busy with a long query`,
				hint: "retry in a moment, or pass --local to skip the check and wait for it",
			})
		case "foreign":
			return new ModeError({
				message: `something is listening at ${url}, but it is not a Maple server`,
				hint: "point MAPLE_LOCAL_URL at the address `maple start` printed",
			})
		case "absent":
			return new ModeError({
				message: `no Maple backend found: nothing is listening at ${url}`,
				hint: LOCAL_URL_HINT,
			})
	}
}

export interface ModeApi {
	/** Resolve the active backend. Fails with `ModeError` if none is available. */
	readonly resolve: Effect.Effect<ResolvedMode, ModeError>
}

export class Mode extends Context.Service<Mode, ModeApi>()("@maple/cli/Mode", {
	make: Effect.gen(function* () {
		const config = yield* MapleConfig
		const client = yield* HttpClient.HttpClient
		const fs = yield* FileSystem

		const remoteConfig = Option.map(
			Option.all({ apiUrl: config.apiUrl, token: config.token }),
			({ apiUrl, token }): ResolvedMode => ({
				_tag: "remote",
				apiUrl,
				token: Redacted.value(token),
				orgId: Option.getOrUndefined(config.orgId),
			}),
		)
		const remote = Option.getOrUndefined(remoteConfig)

		// MAPLE_LOCAL_URL wins; otherwise a running `maple start` on a non-default
		// port is found through its discovery file.
		const localUrl: Effect.Effect<string> =
			process.env.MAPLE_LOCAL_URL === undefined
				? Effect.flatMap(discoverServers(fs), (found) =>
						Effect.sync(() => {
							if (found.ambiguous.length > 1) {
								process.stderr.write(
									`note: several Maple servers are running (${found.ambiguous.join(", ")}); using ${config.localUrl}. Set MAPLE_LOCAL_URL to pick one.\n`,
								)
							}
							return Option.getOrElse(found.url, () => config.localUrl)
						}),
					)
				: Effect.succeed(config.localUrl)
		const local = Effect.map(localUrl, (baseUrl): ResolvedMode => ({ _tag: "local", baseUrl }))

		const resolveOnce: Effect.Effect<ResolvedMode, ModeError> = Effect.gen(function* () {
			const forceRemote = hasFlag("--remote")
			const forceLocal = hasFlag("--local")

			if (forceRemote && forceLocal) {
				return yield* new ModeError({
					message: "--remote and --local cannot be used together",
					hint: "pass one of them, or neither to auto-detect",
				})
			}
			if (forceRemote) {
				if (remote === undefined) {
					return yield* new ModeError({
						message: "remote mode needs a workspace, and none is configured",
						hint: "run `maple login`, or set MAPLE_API_URL and MAPLE_API_TOKEN",
					})
				}
				return remote
			}
			if (forceLocal) return yield* local

			// Stored preference.
			if (Option.contains(config.defaultMode, "remote") && remote !== undefined) return remote
			if (Option.contains(config.defaultMode, "local")) return yield* local

			// Auto-detect: a configured token implies remote; otherwise probe for a
			// running local binary.
			if (remote !== undefined) return remote
			const baseUrl = yield* localUrl
			const probe = yield* probeLocal(client, baseUrl)
			if (probe === "maple") return { _tag: "local", baseUrl } satisfies ResolvedMode
			return yield* probeFailure(probe, baseUrl)
		})

		// Operations and the executor both ask; argv and env cannot change, so probe once.
		const resolve = yield* Effect.cached(resolveOnce)
		return { resolve } satisfies ModeApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
