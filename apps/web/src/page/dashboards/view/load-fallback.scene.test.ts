import { OrgId } from "@maple/domain"
import {
	DashboardDocument,
	DashboardId,
	DashboardNotFoundError,
	DashboardPersistenceError,
	DashboardStoredConfigInvalidError,
	publicHttpErrorBody,
} from "@maple/domain/http"
import { Option, Result, Schema, Array as Arr } from "effect"
import {
	Command,
	Mount,
	click,
	expect as expectView,
	given,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { FetchShares } from "./command"
import { FetchDashboardFallback } from "./command-fallback"
import { boardBreadcrumbLabel } from "./index"
import { ShareMessage } from "./share"
import { Message } from "./message"
import type { Model } from "./model"
import { init, isEditing, update } from "./update"
import { view as pageView } from "./view"
import { subscriptions } from "./subscription"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const NOW = Date.parse("2026-10-01T12:00:00Z")
const DASHBOARD_ID = "dash_platform"

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const themeResolved = () =>
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const TOTAL_ERRORS = {
	id: "total-errors",
	visualization: "stat",
	dataSource: {
		kind: "route",
		endpoint: "errors_summary",
		transform: { reduceToValue: { field: "totalErrors", aggregate: "first" } },
	},
	display: { title: "total-errors", unit: "number" },
	layout: { x: 0, y: 0, w: 3, h: 2 },
}

const documentNamed = (name: string, widgets: ReadonlyArray<unknown> = [TOTAL_ERRORS]) =>
	Schema.decodeUnknownSync(DashboardDocument)({
		id: DASHBOARD_ID,
		name,
		timeRange: { type: "relative", value: "6h" },
		widgets,
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
/** A 500 Maple does not retry on its own, so the error state draws only its Try again. */
const unreadable = publicHttpErrorBody(
	new DashboardStoredConfigInvalidError({
		message: "bad",
		dashboardId,
		component: "document",
		cause: null,
	}),
)
const blankBoard = documentNamed("Platform overview", [])

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
	test("the watchdog runs only while the live board is loading and no snapshot was read", () => {
		const watched = (model: Model) =>
			subscriptions.loadWatchdog.modelToDependencies({ model, context }).orgId
		expect(watched(waiting())).toBe(orgId)
		expect(watched(timedOut().model)).toBeNull()
		expect(watched(snapshotShown())).toBeNull()
		const live = pageUpdate(
			waiting(),
			Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(document) }),
		).model
		expect(watched(live)).toBeNull()
	})

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
		expect(boardBreadcrumbLabel(missing)).toBe("Not found")
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
		// An outage is not a missing board.
		expect(boardBreadcrumbLabel(failed)).toBe("Couldn't load")
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

	test("the snapshot draws its banner and editing is off", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				pageUpdate(
					timedOut().model,
					Message.CompletedFetchDashboardFallback({
						dashboardId: DASHBOARD_ID,
						result: Result.succeed(blankBoard),
					}),
				).model,
			),
			themeResolved(),
			expectView(text(/this dashboard is a snapshot loaded over HTTP/)).toExist(),
			expectView(role("button", { name: "Retry sync" })).toExist(),
			expectView(role("button", { name: "Edit dashboard" })).toBeDisabled(),
		)
	})

	test("a failed read draws an error whose Retry reads the board again", () => {
		const failed = pageUpdate(
			timedOut().model,
			Message.CompletedFetchDashboardFallback({
				dashboardId: DASHBOARD_ID,
				result: Result.fail(unreadable),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(failed),
			themeResolved(),
			expectView(text("Couldn't load dashboard")).toExist(),
			click(role("button", { name: /Try again/ })),
			Command.resolve(
				FetchDashboardFallback,
				Message.CompletedFetchDashboardFallback({
					dashboardId: DASHBOARD_ID,
					result: Result.succeed(blankBoard),
				}),
			),
			Command.resolve(
				FetchShares,
				Message.GotShareMessage({
					message: ShareMessage.CompletedFetchShares({ seq: 1, result: Result.succeed([]) }),
				}),
			),
			expectView(text("Couldn't load dashboard")).toBeAbsent(),
			expectView(text(/this dashboard is a snapshot loaded over HTTP/)).toExist(),
		)
	})
})
