import type { AlertDestinationRow } from "@maple/db"
import {
	AlertDeliveryError,
	AlertDeliveryRejectedError,
	AlertDestinationId,
	UNGROUPED_GROUP_KEY,
} from "@maple/domain/http"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Schema } from "effect"
import { TestClock } from "effect/testing"
import {
	buildAlertChatUrl,
	buildDiscordEmbedsFromTemplate,
	buildSummaryLine,
	buildTemplateContext,
	type DispatchContext,
} from "./AlertDeliveryDispatch"
import { dispatchDelivery } from "./delivery/dispatch"
import type { EffectTransportDeps } from "./delivery/Transport"
import type { TemplateRenderContext } from "./alert-formatting"
import { resolveSignalDisplay } from "./alert-signal-display"
import { renderTemplate } from "./alert-templating/renderer"
import { DEFAULT_BODY_TEMPLATE, DEFAULT_TITLE_TEMPLATE } from "./alert-templating/defaultTemplates"

/** Chat posts must not happen for these destinations. */
const failingChatPost = () =>
	Effect.fail(new AlertDeliveryError({ message: "unexpected postChatAlert", destinationType: "chat" }))

const baseContext: TemplateRenderContext = {
	ruleId: "rule_1" as TemplateRenderContext["ruleId"],
	ruleName: "Checkout error rate",
	eventType: "trigger",
	severity: "critical",
	signalType: "error_rate",
	comparator: "gt",
	threshold: 0.05,
	thresholdUpper: null,
	value: 0.08,
	sampleCount: 1200,
	groupKey: null,
	windowMinutes: 5,
	incidentId: "inc_1" as TemplateRenderContext["incidentId"],
	incidentStatus: "open",
	dedupeKey: "dedupe_1",
	template: null,
	sentAtMs: Date.parse("2026-06-02T00:00:00.000Z"),
}

/**
 * A range rule (`between`) — the only shape that populates `thresholdUpper`, and
 * therefore the only one that renders the default body's `{{#if thresholdUpper}}`
 * clause and the "inside the …–… range" breach phrase.
 */
const rangeContext: TemplateRenderContext = {
	...baseContext,
	ruleName: "Checkout error-rate band",
	comparator: "between",
	threshold: 0.01,
	thresholdUpper: 0.05,
}

const LINK = "https://web.localhost/alerts"
const CHAT = "https://web.localhost/chat?mode=alert"
const DESTINATION_ID = Schema.decodeUnknownSync(AlertDestinationId)("7c6b5a49-3821-4e0f-9d8c-7b6a59483726")

/** Dispatch deps for non-email destinations — email sends must not happen. */
const noEmailDeps: EffectTransportDeps = {
	postChatAlert: failingChatPost,
	sendEmail: () =>
		Effect.fail(new AlertDeliveryError({ message: "unexpected sendEmail", destinationType: "email" })),
}

describe("buildAlertChatUrl (Ask Maple AI link)", () => {
	it("targets the incident diagnosis page when an incident exists", () => {
		const url = buildAlertChatUrl("https://web.localhost", baseContext)
		assert.isTrue(url.startsWith("https://web.localhost/alerts/incidents/inc_1?alert="), url)
	})

	it("falls back to the chat surface when there is no incident row", () => {
		const url = buildAlertChatUrl("https://web.localhost", { ...baseContext, incidentId: null })
		assert.isTrue(url.startsWith("https://web.localhost/chat?"), url)
		assert.include(url, "mode=alert")
	})
})

