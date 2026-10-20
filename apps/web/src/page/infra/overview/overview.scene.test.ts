import { OrgId } from "@maple/domain"
import type { InfraSurfaceLiteral } from "@maple/domain/http"
import { Result, Schema } from "effect"
import { expect as expectView, given, role, scene, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { summarizeVercel } from "../../../components/infra/overview/summaries"
import { type LoadFailure, toLoadFailure } from "../../../data/load-failure"
import type { PageContext } from "../../contract"
import * as Frame from "../kit/frame"
import { Message } from "./message"
import type { Model, SourceId, SourceReading } from "./model"
import { presentSources, sourceState, surfacesOf } from "./state"
import { init, update } from "./update"
import { view } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const integrations = { cloudflare: true, railway: false, vercel: false, planetscale: false, gcp: false }
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC", infra: { presence: null, integrations } }
const window = { startTime: "2026-10-01 11:00:00", endTime: "2026-10-01 12:00:00" }
const later = { startTime: "2026-10-01 11:05:00", endTime: "2026-10-01 12:05:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)
const sourceReads = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	names(commands).filter((name) => name === "FetchInfraOverviewSource")
const resolvedAt = (at: typeof window, mode: Frame.RequestMode) =>
	Message.GotFrameMessage({ message: Frame.Message.CompletedResolveWindow({ window: at, nowMs: NOW, locale: "en-US", mode }) })
const entered = () => update(init({ search: {} }, context).model, resolvedAt(window, "Load"), context)

const complete = (model: Model, source: SourceId, result: Result.Result<SourceReading, LoadFailure>) =>
	update(model, Message.CompletedFetchSource({ source, key: model.sources[source].key ?? "", result }), context).model
const probed = (model: Model, surfaces: ReadonlyArray<InfraSurfaceLiteral>) =>
	update(model, Message.CompletedFetchPresence({ key: model.presence.key ?? "", result: Result.succeed(surfaces) }), context)
const shown = (model: Model) => presentSources(surfacesOf(model, context))

const quiet: SourceReading = { summary: null }
const reporting: SourceReading = {
	summary: { resources: "4 hosts", segments: [], headline: "busiest", headlineTone: "neutral", findings: [] },
}

describe("infra overview", () => {
	test("entry probes the window's presence and, until it answers, reads all eight sources", () => {
		expect(names(init({ search: {} }, context).commands)).toContain("FetchInstallIngestKey")
		expect(names(entered().commands)).toContain("FetchInfraOverviewPresence")
		expect(sourceReads(entered().commands)).toHaveLength(8)
		expect(shown(entered().model)).toHaveLength(8)
	})

	test("once presence answers only the org's sources show, a connected provider with no data included", () => {
		const loaded = complete(complete(entered().model, "cloudflare", Result.succeed(quiet)), "hosts", Result.succeed(reporting))
		const settled = complete(probed(loaded, ["hosts"]).model, "gcp", Result.fail(toLoadFailure("not connected")))
		expect(shown(settled)).toEqual(["hosts", "cloudflare"])
		expect(sourceState(settled, "hosts")).toEqual({ status: "ready", summary: reporting.summary })
	})

	test("a reload with presence known reads only the sources it shows", () => {
		const known = probed(entered().model, ["hosts"]).model
		expect(sourceReads(update(known, resolvedAt(later, "Refresh"), context).commands)).toHaveLength(2)
	})

	test("a source that answered with nothing readable is an error, not an all-clear", () => {
		const settled = complete(entered().model, "gcp", Result.succeed({ summary: null }))
		expect(shown(settled)).toContain("gcp")
		expect(sourceState(settled, "gcp")).toEqual({ status: "error" })
	})

	test("a connected Vercel team is read, and a project serving 5xx is a finding that opens its page", () => {
		const connected: PageContext = {
			...context,
			infra: { presence: null, integrations: { ...integrations, vercel: true } },
		}
		const entered = update(init({ search: {} }, connected).model, resolvedAt(window, "Load"), connected).model
		const known = update(
			entered,
			Message.CompletedFetchPresence({ key: entered.presence.key ?? "", result: Result.succeed([]) }),
			connected,
		).model
		expect(presentSources(surfacesOf(known, connected))).toEqual(["cloudflare", "vercel"])
		const project = {
			projectId: "prj_api",
			projectName: "api",
			serviceName: "api",
			requests: 10_000,
			requests4xx: 0,
			requests5xx: 900,
			cacheHits: 0,
			cacheLookups: 0,
			errorLogs: 12,
			lastSeen: "2026-10-01T11:59:00.000Z",
			p50DurationMs: null,
			p95DurationMs: null,
		}
		const settled = update(
			known,
			Message.CompletedFetchSource({
				source: "vercel",
				key: known.sources.vercel.key ?? "",
				result: Result.succeed({ summary: summarizeVercel([project]) }),
			}),
			connected,
		).model
		scene(
			{ update: (model, message) => update(model, message, connected), view: withViewInputs(view, { context: connected })() },
			given(settled),
			expectView(role("link", { name: /api returning 9.0% 5xx/ })).toHaveAttr("href", "/infra/vercel/prj_api"),
		)
	})
})
