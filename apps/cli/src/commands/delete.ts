import { Effect, Option, Schema } from "effect"
import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { readFileSync } from "node:fs"
import { Mode } from "../core/mode"
import { parseTimestampMs, sinceToMs } from "../core/time"
import { CliUsageError } from "../lib/errors"
import { bold, dim, green } from "../lib/style"
import { isLoopbackHostname } from "../lib/local-address"
import { maintenanceTokenPath } from "../server/archives/retention"
import { hasSubject, ScopedDeleteReport, ScopedDeleteRequest } from "../server/scoped-delete"
import { jsonFormatRequested, writeJson } from "./json-output"
import { serverDiscoveryPath } from "../server/store-version"
import { isProcessAlive, LocalStatus, prettyPath, ServerDiscovery } from "./server-args"

const LOCAL_ONLY = "maple delete removes data from a local store only"

/** Resolve the local server to delete from; remote mode is refused, never forwarded. */
export const resolveDeleteBaseUrl = Effect.gen(function* () {
	if (process.argv.includes("--remote"))
		return yield* new CliUsageError({
			message: `${LOCAL_ONLY}; --remote is not supported`,
			hint: "drop --remote and run it against a `maple start` server",
		})
	const resolved = yield* (yield* Mode).resolve
	if (resolved._tag !== "local")
		return yield* new CliUsageError({
			message: `${LOCAL_ONLY}, and the active mode is remote`,
			hint: "pass --local to target the running `maple start` server",
		})
	return resolved.baseUrl.replace(/\/$/, "")
})

/** `--before` as a relative age (`7d`, `12h`) or an absolute UTC timestamp. */
export const parseBefore = (raw: string, nowMs: number): number | null => {
	const age = sinceToMs(raw)
	return age === null ? parseTimestampMs(raw) : nowMs - age
}

const failure = (message: string, hint?: string) =>
	hint === undefined ? new CliUsageError({ message }) : new CliUsageError({ message, hint })

/** Present flags as a request; a blank `--service` or `--namespace` counts as absent. */
export const buildDeleteRequest = (flags: {
	readonly service: string | undefined
	readonly namespace: string | undefined
	readonly env: string | undefined
	readonly beforeMs: number | undefined
}): Effect.Effect<ScopedDeleteRequest, CliUsageError> =>
	Effect.gen(function* () {
		const present = Object.entries({
			service: flags.service?.trim() || undefined,
			namespace: flags.namespace?.trim() || undefined,
			env: flags.env,
			beforeMs: flags.beforeMs === undefined ? undefined : Math.floor(flags.beforeMs),
		}).filter(([, value]) => value !== undefined)
		const request = yield* Schema.decodeUnknownEffect(ScopedDeleteRequest)(Object.fromEntries(present)).pipe(
			Effect.mapError(() =>
				failure(
					"invalid delete flags",
					"--service, --namespace and --env take at most 512 characters, and --before must be after 1970",
				),
			),
		)
		if (!hasSubject(request))
			return yield* failure("pass --service, --namespace, or both", "e.g. maple delete --namespace pr-42")
		return request
	})

const decodeDiscovery = Schema.decodeUnknownOption(Schema.fromJsonString(ServerDiscovery))

/**
 * The maintenance token goes only to the live loopback server its own store's
 * discovery file names; any server could otherwise claim another store's dataDir.
 */
export const verifyStoreServer = (
	baseUrl: string,
	status: LocalStatus,
	deps: {
		readonly readDiscovery: (path: string) => string
		readonly isAlive: (pid: number) => boolean
	} = { readDiscovery: (path) => readFileSync(path, "utf8"), isAlive: isProcessAlive },
): Effect.Effect<void, CliUsageError> =>
	Effect.gen(function* () {
		const target = URL.canParse(baseUrl) ? new URL(baseUrl) : undefined
		if (target === undefined || !isLoopbackHostname(target.hostname.replace(/^\[(.*)\]$/, "$1")))
			return yield* failure(
				`maple delete only talks to a loopback server, not ${baseUrl}`,
				"run it on the machine that runs `maple start`, against 127.0.0.1",
			)
		const path = serverDiscoveryPath(status.dataDir)
		const discovery = Option.flatMap(
			Option.liftThrowable(deps.readDiscovery)(path),
			decodeDiscovery,
		)
		const port = (url: string) => (URL.canParse(url) ? new URL(url).port : undefined)
		const matches = Option.exists(
			discovery,
			(found) =>
				found.pid === status.pid &&
				found.dataDir === status.dataDir &&
				port(found.url) === target.port &&
				deps.isAlive(found.pid),
		)
		if (!matches)
			return yield* failure(
				`the server at ${baseUrl} is not the live server ${prettyPath(path)} names`,
				"point MAPLE_LOCAL_URL at the `maple start` that owns this store",
			)
	})

