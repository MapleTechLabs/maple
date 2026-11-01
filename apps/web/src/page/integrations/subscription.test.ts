import { OrgId } from "@maple/domain"
import { GithubIntegrationStatus } from "@maple/domain/http"
import { V2PlanetScaleIntegration } from "@maple/domain/http/v2"
import { Clock, Effect, Fiber, Ref, Result, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { click, Command, expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResourcesLive } from "../../platform/resources"
import type { PageContext } from "../contract"
import { ReadClock } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { subscriptions } from "./subscription"
import { init, routeChanged, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const step = (model: Model, message: Message) => update(model, message, context).model
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const status = (fields: Partial<Record<keyof V2PlanetScaleIntegration, unknown>>) =>
	Schema.decodeUnknownSync(V2PlanetScaleIntegration)({
		object: "planetscale_integration",
		connected: true,
		pending_org_selection: false,
		organization: "acme",
		connected_by_user_id: null,
		detected_permissions: null,
		metrics_auth: "api",
		scrape_target: null,
		last_inventory_at: null,
		last_inventory_error: null,
		revoked_at: null,
		expires_at: null,
		api_metrics: { last_polled_at: null, last_error: null },
		...fields,
	})

/** The PlanetScale card open on `status`, with the page's first clock read at 0. */
const cardOn = (integration: V2PlanetScaleIntegration): Model => {
	const model = init({ search: { integration: "planetscale" } }, context).model
	const loaded = step(
		model,
		Message.CompletedLoadPlanetscale({
			key: model.statuses.planetscale.key ?? "",
			result: Result.succeed(integration),
		}),
	)
	return step(loaded, Message.CompletedReadClock({ nowMs: 0 }))
}

const view = withViewInputs(pageView, { context })()
const THIRTY_MINUTES_MS = 30 * 60 * 1000

const { planetscaleWatch } = subscriptions
const isWatching = (model: Model) => planetscaleWatch.modelToDependencies({ model, context }).isWatching

/**
 * A tab left open on the card for `hours`: each tick runs `update` and the clock read it asks
 * for, as the runtime does, and the stream ends once the dependencies stop watching.
 */
const leftOpen = (model: Model, hours: number) =>
	Effect.gen(function* () {
		const state = yield* Ref.make({ model, reads: 0 })
		const ticks = planetscaleWatch.dependenciesToStream({ isWatching: isWatching(model) }).pipe(
			Stream.mapEffect((message) =>
				Effect.flatMap(Clock.currentTimeMillis, (nowMs) =>
					Ref.updateAndGet(state, (current) => ({
						reads: current.reads + 1,
						model: step(step(current.model, message), Message.CompletedReadClock({ nowMs })),
					})),
				),
			),
			Stream.takeUntil((current) => !isWatching(current.model)),
		)
		yield* Effect.forkChild(Stream.runDrain(ticks))
		yield* Effect.yieldNow
		yield* TestClock.adjust(`${hours} hours`)
		return yield* Ref.get(state)
	}).pipe(Effect.provide([TestClock.layer(), ResourcesLive]), Effect.runPromise)

describe("planetscale first-metrics watch", () => {
	test("a tab left open on a stuck card stops reading the status after 30 minutes", async () => {
		const stuck = await leftOpen(cardOn(status({})), 6.5)
		// 24 reads in the first 2 minutes at 5 s, then one a minute until minute 30.
		expect(stuck.reads).toBe(52)
		expect(isWatching(stuck.model)).toBe(false)
	})

	test("a card that is not connected, or waits on an organization, does not watch", () => {
		expect(isWatching(cardOn(status({ connected: false })))).toBe(false)
		expect(isWatching(cardOn(status({ connected: false, pending_org_selection: true })))).toBe(false)
	})

	test("the watch ends once the first metrics land", () => {
		const watching = cardOn(status({}))
		expect(isWatching(watching)).toBe(true)
		const landed = step(
			watching,
			Message.CompletedLoadPlanetscale({
				key: watching.statuses.planetscale.key ?? "",
				result: Result.succeed(
					status({ api_metrics: { last_polled_at: "1970-01-01T00:00:00.000Z", last_error: null } }),
				),
			}),
		)
		expect(isWatching(landed)).toBe(false)
	})

	test("a connection made long after the page opened gets its own full window", () => {
		const idle = step(
			cardOn(status({ connected: false })),
			Message.CompletedReadClock({ nowMs: THIRTY_MINUTES_MS * 2 }),
		)
		const connected = step(
			idle,
			Message.CompletedLoadPlanetscale({
				key: idle.statuses.planetscale.key ?? "",
				result: Result.succeed(status({})),
			}),
		)
		expect(isWatching(connected)).toBe(true)
		const read = step(connected, Message.CompletedReadClock({ nowMs: THIRTY_MINUTES_MS * 2 + 5_000 }))
		expect(isWatching(read)).toBe(true)
	})

	test("after the watch runs out the card offers Check again, which restarts it", async () => {
		const stuck = await leftOpen(cardOn(status({})), 1)
		const stalled = text("Still no metrics after 30 minutes, so this stopped checking on its own.")
		scene(
			{ update: (model: Model, message: Message) => update(model, message, context), view },
			given(stuck.model),
			expectView(stalled).toExist(),
			click(role("button", { name: "Check again" })),
			Command.resolve(ReadClock, Message.CompletedReadClock({ nowMs: stuck.model.nowMs + 1_000 })),
			expectView(stalled).not.toExist(),
		)
		const again = step(stuck.model, Message.ClickedPlanetscaleCheckAgain())
		expect(isWatching(again)).toBe(true)
		const read = step(again, Message.CompletedReadClock({ nowMs: stuck.model.nowMs + 1_000 }))
		expect(isWatching(read)).toBe(true)
	})

	test("time spent on another integration does not count against the watch", () => {
		const watching = step(cardOn(status({})), Message.CompletedReadClock({ nowMs: 5_000 }))
		const away = routeChanged(watching, { search: { integration: "gcp" } }, context).model
		const later = step(away, Message.CompletedReadClock({ nowMs: THIRTY_MINUTES_MS * 2 }))
		const back = routeChanged(later, { search: { integration: "planetscale" } }, context)
		expect(names(back.commands)).toContain("ReadIntegrationsClock")
		const read = step(back.model, Message.CompletedReadClock({ nowMs: THIRTY_MINUTES_MS * 2 + 5_000 }))
		expect(isWatching(read)).toBe(true)
		expect(isWatching(step(read, Message.CompletedReadClock({ nowMs: THIRTY_MINUTES_MS * 3 })))).toBe(
			true,
		)
	})

	test("a reconnect on a card whose watch ran out watches again", async () => {
		const stuck = await leftOpen(cardOn(status({})), 1)
		expect(isWatching(stuck.model)).toBe(false)
		const reconnected = update(
			stuck.model,
			Message.ReceivedConnectMessage({ provider: "planetscale", status: "success", message: null }),
			context,
		).model
		const loaded = update(
			reconnected,
			Message.CompletedLoadPlanetscale({
				key: reconnected.statuses.planetscale.key ?? "",
				result: Result.succeed(status({})),
			}),
			context,
		)
		expect(names(loaded.commands)).toContain("ReadIntegrationsClock")
		const read = step(loaded.model, Message.CompletedReadClock({ nowMs: stuck.model.nowMs + 1_000 }))
		expect(isWatching(read)).toBe(true)
	})

	test("choosing another organization on a card whose watch ran out watches again", async () => {
		const stuck = await leftOpen(cardOn(status({})), 1)
		const selected = step(
			stuck.model,
			Message.CompletedSelectOrganization({ organization: "acme", failure: null }),
		)
		const loaded = step(
			selected,
			Message.CompletedLoadPlanetscale({
				key: selected.statuses.planetscale.key ?? "",
				result: Result.succeed(status({})),
			}),
		)
		const read = step(loaded, Message.CompletedReadClock({ nowMs: stuck.model.nowMs + 1_000 }))
		expect(isWatching(read)).toBe(true)
	})
})

describe("GitHub repository discovery", () => {
	test("keeps issuing reads beyond a twenty-second provider retry delay", async () => {
		const entered = init({ search: { integration: "github" } }, context).model
		const pending = new GithubIntegrationStatus({
			connected: true,
			state: "connected",
			accountLogin: "acme",
			accountType: "organization",
			repositorySelection: "selected",
			ciTracesEnabled: true,
			repositories: [],
			repositoryDiscovery: { _tag: "Pending", requestId: "discovery-1" },
		})
		let model = step(
			entered,
			Message.CompletedLoadGithub({
				key: entered.statuses.github.key ?? "",
				result: Result.succeed(pending),
			}),
		)
		const dependency = subscriptions.githubPoll.modelToDependencies({ model, context })
		const polls = await Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(
				subscriptions.githubPoll.dependenciesToStream(dependency).pipe(
					Stream.take(8),
					Stream.mapEffect((message) =>
						Effect.map(Clock.currentTimeMillis, (at) => ({ message, at })),
					),
					Stream.runCollect,
				),
			)
			yield* Effect.yieldNow
			yield* TestClock.adjust("30 seconds")
			return yield* Fiber.join(fiber)
		}).pipe(Effect.provide([TestClock.layer(), ResourcesLive]), Effect.runPromise)
		expect(polls.at(-1)?.at).toBeGreaterThanOrEqual(20_000)
		for (const { message } of polls) {
			const read = update(model, message, context)
			expect(names(read.commands)).toContain("LoadIntegrationsGithubStatus")
			model = step(
				read.model,
				Message.CompletedLoadGithub({
					key: read.model.statuses.github.key ?? "",
					result: Result.succeed(pending),
				}),
			)
		}
		expect(subscriptions.githubPoll.modelToDependencies({ model, context }).isPolling).toBe(true)
	})
})
