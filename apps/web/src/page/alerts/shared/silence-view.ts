import type { V2AlertSilence } from "@maple/domain/http/v2"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { badge } from "@maple/views/ui/display"
import { icon } from "@maple/views/ui/icon"
import { typography } from "@maple/views/ui/typography"
import { endsAtMs, formatSilenceTime } from "./silences"

/** "Silenced until 15:00": the silence holding back a rule's or an incident's notifications. */
export const silenceBadge = <M>(
	h: HtmlBuilder<M>,
	silence: V2AlertSilence,
	nowMs: number,
	timeZone: string,
	/** Names the one group silenced when the rule as a whole is not ("checkout silenced until"). */
	group: string | null = null,
): Html =>
	badge(h, { variant: "outline", attributes: [h.Title(silence.reason)] }, [
		icon(h, "BellSlashIcon"),
		`${group === null ? "Silenced" : `${group} silenced`} until ${formatSilenceTime(endsAtMs(silence), nowMs, timeZone)}`,
	])

/** Shown in place of the badge when the silences could not be read, so "no badge" never reads as "not silenced". */
export const silenceCheckFailed = <M>(h: HtmlBuilder<M>): Html =>
	typography(h, { size: "xs", tone: "muted" }, ["Couldn't check silences"])

/** The header's "Silence" action, which opens the silence dialog scoped to the page's rule or incident. */
export const silenceButton = <M>(h: HtmlBuilder<M>, onClick: M, isDisabled = false): Html =>
	button(h, { variant: "outline", size: "sm", isDisabled, attributes: [h.OnClick(onClick)] }, [
		icon(h, "BellSlashIcon"),
		"Silence",
	])
