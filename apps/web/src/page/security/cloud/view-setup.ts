import { CLOUD_FINDING_SOURCE_SPECS, type CloudFindingSource } from "@maple/domain/cloud-security"
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
import { hstack, vstack } from "@maple/views/ui/stack"
import { textLink } from "@maple/views/ui/text-link"
import { AppRoute, hrefOf } from "../../../route"
import { type ServiceNotice, type Setup, sourceTitle } from "./derive"

// What the Cloud tab says before it has findings to list: no cloud connected, a cloud's security
// collection not asked for or not granted yet, services off or refused somewhere, and all clear.

const AWS_CONNECT_HREF = hrefOf(AppRoute.SourcesNew({ search: { integration: "aws" } }))
const AWS_MANAGE_HREF = hrefOf(AppRoute.Integrations({ search: { integration: "aws" } }))
const GCP_CONNECT_HREF = hrefOf(AppRoute.SourcesNew({ search: { integration: "gcp" } }))
const GCP_MANAGE_HREF = hrefOf(AppRoute.Integrations({ search: { integration: "gcp" } }))

const AWS_SOURCES_SENTENCE = "GuardDuty, Security Hub, Inspector and IAM Access Analyzer"

const setupEmpty = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		icon: "AwsIcon" | "GoogleCloudIcon" | "ShieldCheckIcon"
		title: string
		description: string
		actions: ReadonlyArray<Html>
	}>,
): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, options.icon)]),
				emptyTitle(h, [options.title]),
				emptyDescription(h, [options.description]),
			]),
			emptyContent(h, [hstack(h, { gap: "2", justify: "center", wrap: true }, options.actions)]),
		],
		emptyFrameClass("dashed"),
	)

const awsConnect = <M>(h: HtmlBuilder<M>): Html =>
	linkButton(h, { href: AWS_CONNECT_HREF, size: "sm" }, [icon(h, "AwsIcon"), "Connect AWS"])

const gcpConnect = <M>(h: HtmlBuilder<M>, variant: "default" | "outline"): Html =>
	linkButton(h, { href: GCP_CONNECT_HREF, size: "sm", variant }, [
		icon(h, "GoogleCloudIcon"),
		"Connect Google Cloud",
	])

const awsSetup = <M>(h: HtmlBuilder<M>, setup: "NotRequested" | "AwaitingGrant"): Html =>
	setup === "NotRequested"
		? setupEmpty(h, {
				icon: "AwsIcon",
				title: "Turn on the Security scan module",
				description: `Your AWS connection does not read security findings yet. Add the Security scan module to it, then deploy the updated stack so the role may read ${AWS_SOURCES_SENTENCE}.`,
				actions: [
					linkButton(h, { href: AWS_MANAGE_HREF, size: "sm", variant: "outline" }, [
						"Open the AWS connection",
					]),
				],
			})
		: setupEmpty(h, {
				icon: "AwsIcon",
				title: "Update the AWS stack to finish",
				description:
					"The connection asks for the Security scan module, but the role in your account does not grant it yet. Deploy the updated stack; findings appear within the hour after the next check.",
				actions: [
					linkButton(h, { href: AWS_MANAGE_HREF, size: "sm", variant: "outline" }, [
						"Get the updated stack",
					]),
				],
			})

const gcpSetup = <M>(h: HtmlBuilder<M>, setup: "NotRequested" | "AwaitingGrant"): Html =>
	setup === "NotRequested"
		? setupEmpty(h, {
				icon: "GoogleCloudIcon",
				title: "Turn on Security findings for Google Cloud",
				description:
					"Your Google Cloud connector does not read Security Command Center findings yet. Turn on Security findings on it, then run its setup again so Maple may read them.",
				actions: [
					linkButton(h, { href: GCP_MANAGE_HREF, size: "sm", variant: "outline" }, [
						"Open the Google Cloud connector",
					]),
				],
			})
		: setupEmpty(h, {
				icon: "GoogleCloudIcon",
				title: "Run the Google Cloud setup again to finish",
				description:
					"The connector asks for Security findings, but its setup has not been run since. Run the updated setup script or console steps; findings appear after the next check.",
				actions: [
					linkButton(h, { href: GCP_MANAGE_HREF, size: "sm", variant: "outline" }, [
						"Get the updated setup",
					]),
				],
			})