describe("buildTemplateContext", () => {
	const ctx = buildTemplateContext(baseContext, LINK, CHAT)

	it("exposes pre-formatted variables", () => {
		assert.strictEqual(ctx["rule.name"], "Checkout error rate")
		assert.strictEqual(ctx.severity, "critical")
		assert.strictEqual(ctx["signal.label"], "Error Rate")
		assert.strictEqual(ctx["event.label"], "Triggered")
		assert.strictEqual(ctx["comparator.label"], ">")
		// error_rate values render as percentages
		assert.strictEqual(ctx.value, "8%")
		assert.strictEqual(ctx.threshold, "5%")
		assert.strictEqual(ctx["observed.summary"], "8% > 5%")
		assert.strictEqual(ctx.window, "5m")
		assert.strictEqual(ctx.group, "all")
		assert.strictEqual(ctx["links.app"], LINK)
		assert.strictEqual(ctx["links.chat"], CHAT)
		assert.strictEqual(ctx.sentAt, "2026-06-02T00:00:00.000Z")
	})

	it("leaves thresholdUpper empty for non-range comparators", () => {
		assert.strictEqual(ctx.thresholdUpper, "")
	})

	it("renders the ungrouped sentinel as `all`, never as `__total__`", () => {
		const ungrouped = buildTemplateContext({ ...baseContext, groupKey: UNGROUPED_GROUP_KEY }, LINK, CHAT)
		assert.strictEqual(ungrouped.group, "all")
	})

	it("renders the default templates without any missing variables", () => {
		const title = renderTemplate(DEFAULT_TITLE_TEMPLATE, ctx)
		const body = renderTemplate(DEFAULT_BODY_TEMPLATE, ctx)
		assert.deepStrictEqual(title.missing, [])
		assert.deepStrictEqual(body.missing, [])
		assert.include(title.text, "Checkout error rate")
		assert.include(title.text, "Triggered")
		assert.include(body.text, "Error Rate is *8%* (> 5%) over the last 5m.")
		assert.include(body.text, "*Severity:* critical · *Group:* all")
	})

	describe("range comparators", () => {
		const range = buildTemplateContext(rangeContext, LINK, CHAT)

		it("formats both bounds and the range observed summary", () => {
			assert.strictEqual(range["comparator.label"], "between")
			assert.strictEqual(range.threshold, "1%")
			assert.strictEqual(range.thresholdUpper, "5%")
			assert.strictEqual(range["observed.summary"], "8% between 1% and 5%")
		})

		it("renders the default body's upper-bound clause", () => {
			const body = renderTemplate(DEFAULT_BODY_TEMPLATE, range)
			assert.deepStrictEqual(body.missing, [])
			assert.include(body.text, "Error Rate is *8%* (between 1% and 5%) over the last 5m.")
		})
	})
})

describe("buildSummaryLine", () => {
	const bold = (context: TemplateRenderContext) => buildSummaryLine(context, (value) => `*${value}*`)

	/**
	 * Regression: a query-driven rule used to render its query-kind enum as the
	 * metric name and its value as a bare unpunctuated integer —
	 * "*builder_query* is *1041923*".
	 */
	it("names what a builder_query rule measures instead of its query kind", () => {
		const line = bold({
			...baseContext,
			ruleName: "Slow DB queries",
			signalType: "builder_query",
			signalDisplay: { label: "p95(duration)", unit: "ms" },
			threshold: 500000,
			value: 1041923,
		})
		assert.include(line, "*p95(duration)* is *1,041,923ms*")
		assert.include(line, "above the 500,000ms threshold")
		assert.notInclude(line, "builder_query")
	})

	it("resolves a metrics rule's name from its stored draft, end to end", () => {
		const line = bold({
			...baseContext,
			ruleName: "DB duration",
			signalType: "builder_query",
			signalDisplay: resolveSignalDisplay({
				signalType: "builder_query",
				queryBuilderDraft: {
					id: "q1",
					name: "Query A",
					dataSource: "metrics",
					aggregation: "sum",
					metricName: "db.query.duration",
				},
			}),
			threshold: 500000,
			value: 1041923,
		})
		assert.include(line, "*sum(db.query.duration)* is *1,041,923*")
		assert.include(line, "above the 500,000 threshold")
	})
})

describe("buildDiscordEmbedsFromTemplate", () => {
	it("maps title/body to the embed and color-codes by severity", () => {
		const [embed] = buildDiscordEmbedsFromTemplate("T", "B", baseContext, LINK, CHAT) as Array<{
			title: string
			description: string
			color: number
			url: string
		}>
		assert.strictEqual(embed.title, "T")
		assert.strictEqual(embed.description, "B")
		assert.strictEqual(embed.url, LINK)
		// critical (non-resolve) → red
		assert.strictEqual(embed.color, 0xe01e5a)
	})
})

