import type { AlertDestinationRow } from "@maple/db/tables"
import { OrgId } from "@maple/domain/primitives"
import { AlertDeliveryError, AlertDestinationId } from "@maple/domain/http"
import { assert, describe, it } from "@effect/vitest"
import { Clock, Effect, Exit, Option, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { dispatchDelivery } from "./dispatch"
import type { EffectTransportDeps } from "./Transport"
import type { DispatchContext } from "./context"

// Real time: the provider below trickles its body on the event loop.
const TIMEOUT_MS = 1_000
/** Generous: the point is "about TIMEOUT_MS", not "until the body ends". */
const WITHIN_MS = TIMEOUT_MS + 500

const DESTINATION_ID = Schema.decodeSync(AlertDestinationId)("7c6b5a49-3821-4e0f-9d8c-7b6a59483726")

const destinationRow: AlertDestinationRow = {
	id: DESTINATION_ID,
	orgId: Schema.decodeSync(OrgId)("org_1"),
	name: "Destination",
	type: "webhook",
	enabled: true,
	configJson: {},
	secretCiphertext: "",
	secretIv: "",
	secretTag: "",
	lastTestedAt: null,
	lastTestError: null,
	consecutiveFailures: 0,
	lastFailureAt: null,
	disabledAt: null,
	disabledReason: null,
	createdAt: 0,
	updatedAt: 0,
	createdBy: "user_1",
	updatedBy: "user_1",
}

const contextFor = (
	secretConfig: DispatchContext["secretConfig"],
	overrides: Partial<DispatchContext> = {},
): DispatchContext => ({
	deliveryKey: "org_1:dest_1:delivery",
	destination: { ...destinationRow, type: secretConfig.type },
	publicConfig: { summary: "Checkout error rate", channelLabel: null },
	secretConfig,
	ruleId: "rule_1",
	ruleName: "Checkout error rate",
	groupKey: null,
	signalType: "error_rate",
	severity: "critical",
	comparator: "gt",
	threshold: 0.05,
	thresholdUpper: null,
	eventType: "trigger",
	incidentId: "inc_1",
	incidentStatus: "open",
	dedupeKey: "org_1:rule_1:checkout",
	windowMinutes: 5,
	value: 0.08,
	sampleCount: 1200,
	template: null,
	sentAtMs: Date.parse("2026-06-02T00:00:00.000Z"),
	...overrides,
})

const deps: EffectTransportDeps = {
	postChatAlert: () =>
		Effect.fail(new AlertDeliveryError({ message: "unexpected", destinationType: "chat" })),
	sendEmail: () => Effect.fail(new AlertDeliveryError({ message: "unexpected", destinationType: "email" })),
}

const webhook = { type: "webhook", url: "https://hooks.example.test/maple", signingSecret: null } as const

/** A body that sends one byte every 50 ms and never ends, so only a deadline stops the read. */
const tricklingBody = (onCancel: () => void = () => undefined) => {
	let timer: ReturnType<typeof setTimeout> | undefined
	return new ReadableStream<Uint8Array>({
		pull: (controller) =>
			new Promise<void>((resolve) => {
				timer = setTimeout(() => {
					controller.enqueue(new TextEncoder().encode("x"))
					resolve()
				}, 50)
			}),
		cancel: () => {
			clearTimeout(timer)
			onCancel()
		},
	})
}

/** Resolves after `ms`, or rejects when the client aborts the request. */
const after = (ms: number, signal: AbortSignal | null | undefined) =>
	new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, ms)
		signal?.addEventListener("abort", () => {
			clearTimeout(timer)
			reject(signal.reason)
		})
	})

const run = (context: DispatchContext, fetchFn: typeof fetch) =>
	Effect.gen(function* () {
		const startedAt = yield* Clock.currentTimeMillis
		const exit = yield* dispatchDelivery(
			context,
			"{}",
			TIMEOUT_MS,
			"https://web.localhost/alerts",
			"https://web.localhost/alerts/rule_1",
			deps,
		).pipe(
			Effect.provide(FetchHttpClient.layer),
			Effect.provideService(FetchHttpClient.Fetch, fetchFn),
			Effect.exit,
		)
		return { exit, elapsedMs: (yield* Clock.currentTimeMillis) - startedAt }
	})

const failureOf = <A, E>(exit: Exit.Exit<A, E>) => Option.getOrUndefined(Exit.findErrorOption(exit))

const failureMessage = <A>(exit: Exit.Exit<A, { readonly message: string }>) => failureOf(exit)?.message ?? ""

