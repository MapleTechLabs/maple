import { cn } from "@maple/ui/lib/utils"
import { type GcpDraftEffect, gcpCollectLock } from "../connector-state"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "@maple/views/ui/icon"
import { featureList } from "../../../kit/feature-list"
import { CAPABILITIES, CAPABILITY_IDS, LOCK_NOTES } from "./gcp-configure-copy"
import type { Capability, GcpFlags } from "./gcp-configure-schema"
import { Message } from "../../../integrations/message"
import { GCP_TITLE, SMALL } from "./view-gcp-parts"
import { hstack, vstackClass } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { Array as Arr } from "effect"

type H = HtmlBuilder<Message>

/** `effect` says, for a connection, what saving a choice does and when. */
export const collectFields = (
	h: H,
	options: Readonly<{
		flags: GcpFlags
		metricsAvailable: boolean
		effect?: (capability: Capability) => GcpDraftEffect | null
		logFilter: Html
	}>,
): Html => {
	const { flags } = options
	const locks = Arr.map(CAPABILITY_IDS, (capability) =>
		gcpCollectLock(flags, capability, options.metricsAvailable),
	)
	return h.fieldset(
		[h.Class(vstackClass({ gap: "3" }))],
		[
			h.legend([h.Class(cn(GCP_TITLE, "mb-3"))], ["What should Maple collect?"]),
			featureList(h, {
				idPrefix: "gcp-collect",
				rows: Arr.map(CAPABILITY_IDS, (capability, index) => {
					const { spec, flag, effects } = CAPABILITIES[capability]
					const note = options.effect?.(capability) ?? null
					const lock = locks[index] ?? null
					return {
						spec,
						isChecked: flags[flag],
						isDisabled: lock !== null,
						onToggle: Message.ToggledGcpCollect({ capability }),
						children: [
							...(lock === "metrics-unavailable"
								? [noteLine(h, "info", LOCK_NOTES["metrics-unavailable"])]
								: []),
							...(note === null
								? []
								: [noteLine(h, note === "stops-now" ? "warn" : "info", effects[note])]),
							...(capability === "logs" && flags.logs_enabled ? [options.logFilter] : []),
						],
					}
				}),
			}),
			// A rule of the pair, so it stands under both and not under the one it happens to lock.
			...(locks.includes("last-on") ? [h.p([h.Class(SMALL)], [LOCK_NOTES["last-on"]])] : []),
		],
	)
}

const noteLine = (h: H, tone: "warn" | "info", text: string): Html =>
	hstack(h, { gap: "1.5", align: "start" }, [
		tone === "warn"
			? icon(h, "AlertWarningIcon", { size: 12, className: "mt-0.5 shrink-0 text-severity-warn" })
			: icon(h, "CircleInfoIcon", { size: 12, className: "mt-0.5 shrink-0 text-muted-foreground" }),
		typography(h, { size: "xs", as: "p", className: "text-pretty" }, [text]),
	])
