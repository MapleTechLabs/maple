import { Context, Effect, Layer, Schema } from "effect"
import { MapleConfig } from "./config"

/**
 * Mode resolution failure — surfaced to the user with an actionable hint. Only
 * raised when a command actually needs a backend (i.e. touches the
 * WarehouseExecutor); `login`/`logout`/`whoami` never trigger it.
 */
class ModeError extends Schema.TaggedErrorClass<ModeError>()("@maple/cli/ModeError", {
	message: Schema.String,
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
// parsing accepts them and `--help` lists them); the actual decision reads
// argv here because the executor layer is constructed outside the parsed-flag
// context. Scanning argv is position-independent (`maple --remote services`
// and `maple services --remote` both work).
const hasFlag = (name: string): boolean =>
	typeof process !== "undefined" && Array.isArray(process.argv) && process.argv.includes(name)

/** Fast, non-fatal liveness probe of the local binary's `/health` route. */
const probeLocal = (baseUrl: string): Effect.Effect<boolean> =>
	Effect.tryPromise(async () => {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), 400)
		try {
			const res = await fetch(`${baseUrl.replace(/\/$/, "")}/health`, { signal: controller.signal })
			return res.ok
		} finally {
			clearTimeout(timer)
		}
	}).pipe(Effect.orElseSucceed(() => false))

export interface ModeShape {
	/** Resolve the active backend. Fails with `ModeError` if none is available. */
	readonly resolve: Effect.Effect<ResolvedMode, ModeError>
}

export class Mode extends Context.Service<Mode, ModeShape>()("@maple/cli/Mode", {
	make: Effect.gen(function* () {
		const config = yield* MapleConfig

		const hasRemoteCreds = !!config.token && !!config.apiUrl
		const remote = (): ResolvedMode => ({
			_tag: "remote",
			apiUrl: config.apiUrl!,
			token: config.token!,
			orgId: config.orgId,
		})
		const local = (): ResolvedMode => ({ _tag: "local", baseUrl: config.localUrl })

		const resolve: Effect.Effect<ResolvedMode, ModeError> = Effect.gen(function* () {
			const forceRemote = hasFlag("--remote")
			const forceLocal = hasFlag("--local")

			if (forceRemote && forceLocal) {
				return yield* new ModeError({ message: "Cannot use --remote and --local together." })
			}
			if (forceRemote) {
				if (!hasRemoteCreds) {
					return yield* new ModeError({
						message:
							"Remote mode needs a workspace. Run `maple login`, or set MAPLE_API_URL + MAPLE_API_TOKEN.",
					})
				}
				return remote()
			}
			if (forceLocal) return local()

			// Stored preference.
			if (config.defaultMode === "remote" && hasRemoteCreds) return remote()
			if (config.defaultMode === "local") return local()

			// Auto-detect: a configured token implies remote; otherwise probe for a
			// running local binary.
			if (hasRemoteCreds) return remote()
			if (yield* probeLocal(config.localUrl)) return local()

			return yield* new ModeError({
				message:
					"No Maple backend found. Start local mode with `maple start`, or run `maple login` to connect a remote workspace. Override with --local / --remote.",
			})
		})

		return { resolve } satisfies ModeShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
