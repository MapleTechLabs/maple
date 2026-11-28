import type { CloudFindingDetail } from "@maple/domain/http"
import { Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
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
import { errorState } from "@maple/views/ui/error-state"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { keyValue, keyValueList } from "@maple/views/ui/key-value"
import { panel } from "@maple/views/ui/panel"
import { dividedList } from "@maple/views/ui/rule"
import { hstack, vstack } from "@maple/views/ui/stack"
import { textLink } from "@maple/views/ui/text-link"
import { timestamp } from "@maple/views/ui/timestamp"
import { typography } from "@maple/views/ui/typography"
import { AppRoute, hrefOf } from "../../../route"
import { detailTitle } from "../../kit/detail-header"
import { jsonBlock, prettyJson } from "../../kit/json-block"
import { placeholderRows } from "../kit/parts"
import { detailQueryOf, listHref, PROVIDER_LABEL, requestsLabel, sourceTitle, STATUS_LABEL } from "./derive"
import { Message, type Model } from "./model"
import { cloudSeverityBadge, externalLinkAttributes } from "./parts"

// One cloud finding: what the service said, the resource, when it was seen, the services whose
// telemetry carried the resource, and the way to it in its cloud's console.

type H = HtmlBuilder<Message>
type Clock = Readonly<{ nowMs: number; timeZone: string }>

const backLink = (h: H): Html =>
	textLink(h, { href: listHref(), tone: "muted", className: "inline-flex items-center gap-1" }, [
		icon(h, "ArrowLeftIcon", { size: 14 }),
		"All cloud findings",
	])

const missing = (h: H): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "CircleInfoIcon")]),
				emptyTitle(h, ["This finding is not here"]),
				emptyDescription(h, [
					"It may have been resolved and pruned, or the link is incomplete. The list has every finding Maple keeps.",
				]),
			]),
			emptyContent(h, [backLink(h)]),
		],
		emptyFrameClass("dashed"),
	)

const affectedServices = (h: H, detail: CloudFindingDetail, isMatched: boolean): Html =>
	vstack(h, { gap: "2" }, [
		eyebrow(h, { variant: "mono" }, ["Affected services, last 24 hours"]),
		...(isMatched || detail.affectedServices.length === 0
			? []
			: [
					typography(h, { size: "xs", tone: "muted", as: "p" }, [
						"Telemetry could not be fully read just now, so this list may be incomplete.",
					]),
				]),
		detail.affectedServices.length === 0
			? typography(h, { size: "sm", tone: "muted", as: "p" }, [
					isMatched
						? `No service sent telemetry naming ${detail.resourceId} in its resource attributes.`
						: "Telemetry could not be read just now. Reload to try again.",
				])
			: dividedList(
					h,
					{ as: "ul", bordered: true, attributes: [h.AriaLabel("Affected services")] },
					Arr.map(detail.affectedServices, (service) =>
						hstack(
							h,
							{
								as: "li",
								gap: "3",
								align: "center",
								justify: "between",
								className: "px-3 py-2",
							},
							[
								textLink(
									h,
									{
										href: hrefOf(
											AppRoute.Service({ serviceName: service.service, search: {} }),
										),
									},
									[service.service],
								),
								typography(h, { size: "xs", tone: "muted", numeric: true }, [
									requestsLabel(service.requests),
								]),
							],
						),
					),
				),
	])

const findingPanel = (h: H, detail: CloudFindingDetail, clock: Clock, isMatched: boolean): Html => {
	const at = (value: number) => timestamp(h, { value, ...clock, withYear: true, className: "tabular-nums" })
	const isGcp = detail.provider === "gcp"
	return panel(h, { className: "p-5" }, [
		vstack(h, { gap: "5" }, [
			hstack(h, { gap: "4", justify: "between", align: "start", wrap: true }, [
				detailTitle(h, {
					kind: [
						cloudSeverityBadge(h, detail.severity),
						sourceTitle(detail.source),
						STATUS_LABEL[detail.status],
					],
					title: [detail.title],
				}),
				linkButton(
					h,
					{
						href: detail.consoleUrl,
						variant: "outline",
						size: "sm",
						attributes: externalLinkAttributes(h),
					},
					[
						isGcp ? "Open in Google Cloud console" : "Open in AWS console",
						icon(h, "ExternalLinkIcon", { size: 12 }),
					],
				),
			]),
			...(detail.description === null
				? []
				: [
						typography(h, { size: "sm", as: "p", className: "max-w-3xl font-prose" }, [
							detail.description,
						]),
					]),
			keyValueList(h, { layout: "grid" }, [
				keyValue(h, { label: "Resource", wrap: true, mono: true }, [detail.resourceId]),
				...(detail.resourceName === null
					? []
					: [keyValue(h, { label: "Resource name", wrap: true }, [detail.resourceName])]),
				keyValue(h, { label: "Resource type", wrap: true, mono: true }, [detail.resourceType]),
				keyValue(h, { label: "Finding type", wrap: true, mono: true }, [detail.type]),
				keyValue(h, { label: "Cloud", wrap: true }, [PROVIDER_LABEL[detail.provider]]),
				keyValue(h, { label: isGcp ? "Project" : "Account", wrap: true, mono: true }, [
					detail.accountId,
				]),
				keyValue(h, { label: isGcp ? "Location" : "Region", wrap: true, mono: true }, [
					detail.region,
				]),
				keyValue(h, { label: "Occurrences", wrap: true }, [String(detail.occurrences)]),
				keyValue(h, { label: "First seen", wrap: true }, [at(detail.firstSeenAt)]),
				keyValue(h, { label: "Last seen", wrap: true }, [at(detail.lastSeenAt)]),
				keyValue(h, { label: "Synced", wrap: true }, [at(detail.syncedAt)]),
			]),
			affectedServices(h, detail, isMatched),
			...(detail.detail === null
				? []
				: [
						vstack(h, { gap: "1.5" }, [
							eyebrow(h, { variant: "mono" }, [`${sourceTitle(detail.source)} finding`]),
							jsonBlock(h, prettyJson(detail.detail)),
						]),
					]),
		]),
	])
}

export const detailBody = (h: H, model: Model, clock: Clock): ReadonlyArray<Html> => {
	if (detailQueryOf(model.findingSearch) === null) return [missing(h)]
	return [
		backLink(h),
		AsyncData.matchData(model.detail.data, {
			onEmpty: () => placeholderRows(h, 8),
			onFailure: (failure) =>
				failure.code === "cloud_finding_not_found"
					? missing(h)
					: errorState(h, {
							failure,
							title: "Couldn't load the finding",
							onRetry: Message.ClickedRetry(),
						}),
			onData: (response) => findingPanel(h, response.finding, clock, response.telemetryMatched),
		}),
	]
}
