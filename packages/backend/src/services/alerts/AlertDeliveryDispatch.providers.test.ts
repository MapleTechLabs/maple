import type { AlertDestinationRow } from "@maple/db/tables"
import { AlertDeliveryError, AlertDestinationId, OrgId } from "@maple/domain/http"
import { assert, describe, it } from "@effect/vitest"
import { createHmac } from "node:crypto"
import { Array as Arr, Effect, Schema } from "effect"
import type { DispatchContext } from "./AlertDeliveryDispatch"
import { dispatchDelivery as dispatchDeliveryRaw } from "./delivery/dispatch"
import { FetchHttpClient } from "effect/http"
import type { EffectTransportDeps } from "./delivery/Transport"

/** Fetch bodies arrive as a string or, from the Effect HTTP client, as bytes. */
const requestBodyText = (body: RequestInit["body"]): string =>
	body instanceof Uint8Array ? new TextDecoder().decode(body) : typeof body === "string" ? body : ""

type DispatchArgs = Parameters<typeof dispatchDeliveryRaw>

/** The runtime provides the HTTP client; each test fakes the wire as `FetchHttpClient.Fetch`. */
const dispatchDelivery = (
	context: DispatchArgs[0],
	payloadJson: DispatchArgs[1],
	fetchFn: typeof fetch,
	...rest: [DispatchArgs[2], DispatchArgs[3], DispatchArgs[4], DispatchArgs[5]]
) =>
	dispatchDeliveryRaw(context, payloadJson, ...rest).pipe(
		Effect.provide(FetchHttpClient.layer),
		Effect.provideService(FetchHttpClient.Fetch, fetchFn),
	)

/**
 * Characterization tests: they pin what each provider ACTUALLY sends today,
 * before the delivery layer is restructured onto a transport registry.
 *
 * `discord`, `pagerduty` and `webhook` had no direct dispatch
 * coverage at all, so a refactor had nothing to refactor against. These are deliberately literal
 * (exact URL, exact headers, exact parsed body) rather than
 * behaviour-describing: their job is to make any change to the wire show up as
 * a reviewable diff.
 *
 * Where today's behaviour is a known defect, the assertion pins the DEFECT and
 * says so. Normalizing those is a later, explicit stage.
 */

/** Chat posts must not happen for these destinations. */
const failingChatPost = () =>
	Effect.fail(new AlertDeliveryError({ message: "unexpected postChatAlert", destinationType: "chat" }))

/** These tests send to no Linear destination. */
const unusedLinear: EffectTransportDeps["linear"] = {
	request: () =>
		Effect.fail(new AlertDeliveryError({ message: "unexpected Linear call", destinationType: "linear" })),
	findThread: () =>
		Effect.fail(new AlertDeliveryError({ message: "unexpected Linear call", destinationType: "linear" })),
	saveThread: () =>
		Effect.fail(new AlertDeliveryError({ message: "unexpected Linear call", destinationType: "linear" })),
}

const DESTINATION_ID = Schema.decodeSync(AlertDestinationId)("7c6b5a49-3821-4e0f-9d8c-7b6a59483726")

const SENT_AT_MS = Date.parse("2026-06-02T00:00:00.000Z")
const LINK = "https://web.localhost/alerts"
const CHAT = "https://web.localhost/alerts/rule_1"

const destinationRow = (overrides: Partial<AlertDestinationRow> = {}): AlertDestinationRow => ({
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
	...overrides,
})

/** A breaching error-rate alert — the shape every provider renders from. */
const contextFor = (secretConfig: DispatchContext["secretConfig"]): DispatchContext => ({
	deliveryKey: "org_1:dest_1:delivery",
	destination: destinationRow({ type: secretConfig.type }),
	publicConfig: { summary: "Checkout error rate", channelLabel: null },
	secretConfig,
	ruleId: "rule_1",
	ruleName: "Checkout error rate",
	groupKey: "checkout",
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
	sentAtMs: SENT_AT_MS,
})

/** Neither dep may be invoked by these four providers. */
const noDeps: EffectTransportDeps = {
	postChatAlert: failingChatPost,
	linear: unusedLinear,
	sendEmail: () =>
		Effect.fail(new AlertDeliveryError({ message: "unexpected sendEmail", destinationType: "email" })),
}

