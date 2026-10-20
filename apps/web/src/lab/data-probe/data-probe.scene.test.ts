import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { click, Command, expect, given, Mount, role, Subscription, scene, text } from "foldkit/scene"
import { expect as assert, describe, test } from "vitest"
import { requestKey } from "../../data/request-key"
import { Message as ToastMessage, PortalToasts } from "../../ui/toast"
import { CheckProbeSession, FetchServicesFacets, init, Message, ResolveWindow, update, view } from "./index"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const windowOf = (endHour: string) => ({
	startTime: "2026-10-01 00:00:00",
	endTime: `2026-10-01 ${endHour}:00:00`,
})
const keyOf = (window: ReturnType<typeof windowOf>) =>
	requestKey(orgId, "getServicesFacets", { data: window })

const facets = (services: number) => ({
	environments: [{ name: "production", count: 10 }],
	namespaces: [],
	commitShas: [],
	services: Array.from({ length: services }, (_, index) => ({ name: `svc-${index}`, count: 1 })),
})

/** The page's two Notifications regions portal themselves out of `#app`. */
const portalsMounted = () => [
	Mount.resolve(PortalToasts, ToastMessage.CompletedPortalToasts()),
	Mount.resolve(PortalToasts, ToastMessage.CompletedPortalToasts()),
]

const first = windowOf("12")
const second = windowOf("13")
const third = windowOf("14")
const refresh = role("button", { name: "Refresh" })

/** Entry: init asks for the session; the session asks for the window; the window for the facets. */
const named = (commands: ReadonlyArray<{ readonly name: string; readonly args?: unknown }> | undefined) =>
	(commands ?? []).map(({ name, args }) => ({ name, args }))

const entered = () => {
	const { model, commands } = init()
	assert(named(commands)).toEqual(named([CheckProbeSession()]))
	const session = update(model, Message.SucceededCheckProbeSession({ orgId }))
	assert(named(session.commands)).toEqual(named([ResolveWindow({ mode: "Load" })]))
	const windowed = update(session.model, Message.CompletedResolveWindow({ window: first, mode: "Load" }))
	assert(named(windowed.commands)).toEqual(
		named([FetchServicesFacets({ key: keyOf(first), window: first })]),
	)
	return update(
		windowed.model,
		Message.CompletedFetchServicesFacets({ key: keyOf(first), result: Result.succeed(facets(6)) }),
	).model
}

describe("data probe", () => {
	test("entry checks the session, resolves the window, then shows the facets fetched under its key", () => {
		scene(
			{ update, view },
			given(entered()),
			...portalsMounted(),
			expect(text("Services: 6")).toExist(),
			expect(text("Environments: 1")).toExist(),
		)
	})

	test("an alert rule count read for another org is dropped", () => {
		const otherOrg = Schema.decodeSync(OrgId)("org_other")
		scene(
			{ update, view },
			given(entered()),
			...portalsMounted(),
			Subscription.emit(Message.UpdatedAlertRules({ orgId: otherOrg, count: 9 })),
			expect(text("Alert rules: loading")).toExist(),
			Subscription.emit(Message.UpdatedAlertRules({ orgId, count: 4 })),
			expect(text("Alert rules: 4")).toExist(),
		)
	})

	test("refresh keeps the counts on screen until the new window's answer lands", () => {
		scene(
			{ update, view },
			given(entered()),
			...portalsMounted(),
			click(refresh),
			Command.resolve(
				ResolveWindow({ mode: "Refresh" }),
				Message.CompletedResolveWindow({ window: second, mode: "Refresh" }),
			),
			expect(text("Services: 6 (refreshing)")).toExist(),
			Command.resolve(
				FetchServicesFacets({ key: keyOf(second), window: second }),
				Message.CompletedFetchServicesFacets({
					key: keyOf(second),
					result: Result.succeed(facets(7)),
				}),
			),
			expect(text("Services: 7")).toExist(),
		)
	})

	// Scene refuses an interaction while a Command is unresolved, so the race is driven through update.
	test("an answer still in flight when a newer window was asked for is dropped", () => {
		const refreshed = update(
			entered(),
			Message.CompletedResolveWindow({ window: second, mode: "Refresh" }),
		).model
		const superseded = update(
			refreshed,
			Message.CompletedResolveWindow({ window: third, mode: "Refresh" }),
		).model
		const late = update(
			superseded,
			Message.CompletedFetchServicesFacets({ key: keyOf(second), result: Result.succeed(facets(1)) }),
		)
		assert(late.model).toEqual(superseded)
		scene(
			{ update, view },
			given(late.model),
			...portalsMounted(),
			expect(text("Services: 6 (refreshing)")).toExist(),
		)
	})
})
