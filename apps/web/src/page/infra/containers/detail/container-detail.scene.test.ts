import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { expect as expectView, given, Mount, role, scene, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "../../../../charts/theme-colors"
import type { PageContext } from "../../../contract"
import * as Frame from "../../kit/frame"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 11:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")
const route = { containerName: "ci-worker-1", search: { host: "build-runner-01" } }

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const windowed = () =>
	pageUpdate(
		init(route, context).model,
		Message.GotFrameMessage({
			message: Frame.Message.CompletedResolveWindow({
				window,
				nowMs: NOW,
				locale: "en-US",
				mode: "Load",
			}),
		}),
	)

describe("container detail", () => {
	test("the window fetches the summary and the selected metric only; a tab click fetches its own", () => {
		const entered = windowed()
		const names = (entered.commands ?? []).map(({ name }) => name)
		expect(names).toContain("FetchInfraContainerSummary")
		expect(names.filter((name) => name === "FetchInfraContainerSeries")).toHaveLength(1)
		const picked = pageUpdate(entered.model, Message.ClickedMetric({ metric: "network" }))
		expect((picked.commands ?? []).map(({ name }) => name)).toEqual(["FetchInfraContainerSeries"])
		expect(picked.model.metric).toBe("network")
	})

	test("a container with no data in the window offers the way back to the list", () => {
		const model = windowed().model
		const empty = pageUpdate(
			model,
			Message.CompletedFetchSummary({ key: model.summary.key ?? "", result: Result.succeed(null) }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(empty),
			Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} })),
			expectView(role("link", { name: /containers/i })).toHaveAttr("href", "/infra/containers"),
		)
	})
})