interface RecordedCall {
	readonly url: string
	readonly method: string
	readonly headers: Headers
	readonly body: string
}

/** Captures the outbound request and replies with `response`. */
const recorder = (response: () => Response) => {
	const calls: Array<RecordedCall> = []
	const fetchFn: typeof fetch = async (input, init) => {
		calls.push({
			url: String(input instanceof Request ? input.url : input),
			method: init?.method ?? "GET",
			headers: new Headers(init?.headers),
			body: requestBodyText(init?.body),
		})
		return response()
	}
	return { calls, fetchFn }
}

const ok = () => new Response("", { status: 200 })

const dispatch = (context: DispatchContext, fetchFn: typeof fetch, payloadJson = "{}") =>
	dispatchDelivery(context, payloadJson, fetchFn, 5_000, LINK, CHAT, noDeps)

/* -------------------------------------------------------------------------- */

describe("dispatchDelivery: pagerduty", () => {
	const context = contextFor({ type: "pagerduty", integrationKey: "R0UT1NGK3Y" })

	it.effect("posts an Events v2 trigger envelope to the fixed vendor host", () =>
		Effect.gen(function* () {
			const { calls, fetchFn } = recorder(ok)
			const result = yield* dispatch(context, fetchFn)

			assert.lengthOf(calls, 1)
			const call = calls[0]
			assert.strictEqual(call.url, "https://events.pagerduty.com/v2/enqueue")
			assert.strictEqual(call.method, "POST")
			assert.strictEqual(call.headers.get("content-type"), "application/json")

			const body = JSON.parse(call.body)
			assert.strictEqual(body.routing_key, "R0UT1NGK3Y")
			assert.strictEqual(body.event_action, "trigger")
			assert.strictEqual(body.dedup_key, "org_1:rule_1:checkout")
			assert.strictEqual(body.payload.summary, "Checkout error rate trigger")
			assert.strictEqual(body.payload.source, "checkout")
			assert.strictEqual(body.payload.severity, "critical")
			assert.deepStrictEqual(body.links, [{ href: LINK, text: "Open in Maple" }])
			assert.strictEqual(body.payload.custom_details.chatUrl, CHAT)
			// custom_details carries RAW numbers, not the formatted strings the chat
			// providers render — a PagerDuty payload is machine-facing.
			assert.strictEqual(body.payload.custom_details.value, 0.08)
			assert.strictEqual(body.payload.custom_details.threshold, 0.05)
			assert.strictEqual(body.payload.custom_details.signalType, "error_rate")

			assert.deepStrictEqual(result, {
				providerMessage: "Delivered to PagerDuty",
				providerReference: "org_1:rule_1:checkout",
				responseCode: 200,
			})
		}),
	)

	it.effect("maps a resolve event to event_action resolve on the same dedup key", () =>
		Effect.gen(function* () {
			const { calls, fetchFn } = recorder(ok)
			yield* dispatch({ ...context, eventType: "resolve" }, fetchFn)

			const body = JSON.parse(calls[0].body)
			assert.strictEqual(body.event_action, "resolve")
			assert.strictEqual(body.dedup_key, "org_1:rule_1:checkout")
		}),
	)

	it.effect("collapses a warning severity to PagerDuty's warning level", () =>
		Effect.gen(function* () {
			const { calls, fetchFn } = recorder(ok)
			yield* dispatch({ ...context, severity: "warning" }, fetchFn)

			assert.strictEqual(JSON.parse(calls[0].body).payload.severity, "warning")
		}),
	)
})

