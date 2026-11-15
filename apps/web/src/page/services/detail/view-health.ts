import { parseWarehouseDateTime } from "@maple/query-engine"
import { formatErrorRate, formatLatency, formatRate } from "@maple/ui/lib/format"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertAction, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { button } from "@maple/views/ui/button"
import { badge } from "@maple/views/ui/display"
import { icon } from "@maple/views/ui/icon"
import { statRail, statRailItem, statRailLoading } from "../../kit/stat-rail"
import { firstLine, isResolvableSha } from "../../kit/commit-card"
import { shortId } from "@maple/ui/lib/ids"
import { countLabel } from "@maple/ui/lib/format"
import { deriveHealth, type Signal } from "./derive-health"
import {
	type DeployCheck,
	dataEndOf,
	deployBefore,
	deployDataEndOf,
	isComparable,
	isSameDeploy,
	leadDeploy,
} from "./derive-deploys"
import type { Issue, Model } from "./model"
import { Message } from "./message"
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
	const health = deriveHealth(mergedPoints(model), dataEndOf(model))
	if (health === null) return null
	const now = (signal: Signal, format: (value: number) => string) =>
		signal.now === null ? "—" : format(signal.now)
	return statRail(h, { columns: 4, className: "w-full overflow-hidden" }, [
		statRailItem(h, {
			eyebrow: "Requests",
			eyebrowTooltip: "The latest complete bucket, and the average over the window beneath it.",
			value: now(health.throughput, formatRate),
			tone: health.throughput.tone,
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

/** "9b2f0d1 Batch card authorisations… production": the short sha, the subject once resolved, the environment. */
const deployName = (h: H, model: Model, deploy: DeployCheck): Html => {
	const sha = isResolvableSha(deploy.sha) ? shortId(deploy.sha, "sha") : deploy.sha
	const commit = model.commits[deploy.sha]
	const subject = commit !== undefined && AsyncData.isSuccess(commit) ? firstLine(commit.data.message) : ""
	return hstack(h, { gap: "2", className: "min-w-0" }, [
		typography(h, { size: "xs", mono: true, tone: "foreground", className: "shrink-0" }, [sha]),
		...(subject === "" ? [] : [typography(h, { tone: "foreground", truncate: true }, [subject])]),
		...(deploy.environment === ""
			? []
			: [badge(h, { size: "xs", variant: "meta", className: "shrink-0" }, [deploy.environment])]),
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

/** A deploy flagged before its window is up names the minutes it was judged on, not the full window. */
const detail = (deploy: DeployCheck, newIssues: number): string => {
	const window = `${deploy.windowMinutes} minutes`
	const judged =
		deploy.minutes < deploy.windowMinutes ? countLabel(Math.max(1, deploy.minutes), "minute") : window
	const issues = newIssues === 0 ? "" : ` ${countLabel(newIssues, "open issue")} first seen since.`
	const figure = verdictFigure(deploy)
	return figure === undefined
		? isComparable(deploy)
			? `No change so far against the ${window} before it.${issues}`
			: `Too little traffic to compare yet.${issues}`
		: `${figure} in its first ${judged}, against the ${window} before it.${issues}`
}

/** The newest flagged deploy, else the one still verifying; nothing when every deploy is settled. */
export const deployCallout = (h: H, model: Model, deploys: ReadonlyArray<DeployCheck>): Html => {
	const deploy = leadDeploy(deploys)
	if (deploy === undefined) return null
	const issues: ReadonlyArray<Issue> = AsyncData.getOrElse(model.issues.data, () => [])
	// The issue tags' rule: an issue belongs to the newest deploy before it first appeared.
	const newIssues = Arr.filter(issues, (issue) =>
		isSameDeploy(
			deployBefore(deploys, parseWarehouseDateTime(issue.firstSeenAt), deployDataEndOf(model)),
			deploy,
		),
	).length
	return alert(h, { variant: ALERT_VARIANT[deploy.verdict], role: "status" }, [
		icon(h, deploy.verdict === "verifying" ? "ClockIcon" : "CircleWarningIcon"),
		alertTitle(h, [headline(deploy)]),
		alertDescription(h, [deployName(h, model, deploy), h.span([], [detail(deploy, newIssues)])]),
		alertAction(h, [
			button(
				h,
				{
					variant: "outline",
					size: "sm",
					attributes: [
						h.OnClick(
							Message.ClickedDeploy({ sha: deploy.sha, environment: deploy.environment }),
						),
					],
				},
				["What changed", icon(h, "ArrowRightIcon")],
			),
		]),
	])
}