const postDelete = (baseUrl: string, body: ScopedDeleteRequest & { readonly dryRun: boolean }) =>
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient
		const status = yield* HttpClient.get(`${baseUrl}/local/status`).pipe(
			Effect.flatMap(HttpClientResponse.filterStatusOk),
			Effect.flatMap(HttpClientResponse.schemaBodyJson(LocalStatus)),
			Effect.mapError(() => failure(`no Maple server answered at ${baseUrl}`, "start one with `maple start`")),
		)
		yield* verifyStoreServer(baseUrl, status)
		// The token sits beside the data dir, so only the machine that owns the store can delete.
		const tokenPath = maintenanceTokenPath(status.dataDir)
		const token = yield* Effect.try({
			try: () => readFileSync(tokenPath, "utf8").trim(),
			catch: () =>
				failure(
					`cannot read the maintenance token at ${prettyPath(tokenPath)}`,
					"run maple delete as the same user, on the machine that runs `maple start`",
				),
		})
		const response = yield* client
			.execute(
				HttpClientRequest.post(`${baseUrl}/local/maintenance/delete`).pipe(
					HttpClientRequest.setHeader("x-maple-maintenance-token", token),
					HttpClientRequest.bodyText(JSON.stringify(body), "application/json"),
				),
			)
			.pipe(Effect.mapError((error) => failure(`delete request failed: ${error.message}`)))
		const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
		if (response.status === 404)
			return yield* failure("this server predates `maple delete`", "update with `maple update` and restart it")
		if (response.status < 200 || response.status >= 300)
			return yield* failure(text || `server answered HTTP ${response.status}`)
		return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ScopedDeleteReport))(text).pipe(
			Effect.mapError(() => failure("the server returned an unreadable delete report")),
		)
	})

const describeRequest = (request: ScopedDeleteRequest): string =>
	[
		...(request.service === undefined ? [] : [`service ${bold(request.service)}`]),
		...(request.namespace === undefined ? [] : [`namespace ${bold(request.namespace)}`]),
		...(request.env === undefined ? [] : [`env ${bold(request.env === "" ? '""' : request.env)}`]),
		...(request.beforeMs === undefined ? [] : [`before ${bold(new Date(request.beforeMs).toISOString())}`]),
	].join(", ")

const renderReport = (report: ScopedDeleteReport): string => {
	const lines = report.tables
		.filter((t) => t.strategy !== "excluded" && (t.rows > 0 || (t.skippedHours ?? 0) > 0))
		.map((t) =>
			t.strategy === "filter"
				? `  ${t.table.padEnd(36)} ${t.rows} row(s)`
				: `  ${t.table.padEnd(36)} ${t.rebuiltHours} hour(s) recomputed` +
					((t.skippedHours ?? 0) > 0 ? dim(`, ${t.skippedHours} past source retention kept`) : ""),
		)
	return lines.length === 0 ? `  ${dim("nothing matched")}\n` : `${lines.join("\n")}\n`
}

export const deleteCommand = Command.make("delete", {
	service: Flag.optional(
		Flag.String("service").pipe(Flag.withDescription("service.name whose telemetry to delete")),
	),
	namespace: Flag.optional(
		Flag.String("namespace").pipe(
			Flag.withDescription("service.namespace whose telemetry to delete (with --service: both must match)"),
		),
	),
	env: Flag.optional(
		Flag.String("env").pipe(
			Flag.withDescription("Only rows whose deployment.environment(.name) equals this value"),
		),
	),
	before: Flag.optional(
		Flag.String("before").pipe(
			Flag.withDescription(
				"Only rows older than this: an age (7d, 12h) or UTC timestamp; floored to the hour",
			),
		),
	),
	yes: Flag.Boolean("yes").pipe(
		Flag.withDescription("Delete; without it the command only previews what would go"),
		Flag.withDefault(false),
	),
}).pipe(
	Command.withDescription(
		"Delete a service's or namespace's telemetry from the local store: raw tables and every derived rollup (local only)",
	),
	Command.withExamples([
		{ command: "maple delete --service checkout-pr-42" },
		{ command: "maple delete --namespace pr-42 --yes" },
		{ command: "maple delete --service api --env preview-17 --yes" },
		{ command: "maple delete --service api --before 7d --yes" },
	]),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const baseUrl = yield* resolveDeleteBaseUrl
			const rawBefore = Option.getOrUndefined(a.before)
			const beforeMs = rawBefore === undefined ? undefined : parseBefore(rawBefore, Date.now())
			if (beforeMs === null)
				return yield* failure(`invalid --before: ${rawBefore}`, "use an age like 7d or a timestamp like 2026-10-01 12:00")
			const request = yield* buildDeleteRequest({
				service: Option.getOrUndefined(a.service),
				namespace: Option.getOrUndefined(a.namespace),
				env: Option.getOrUndefined(a.env),
				beforeMs,
			})
			const report = yield* postDelete(baseUrl, { ...request, dryRun: !a.yes })
			if (jsonFormatRequested()) yield* writeJson(report)
			else
				yield* Effect.sync(() =>
					process.stderr.write(
						`${a.yes ? green("✓ deleted") : "would delete"} ${describeRequest(report.request)}\n` +
							renderReport(report) +
							(a.yes
								? dim(
										"  Checkpoints taken before now still hold these rows until the next refresh; `maple checkpoint` refreshes now.\n",
									)
								: ""),
					),
				)
			if (!a.yes && report.tables.some((t) => t.rows > 0))
				return yield* failure("nothing was deleted (preview)", "re-run with --yes to delete")
		}),
	),
)
