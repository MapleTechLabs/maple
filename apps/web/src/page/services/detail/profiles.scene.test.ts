import { OrgId } from "@maple/domain"
import { LinkedCursorMessage, MountLinkedZoom } from "@maple/views/charts/linked-cursor"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import { toLoadFailure } from "@maple/views/data/load-failure"
import * as ProfileFlamegraph from "@maple/views/profiles/profile-flamegraph"
import { Option, Result, Schema, Array as Arr } from "effect"
import {
	expect as expectView,
	given,
	label,
	Mount,
	role,
	scene,
	selector,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { FetchOperations, FetchProfile, ProfileInput } from "./command"
import { Message } from "./message"
import type { Model, ServiceProfile } from "./model"
import { init, routeChanged, update } from "./update"
import { view as pageView } from "./view"
import { PROFILE_CHART_ROWS } from "./view-profiles"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const outside: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const inRollout: PageContext = { ...outside, hasProfiling: true }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const themeResolved = () =>
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))

/** The page as an org sees it: its update and view under one context. */
const pageFor = (context: PageContext) => {
	const pageUpdate = (model: Model, message: Message) => update(model, message, context)
	const entered = (search: Model["search"]) => {
		const start = init({ serviceName: "checkout-api", search }, context).model
		return pageUpdate(start, Message.CompletedResolveClock({ nowMs: NOW, mode: "Load" }))
	}
	const answered = (result: Result.Result<ServiceProfile, ReturnType<typeof toLoadFailure>>): Model => {
		const model = entered({ tab: "profiles" }).model
		return pageUpdate(model, Message.CompletedFetchProfile({ key: model.profile.key ?? "", result }))
			.model
	}
	return { pageUpdate, entered, answered, view: withViewInputs(pageView, { context })() }
}

const MS = 1_000_000

const profile: NonNullable<ServiceProfile> = {
	sampleType: "cpu",
	sampleUnit: "nanoseconds",
	totalValue: 9000 * MS,
	totalStacks: 2,
	// One profiled minute: 9 s of CPU over it is 0.15 cores.
	durationNano: 60 * 1000 * MS,
	truncated: false,
	stacks: [
		{
			frames: ["handleRequest", "rankMatches", "levenshtein"],
			files: ["/app/node_modules/router/index.js", "/app/src/rank.ts", "/app/src/distance.ts"],
			lines: [10, 18, 7],
			value: 6000 * MS,
		},
		{
			frames: ["handleRequest", "priceCart"],
			files: ["/app/node_modules/router/index.js", "/app/src/cart.ts"],
			lines: [10, 29],
			value: 3000 * MS,
		},
	],
}

