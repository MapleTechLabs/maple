import {
	AlertValidationError,
	IncidentIoAlertDestinationConfig,
	MicrosoftTeamsAlertDestinationConfig,
} from "@maple/domain/http"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { Array as Arr, Effect } from "effect"
import { AlertsService } from "./AlertsService"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import {
	adminRoles,
	asOrgId,
	asUserId,
	emptyWarehouseRows,
	getError,
	makeLayer,
	makeWarehouseStub,
} from "./alerts-service-test-support"

/** Fetch bodies arrive as a string or, from the Effect HTTP client, as bytes. */
const requestBodyText = (body: RequestInit["body"]): string =>
	body instanceof Uint8Array ? new TextDecoder().decode(body) : typeof body === "string" ? body : ""

interface Captured {
	readonly url: string
	readonly authorization: string | null
	readonly body: string
}

/** The local capture harness: records every outbound request and answers 202 like both vendors. */
const capture = () => {
	const requests: Array<Captured> = []
	const fetchImpl: typeof fetch = async (input, init) => {
		requests.push({
			url: String(input instanceof Request ? input.url : input),
			authorization: new Headers(init?.headers).get("authorization"),
			body: requestBodyText(init?.body),
		})
		return new Response(JSON.stringify({ status: "success" }), { status: 202 })
	}
	return { requests, fetchImpl }
}

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

const orgId = asOrgId("org_paging")
const userId = asUserId("user_paging")

const TEAMS_URL =
	"https://default0a1b2c3d.47.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/9f8e7d6c5b4a3928/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=t3ams-s1g"

const layer = (testDb: TestDb, fetchImpl?: typeof fetch) =>
	makeLayer(
		testDb,
		makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }),
		fetchImpl === undefined ? undefined : { fetch: fetchImpl },
	)

describe("AlertsService: Microsoft Teams destinations", () => {
	it.effect("turns away a retired Office 365 connector URL with the reason", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const exit = yield* Effect.exit(
				alerts.createDestination(
					orgId,
					userId,
					adminRoles,
					new MicrosoftTeamsAlertDestinationConfig({
						type: "microsoft-teams",
						name: "Ops",
						webhookUrl: "https://contoso.webhook.office.com/webhookb2/a@b/IncomingWebhook/c/d",
					}),
				),
			)
			const error = getError(exit)
			assert.instanceOf(error, AlertValidationError)
			assert.include(error.message, "retired in May 2026")
		}).pipe(Effect.provide(layer(testDb)))
	})

	it.effect("saves a Workflows webhook without exposing its signature and posts a test card", () => {
		const testDb = createTestDb(trackedDbs)
		const { requests, fetchImpl } = capture()
		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const destination = yield* alerts.createDestination(
				orgId,
				userId,
				adminRoles,
				new MicrosoftTeamsAlertDestinationConfig({
					type: "microsoft-teams",
					name: "Ops",
					webhookUrl: TEAMS_URL,
				}),
			)
			assert.strictEqual(destination.summary, "Workflow 9f8e7d6c…")
			assert.notInclude(JSON.stringify(destination), "t3ams-s1g")

			const response = yield* alerts.testDestination(orgId, userId, adminRoles, destination.id)
			assert.isTrue(response.success)
			assert.lengthOf(requests, 1)
			assert.strictEqual(new URL(requests[0]?.url ?? "").searchParams.get("sig"), "t3ams-s1g")
			const body = JSON.parse(requests[0]?.body ?? "{}")
			assert.strictEqual(body.attachments[0].content.type, "AdaptiveCard")
		}).pipe(Effect.provide(layer(testDb, fetchImpl)))
	})
})

describe("AlertsService: incident.io destinations", () => {
	it.effect("rejects a pasted URL in place of the alert source config id", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const exit = yield* Effect.exit(
				alerts.createDestination(
					orgId,
					userId,
					adminRoles,
					new IncidentIoAlertDestinationConfig({
						type: "incident-io",
						name: "Paging",
						alertSourceConfigId:
							"https://api.incident.io/v2/alert_events/http/01GW2G3V0S59R238FAHPDS1R66",
						token: "tok",
					}),
				),
			)
			assert.instanceOf(getError(exit), AlertValidationError)
		}).pipe(Effect.provide(layer(testDb)))
	})

	it.effect("keeps the token write-only, test-sends with it, and keeps it across an edit", () => {
		const testDb = createTestDb(trackedDbs)
		const { requests, fetchImpl } = capture()
		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const destination = yield* alerts.createDestination(
				orgId,
				userId,
				adminRoles,
				new IncidentIoAlertDestinationConfig({
					type: "incident-io",
					name: "Paging",
					alertSourceConfigId: "01GW2G3V0S59R238FAHPDS1R66",
					token: "inc-s3cret",
				}),
			)
			assert.strictEqual(destination.summary, "Alert source 01GW2G3V0S59R238FAHPDS1R66")
			assert.strictEqual(destination.channelLabel, "01GW2G3V0S59R238FAHPDS1R66")
			assert.notInclude(JSON.stringify(destination), "inc-s3cret")

			// Renaming sends no token: the stored one must survive.
			yield* alerts.updateDestination(orgId, userId, adminRoles, destination.id, {
				type: "incident-io",
				name: "Paging (prod)",
			})
			// A different alert source has its own token: moving the id alone is refused.
			const moved = yield* Effect.exit(
				alerts.updateDestination(orgId, userId, adminRoles, destination.id, {
					type: "incident-io",
					alertSourceConfigId: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
				}),
			)
			assert.include(getError(moved).message, "needs its own token")
			const response = yield* alerts.testDestination(orgId, userId, adminRoles, destination.id)
			assert.isTrue(response.success)
			// A test opens an alert and closes it at once.
			assert.deepStrictEqual(
				Arr.map(requests, (request) => [
					request.url,
					request.authorization,
					JSON.parse(request.body).status,
				]),
				[
					[
						"https://api.incident.io/v2/alert_events/http/01GW2G3V0S59R238FAHPDS1R66",
						"Bearer inc-s3cret",
						"firing",
					],
					[
						"https://api.incident.io/v2/alert_events/http/01GW2G3V0S59R238FAHPDS1R66",
						"Bearer inc-s3cret",
						"resolved",
					],
				],
			)
		}).pipe(Effect.provide(layer(testDb, fetchImpl)))
	})
})