describe("dispatchDelivery: webhook", () => {
	const url = "https://hooks.example.test/maple"

	it.effect("ships the caller's payload verbatim with the maple headers", () =>
		Effect.gen(function* () {
			const { calls, fetchFn } = recorder(ok)
			const payloadJson = '{"eventType":"trigger","rule":{"id":"rule_1"}}'
			const result = yield* dispatch(
				contextFor({ type: "webhook", url, signingSecret: null }),
				fetchFn,
				payloadJson,
			)

			assert.lengthOf(calls, 1)
			const call = calls[0]
			assert.strictEqual(call.url, url)
			assert.strictEqual(call.method, "POST")
			// Byte-identical: the webhook body IS the caller's payload string.
			assert.strictEqual(call.body, payloadJson)
			assert.strictEqual(call.headers.get("content-type"), "application/json")
			assert.strictEqual(call.headers.get("x-maple-event-type"), "trigger")
			assert.strictEqual(call.headers.get("x-maple-delivery-key"), "org_1:dest_1:delivery")
			assert.isNull(call.headers.get("x-maple-signature"))

			assert.deepStrictEqual(result, {
				providerMessage: "Delivered to webhook",
				providerReference: "org_1:rule_1:checkout",
				responseCode: 200,
			})
		}),
	)

	it.effect("signs the exact payload bytes with HMAC-SHA256 when a secret is set", () =>
		Effect.gen(function* () {
			const { calls, fetchFn } = recorder(ok)
			const payloadJson = '{"eventType":"trigger"}'
			yield* dispatch(
				contextFor({ type: "webhook", url, signingSecret: "s3cr3t" }),
				fetchFn,
				payloadJson,
			)

			const signature = calls[0].headers.get("x-maple-signature")
			assert.isNotNull(signature)
			// Pinned: consumers verify against this exact construction.
			assert.strictEqual(signature, createHmac("sha256", "s3cr3t").update(payloadJson).digest("hex"))
		}),
	)

	it.effect("surfaces the upstream status and body on failure", () =>
		Effect.gen(function* () {
			const { fetchFn } = recorder(() => new Response("upstream exploded", { status: 500 }))
			const error = yield* Effect.flip(
				dispatch(contextFor({ type: "webhook", url, signingSecret: null }), fetchFn),
			)

			assert.strictEqual(error.destinationType, "webhook")
			assert.include(error.message, "Webhook delivery failed with 500")
			assert.include(error.message, "upstream exploded")
		}),
	)
})

describe("dispatchDelivery: discord", () => {
	const webhookUrl = "https://discord.com/api/webhooks/1234567890/tok3n-in-the-path"
	const context = contextFor({ type: "discord", webhookUrl })

	it.effect("posts a username + content line + one embed to the configured webhook", () =>
		Effect.gen(function* () {
			const { calls, fetchFn } = recorder(ok)
			const result = yield* dispatch(context, fetchFn)

			assert.lengthOf(calls, 1)
			const call = calls[0]
			assert.strictEqual(call.url, webhookUrl)
			assert.strictEqual(call.method, "POST")
			assert.strictEqual(call.headers.get("content-type"), "application/json")

			const body = JSON.parse(call.body)
			assert.strictEqual(body.username, "Maple Alerts")
			assert.strictEqual(body.content, "**Checkout error rate**: Triggered")
			assert.lengthOf(body.embeds, 1)
			const embed = body.embeds[0]
			assert.strictEqual(embed.url, LINK)
			assert.strictEqual(embed.color, 0xe01e5a)
			const fieldNames = embed.fields.map((f: { name: string }) => f.name)
			assert.deepStrictEqual(fieldNames, ["Severity", "Signal", "Group", "Observed", "Window", "Links"])

			// NORMALIZED: Discord used to be the only provider returning no
			// provider reference, so its delivery rows had nothing to correlate
			// against. Discord's plain webhook POST returns an empty body, so there
			// is no message id to quote — it now reports the dedupe key, the same
			// correlation handle pagerduty/webhook use.
			assert.deepStrictEqual(result, {
				providerMessage: "Delivered to Discord",
				providerReference: "org_1:rule_1:checkout",
				responseCode: 200,
			})
		}),
	)

	it.effect("does not read the caller's payload json", () =>
		Effect.gen(function* () {
			const { calls, fetchFn } = recorder(ok)
			yield* dispatch(context, fetchFn, '{"totally":"ignored"}')

			assert.notInclude(calls[0].body, "totally")
		}),
	)
})

