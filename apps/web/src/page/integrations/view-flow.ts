import type { Html, HtmlBuilder } from "foldkit/html"
import type { DataIntegration } from "../../route/data-integrations"
import { flowColumns, liveChecklist, savedBanner } from "../kit/connect-flow"
import { overviewOf } from "./derive"
import { relativeTime } from "../kit/relative-time"
import type { FlowStage } from "./flow"
import type { Message } from "./message"
import type { Model } from "./model"
import { cardView } from "./view"
import { providerModuleOf } from "./provider-modules"
import { gcpFlowView } from "../infra-integrations/gcp/integration/view-flow-gcp"
import { prometheusFlowView } from "./view-flow-prometheus"
import { cloudflareFlowView } from "../infra-integrations/cloudflare/integration/view-flow-cloudflare"
import { githubFlowView } from "./view-flow-github"
import { awsFlowView } from "../infra-integrations/aws/integration/view-flow-aws"

type H = HtmlBuilder<Message>

/** A source not yet on the shared steps: its own card to connect, then its overview as Go live. */
const genericFlowView = (
	h: H,
	model: Model,
	integration: DataIntegration,
	stage: FlowStage,
	timeZone: string,
): Html => {
	if (stage !== "live") return flowColumns(h, [...cardView(h, model, integration, timeZone)], null)
	const overview = overviewOf(model.statuses, model.nowMs, integration)
	const connected = overview?.kind === "connected" ? overview : null
	return flowColumns(
		h,
		[
			savedBanner(h, "Saved as a source. Safe to leave; collection keeps running."),
			liveChecklist(h, {
				rows: [
					{
						state: "done",
						title: "Connected",
						detail: connected?.context ?? null,
					},
					connected === null || connected.health === "pending"
						? {
								state: "working",
								title: "Waiting for the first data",
								detail: connected?.stat ?? null,
							}
						: connected.health === "attention"
							? { state: "failed", title: connected.stateLabel, detail: connected.issue ?? "" }
							: {
									state: "done",
									title: "Receiving data",
									meta:
										connected.lastSync === null
											? null
											: relativeTime(h, {
													value: connected.lastSync.at,
													nowMs: model.nowMs,
													timeZone,
													prefix: connected.lastSync.verb,
												}),
								},
				],
			}),
		],
		null,
	)
}

export const flowView = (
	h: H,
	model: Model,
	integration: DataIntegration,
	stage: FlowStage,
	timeZone: string,
): Html => {
	const providerView = providerModuleOf(integration)?.flowView ?? null
	if (providerView !== null) return providerView(h, model, stage, timeZone)
	switch (integration) {
		case "prometheus":
		case "warpstream":
			return prometheusFlowView(h, model, integration, stage, timeZone)
		case "aws":
			return awsFlowView(h, model, stage, timeZone)
		case "gcp":
			return gcpFlowView(h, model, stage, timeZone)
		case "cloudflare":
			return cloudflareFlowView(h, model, stage)
		case "github":
			return githubFlowView(h, model, stage)
		default:
			return genericFlowView(h, model, integration, stage, timeZone)
	}
}
