import type { PushSourcePlatform } from "@maple/domain/primitives"
import { Submodel } from "foldkit"
import { AppRoute } from "../../../route"
import type { PageContext } from "../../contract"
import type { DataIntegration } from "../../integrations/embed"
import type { Message } from "./message"
import type { Model } from "./model"
import { type FlowReturn, init, isIntegrationConnected } from "./update"
import { stepBody, titleContent } from "./view"

// `/sources/new`'s flow without the page around it, for onboarding's connect drawer.

export { Message } from "./message"
export { Model } from "./model"
export { type FlowReturn, updateFlow } from "./update"
export { subscriptions } from "./subscription"

/** What the flow opens on: a data integration's steps, or a push platform's name and token. */
export type FlowTarget =
	| Readonly<{ _tag: "Integration"; integration: DataIntegration }>
	| Readonly<{ _tag: "Push"; platform: PushSourcePlatform }>

/** The flow entered at its target, as `/sources/new?integration=` or `?platform=` would. */
export const initFlow = (target: FlowTarget, context: PageContext): FlowReturn =>
	init(
		AppRoute.SourcesNew({
			search:
				target._tag === "Integration"
					? { integration: target.integration }
					: { platform: target.platform },
		}),
		context,
	)

/** The source exists: connected, or a push source created. */
export const isFlowDone = (model: Model): boolean => model.created !== null || isIntegrationConnected(model)

/** The drawer's header: the source's mark, its title and the trail. */
export const headerEmbed = Submodel.defineView<Model, Message, Readonly<Record<never, never>>>(
	(model, _, h) => titleContent(h, model),
)

/** The drawer's body: the current step and its footer, with Done in place of links away. */
export const bodyEmbed = Submodel.defineView<Model, Message, Readonly<{ timeZone: string }>>(
	(model, inputs, h) => stepBody(h, model, inputs.timeZone, "drawer"),
)