describe("service detail, Profiles tab", () => {
	test("another environment opens the profile whole; the same read keeps the view", () => {
		const page = pageFor(inRollout)
		const searched = page.pageUpdate(
			page.answered(Result.succeed(profile)),
			Message.GotFlamegraphMessage({
				message: ProfileFlamegraph.Message.ChangedSearch({ value: "rank" }),
			}),
		).model
		expect(searched.flamegraph.search).toBe("rank")

		const unchanged = routeChanged(
			searched,
			{ serviceName: "checkout-api", search: searched.search },
			inRollout,
		).model
		expect(unchanged.flamegraph.search).toBe("rank")

		const elsewhere = routeChanged(
			searched,
			{ serviceName: "checkout-api", search: { ...searched.search, environments: ["staging"] } },
			inRollout,
		).model
		expect(elsewhere.profile.key).not.toBe(searched.profile.key)
		expect(elsewhere.flamegraph.search).toBe("")
		expect(elsewhere.flamegraph.resetToken).toBe(searched.flamegraph.resetToken + 1)
	})

	test("an org outside the rollout has no Profiles tab, and its URL reads as Overview", () => {
		const page = pageFor(outside)
		const opened = page.entered({ tab: "profiles" })
		expect(names(opened.commands)).not.toContain(FetchProfile.name)
		expect(names(opened.commands)).toContain(FetchOperations.name)
		scene(
			{ update: page.pageUpdate, view: page.view },
			given(opened.model),
			themeResolved(),
			Mount.resolve(MountLinkedZoom, LinkedCursorMessage.CompletedMountLinkedCursor()),
			expectView(role("link", { name: "Profiles" })).not.toExist(),
			expectView(role("link", { name: "Overview" })).toHaveAttr("aria-current", "page"),
		)
	})

	test("an org in the rollout reads the service's profile for the window when the tab opens", () => {
		const page = pageFor(inRollout)
		const overview = page.entered({})
		expect(names(overview.commands)).not.toContain(FetchProfile.name)
		const opened = page.entered({ tab: "profiles" })
		expect(names(opened.commands)).toContain(FetchProfile.name)
		expect(names(opened.commands)).not.toContain(FetchOperations.name)
		scene(
			{ update: page.pageUpdate, view: page.view },
			given(opened.model),
			themeResolved(),
			expectView(role("link", { name: "Profiles" })).toHaveAttr("aria-current", "page"),
		)
	})

	test("shows a busy skeleton, and no chart, while the first read is out", () => {
		const page = pageFor(inRollout)
		scene(
			{ update: page.pageUpdate, view: page.view },
			given(page.entered({ tab: "profiles" }).model),
			themeResolved(),
			expectView(label("Loading the profile")).toHaveAttr("aria-busy", "true"),
			expectView(role("table", { name: "Top functions" })).not.toExist(),
			expectView(selector("[data-profile-flamegraph]")).not.toExist(),
		)
	})

	test("the read names an environment only when exactly one is selected", () => {
		const page = pageFor(inRollout)
		// The command's input decodes only with its unset keys left out, as the API's request does.
		const decodeArgs = Schema.decodeUnknownOption(Schema.Struct({ input: ProfileInput }))
		const inputOf = (search: Model["search"]) =>
			Arr.findFirst(page.entered(search).commands ?? [], ({ name }) => name === FetchProfile.name).pipe(
				Option.flatMap(({ args }) => decodeArgs(args)),
				Option.map(({ input }) => input),
			)
		const everyEnvironment = Option.some({
			serviceName: "checkout-api",
			startTime: expect.any(String),
			endTime: expect.any(String),
		})
		// Strict: a `deploymentEnv` key holding `undefined` is not the same input.
		expect(inputOf({ tab: "profiles" })).toStrictEqual(everyEnvironment)
		expect(inputOf({ tab: "profiles", environments: ["production", "staging"] })).toStrictEqual(
			everyEnvironment,
		)
		expect(
			Option.map(
				inputOf({ tab: "profiles", environments: ["production"] }),
				(input) => input.deploymentEnv,
			),
		).toEqual(Option.some("production"))
	})

	test("a service without profiles is told how to turn profiling on", () => {
		const page = pageFor(inRollout)
		scene(
			{ update: page.pageUpdate, view: page.view },
			given(page.answered(Result.succeed(null))),
			themeResolved(),
			expectView(text("No profiles in this window")).toExist(),
			expectView(text("profiling: true")).toExist(),
			expectView(role("button", { name: "Copy Code" })).toExist(),
			expectView(role("table", { name: "Top functions" })).not.toExist(),
		)
	})

	test("a service with profiles shows the flame chart's totals and its top functions", () => {
		const page = pageFor(inRollout)
		const opened = page.answered(Result.succeed(profile))
		scene(
			{ update: page.pageUpdate, view: page.view },
			given(opened),
			themeResolved(),
			Mount.resolve(
				ProfileFlamegraph.MountFlameChart({
					chartId: opened.flamegraph.id,
					maxRows: PROFILE_CHART_ROWS,
				}),
				Message.GotFlamegraphMessage({
					message: ProfileFlamegraph.Message.ChangedZoom({ isZoomed: false }),
				}),
			),
			expectView(role("heading", { name: "Profile: cpu" })).toExist(),
			expectView(text("9.00s on CPU, 0.15 cores on average, 2 distinct stacks")).toExist(),
			expectView(role("table", { name: "Top functions" })).toExist(),
			expectView(text("levenshtein")).toExist(),
			expectView(text("priceCart")).toExist(),
			expectView(text("No profiles in this window")).not.toExist(),
		)
	})

	test("a failed read offers Try again, which asks for the profile again", () => {
		const page = pageFor(inRollout)
		const failed = page.answered(Result.fail(toLoadFailure("boom")))
		scene(
			{ update: page.pageUpdate, view: page.view },
			given(failed),
			themeResolved(),
			expectView(text("Couldn't load the profile")).toExist(),
		)
		const retried = page.pageUpdate(failed, Message.ClickedRetry({ target: "Profile" }))
		expect(names(retried.commands)).toEqual([FetchProfile.name])
	})
})
