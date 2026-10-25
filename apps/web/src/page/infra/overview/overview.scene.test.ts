import { OrgId } from "@maple/domain"
import type { InfraSurfaceLiteral } from "@maple/domain/http"
import { Result, Schema } from "effect"
import {
	all,
	expect as expectView,
	expectAll,
	given,
	nth,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { type LoadFailure, toLoadFailure } from "../../../data/load-failure"
import type { PageContext } from "../../contract"
import * as Frame from "../kit/frame"
import { Message } from "./message"
import type { Model, SourceId, SourceReading } from "./model"
import { presentSources, sourceState, surfacesOf } from "./state"
import { infraSurfacesSettled, init, update } from "./update"
import { view } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const integrations = {
	cloudflare: true,
	railway: false,
	planetscale: false,
	gcp: false,
	supabase: false,
	aws: false,
}
const context: PageContext = {
	orgId,
	pinnedNamespace: null,
	timeZone: "UTC",
	infra: { presence: null, isPresenceFailed: false, integrations, remembered: undefined },
}
const pending = { ...integrations, gcp: null }
const window = { startTime: "2026-10-01 11:00:00", endTime: "2026-10-01 12:00:00" }
const later = { startTime: "2026-10-01 11:05:00", endTime: "2026-10-01 12:05:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)
const sourceReads = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	names(commands).filter((name) => name === "FetchInfraOverviewSource")
const resolvedAt = (at: typeof window, mode: Frame.RequestMode) =>
	Message.GotFrameMessage({
		message: Frame.Message.CompletedResolveWindow({ window: at, nowMs: NOW, locale: "en-US", mode }),
	})
const entered = () => update(init({ search: {} }, context).model, resolvedAt(window, "Load"), context)

const complete = (model: Model, source: SourceId, result: Result.Result<SourceReading, LoadFailure>) =>
	update(
		model,
		Message.CompletedFetchSource({ source, key: model.sources[source].key ?? "", result }),
		context,
	).model
const probed = (model: Model, surfaces: ReadonlyArray<InfraSurfaceLiteral>) =>
	update(
		model,
		Message.CompletedFetchPresence({ key: model.presence.key ?? "", result: Result.succeed(surfaces) }),
		context,
	)
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const shown = (model: Model) => presentSources(surfacesOf(model, context))

const quiet: SourceReading = { summary: null }
const reporting: SourceReading = {
	summary: {
		resources: "4 hosts",
		segments: [],
		headline: "busiest",
		headlineTone: "neutral",
		findings: [],
	},
}

const finding = (key: string, tone: "crit" | "warn" | "stale", title: string) => ({
	key,
	source: "hosts" as const,
	tone,
	title,
	detail: "detail",
	target: { kind: "host" as const, hostName: key },
})
const withFindings: SourceReading = {
	summary: {
		...reporting.summary!,
		findings: [finding("a", "stale", "a went quiet"), finding("b", "crit", "b at 99% CPU")],
	},
}

describe("infra overview", () => {
	test("entry probes the window's presence and reads no source until the org's sources are known", () => {
		expect(names(init({ search: {} }, context).commands)).toContain("FetchInstallIngestKey")
		expect(names(entered().commands)).toContain("FetchInfraOverviewPresence")
		expect(sourceReads(entered().commands)).toEqual([])
		expect(shown(entered().model)).toBeNull()
	})

	test("once presence answers only the org's sources are read, a connected provider with no data included", () => {
		const settled = probed(entered().model, ["hosts"])
		expect(shown(settled.model)).toEqual(["hosts", "cloudflare"])
		expect(sourceReads(settled.commands)).toHaveLength(2)
		const loaded = complete(settled.model, "hosts", Result.succeed(reporting))
		expect(sourceState(loaded, "hosts")).toEqual({ status: "ready", summary: reporting.summary })
	})

	test("a status still pending keeps the sources unknown even after the probe answers", () => {
		const waiting: PageContext = { ...context, infra: { ...context.infra!, integrations: pending } }
		const model = update(init({ search: {} }, waiting).model, resolvedAt(window, "Load"), waiting).model
		const answered = update(
			model,
			Message.CompletedFetchPresence({
				key: model.presence.key ?? "",
				result: Result.succeed(["hosts"]),
			}),
			waiting,
		)
		expect(presentSources(surfacesOf(answered.model, waiting))).toBeNull()
		expect(sourceReads(answered.commands)).toEqual([])
		// The last status lands after the probe: the shell's settle step requests the sources.
		const settled = infraSurfacesSettled(answered.model, context)
		expect(sourceReads(settled.commands)).toHaveLength(2)
		// A source that already failed keeps its error row instead of loading again.
		const failed = complete(settled.model, "hosts", Result.fail(toLoadFailure("boom")))
		expect(sourceReads(infraSurfacesSettled(failed, context).commands)).toEqual([])
		expect(sourceState(failed, "hosts")).toEqual({ status: "error", failure: toLoadFailure("boom") })
	})

	test("the remembered sources are read on entry, before the probe answers", () => {
		const remembering: PageContext = {
			...context,
			infra: { ...context.infra!, integrations: pending, remembered: ["hosts", "k8sPods"] },
		}
		const model = update(init({ search: {} }, remembering).model, resolvedAt(window, "Load"), remembering)
		expect(presentSources(surfacesOf(model.model, remembering))).toEqual(["hosts", "kubernetes"])
		expect(sourceReads(model.commands)).toHaveLength(2)
	})

	test("a failed probe with no remembered set shows every source rather than hiding one", () => {
		const failed = update(
			entered().model,
			Message.CompletedFetchPresence({
				key: entered().model.presence.key ?? "",
				result: Result.fail(toLoadFailure("boom")),
			}),
			context,
		)
		expect(shown(failed.model)).toHaveLength(9)
		expect(sourceReads(failed.commands)).toHaveLength(9)
	})

	test("a reload with presence known reads only the sources it shows", () => {
		const known = probed(entered().model, ["hosts"]).model
		expect(sourceReads(update(known, resolvedAt(later, "Refresh"), context).commands)).toHaveLength(2)
	})

	test("a source that answered with nothing readable is an error, not an all-clear", () => {
		const settled = complete(
			probed(entered().model, ["hosts"]).model,
			"cloudflare",
			Result.succeed(quiet),
		)
		expect(shown(settled)).toContain("cloudflare")
		expect(sourceState(settled, "cloudflare")).toEqual({ status: "error" })
	})

	test("needs attention lists nothing until every source answered, then lists them worst first", () => {
		const known = probed(entered().model, ["hosts"]).model
		const hostsIn = complete(known, "hosts", Result.succeed(withFindings))
		const page = withViewInputs(view, { context })()
		scene(
			{ update: pageUpdate, view: page },
			given(hostsIn),
			expectView(text("b at 99% CPU")).not.toExist(),
		)
		const allIn = complete(hostsIn, "cloudflare", Result.succeed(quiet))
		scene(
			{ update: pageUpdate, view: page },
			given(allIn),
			expectView(text("b at 99% CPU")).toExist(),
			expectView(text("Couldn't check this source. Its page shows the error.")).toExist(),
			// Findings are the page's first links: worst first, regardless of the source's order.
			expectView(nth(all.role("link"), 0)).toContainText("b at 99% CPU"),
			expectView(nth(all.role("link"), 1)).toContainText("a went quiet"),
		)
	})

	test("every source failing for one reason shows that reason once, not a row per source", () => {
		const failure = toLoadFailure("boom")
		const known = probed(entered().model, ["hosts"]).model
		const allFailed = complete(
			complete(known, "hosts", Result.fail(failure)),
			"cloudflare",
			Result.fail(failure),
		)
		scene(
			{ update: pageUpdate, view: withViewInputs(view, { context })() },
			given(allFailed),
			expectAll(all.role("alert")).toHaveCount(1),
			expectView(text(failure.title)).toExist(),
		)
	})

	test("trying the shared failure again reads every source and keeps the reason up until they answer", () => {
		// `retryable: false` skips the auto-retry Mount; the button only needs `recovery: "retry"`.
		const failure: LoadFailure = { ...toLoadFailure("boom"), recovery: "retry", retryable: false }
		const known = probed(entered().model, ["hosts"]).model
		const allFailed = complete(
			complete(known, "hosts", Result.fail(failure)),
			"cloudflare",
			Result.fail(failure),
		)
		const retried = pageUpdate(allFailed, Message.ClickedRetry())
		expect(sourceReads(retried.commands)).toHaveLength(2)
		const render = { update: pageUpdate, view: withViewInputs(view, { context })() }
		scene(render, given(allFailed), expectView(role("button", { name: "Try again" })).toExist())
		scene(render, given(retried.model), expectView(text(failure.title)).toExist())
	})
})
