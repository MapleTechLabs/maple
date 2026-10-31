import { decodeOAuthReturnHash, type OAuthCompleteRequest } from "@maple/domain/http"
import { Effect, Option, Schema } from "effect"

// An OAuth return (`#maple_oauth=…`) is captured once at boot and kept in this tab's
// sessionStorage, so it survives the route redirects and the sign-in round trip that drop the
// fragment, and is finished by whichever page loads the integrations module.

const KEY = "maple:oauth-return"

/** The state row's own lifetime: a return older than this can only fail. */
const TTL_MS = 10 * 60_000

export interface ReturnStorage {
	readonly getItem: (key: string) => string | null
	readonly setItem: (key: string, value: string) => void
	readonly removeItem: (key: string) => void
}

/** The tab's sessionStorage, reached lazily: reading it can throw where storage is disabled. */
export const browserStorage: ReturnStorage = {
	getItem: (key) => window.sessionStorage.getItem(key),
	setItem: (key, value) => window.sessionStorage.setItem(key, value),
	removeItem: (key) => window.sessionStorage.removeItem(key),
}

const Stashed = Schema.fromJsonString(Schema.Struct({ hash: Schema.String, savedAt: Schema.Number }))
const decodeStashed = Schema.decodeUnknownOption(Stashed)
const encodeStashed = Schema.encodeSync(Stashed)

/**
 * Take a return off the URL and stash it. The fragment carries an authorization code, so it is
 * stripped even when the stash fails. False when the fragment is not a return.
 */
export const captureOAuthReturn = (env: {
	readonly hash: string
	readonly now: number
	readonly storage: ReturnStorage
	readonly stripHash: () => void
}): Effect.Effect<boolean> =>
	Effect.gen(function* () {
		if (Option.isNone(decodeOAuthReturnHash(env.hash))) return false
		yield* Effect.sync(env.stripHash)
		yield* Effect.try(() =>
			env.storage.setItem(KEY, encodeStashed({ hash: env.hash, savedAt: env.now })),
		).pipe(Effect.ignore)
		return true
	})

const readStashed = (storage: ReturnStorage) =>
	Effect.try(() => storage.getItem(KEY)).pipe(Effect.orElseSucceed(() => null))

const decodeFresh = (raw: string, now: number): Option.Option<OAuthCompleteRequest> =>
	decodeStashed(raw).pipe(
		Option.filter((stashed) => stashed.savedAt <= now && now - stashed.savedAt <= TTL_MS),
		Option.flatMap((stashed) => decodeOAuthReturnHash(stashed.hash)),
	)

/** The stashed return, removed as it is read; none once it is older than its state could be. */
export const takeOAuthReturn = (
	storage: ReturnStorage,
	now: number,
): Effect.Effect<Option.Option<OAuthCompleteRequest>> =>
	Effect.gen(function* () {
		const raw = yield* readStashed(storage)
		if (raw === null) return Option.none()
		yield* Effect.try(() => storage.removeItem(KEY)).pipe(Effect.ignore)
		return decodeFresh(raw, now)
	})

/** The stashed return left in place, for a screen that opens the page which takes it. */
export const peekOAuthReturn = (
	storage: ReturnStorage,
	now: number,
): Effect.Effect<Option.Option<OAuthCompleteRequest>> =>
	Effect.map(readStashed(storage), (raw) => (raw === null ? Option.none() : decodeFresh(raw, now)))