/** What the org does next when no cloud's findings can be listed yet: one card per connected cloud. */
export const setupState = <M>(h: HtmlBuilder<M>, setup: Setup): Html => {
	if (setup.aws === undefined && setup.gcp === undefined)
		return setupEmpty(h, {
			icon: "ShieldCheckIcon",
			title: "Connect a cloud to see its security findings",
			description: `Maple reads ${AWS_SOURCES_SENTENCE} findings from AWS, and Security Command Center findings from Google Cloud, and shows which of your services each one touches. Choose the Security scan module on AWS, or Security findings on Google Cloud, when you connect.`,
			actions: [awsConnect(h), gcpConnect(h, "outline")],
		})
	const cards = [
		...(setup.aws === undefined || setup.aws === "Ready" ? [] : [awsSetup(h, setup.aws)]),
		...(setup.gcp === undefined || setup.gcp === "Ready" ? [] : [gcpSetup(h, setup.gcp)]),
	]
	return vstack(h, { gap: "4" }, cards)
}

/**
 * A cloud whose security collection is asked for but not granted while another cloud's findings
 * list: a callout above the list, since the list alone would read as complete.
 */
export const pendingSetupNotices = <M>(h: HtmlBuilder<M>, setup: Setup): ReadonlyArray<Html> => [
	...(setup.aws === "AwaitingGrant"
		? [
				alert(h, { variant: "default", size: "sm" }, [
					icon(h, "CircleInfoIcon"),
					alertTitle(h, ["Update the AWS stack to read its findings"]),
					alertDescription(h, [
						"The AWS connection asks for the Security scan module, but its role does not grant it yet. ",
						textLink(h, { href: AWS_MANAGE_HREF }, ["Get the updated stack"]),
					]),
				]),
			]
		: []),
	...(setup.gcp === "AwaitingGrant"
		? [
				alert(h, { variant: "default", size: "sm" }, [
					icon(h, "CircleInfoIcon"),
					alertTitle(h, ["Run the Google Cloud setup again to read its findings"]),
					alertDescription(h, [
						"The Google Cloud connector asks for Security findings, but its setup has not been run since. ",
						textLink(h, { href: GCP_MANAGE_HREF }, ["Get the updated setup"]),
					]),
				]),
			]
		: []),
]

const external = <M>(h: HtmlBuilder<M>) => [h.Target("_blank"), h.Rel("noopener noreferrer")]

const placesText = (places: ReadonlyArray<string>): string =>
	places.length <= 3
		? Arr.join(places, ", ")
		: `${Arr.join(Arr.take(places, 3), ", ")} and ${places.length - 3} more`

/** One service that is off, refused or failing somewhere, as a callout with its way out. */
const noticeAlert = <M>(h: HtmlBuilder<M>, notice: ServiceNotice): Html => {
	const spec = CLOUD_FINDING_SOURCE_SPECS[notice.source]
	const isGcp = notice.provider === "gcp"
	// AWS services answer per region; Security Command Center per scope.
	const where = `${isGcp ? "for" : "in"} ${placesText(notice.places)}`
	switch (notice.state) {
		case "not_enabled":
			return alert(h, { variant: "default", size: "sm" }, [
				icon(h, "CircleInfoIcon"),
				alertTitle(h, [
					isGcp ? `${spec.title} is not activated ${where}` : `${spec.title} is off ${where}`,
				]),
				alertDescription(h, [
					`${spec.summary} `,
					textLink(h, { href: spec.enableUrl, attributes: external(h) }, [
						isGcp ? `Activate ${spec.title}` : `Turn on ${spec.title}`,
					]),
				]),
			])
		case "denied":
			return alert(h, { variant: "warn", size: "sm" }, [
				icon(h, "LockIcon"),
				alertTitle(h, [
					isGcp
						? `The connector may not read ${spec.title} ${where}`
						: `The role may not read ${spec.title} ${where}`,
				]),
				alertDescription(h, [
					...(notice.lastError === null ? [] : [`${notice.lastError} `]),
					isGcp
						? textLink(h, { href: GCP_MANAGE_HREF }, ["Run the Google Cloud setup again"])
						: textLink(h, { href: AWS_MANAGE_HREF }, ["Update the AWS stack"]),
				]),
			])
		case "failing":
			return alert(h, { variant: "crit", size: "sm" }, [
				icon(h, "CircleWarningIcon"),
				alertTitle(h, [`Reading ${spec.title} failed ${where}`]),
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
					"Maple reads your clouds' security services every five minutes. Findings show here once the first read is done.",
				]),
			]),
		],
		"py-14",
	)

/**
 * No active finding: what was checked, so the quiet reads as a result. With a service that could
 * not be read, it says the quiet covers only the ones that answered.
 */
export const allClear = <M>(
	h: HtmlBuilder<M>,
	isPartial: boolean,
	sources: ReadonlyArray<CloudFindingSource>,
): Html =>
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
						: sources.length === 1
							? `${Arr.join(Arr.map(sources, sourceTitle), "")} reports no active finding.`
							: `None of ${Arr.join(Arr.map(sources, sourceTitle), ", ")} reports an active finding where they are on.`,
				]),
			]),
		],
		"py-14",
	)