describe("HTTP delivery deadline", () => {
	it.live("a failure body that never ends stops at the deadline and keeps the status", () =>
		Effect.gen(function* () {
			const { exit, elapsedMs } = yield* run(
				contextFor(webhook),
				async () => new Response(tricklingBody(), { status: 500 }),
			)
			assert.strictEqual(
				failureMessage(exit),
				"Webhook delivery failed with 500: <body not received before the deadline>",
			)
			assert.isBelow(elapsedMs, WITHIN_MS)
		}),
	)

	it.live("a slow 404 is still a missing target, not a retryable timeout", () =>
		Effect.gen(function* () {
			const { exit } = yield* run(
				contextFor(webhook),
				async () => new Response(tricklingBody(), { status: 404 }),
			)
			assert.strictEqual(failureOf(exit)?._tag, "@maple/http/errors/AlertDeliveryTargetMissingError")
		}),
	)

	it.live("an ack body that never ends times out at the delivery deadline and is cancelled", () =>
		Effect.gen(function* () {
			let cancelled = false
			const { exit, elapsedMs } = yield* run(
				contextFor({ type: "telegram", botToken: "123456789:secret-token", chatId: "-100123" }),
				async () =>
					new Response(
						tricklingBody(() => {
							cancelled = true
						}),
						{ status: 200 },
					),
			)
			assert.strictEqual(failureMessage(exit), `Telegram delivery timed out after ${TIMEOUT_MS}ms`)
			assert.isBelow(elapsedMs, WITHIN_MS)
			assert.isTrue(cancelled, "the provider's body stream is cancelled, not left open")
		}),
	)

	it.live("a follow-up gets what is left of the deadline, not a fresh one", () =>
		Effect.gen(function* () {
			let calls = 0
			// The page takes most of the budget; the follow-up resolve would take a full one.
			const { exit, elapsedMs } = yield* run(
				contextFor(
					{ type: "pagerduty", integrationKey: "k" },
					{ eventType: "resolve", incidentStatus: "resolved", incidentPeakSeverity: "critical" },
				),
				async (_input, init) => {
					calls += 1
					await after(calls === 1 ? 500 : TIMEOUT_MS, init?.signal)
					return new Response("", { status: 202 })
				},
			)
			assert.strictEqual(calls, 2)
			assert.strictEqual(failureMessage(exit), `PagerDuty delivery timed out after ${TIMEOUT_MS}ms`)
			// A fresh budget for the follow-up would end at 1500ms.
			assert.isBelow(elapsedMs, TIMEOUT_MS + 300)
		}),
	)

	it.live("a follow-up with no time left is not sent", () =>
		Effect.gen(function* () {
			const live = yield* Clock.Clock
			// Wall time as the delivery sees it: the page "takes" the whole budget.
			let skewMs = 0
			const nowMs = () => live.currentTimeMillisUnsafe() + skewMs
			const skewed: Clock.Clock = {
				currentTimeMillisUnsafe: nowMs,
				currentTimeMillis: Effect.sync(nowMs),
				currentTimeNanosUnsafe: () => BigInt(nowMs()) * 1_000_000n,
				currentTimeNanos: Effect.sync(() => BigInt(nowMs()) * 1_000_000n),
				monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
				monotonicTimeNanos: live.monotonicTimeNanos,
				sleep: (duration) => live.sleep(duration),
			}
			let calls = 0
			const { exit } = yield* run(
				contextFor(
					{ type: "pagerduty", integrationKey: "k" },
					{ eventType: "resolve", incidentStatus: "resolved", incidentPeakSeverity: "critical" },
				),
				async () => {
					calls += 1
					skewMs += TIMEOUT_MS
					return new Response("", { status: 202 })
				},
			).pipe(Effect.provideService(Clock.Clock, skewed))
			assert.strictEqual(calls, 1)
			assert.strictEqual(failureMessage(exit), `PagerDuty delivery timed out after ${TIMEOUT_MS}ms`)
		}),
	)

	it.live("a prompt failure still reports the provider's status and body", () =>
		Effect.gen(function* () {
			const { exit } = yield* run(
				contextFor(webhook),
				async () => new Response("bad gateway", { status: 502 }),
			)
			assert.strictEqual(failureMessage(exit), "Webhook delivery failed with 502: bad gateway")
		}),
	)

	it.live("a prompt 2xx delivers", () =>
		Effect.gen(function* () {
			const { exit } = yield* run(contextFor(webhook), async () => new Response("", { status: 200 }))
			assert.isTrue(Exit.isSuccess(exit))
		}),
	)
})