describe("dispatchDelivery: google-chat", () => {
	const context = contextFor({
		type: "google-chat",
		webhookUrl: "https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=t",
	})

	it.effect("names a revoked webhook on 401 and 403", () =>
		Effect.gen(function* () {
			for (const status of [401, 403]) {
				const { fetchFn } = recorder(() => new Response("", { status }))
				const error = yield* Effect.flip(dispatch(context, fetchFn))
				assert.strictEqual(error.destinationType, "google-chat")
				assert.include(error.message, "it was revoked")
			}
		}),
	)

	it.effect("asks for a new webhook on 404", () =>
		Effect.gen(function* () {
			const { fetchFn } = recorder(() => new Response("", { status: 404 }))
			const error = yield* Effect.flip(dispatch(context, fetchFn))
			assert.include(error.message, "create a new one in the space")
		}),
	)
})

describe("dispatchDelivery: microsoft-teams", () => {
	const context = contextFor({
		type: "microsoft-teams",
		webhookUrl:
			"https://default0a1b.47.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/abc123/triggers/manual/paths/invoke?api-version=1&sv=1.0&sig=s1g",
	})
	const accepted = () => new Response("", { status: 202 })

	it.effect("acknowledges the 202 the Workflows trigger answers", () =>
		Effect.gen(function* () {
			const { calls, fetchFn } = recorder(accepted)
			const result = yield* dispatch(context, fetchFn)
			assert.lengthOf(calls, 1)
			assert.strictEqual(JSON.parse(calls[0].body).type, "message")
			assert.deepStrictEqual(result, {
				providerMessage: "Delivered to Microsoft Teams",
				providerReference: "org_1:rule_1:checkout",
				responseCode: 202,
			})
		}),
	)

	it.effect("explains a rejected or deleted flow", () =>
		Effect.gen(function* () {
			const messages = yield* Effect.forEach([401, 404], (status) =>
				Effect.flip(dispatch(context, recorder(() => new Response("", { status })).fetchFn)).pipe(
					Effect.map((error) => error.message),
				),
			)
			assert.include(messages[0], 'set its trigger to "Anyone"')
			assert.include(messages[1], "no longer exists")
		}),
	)
})

describe("dispatchDelivery: incident-io", () => {
	const context = contextFor({
		type: "incident-io",
		alertSourceConfigId: "01GW2G3V0S59R238FAHPDS1R66",
		token: "inc-s3cret",
	})
	const accepted = () =>
		new Response(JSON.stringify({ status: "success", message: "Event accepted for processing" }), {
			status: 202,
		})
	const bodies = (calls: ReadonlyArray<RecordedCall>) =>
		Arr.map(calls, (call) => {
			const body = JSON.parse(call.body)
			return [body.status, body.deduplication_key]
		})

	it.effect("posts a firing event to the alert source with the token as a Bearer header", () =>
		Effect.gen(function* () {
			const { calls, fetchFn } = recorder(accepted)
			const result = yield* dispatch(context, fetchFn)

			assert.lengthOf(calls, 1)
			const call = calls[0]
			assert.strictEqual(
				call.url,
				"https://api.incident.io/v2/alert_events/http/01GW2G3V0S59R238FAHPDS1R66",
			)
			assert.strictEqual(call.method, "POST")
			assert.strictEqual(call.headers.get("authorization"), "Bearer inc-s3cret")
			const body = JSON.parse(call.body)
			assert.strictEqual(body.title, "Checkout error rate triggered")
			assert.strictEqual(body.status, "firing")
			assert.strictEqual(body.deduplication_key, "org_1:rule_1:checkout")
			assert.strictEqual(body.source_url, LINK)
			assert.include(body.description, `[Ask Maple AI](${CHAT})`)
			assert.strictEqual(body.metadata.severity, "critical")
			assert.strictEqual(body.metadata.group_key, "checkout")
			assert.strictEqual(body.metadata.value, 0.08)
			assert.deepStrictEqual(result, {
				providerMessage: "Delivered to incident.io",
				providerReference: "org_1:rule_1:checkout",
				responseCode: 202,
			})
		}),
	)

	it.effect("resolves the alert it opened under the same rule-and-group key", () =>
		Effect.gen(function* () {
			const { calls, fetchFn } = recorder(accepted)
			yield* dispatch({ ...context, eventType: "resolve" }, fetchFn)
			assert.deepStrictEqual(bodies(calls), [["resolved", "org_1:rule_1:checkout"]])
		}),
	)

	it.effect(
		"pages a two-tier rule's critical escalation under its own key, and closes both on resolve",
		() =>
			Effect.gen(function* () {
				const twoTier = { ...context, ruleSeverities: ["warning", "critical"] as const }
				const fired = recorder(accepted)
				yield* dispatch({ ...twoTier, incidentSeverity: "critical" }, fired.fetchFn)
				assert.deepStrictEqual(bodies(fired.calls), [["firing", "org_1:rule_1:checkout:critical"]])

				const resolved = recorder(accepted)
				yield* dispatch(
					{ ...twoTier, eventType: "resolve", incidentPeakSeverity: "critical" },
					resolved.fetchFn,
				)
				assert.deepStrictEqual(bodies(resolved.calls), [
					["resolved", "org_1:rule_1:checkout"],
					["resolved", "org_1:rule_1:checkout:critical"],
				])
			}),
	)

	it.effect("closes a test alert as soon as it opens it", () =>
		Effect.gen(function* () {
			const { calls, fetchFn } = recorder(accepted)
			yield* dispatch({ ...context, eventType: "test", dedupeKey: "org_1:dest_1:test" }, fetchFn)
			assert.deepStrictEqual(bodies(calls), [
				["firing", "org_1:dest_1:test"],
				["resolved", "org_1:dest_1:test"],
			])
		}),
	)

	it.effect("names a bad token, an unknown source and the rate limit", () =>
		Effect.gen(function* () {
			const messages = yield* Effect.forEach([401, 404, 429], (status) =>
				Effect.flip(dispatch(context, recorder(() => new Response("{}", { status })).fetchFn)).pipe(
					Effect.map((error) => error.message),
				),
			)
			assert.include(messages[0], "rejected the token")
			assert.include(messages[1], "no alert source with this ID")
			assert.include(messages[2], "rate-limited")
		}),
	)
})

