import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import * as Frame from "../kit/frame"
import { Message } from "./message"
import type { Model, SourceId, SourceReading } from "./model"
import { presentSources, sourceState } from "./state"
import { init, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 11:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)
const resolved = Message.GotFrameMessage({
	message: Frame.Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
})
const entered = () => update(init({ search: {} }, context).model, resolved, context)

const complete = (model: Model, source: SourceId, result: Result.Result<SourceReading, never>) =>
	update(model, Message.CompletedFetchSource({ source, key: model.sources[source].key ?? "", result }), context).model

const quiet: SourceReading = { summary: null, isReporting: false }
const reporting: SourceReading = {
	summary: { resources: "4 hosts", segments: [], headline: "busiest", headlineTone: "neutral", findings: [] },
	isReporting: true,
}

describe("infra overview", () => {
	test("entry fetches the install key, and the window reads all seven sources", () => {
		expect(names(init({ search: {} }, context).commands)).toContain("FetchInstallIngestKey")
		expect(names(entered().commands).filter((name) => name === "FetchInfraOverviewSource")).toHaveLength(7)
	})

	test("every source shows while it loads; a quiet one drops out once it answers", () => {
		const loading = entered().model
		expect(presentSources(loading)).toHaveLength(7)
		const settled = complete(complete(loading, "cloudflare", Result.succeed(quiet)), "hosts", Result.succeed(reporting))
		expect(presentSources(settled)).not.toContain("cloudflare")
		expect(sourceState(settled, "hosts")).toEqual({ status: "ready", summary: reporting.summary })
		expect(sourceState(settled, "containers")).toEqual({ status: "loading" })
	})

	test("a source that answered with nothing readable is an error, not an all-clear", () => {
		const settled = complete(entered().model, "gcp", Result.succeed({ summary: null, isReporting: true }))
		expect(presentSources(settled)).toContain("gcp")
		expect(sourceState(settled, "gcp")).toEqual({ status: "error" })
	})
})
