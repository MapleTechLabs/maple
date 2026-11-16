import { CLOUD_FINDING_SOURCE_SPECS, CLOUD_FINDING_SOURCES } from "@maple/domain/cloud-security"
import { Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { linkButton } from "@maple/views/ui/button"
import {
	empty,
	emptyContent,
	emptyDescription,
	emptyFrameClass,
	emptyHeader,
	emptyMedia,
	emptyTitle,
} from "@maple/views/ui/empty"
import { icon } from "@maple/views/ui/icon"
import { vstack } from "@maple/views/ui/stack"
import { textLink } from "@maple/views/ui/text-link"
import { AppRoute, hrefOf } from "../../../route"
import { type ServiceNotice, type Setup, sourceTitle } from "./derive"

// What the Cloud tab says before it has findings to list: AWS not connected, the security module
// not asked for or not granted yet, services off or refused in some regions, and all clear.

const CONNECT_HREF = hrefOf(AppRoute.SourcesNew({ search: { integration: "aws" } }))
const MANAGE_HREF = hrefOf(AppRoute.Integrations({ search: { integration: "aws" } }))

const SOURCES_SENTENCE = "GuardDuty, Security Hub, Inspector and IAM Access Analyzer"

const setupEmpty = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ title: string; description: string; action: Html }>,
): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "AwsIcon")]),
				emptyTitle(h, [options.title]),
				emptyDescription(h, [options.description]),
			]),
			emptyContent(h, [options.action]),
		],
		emptyFrameClass("dashed"),
	)

/** The setup step the org is on, when it is not `Ready`. */
export const setupState = <M>(h: HtmlBuilder<M>, setup: Exclude<Setup, "Ready">): Html => {
	switch (setup) {
		case "NoConnection":
			return setupEmpty(h, {
				title: "Connect AWS to see its security findings",
				description: `Maple reads ${SOURCES_SENTENCE} findings from your accounts and shows which of your services each one touches. Choose the Security scan module when you connect.`,
				action: linkButton(h, { href: CONNECT_HREF, size: "sm" }, [
					icon(h, "AwsIcon"),
					"Connect AWS",
				]),
			})
		case "NotRequested":
			return setupEmpty(h, {
				title: "Turn on the Security scan module",
				description: `Your AWS connection does not read security findings yet. Add the Security scan module to it, then deploy the updated stack so the role may read ${SOURCES_SENTENCE}.`,
				action: linkButton(h, { href: MANAGE_HREF, size: "sm", variant: "outline" }, [
					"Open the AWS connection",
				]),
			})
		case "AwaitingGrant":
			return setupEmpty(h, {
				title: "Update the AWS stack to finish",
				description:
					"The connection asks for the Security scan module, but the role in your account does not grant it yet. Deploy the updated stack; findings appear within the hour after the next check.",
				action: linkButton(h, { href: MANAGE_HREF, size: "sm", variant: "outline" }, [
					"Get the updated stack",
				]),
			})
	}
}

const external = <M>(h: HtmlBuilder<M>) => [h.Target("_blank"), h.Rel("noopener noreferrer")]

const regionsText = (regions: ReadonlyArray<string>): string =>
	regions.length <= 3
		? Arr.join(regions, ", ")
		: `${Arr.join(Arr.take(regions, 3), ", ")} and ${regions.length - 3} more`

/** One service that is off, refused or failing somewhere, as a callout with its way out. */
const noticeAlert = <M>(h: HtmlBuilder<M>, notice: ServiceNotice): Html => {
	const spec = CLOUD_FINDING_SOURCE_SPECS[notice.source]
	const where = regionsText(notice.regions)
	switch (notice.state) {
		case "not_enabled":
			return alert(h, { variant: "default", size: "sm" }, [
				icon(h, "CircleInfoIcon"),
				alertTitle(h, [`${spec.title} is off in ${where}`]),
				alertDescription(h, [
					`${spec.summary} `,
					textLink(h, { href: spec.enableUrl, attributes: external(h) }, [`Turn on ${spec.title}`]),
				]),
			])
		case "denied":
			return alert(h, { variant: "warn", size: "sm" }, [
				icon(h, "LockIcon"),
				alertTitle(h, [`The role may not read ${spec.title} in ${where}`]),
				alertDescription(h, [
					...(notice.lastError === null ? [] : [`${notice.lastError} `]),
					textLink(h, { href: MANAGE_HREF }, ["Update the AWS stack"]),
				]),
			])
		case "failing":
			return alert(h, { variant: "crit", size: "sm" }, [
				icon(h, "CircleWarningIcon"),
				alertTitle(h, [`Reading ${spec.title} failed in ${where}`]),
				alertDescription(h, [
					notice.lastError ?? "No error was reported. Maple retries on the next poll.",
				]),
			])
	}
}

export const serviceNotices = <M>(h: HtmlBuilder<M>, notices: ReadonlyArray<ServiceNotice>): Html | null =>
	notices.length === 0
		? null
		: vstack(
				h,
				{ gap: "2", attributes: [h.AriaLabel("Security services that need attention")] },
				Arr.map(notices, (notice) => noticeAlert(h, notice)),
			)

/** Granted, but no service has been read yet: the quiet is not a result yet. */
export const awaitingFirstRead = <M>(h: HtmlBuilder<M>): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "HistoryIcon")]),
				emptyTitle(h, ["Waiting for the first read"]),
				emptyDescription(h, [
					"Maple reads the account's security services every five minutes. Findings show here once the first read is done.",
				]),
			]),
		],
		"py-14",
	)

/**
 * No active finding: what was checked, so the quiet reads as a result. With a service that could
 * not be read, it says the quiet covers only the ones that answered.
 */
export const allClear = <M>(h: HtmlBuilder<M>, isPartial: boolean): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [
					icon(h, isPartial ? "CircleInfoIcon" : "ShieldCheckIcon"),
				]),
				emptyTitle(h, [
					isPartial ? "No active findings from the services that answered" : "No active findings",
				]),
				emptyDescription(h, [
					isPartial
						? "The services above could not be read, so findings they hold are not listed yet."
						: `None of ${Arr.join(Arr.map(CLOUD_FINDING_SOURCES, sourceTitle), ", ")} reports an active finding in the regions they are on.`,
				]),
			]),
		],
		"py-14",
	)
