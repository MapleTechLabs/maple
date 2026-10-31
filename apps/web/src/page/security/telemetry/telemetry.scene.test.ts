import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import {
	catchAllExposureOf,
	emptyExposureOf,
	exposureOf,
	runtimesOf,
	SAMPLE_TRACE_ID,
} from "../../../lab/security-telemetry-fixture"
import { AppRoute, hrefOf } from "../../../route"
import type { PageContext } from "../../contract"
import { runtimeEntries } from "./derive"
import { Message, type Model } from "./model"
import { init, routeChanged, update } from "./update"
import { view as pageView } from "./view"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_acme"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const NOW = Date.UTC(2026, 9, 31, 14, 32)
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const exposureRoute = AppRoute.SecurityExposure()
const runtimesRoute = AppRoute.SecurityRuntimes()

const withExposure = (data = exposureOf(NOW)): Model => {
	const entered = init(exposureRoute, context).model
	return [
		Message.ReadClock({ nowMs: NOW }),
		Message.CompletedFetchExposure({ key: entered.exposure.key ?? "", result: Result.succeed(data) }),
	].reduce((model, message) => pageUpdate(model, message).model, entered)
}

const withRuntimes = (): Model => {
	const entered = init(runtimesRoute, context).model
	return [
		Message.ReadClock({ nowMs: NOW }),
		Message.CompletedFetchRuntimes({
			key: entered.runtimes.key ?? "",
			result: Result.succeed(runtimesOf(NOW)),
		}),
	].reduce((model, message) => pageUpdate(model, message).model, entered)
}

describe("security telemetry tabs", () => {
	test("each tab reads only its own endpoint, and a tab switch keeps what was read", () => {
		expect(names(init(exposureRoute, context).commands)).toEqual(
			expect.arrayContaining(["SecurityApiExposure"]),
		)
		expect(names(init(exposureRoute, context).commands)).not.toContain("SecurityApiRuntimes")
		const toRuntimes = routeChanged(withExposure(), runtimesRoute, context)
		expect(names(toRuntimes.commands)).toEqual(["SecurityApiRuntimes"])
		const back = routeChanged(toRuntimes.model, exposureRoute, context)
		expect(names(back.commands)).toEqual([])
	})

	test("while loading, the tab strip shows and the content is busy", () => {
		scene(
			{ update: pageUpdate, view },
			given(init(exposureRoute, context).model),
			expectView(role("link", { name: /Exposure/ })).toExist(),
			expectView(role("link", { name: /Runtimes/ })).toExist(),
			expectView(text("Probe requests")).toBeAbsent(),
			expectView(text("No scanner traffic in the last 7 days")).toBeAbsent(),
		)
	})

	test("no scanner traffic shows the calm empty state", () => {
		scene(
			{ update: pageUpdate, view },
			given(withExposure(emptyExposureOf())),
			expectView(text("No scanner traffic in the last 7 days")).toExist(),
			expectView(text(/answered with a success/)).toBeAbsent(),
		)
	})

	test("probe paths a service answered head the tab, with a link to a sample trace", () => {
		scene(
			{ update: pageUpdate, view },
			given(withExposure()),
			expectView(text("2 probe paths answered with a success")).toExist(),
			expectView(role("link", { name: "Sample trace" })).toHaveAttr(
				"href",
				hrefOf(AppRoute.Trace({ traceId: SAMPLE_TRACE_ID, search: {} })),
			),
			expectView(text("Secrets and credential files")).toExist(),
			expectView(text("WordPress")).toExist(),
			expectView(text("Named scanners on ordinary paths")).toExist(),
			expectView(text("ZGrab")).toExist(),
		)
	})

	test("a service that answers every probe path is a likely catch-all, not an exposure", () => {
		scene(
			{ update: pageUpdate, view },
			given(withExposure(catchAllExposureOf(NOW))),
			expectView(text("2 probe paths answered with a success")).toExist(),
			expectView(text("Likely catch-all routes")).toExist(),
			expectView(text("4 of 4 sensitive probe paths answered")).toExist(),
			// The catch-all app's 30 answered /.env probes stay out of the category count (120, not 150).
			expectView(text("150")).toBeAbsent(),
		)
	})

	test("answers only from catch-all routes leave no callout, and the totals say so", () => {
		const data = catchAllExposureOf(NOW)
		scene(
			{ update: pageUpdate, view },
			given(
				withExposure({ ...data, exposed: data.exposed.filter((row) => row.service === "web-app") }),
			),
			expectView(text(/answered with a success/)).toBeAbsent(),
			expectView(text("1 likely catch-all route")).toExist(),
			expectView(role("link", { name: "Sample trace" })).toHaveAttr(
				"href",
				hrefOf(AppRoute.Trace({ traceId: SAMPLE_TRACE_ID, search: {} })),
			),
		)
	})

	test("a full exposed list reads as a floor", () => {
		const data = exposureOf(NOW)
		const row = data.exposed[0]!
		const exposed = Array.from({ length: 50 }, (_, index) => ({ ...row, path: `/.env.${index}` }))
		scene(
			{ update: pageUpdate, view },
			given(withExposure({ ...data, exposed })),
			expectView(text("50+ probe paths answered with a success")).toExist(),
		)
	})

	test("traffic with nothing answered shows no exposure callout", () => {
		scene(
			{ update: pageUpdate, view },
			given(withExposure({ ...exposureOf(NOW), exposed: [] })),
			expectView(text(/answered with a success/)).toBeAbsent(),
			expectView(text("none answered a sensitive probe")).toExist(),
		)
	})

	test("runtimes list worst first and explain the services that report no version", () => {
		const model = withRuntimes()
		const runtimes = model.runtimes.data
		expect(runtimes._tag).toBe("Success")
		if (runtimes._tag !== "Success") return
		expect(runtimeEntries(runtimes.data).map((entry) => entry.row.service)).toEqual([
			"checkout-api",
			"payments",
			"inventory",
			"search",
			"ledger",
			"realtime",
			"billing-worker",
			"edge-router",
		])
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("End of life")).toExist(),
			expectView(text("since 2023-09-11 · cycle 16")).toExist(),
			expectView(text("Update available")).toExist(),
			expectView(text("latest 22.11.0")).toExist(),
			expectView(text("Release data unavailable")).toExist(),
			expectView(text("Unrecognized release")).toExist(),
			expectView(text("Not tracked")).toExist(),
			expectView(text("Bun")).toExist(),
			expectView(text("Some services report no runtime version")).toExist(),
			expectView(role("link", { name: "endoflife.date" })).toExist(),
		)
	})

	test("a failed read shows the error, and Try again reads it again", () => {
		const entered = init(runtimesRoute, context).model
		const failed = pageUpdate(
			entered,
			Message.CompletedFetchRuntimes({
				key: entered.runtimes.key ?? "",
				result: Result.fail(toLoadFailure(new Error("unexpected body"))),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(text("Couldn't load service runtimes")).toExist(),
			expectView(role("button", { name: "Try again" })).toExist(),
		)
		expect(names(pageUpdate(failed, Message.ClickedRetry()).commands)).toContain("SecurityApiRuntimes")
	})
})
