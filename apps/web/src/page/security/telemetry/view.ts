import { Submodel } from "foldkit"
import type { PageViewInputs } from "../../contract"
import { securityLayout } from "../kit/layout"
import { Message, type Model } from "./model"
import { exposureBody } from "./view-exposure"
import { runtimesBody } from "./view-runtimes"

// The Exposure and Runtimes tabs inside the Security frame. No plan gate: they read telemetry.

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	model.tab === "exposure"
		? securityLayout(h, { source: "exposure" }, exposureBody(h, model, inputs.context.timeZone))
		: securityLayout(h, { source: "runtimes" }, runtimesBody(h, model, inputs.context.timeZone)),
)
