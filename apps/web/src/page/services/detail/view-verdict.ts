import { formatErrorRate, formatLatency } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "@maple/views/ui/display"
import type { DeployCheck, Verdict } from "./derive-deploys"

// How a deploy's verdict reads: its tone, its label and the before → after figure behind it.

const VERDICT_VARIANT = {
	"errors-up": "crit",
	slower: "warn",
	verifying: "info",
	clean: "muted",
	unjudged: "muted",
} as const satisfies Record<Verdict, "crit" | "warn" | "info" | "muted">

const VERDICT_HINT = {
	"errors-up": "Errors at least twice as often in its first minutes as in the minutes before it.",
	slower: "p95 latency up a quarter or more in its first minutes against the minutes before it.",
	verifying: "Still inside its first minutes: the verdict lands when they are up.",
	clean: "No change worth flagging between its first minutes and the minutes before it.",
	unjudged:
		"Too little traffic on one side of the deploy to compare, or its minutes have aged out of the rollup.",
} as const satisfies Record<Verdict, string>

const verdictLabel = (check: DeployCheck): string => {
	switch (check.verdict) {
		case "errors-up":
			return "Errors up"
		case "slower":
			return "Slower"
		case "verifying":
			return `Verifying ${check.minutes}/${check.windowMinutes} min`
		case "clean":
			return "Clean"
		case "unjudged":
			return "Not judged"
	}
}

/** "errors 0.3% → 4.8%" / "p95 180ms → 262ms": the comparison behind a flag. */
export const verdictFigure = (check: DeployCheck): string | undefined => {
	switch (check.verdict) {
		case "errors-up":
			return `errors ${formatErrorRate(check.before.errorRate)} → ${formatErrorRate(check.after.errorRate)}`
		case "slower":
			return `p95 ${formatLatency(check.before.p95Ms)} → ${formatLatency(check.after.p95Ms)}`
		case "verifying":
		case "clean":
		case "unjudged":
			return undefined
	}
}

export const verdictBadge = <M>(h: HtmlBuilder<M>, check: DeployCheck): Html =>
	badge(
		h,
		{
			size: "xs",
			variant: VERDICT_VARIANT[check.verdict],
			className: "cursor-default",
			attributes: [h.Title(VERDICT_HINT[check.verdict])],
		},
		[verdictLabel(check)],
	)
