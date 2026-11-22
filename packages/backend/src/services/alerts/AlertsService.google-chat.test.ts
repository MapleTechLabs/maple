import { AlertValidationError, GoogleChatAlertDestinationConfig } from "@maple/domain/http"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import {
	adminGrants,
	asOrgId,
	asUserId,
	emptyWarehouseRows,
	getError,
	makeLayer,
	makeWarehouseStub,
	alertServices,
} from "./alerts-service-test-support"
import { actingAs } from "@maple/backend/testing/acting-as"

/** Fetch bodies arrive as a string or, from the Effect HTTP client, as bytes. */
const requestBodyText = (body: RequestInit["body"]): string =>
	body instanceof Uint8Array ? new TextDecoder().decode(body) : typeof body === "string" ? body : ""

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

const WEBHOOK_URL = "https://chat.googleapis.com/v1/spaces/AAAAops/messages?key=api-key&token=secret-token"

describe("AlertsService: Google Chat destinations", () => {
	it.effect("rejects a URL that is not a Google Chat webhook", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const alerts = yield* alertServices
			const exit = yield* Effect.exit(
				alerts
					.createDestination(
						new GoogleChatAlertDestinationConfig({
							type: "google-chat",
							name: "Ops",
							webhookUrl: "https://chat.google.com/room/AAAAops",
						}),
					)
					.pipe(actingAs(asOrgId("org_gchat"), adminGrants, asUserId("user_gchat"))),
			)
			const error = getError(exit)
			assert.instanceOf(error, AlertValidationError)
			assert.include(error.message, "chat.googleapis.com")
		}).pipe(
			Effect.provide(makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }))),
		)
	})

	it.effect("saves a webhook without exposing its token and posts a threaded test card", () => {
		const testDb = createTestDb(trackedDbs)
		const requests: Array<{ url: string; body: string }> = []
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push({
				url: String(input instanceof Request ? input.url : input),
				body: requestBodyText(init?.body),
			})
			return Response.json({ name: "spaces/AAAAops/messages/1" })
		}) as typeof fetch

		return Effect.gen(function* () {
			const alerts = yield* alertServices
			const orgId = asOrgId("org_gchat")
			const userId = asUserId("user_gchat")
			const destination = yield* alerts
				.createDestination(
					new GoogleChatAlertDestinationConfig({
						type: "google-chat",
						name: "Ops",
						webhookUrl: WEBHOOK_URL,
					}),
				)
				.pipe(actingAs(orgId, adminGrants, userId))
			assert.strictEqual(destination.summary, "Space AAAAops")
			assert.notInclude(JSON.stringify(destination), "secret-token")

			const response = yield* alerts
				.testDestination(destination.id)
				.pipe(actingAs(orgId, adminGrants, userId))
			assert.isTrue(response.success)
			assert.lengthOf(requests, 1)
			const url = new URL(requests[0]?.url ?? "")
			assert.strictEqual(url.host, "chat.googleapis.com")
			assert.strictEqual(url.searchParams.get("token"), "secret-token")
			const body = JSON.parse(requests[0]?.body ?? "{}")
			assert.strictEqual(body.cardsV2[0].cardId, "maple-alert")
			assert.isString(body.thread.threadKey)
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
					fetch: fetchImpl,
				}),
			),
		)
	})
})
