import {
	encodeOAuthReturnHash,
	GithubInstallationSelection,
	type OAuthCompleteRequest,
} from "@maple/domain/http"
import { Effect, Option } from "effect"
import { describe, expect, test } from "vitest"
import { completeOAuthReturnWith } from "../page/integrations/oauth-return"
import { captureOAuthReturn, peekOAuthReturn, type ReturnStorage } from "./oauth-return-stash"

/** A tab's sessionStorage. */
const memoryStorage = (): ReturnStorage => {
	const items = new Map<string, string>()
	return {
		getItem: (key) => items.get(key) ?? null,
		setItem: (key, value) => {
			items.set(key, value)
		},
		removeItem: (key) => {
			items.delete(key)
		},
	}
}

const CALLBACK_HASH = encodeOAuthReturnHash({ flow: "cloudflare", query: "code=c-1&state=s-1" })
const BOOT_AT = 1_800_000_000_000

/** The dashboard booting at the callback URL: the fragment the API wrote, before any routing. */
const boot = (storage: ReturnStorage, hash = CALLBACK_HASH) => {
	const stripped: Array<boolean> = []
	Effect.runSync(captureOAuthReturn({ hash, now: BOOT_AT, storage, stripHash: () => stripped.push(true) }))
	return stripped.length > 0
}

/** The integrations module finishing whatever return this tab holds, at `now`. */
const finish = (storage: ReturnStorage, now: number) => {
	const posted: Array<OAuthCompleteRequest> = []
	const outcome = Effect.runSync(
		completeOAuthReturnWith({
			storage,
			now,
			handOff: () => Effect.succeed(false),
			redirect: () => Effect.void,
			complete: (request) =>
				Effect.sync(() => {
					posted.push(request)
					return { status: "success" as const, message: "ok", chat: null }
				}),
		}),
	)
	return { posted, outcome }
}

describe("an OAuth return captured at boot", () => {
	test("takes the fragment off the URL before routing or telemetry can read it", () => {
		expect(boot(memoryStorage())).toBe(true)
	})

	test("completes on the page the data-integration redirect lands on", () => {
		const storage = memoryStorage()
		boot(storage)
		// `/integrations?integration=cloudflare` is replaced by `/sources/new?...`, which drops the
		// fragment; the Sources step embeds the integrations module, which finishes the return.
		const { posted, outcome } = finish(storage, BOOT_AT + 500)
		expect(posted.map((request) => [request.flow, request.query])).toEqual([
			["cloudflare", "code=c-1&state=s-1"],
		])
		expect(outcome?.provider).toBe("cloudflare")
	})

	test("an existing GitHub installation's account choices reach the opener and the full-page return", () => {
		const github = new GithubInstallationSelection({
			state: "verified-choice",
			needsApproval: [],
			unavailable: 0,
			installUrl: "https://github.test/apps/maple/installations/new?state=install-1",
			installations: [
				{
					id: "101",
					accountLogin: "acme",
					accountType: "organization",
					repositorySelection: "selected",
				},
			],
		})
		const forwarded: Array<GithubInstallationSelection | undefined> = []
		for (const hasOpener of [true, false]) {
			const storage = memoryStorage()
			boot(storage, encodeOAuthReturnHash({ flow: "github", query: "code=c-1&state=s-1" }))
			const outcome = Effect.runSync(
				completeOAuthReturnWith({
					storage,
					now: BOOT_AT + 500,
					complete: () =>
						Effect.succeed({
							status: "success",
							message: "Choose an account",
							chat: null,
							github,
						}),
					handOff: (_provider, _status, _message, selection) =>
						Effect.sync(() => {
							forwarded.push(selection)
							return hasOpener
						}),
					redirect: () => Effect.die("an account choice is not redirected"),
				}),
			)
			expect(outcome?.github).toEqual(github)
			expect(outcome?.isHandedOff).toBe(hasOpener)
		}
		expect(forwarded).toEqual([github, github])
	})

	test("a GitHub authorization with nothing to choose sends the window on to install", () => {
		const github = new GithubInstallationSelection({
			state: "empty-choice",
			needsApproval: [],
			unavailable: 0,
			installUrl: "https://github.test/apps/maple/installations/new?state=install-1",
			installations: [],
		})
		const storage = memoryStorage()
		boot(storage, encodeOAuthReturnHash({ flow: "github", query: "code=c-1&state=s-1" }))
		const redirected: Array<string> = []
		const handedOff: Array<string> = []
		const outcome = Effect.runSync(
			completeOAuthReturnWith({
				storage,
				now: BOOT_AT + 500,
				complete: () => Effect.succeed({ status: "success", message: "ok", chat: null, github }),
				handOff: (provider) => Effect.sync(() => (handedOff.push(provider), true)),
				redirect: (url) => Effect.sync(() => void redirected.push(url)),
			}),
		)
		expect(redirected).toEqual([github.installUrl])
		expect(handedOff).toEqual([])
		expect(outcome?.isHandedOff).toBe(true)
	})

	test("installations it could not connect stay on the page instead of redirecting to install", () => {
		const github = new GithubInstallationSelection({
			state: "unavailable-choice",
			needsApproval: [],
			unavailable: 1,
			installUrl: "https://github.test/apps/maple/installations/new?state=install-1",
			installations: [],
		})
		const storage = memoryStorage()
		boot(storage, encodeOAuthReturnHash({ flow: "github", query: "code=c-1&state=s-1" }))
		const outcome = Effect.runSync(
			completeOAuthReturnWith({
				storage,
				now: BOOT_AT + 500,
				complete: () => Effect.succeed({ status: "success", message: "ok", chat: null, github }),
				handOff: () => Effect.succeed(false),
				redirect: () => Effect.die("an account it could not connect is not redirected"),
			}),
		)
		expect(outcome?.github).toEqual(github)
	})

	test("completes after a sign-in round trip, and only once", () => {
		const storage = memoryStorage()
		boot(storage)
		// Signed out: `/sign-in?redirect_url=/integrations?...` carries no fragment either.
		expect(finish(storage, BOOT_AT + 90_000).posted).toHaveLength(1)
		expect(finish(storage, BOOT_AT + 91_000).posted).toHaveLength(0)
	})

	test("drops a return older than its state could be", () => {
		const storage = memoryStorage()
		boot(storage)
		expect(finish(storage, BOOT_AT + 11 * 60_000).posted).toHaveLength(0)
	})

	test("leaves an ordinary fragment alone", () => {
		const storage = memoryStorage()
		expect(boot(storage, "#section-2")).toBe(false)
		expect(finish(storage, BOOT_AT).posted).toHaveLength(0)
	})

	test("onboarding sees which provider returned without taking it from the flow that finishes it", () => {
		const storage = memoryStorage()
		boot(storage)
		const peeked = Effect.runSync(peekOAuthReturn(storage, BOOT_AT + 500))
		expect(Option.map(peeked, (request) => request.flow)).toEqual(Option.some("cloudflare"))
		expect(finish(storage, BOOT_AT + 600).posted).toHaveLength(1)
		expect(Effect.runSync(peekOAuthReturn(storage, BOOT_AT + 700))).toEqual(Option.none())
	})

	test("a return older than its state reads as none to onboarding too", () => {
		const storage = memoryStorage()
		boot(storage)
		expect(Effect.runSync(peekOAuthReturn(storage, BOOT_AT + 11 * 60_000))).toEqual(Option.none())
	})
})
