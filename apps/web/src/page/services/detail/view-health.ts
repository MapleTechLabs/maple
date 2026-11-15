import { parseWarehouseDateTime } from "@maple/query-engine"
import { formatErrorRate, formatLatency, formatRate } from "@maple/ui/lib/format"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { icon } from "@maple/views/ui/icon"
import { statRail, statRailItem, statRailLoading } from "../../kit/stat-rail"
import { firstLine, isResolvableSha } from "../../kit/commit-card"
import { shortId } from "@maple/ui/lib/ids"
import { countLabel } from "@maple/ui/lib/format"
import { deriveHealth, type Signal } from "./derive-health"
import { type DeployCheck, deployBefore, leadDeploy } from "./derive-deploys"
import type { Issue, Model } from "./model"
import type { Message } from "./message"
import { mergedPoints } from "./view-charts"
import { verdictFigure } from "./view-verdict"
import { Array as Arr } from "effect"
import { hstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"

// The Overview's top: the deploy that needs a look, then each golden signal now against its window.

type H = HtmlBuilder<Message>

const caption = (signal: Signal, format: (value: number) => string, noun: string): string =>
	signal.window === null ? "" : `${noun} ${format(signal.window)}`

/** Requests, error rate, p95 and Apdex in the latest complete bucket; their window value beneath. */
export const healthStrip = (h: H, model: Model, isLoading: boolean): Html => {
	if (isLoading) return statRailLoading(h, 4, 4, "w-full overflow-hidden")
	const health = deriveHealth(mergedPoints(model))
	if (health === null) return null
	const now = (signal: Signal, format: (value: number) => string) =>
		signal.now === null ? "—" : format(signal.now)
	return statRail(h, { columns: 4, className: "w-full overflow-hidden" }, [
		statRailItem(h, {
			eyebrow: "Requests",
			eyebrowTooltip: "The latest complete bucket, and the average over the window beneath it.",
			value: now(health.throughput, formatRate),
			hint: "/s",
			subline: caption(health.throughput, (value) => `${formatRate(value)}/s`, "avg"),
			spark: health.throughput.values,
		}),
		statRailItem(h, {
			eyebrow: "Error rate",
			value: now(health.errorRate, formatErrorRate),
			tone: health.errorRate.tone,
			subline: caption(health.errorRate, formatErrorRate, "window"),
			spark: health.errorRate.values,
		}),
		statRailItem(h, {
			eyebrow: "p95 latency",
			value: now(health.p95, formatLatency),
			tone: health.p95.tone,
			subline: caption(health.p95, formatLatency, "typical"),
			spark: health.p95.values,
		}),
		statRailItem(h, {
			eyebrow: "Apdex",
			value: now(health.apdex, (value) => value.toFixed(2)),
			tone: health.apdex.tone,
			subline: caption(health.apdex, (value) => value.toFixed(2), "window"),
			spark: health.apdex.values,
		}),
	])
}

const ALERT_VARIANT = {
	"errors-up": "crit",
	slower: "warn",
	verifying: "info",
	clean: "default",
	unjudged: "default",
} as const

/** "9b2f0d1 Batch card authorisations…": the short sha, then the subject once it resolved. */
const deployName = (h: H, model: Model, deploy: DeployCheck): Html => {
	const sha = isResolvableSha(deploy.sha) ? shortId(deploy.sha, "sha") : deploy.sha
	const commit = model.commits[deploy.sha]
	const subject = commit !== undefined && AsyncData.isSuccess(commit) ? firstLine(commit.data.message) : ""
	return hstack(h, { gap: "2", className: "min-w-0" }, [
		typography(h, { size: "xs", mono: true, tone: "foreground", className: "shrink-0" }, [sha]),
		...(subject === "" ? [] : [typography(h, { tone: "foreground", truncate: true }, [subject])]),
	])
}

const headline = (deploy: DeployCheck): string => {
	switch (deploy.verdict) {
		case "errors-up":
			return "Errors up since this deploy"
		case "slower":
			return "Slower since this deploy"
		// `leadDeploy` returns only flagged or verifying deploys.
		case "verifying":
		case "clean":
		case "unjudged":
			return `Verifying this deploy: ${deploy.minutes} of ${deploy.windowMinutes} minutes in`
	}
}

const detail = (deploy: DeployCheck, newIssues: number): string => {
	const window = `${deploy.windowMinutes} minutes`
	const issues = newIssues === 0 ? "" : ` ${countLabel(newIssues, "open issue")} first seen since.`
	const figure = verdictFigure(deploy)
	return figure === undefined
		? `No change so far against the ${window} before it.${issues}`
		: `${figure} in its first ${window}, against the ${window} before it.${issues}`
}

/** The newest flagged deploy, else the one still verifying; nothing when every deploy is settled. */
export const deployCallout = (h: H, model: Model, deploys: ReadonlyArray<DeployCheck>): Html => {
	const deploy = leadDeploy(deploys)
	if (deploy === undefined) return null
	const issues: ReadonlyArray<Issue> = AsyncData.getOrElse(model.issues.data, () => [])
	// The issue tags' rule: an issue belongs to the newest deploy before it first appeared.
	const newIssues = Arr.filter(
		issues,
		(issue) => deployBefore(deploys, parseWarehouseDateTime(issue.firstSeenAt)) === deploy,
	).length
	return alert(h, { variant: ALERT_VARIANT[deploy.verdict], role: "status" }, [
		icon(h, deploy.verdict === "verifying" ? "ClockIcon" : "CircleWarningIcon"),
		alertTitle(h, [headline(deploy)]),
		alertDescription(h, [deployName(h, model, deploy), h.span([], [detail(deploy, newIssues)])]),
	])
}