describe("dispatchDelivery: telegram", () => {
	const botToken = "123456789:tok3n-in-the-path"
	const context = contextFor({ type: "telegram", botToken, chatId: "-1001234567890" })
	const sent = () =>
		new Response(JSON.stringify({ ok: true, result: { message_id: 4242 } }), { status: 200 })

	it.effect("posts an HTML message with an Open in Maple inline button", () =>
		Effect.gen(function* () {
			const { calls, fetchFn } = recorder(sent)
			const result = yield* dispatch(context, fetchFn)

			assert.lengthOf(calls, 1)
			const call = calls[0]
			assert.strictEqual(call.url, `https://api.telegram.org/bot${botToken}/sendMessage`)
			assert.strictEqual(call.method, "POST")

			const body = JSON.parse(call.body)
			assert.strictEqual(body.chat_id, "-1001234567890")
			assert.strictEqual(body.parse_mode, "HTML")
			assert.include(body.text, "<b>Checkout error rate</b>")
			assert.deepStrictEqual(
				body.reply_markup.inline_keyboard[0].map((b: { url: string }) => b.url),
				[LINK],
			)
			// The token authenticates via the path; it must never also ride in the body.
			assert.notInclude(call.body, botToken)

			assert.deepStrictEqual(result, {
				providerMessage: "Delivered to Telegram chat -1001234567890",
				providerReference: "4242",
				responseCode: 200,
			})
		}),
	)

	/**
	 * Telegram reports logical failures as HTTP 200 + `{ ok: false }`, so a
	 * status-only reading of the response would record a silent non-delivery as
	 * a success.
	 */
	it.effect("treats a 200 with ok:false as a failure", () =>
		Effect.gen(function* () {
			const { fetchFn } = recorder(
				() =>
					new Response(
						JSON.stringify({
							ok: false,
							error_code: 403,
							description: "Forbidden: bot was kicked",
						}),
						{ status: 200 },
					),
			)
			const error = yield* Effect.flip(dispatch(context, fetchFn))

			assert.strictEqual(error.destinationType, "telegram")
			assert.include(error.message, "bot was kicked")
			assert.isFalse(error.error.retryable)
		}),
	)

	it.effect("does not read the caller's payload json", () =>
		Effect.gen(function* () {
			const { calls, fetchFn } = recorder(sent)
			yield* dispatch(context, fetchFn, '{"totally":"ignored"}')

			assert.notInclude(calls[0].body, "totally")
		}),
	)
})
