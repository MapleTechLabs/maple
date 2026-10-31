import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { expect as expectView, given, label, Mount, scene, text, withViewInputs } from "foldkit/scene"
import { describe, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "../../../../charts/theme-colors"
import { toLoadFailure } from "../../../../data/load-failure"
import { failureSentence } from "../../../../ui/error-state"
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
const route = { nodeName: "node-a", search: {} }
const PODS_FAILURE = { ...toLoadFailure(new Error("boom")), message: "The pods read timed out." }

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const themed = () => Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))

const windowed = (): Model =>
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
	).model

describe("kubernetes node", () => {
	test("pods on the node show a skeleton while loading and the failure when the read fails", () => {
		scene(
			{ update: pageUpdate, view },
			given(windowed()),
			themed(),
			expectView(label("Loading pods")).toExist(),
		)
		const model = windowed()
		const failed = pageUpdate(
			model,
			Message.CompletedFetchPods({ key: model.pods.key ?? "", result: Result.fail(PODS_FAILURE) }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(failed),
			themed(),
			expectView(text("Couldn't load pods on this node")).toExist(),
			expectView(text(failureSentence(PODS_FAILURE))).toExist(),
		)
	})
})