describe("dispatchDelivery", () => {
	const destinationRow: AlertDestinationRow = {
		id: DESTINATION_ID,
		orgId: "org_1" as AlertDestinationRow["orgId"],
		name: "PagerDuty",
		type: "pagerduty",
		enabled: true,
		configJson: {},
		secretCiphertext: "",
		secretIv: "",
		secretTag: "",
		lastTestedAt: null,
		lastTestError: null,
		createdAt: new Date(0),
		updatedAt: new Date(0),
		createdBy: "user_1",
		updatedBy: "user_1",
	}

	const pagerdutyContext: DispatchContext = {
		deliveryKey: "org_1:dest_1:test",
		destination: destinationRow,
		publicConfig: { summary: "Test alert", channelLabel: null },
		secretConfig: { type: "pagerduty", integrationKey: "not-a-valid-routing-key" },
		ruleId: "rule_1",
		ruleName: "Test alert",
		groupKey: null,
		signalType: "throughput",
		severity: "warning",
		comparator: "lt",
		threshold: 1,
		thresholdUpper: null,
		eventType: "test",
		incidentId: null,
		incidentStatus: "resolved",
		dedupeKey: "org_1:dest_1:test",
		windowMinutes: 5,
		value: 0,
		sampleCount: 0,
		template: null,
		sentAtMs: Date.parse("2026-06-02T00:00:00.000Z"),
	}

	it.effect("includes the provider's response body in the delivery error", () =>
		Effect.gen(function* () {
			const body =
				'{"status":"invalid event","message":"Event object is invalid","errors":["routing_key is invalid"]}'
			const fetchFn: typeof fetch = async () => new Response(body, { status: 400 })

			const error = yield* Effect.flip(
				dispatchDelivery(pagerdutyContext, "{}", fetchFn, 5_000, LINK, CHAT, noEmailDeps),
			)

			// A 400 is the provider refusing this payload — retrying re-sends the
			// same rejected request, so it classifies as terminal.
			assert.instanceOf(error, AlertDeliveryRejectedError)
			assert.isFalse(error.error.retryable)
			assert.strictEqual(error.destinationType, "pagerduty")
			assert.strictEqual(error.providerStatus, 400)
			assert.include(error.message, "PagerDuty delivery failed with 400")
			// The PagerDuty rejection reason is now surfaced instead of swallowed.
			assert.include(error.message, "routing_key is invalid")
		}),
	)

	it.effect("calls an unguarded transport's fetch detached from the runtime object", () =>
		Effect.gen(function* () {
			// Regression: the unguarded transports used to call `runtime.fetchFn(...)`,
			// a method call that hands workerd's global `fetch` a `this` of the
			// runtime object — "Illegal invocation", every such delivery dead.
			// A `function` (not an arrow) is what makes `this` observable here.
			let called = false
			let receiver: typeof globalThis | undefined
			const fetchFn: typeof fetch = function (this: typeof globalThis | undefined) {
				called = true
				receiver = this
				return Promise.resolve(new Response("{}", { status: 202 }))
			}

			yield* dispatchDelivery(pagerdutyContext, "{}", fetchFn, 5_000, LINK, CHAT, noEmailDeps)

			assert.isTrue(called)
			assert.isUndefined(receiver)
		}),
	)

	it.effect("a hung fetch times out via the Clock and fails typed", () =>
		Effect.gen(function* () {
			// Never settles — only the Clock-driven timeoutOrElse can end this.
			const fetchFn: typeof fetch = () => new Promise<Response>(() => {})

			const fiber = yield* Effect.forkChild(
				Effect.flip(
					dispatchDelivery(pagerdutyContext, "{}", fetchFn, 5_000, LINK, CHAT, noEmailDeps),
				),
				{ startImmediately: true },
			)
			yield* TestClock.adjust("6 seconds")
			const error = yield* Fiber.join(fiber)

			assert.instanceOf(error, AlertDeliveryError)
			assert.strictEqual(error.destinationType, "pagerduty")
			assert.include(error.message, "timed out after 5000ms")
		}),
	)

	it.effect("the delivery timeout aborts the underlying request", () =>
		Effect.gen(function* () {
			// A timeout that leaves the POST running is a duplicate page in waiting:
			// the queue retries while the "timed-out" request still delivers.
			let sawSignal = false
			let aborted = false
			const fetchFn: typeof fetch = (_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					sawSignal = init?.signal != null
					init?.signal?.addEventListener("abort", () => {
						aborted = true
						reject(new DOMException("The operation was aborted", "AbortError"))
					})
				})

			const fiber = yield* Effect.forkChild(
				Effect.flip(
					dispatchDelivery(pagerdutyContext, "{}", fetchFn, 5_000, LINK, CHAT, noEmailDeps),
				),
				{ startImmediately: true },
			)
			yield* TestClock.adjust("6 seconds")
			const error = yield* Fiber.join(fiber)

			assert.instanceOf(error, AlertDeliveryError)
			assert.include(error.message, "timed out")
			assert.isTrue(sawSignal)
			assert.isTrue(aborted)
		}),
	)

	it.effect("webhook: the abort signal survives the SSRF-guarded fetch path", () =>
		Effect.gen(function* () {
			const webhookContext: DispatchContext = {
				...pagerdutyContext,
				destination: { ...destinationRow, name: "Webhook", type: "webhook" },
				publicConfig: { summary: "POST hooks.example.test", channelLabel: null },
				secretConfig: {
					type: "webhook",
					url: "https://hooks.example.test/maple",
					signingSecret: null,
				},
			}
			let aborted = false
			const fetchFn: typeof fetch = (_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						aborted = true
						reject(new DOMException("The operation was aborted", "AbortError"))
					})
				})

			const fiber = yield* Effect.forkChild(
				Effect.flip(dispatchDelivery(webhookContext, "{}", fetchFn, 5_000, LINK, CHAT, noEmailDeps)),
				{ startImmediately: true },
			)
			yield* TestClock.adjust("6 seconds")
			const error = yield* Fiber.join(fiber)

			assert.instanceOf(error, AlertDeliveryError)
			assert.include(error.message, "timed out")
			assert.isTrue(aborted)
		}),
	)

	const failingFetch: typeof fetch = async () => {
		throw new Error("fetch must not be called for email dispatch")
	}

	const emailContext: DispatchContext = {
		...pagerdutyContext,
		destination: { ...destinationRow, name: "Email", type: "email" },
		secretConfig: {
			type: "email",
			members: [
				{ userId: "user_ops", email: "ops@acme.test", name: "Ops" },
				{ userId: "user_oncall", email: "oncall@acme.test", name: null },
			],
		},
	}

	it.effect("email: sends one email per recipient with the built-in format", () =>
		Effect.gen(function* () {
			const sent: Array<{ to: string; subject: string; html: string }> = []
			const deps: EffectTransportDeps = {
				postChatAlert: failingChatPost,
				sendEmail: (to, subject, html) =>
					Effect.sync(() => {
						sent.push({ to, subject, html })
					}),
			}

			const result = yield* dispatchDelivery(emailContext, "{}", failingFetch, 5_000, LINK, CHAT, deps)

			assert.deepStrictEqual(
				sent.map((s) => s.to),
				["ops@acme.test", "oncall@acme.test"],
			)
			assert.include(sent[0]!.subject, "Test alert")
			assert.include(sent[0]!.subject, "Test")
			assert.include(sent[0]!.html, "Test alert")
			assert.include(sent[0]!.html, LINK)
			assert.include(sent[0]!.html, CHAT)
			assert.strictEqual(result.providerMessage, "Emailed 2 members")
			assert.strictEqual(result.responseCode, null)
		}),
	)

	it.effect("email: surfaces a send failure as an email delivery error", () =>
		Effect.gen(function* () {
			const deps: EffectTransportDeps = {
				postChatAlert: failingChatPost,
				sendEmail: () =>
					Effect.fail(
						new AlertDeliveryError({
							message: "Email not configured: EMAIL binding is missing",
							destinationType: "email",
						}),
					),
			}

			const error = yield* Effect.flip(
				dispatchDelivery(emailContext, "{}", failingFetch, 5_000, LINK, CHAT, deps),
			)

			assert.instanceOf(error, AlertDeliveryError)
			assert.strictEqual(error.destinationType, "email")
			assert.include(error.message, "EMAIL binding is missing")
		}),
	)

	it.effect("email: succeeds with annotation when only some members fail", () =>
		Effect.gen(function* () {
			const sent: string[] = []
			const deps: EffectTransportDeps = {
				postChatAlert: failingChatPost,
				sendEmail: (to) =>
					to === "oncall@acme.test"
						? Effect.fail(
								new AlertDeliveryError({
									message: "mailbox unavailable",
									destinationType: "email",
								}),
							)
						: Effect.sync(() => {
								sent.push(to)
							}),
			}

			const result = yield* dispatchDelivery(emailContext, "{}", failingFetch, 5_000, LINK, CHAT, deps)

			assert.deepStrictEqual(sent, ["ops@acme.test"])
			assert.include(result.providerMessage, "Emailed 1 of 2 members")
			assert.include(result.providerMessage, "oncall@acme.test")
			assert.include(result.providerMessage, "mailbox unavailable")
		}),
	)

	it.effect("email: fails with the first member error when every member fails", () =>
		Effect.gen(function* () {
			const deps: EffectTransportDeps = {
				postChatAlert: failingChatPost,
				sendEmail: () =>
					Effect.fail(
						new AlertDeliveryError({
							message: "Cloudflare Email send timed out after 15s",
							destinationType: "email",
						}),
					),
			}

			const error = yield* Effect.flip(
				dispatchDelivery(emailContext, "{}", failingFetch, 5_000, LINK, CHAT, deps),
			)

			assert.instanceOf(error, AlertDeliveryError)
			assert.include(error.message, "failed for all 2 members")
			// The verbatim member error must survive aggregation so retryability
			// classification (timeout detection) keeps working upstream.
			assert.include(error.message, "timed out")
		}),
	)
})
