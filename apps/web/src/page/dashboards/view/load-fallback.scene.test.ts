import { OrgId } from "@maple/domain"
import {
	DashboardDocument,
	DashboardId,
	DashboardNotFoundError,
	DashboardPersistenceError,
	publicHttpErrorBody,
} from "@maple/domain/http"
import { Option, Result, Schema, Array as Arr } from "effect"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { FetchDashboardFallback } from "./command-fallback"
import { Message } from "./message"
import type { Model } from "./model"
import { init, isEditing, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const NOW = Date.parse("2026-10-01T12:00:00Z")
const DASHBOARD_ID = "dash_platform"

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const documentNamed = (name: string) =>
	Schema.decodeUnknownSync(DashboardDocument)({
		id: DASHBOARD_ID,
		name,
		timeRange: { type: "relative", value: "6h" },
		widgets: [
			{
				id: "total-errors",
				visualization: "stat",
				dataSource: {
					kind: "route",
					endpoint: "errors_summary",
					transform: { reduceToValue: { field: "totalErrors", aggregate: "first" } },
				},
				display: { title: "total-errors", unit: "number" },
				layout: { x: 0, y: 0, w: 3, h: 2 },
			},
		],
		createdAt: "2026-09-19T12:00:00.000Z",
		updatedAt: "2026-09-28T12:00:00.000Z",
		schemaVersion: 3,
	})
const document = documentNamed("Platform overview")
const liveDocument = documentNamed("Live name")

const dashboardId = Schema.decodeSync(DashboardId)("00000000-0000-4000-8000-000000000001")
const notFound = publicHttpErrorBody(
	new DashboardNotFoundError({ dashboardId, message: "No such dashboard." }),
)
const outage = publicHttpErrorBody(new DashboardPersistenceError({ message: "Database unavailable" }))

/** Entered with `?mode=edit`, clocked, and still waiting on the live board. */
const waiting = (): Model =>
	pageUpdate(
		init({ dashboardId: DASHBOARD_ID, search: { mode: "edit" } }, context).model,
		Message.CompletedReadClock({ nowMs: NOW }),
	).model

/** The live board timed out and its HTTP read is in flight. */
const timedOut = () => pageUpdate(waiting(), Message.TimedOutLiveDashboard({ orgId }))

const snapshotShown = (): Model =>
	pageUpdate(
		timedOut().model,
		Message.CompletedFetchDashboardFallback({
			dashboardId: DASHBOARD_ID,
			result: Result.succeed(document),
		}),
	).model

describe("dashboard board load fallback", () => {
	test("a silent live board reads the HTTP snapshot and asks the collections to reconnect", () => {
		const fired = timedOut()
		expect(names(fired.commands)).toEqual([FetchDashboardFallback.name])
		expect(fired.outMessage?._tag).toBe("RequestedReconnectOrgCollections")
		// A second timeout while the read is in flight starts nothing new.
		expect(pageUpdate(fired.model, Message.TimedOutLiveDashboard({ orgId })).commands).toBeUndefined()
	})

	test("the snapshot renders read-only, and its tiles still fetch their data", () => {
		const shown = pageUpdate(
			timedOut().model,
			Message.CompletedFetchDashboardFallback({
				dashboardId: DASHBOARD_ID,
				result: Result.succeed(document),
			}),
		)
		expect(shown.model.status).toBe("Ready")
		expect(shown.model.document?.name).toBe("Platform overview")
		expect(isEditing(shown.model)).toBe(false)
		const revealed = pageUpdate(shown.model, Message.RevealedWidget({ widgetId: "total-errors" }))
		expect(names(revealed.commands)).toContain("FetchDashboardWidget")
		expect(pageUpdate(shown.model, Message.ClickedTitle()).model.titleDraft).toBeNull()
	})

	test("the live board arriving after the snapshot takes over and editing comes back", () => {
		const live = pageUpdate(
			snapshotShown(),
			Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(liveDocument) }),
		).model
		expect(live.document?.name).toBe("Live name")
		expect(isEditing(live)).toBe(true)
		expect(pageUpdate(live, Message.ClickedTitle()).model.titleDraft).toBe("Live name")
	})

	test("a snapshot answering after the live board is dropped", () => {
		const live = pageUpdate(
			timedOut().model,
			Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(liveDocument) }),
		).model
		const late = pageUpdate(
			live,
			Message.CompletedFetchDashboardFallback({
				dashboardId: DASHBOARD_ID,
				result: Result.succeed(document),
			}),
		).model
		expect(late.document?.name).toBe("Live name")
		expect(isEditing(late)).toBe(true)
	})

	test("a board the API does not know lands on not found", () => {
		const missing = pageUpdate(
			timedOut().model,
			Message.CompletedFetchDashboardFallback({
				dashboardId: DASHBOARD_ID,
				result: Result.fail(notFound),
			}),
		).model
		expect(missing.status).toBe("Missing")
	})

	test("any other failure shows an error, and Retry reads the board again", () => {
		const failed = pageUpdate(
			timedOut().model,
			Message.CompletedFetchDashboardFallback({
				dashboardId: DASHBOARD_ID,
				result: Result.fail(outage),
			}),
		).model
		expect(failed.status).toBe("Failed")
		expect(failed.snapshot._tag).toBe("Failed")
		const retried = pageUpdate(failed, Message.ClickedRetrySync())
		expect(retried.model.status).toBe("Loading")
		expect(names(retried.commands)).toEqual([FetchDashboardFallback.name])
		expect(retried.outMessage?._tag).toBe("RequestedReconnectOrgCollections")
		const recovered = pageUpdate(
			retried.model,
			Message.CompletedFetchDashboardFallback({
				dashboardId: DASHBOARD_ID,
				result: Result.succeed(document),
			}),
		).model
		expect(recovered.status).toBe("Ready")
	})

	test("Retry sync on a shown snapshot reconnects without reading it again", () => {
		const retried = pageUpdate(snapshotShown(), Message.ClickedRetrySync())
		expect(retried.commands).toBeUndefined()
		expect(retried.outMessage?._tag).toBe("RequestedReconnectOrgCollections")
	})
})
