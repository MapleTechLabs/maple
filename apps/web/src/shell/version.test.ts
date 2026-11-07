import { describe, expect, it } from "@effect/vitest"
import { Array as Arr, Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { probeStaleBuild, type StaleSignal } from "./version"

const memoryStorage = () => {
	const values = new Map<string, string>()
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value)
		},
	}
}

// The tab fetches a relative `/version.json`; Node needs an origin to parse it.
const answering = (body: string) =>
	Layer.succeed(
		HttpClient.HttpClient,
		HttpClient.make((request) =>
			Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body))),
		).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("https://app.test"))),
	)

const serving = (commit: string) => answering(JSON.stringify({ commit }))

const visible = Effect.succeed(false)
const hidden = Effect.succeed(true)

const signal: StaleSignal = { trigger: "chunk_load", detail: "Failed to fetch dynamically imported module" }

describe("probeStaleBuild", () => {
	it.effect("reloads once onto a newer deployed build, then leaves it to the banner", () =>
		Effect.gen(function* () {
			const storage = memoryStorage()
			let reloads = 0
			const reload = Effect.sync(() => {
				reloads += 1
			})
			const first = yield* probeStaleBuild(signal, storage, hidden, reload)
			const second = yield* probeStaleBuild(signal, storage, hidden, reload)
			expect(reloads).toBe(1)
			// Both surface the newer commit so the banner shows if the reload did not land.
			expect(Option.map(first, (message) => message.maybeCommit)).toEqual(
				Option.some(Option.some("next-build")),
			)
			expect(Option.isSome(second)).toBe(true)
		}).pipe(Effect.provide(serving("next-build"))),
	)

	it.effect("reloads again for a later deploy", () =>
		Effect.gen(function* () {
			const storage = memoryStorage()
			let reloads = 0
			const reload = Effect.sync(() => {
				reloads += 1
			})
			yield* probeStaleBuild(signal, storage, hidden, reload).pipe(Effect.provide(serving("build-a")))
			yield* probeStaleBuild(signal, storage, hidden, reload).pipe(Effect.provide(serving("build-b")))
			expect(reloads).toBe(2)
		}),
	)

	it.effect("does nothing when the server runs this build", () =>
		Effect.gen(function* () {
			let reloads = 0
			const result = yield* probeStaleBuild(
				signal,
				memoryStorage(),
				hidden,
				Effect.sync(() => {
					reloads += 1
				}),
				"this-build",
			)
			expect(reloads).toBe(0)
			expect(Option.isNone(result)).toBe(true)
		}).pipe(Effect.provide(serving("this-build"))),
	)

	it.effect("does not reload when the deployed commit cannot be read", () =>
		Effect.gen(function* () {
			let reloads = 0
			const result = yield* probeStaleBuild(
				signal,
				memoryStorage(),
				visible,
				Effect.sync(() => {
					reloads += 1
				}),
			)
			expect(reloads).toBe(0)
			expect(Option.isNone(result)).toBe(true)
		}).pipe(
			// A stale CDN answers an unknown path with index.html.
			Effect.provide(answering("<html>")),
		),
	)

	it.effect("does not reload when session storage is unavailable", () =>
		Effect.gen(function* () {
			let reloads = 0
			const throwing = {
				getItem: () => {
					throw new DOMException("denied", "SecurityError")
				},
				setItem: () => {},
			}
			yield* probeStaleBuild(
				signal,
				throwing,
				hidden,
				Effect.sync(() => {
					reloads += 1
				}),
			)
			expect(reloads).toBe(0)
		}).pipe(Effect.provide(serving("next-build"))),
	)
	it.effect("a visible tab gets the banner, never a reload that could drop unsaved edits", () =>
		Effect.gen(function* () {
			const row: StaleSignal = { trigger: "undecodable_row", detail: "alert_incidents x" }
			let reloads = 0
			const reload = Effect.sync(() => {
				reloads += 1
			})
			const shown = yield* Effect.forEach([signal, row], (trigger) =>
				probeStaleBuild(trigger, memoryStorage(), visible, reload),
			)
			expect(Arr.every(shown, Option.isSome)).toBe(true)
			expect(reloads).toBe(0)
		}).pipe(Effect.provide(serving("next-build"))),
	)
})
