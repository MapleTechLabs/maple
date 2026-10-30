import { cn } from "@maple/ui/lib/utils"
import { type GcpDraftEffect, gcpCollectLock } from "../../components/integrations/gcp-connector-state"
import type { Html, HtmlBuilder } from "foldkit/html"
import { labelIdOf } from "../../ui/choice"
import { icon } from "../../ui/icon"
import * as Switch from "../../ui/switch"
import { CAPABILITIES, CAPABILITY_IDS, LOCK_NOTES } from "./gcp-configure-copy"
import type { Capability, GcpFlags } from "./gcp-configure-schema"
import { Message } from "./message"
import { GCP_TITLE, SMALL } from "./view-gcp-parts"

// `CollectFields`: a switch per capability, with the log filter under Logs. Nothing is saved here.

type H = HtmlBuilder<Message>

const COLLECT_ID = "gcp-collect"

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
	const locks = CAPABILITY_IDS.map((capability) =>
		gcpCollectLock(flags, capability, options.metricsAvailable),
	)
	return h.fieldset(
		[h.Class("flex flex-col gap-3")],
		[
			h.legend([h.Class(cn(GCP_TITLE, "mb-3"))], ["What should Maple collect?"]),
			h.div(
				[h.Class("divide-y divide-border-subtle rounded-md border")],
				CAPABILITY_IDS.map((capability, index) => {
					const { title, flag, description, effects } = CAPABILITIES[capability]
					const note = options.effect?.(capability) ?? null
					const inputId = `${COLLECT_ID}-${capability}`
					const lock = locks[index] ?? null
					return h.div(
						[h.Class("flex flex-col gap-3 p-4")],
						[
							h.div(
								[h.Class("flex items-start gap-4")],
								[
									h.div(
										[h.Class("flex min-w-0 flex-1 flex-col gap-0.5")],
										[
											h.label(
												[
													h.For(inputId),
													h.Id(labelIdOf(inputId)),
													h.Class("text-sm font-medium"),
												],
												[title],
											),
											h.p(
												[h.Class(SMALL)],
												[
													lock === "metrics-unavailable"
														? LOCK_NOTES["metrics-unavailable"]
														: description,
												],
											),
											...(note === null ? [] : [effectNote(h, note, effects[note])]),
										],
									),
									...Switch.switchControl(h, {
										id: `${inputId}-switch`,
										inputId,
										isChecked: flags[flag],
										isDisabled: lock !== null,
										labelledBy: labelIdOf(inputId),
										onToggle: Message.ToggledGcpCollect({ capability }),
									}),
								],
							),
							...(capability === "logs" && flags.logs_enabled ? [options.logFilter] : []),
						],
					)
				}),
			),
			// A rule of the pair, so it stands under both and not under the one it happens to lock.
			...(locks.includes("last-on") ? [h.p([h.Class(SMALL)], [LOCK_NOTES["last-on"]])] : []),
		],
	)
}

const effectNote = (h: H, note: GcpDraftEffect, text: string): Html =>
	h.p(
		[h.Class("flex items-start gap-1.5 text-xs/5 text-pretty text-foreground")],
		[
			note === "stops-now"
				? icon(h, "AlertWarningIcon", { size: 12, className: "mt-1 shrink-0 text-severity-warn" })
				: icon(h, "CircleInfoIcon", { size: 12, className: "mt-1 shrink-0 text-muted-foreground" }),
			text,
		],
	)
