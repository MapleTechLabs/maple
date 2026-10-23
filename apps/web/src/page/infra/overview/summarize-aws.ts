import { AWS_INFRA_KINDS } from "@maple/domain/aws-infra"
import { countLabel } from "@maple/ui/lib/format"
import type { FleetRead } from "../../infra-integrations/aws/data"
import { type ResourceView, resourceViews, summaryOf } from "../../infra-integrations/aws/derive"
import type { Finding, SourceSummary } from "./model"

// `summarizeAws`: the /infra/aws page's health, as the overview's row and findings.

const MAX_FINDINGS = 3

/** What a finding says after the resource's name, by the band cell it counts in. */
const PHRASE = new Map([
	["status", "failing its status check"],
	["hot", "above 80% CPU or memory"],
	["5xx", "serving 5xx on 1% of requests or more"],
	["errors", "erroring on 1% of invocations or more"],
	["throttled", "throttled"],
	["backlog", "backed up over 5 min"],
])

const finding = (view: ResourceView, tone: "crit" | "warn"): Finding => ({
	key: `aws:${view.kind}:${JSON.stringify(view.keys)}`,
	source: "aws",
	tone,
	subject: view.name,
	title: `${view.name} ${PHRASE.get(view.scope ?? "") ?? view.reason ?? "needs a look"}`,
	detail: [AWS_INFRA_KINDS[view.kind].label, view.cluster, view.region]
		.filter((part) => part !== "")
		.join(" · "),
	target: {
		kind: "aws",
		resourceKind: view.kind,
		name: view.name,
		cluster: view.cluster,
		region: view.region,
		account: view.account,
	},
})

/** `null` when every kind's read failed: the overview shows that as couldn't load, not as empty. */
export const summarizeAws = (reads: ReadonlyArray<FleetRead>): SourceSummary | null => {
	const failed = reads.filter((read) => read.failed)
	if (reads.length > 0 && failed.length === reads.length) return null
	const views = reads.flatMap(resourceViews)
	const summary = summaryOf(views)
	const flagged = summary.counts.crit + summary.counts.warn
	const findings = [
		...views.filter((view) => view.health === "crit").map((view) => finding(view, "crit")),
		...views.filter((view) => view.health === "warn").map((view) => finding(view, "warn")),
	].slice(0, MAX_FINDINGS)
	const unread = failed.map((read) => AWS_INFRA_KINDS[read.kind].title).join(", ")
	return {
		resources: countLabel(summary.total, "resource"),
		segments: [
			{ key: "ok", count: summary.counts.ok },
			{ key: "idle", count: summary.counts.idle },
			{ key: "elevated", count: summary.counts.warn },
			{ key: "saturated", count: summary.counts.crit },
		],
		headline:
			[
				...(unread === "" ? [] : [`${unread} not read`]),
				...(flagged > 0 ? [`${countLabel(flagged, "resource")} needing a look`] : []),
				...(flagged === 0 && summary.counts.idle > 0
					? [`${countLabel(summary.counts.idle, "resource")} idle, still billed`]
					: []),
			].join(", ") || (summary.total > 0 ? "all healthy" : "no metrics in this window"),
		headlineTone: summary.counts.crit > 0 ? "crit" : flagged > 0 ? "warn" : "neutral",
		findings,
	}
}
