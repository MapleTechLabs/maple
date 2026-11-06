import type { V2AwsConnection } from "@maple/domain/http/v2"
import { AWS_METRIC_NAMESPACES, type AwsMetricNamespace } from "@maple/domain/primitives"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { label } from "@maple/views/ui/label"
import { heading } from "@maple/views/ui/heading"
import * as Checkbox from "@maple/views/ui/checkbox"
import { switchControl } from "@maple/views/ui/switch"
import { type AwsSelection, selectionOf } from "./aws"
import { Message } from "./message"
import type { Model } from "./model"
import { typography } from "@maple/views/ui/typography"
import { vstack } from "@maple/views/ui/stack"
import { Array as Arr, String as Str } from "effect"

// Which regions and services a connection streams: Choose data in the connect flow, and Edit data
// on the connected card.

type H = HtmlBuilder<Message>

/** Commercial regions with a metric stream; a region picked elsewhere is listed too. */
const REGIONS: ReadonlyArray<Readonly<{ code: string; location: string }>> = [
	{ code: "us-east-1", location: "N. Virginia" },
	{ code: "us-east-2", location: "Ohio" },
	{ code: "us-west-1", location: "N. California" },
	{ code: "us-west-2", location: "Oregon" },
	{ code: "ca-central-1", location: "Canada" },
	{ code: "sa-east-1", location: "Sao Paulo" },
	{ code: "eu-west-1", location: "Ireland" },
	{ code: "eu-west-2", location: "London" },
	{ code: "eu-west-3", location: "Paris" },
	{ code: "eu-central-1", location: "Frankfurt" },
	{ code: "eu-north-1", location: "Stockholm" },
	{ code: "eu-south-1", location: "Milan" },
	{ code: "ap-south-1", location: "Mumbai" },
	{ code: "ap-southeast-1", location: "Singapore" },
	{ code: "ap-southeast-2", location: "Sydney" },
	{ code: "ap-northeast-1", location: "Tokyo" },
	{ code: "ap-northeast-2", location: "Seoul" },
	{ code: "ap-northeast-3", location: "Osaka" },
	{ code: "ap-east-1", location: "Hong Kong" },
	{ code: "me-south-1", location: "Bahrain" },
	{ code: "af-south-1", location: "Cape Town" },
]

export const NAMESPACE_LABEL = {
	"AWS/ECS": "ECS",
	"ECS/ContainerInsights": "ECS Container Insights",
	"AWS/ApplicationELB": "Application Load Balancer",
	"AWS/NetworkELB": "Network Load Balancer",
	"AWS/RDS": "RDS",
	"AWS/Lambda": "Lambda",
	"AWS/SQS": "SQS",
	"AWS/EC2": "EC2",
	"AWS/DynamoDB": "DynamoDB",
	"AWS/ApiGateway": "API Gateway",
} satisfies Record<AwsMetricNamespace, string>

const regionList = (h: H, connection: V2AwsConnection, selection: AwsSelection): Html => {
	const extra = Arr.map(
		Arr.filter(selection.regions, (code) => !Arr.some(REGIONS, (region) => region.code === code)),
		(code) => ({ code, location: "" }),
	)
	return h.ul(
		[h.Class("grid grid-cols-1 gap-x-4 @2xl/page:grid-cols-2"), h.AriaLabel("Regions")],
		Arr.map([...REGIONS, ...extra], (region) => {
			const isPicked = selection.regions.includes(region.code)
			const inputId = `aws-region-${region.code}`
			return h.li(
				[h.Class("border-b border-border-subtle")],
				[
					label(h, { className: "flex cursor-pointer gap-3 py-2 text-sm font-normal sm:text-sm" }, [
						...Checkbox.view(h, {
							model: { isChecked: isPicked },
							toParentMessage: () =>
								Message.ToggledAwsRegion({ id: connection.id, region: region.code }),
							id: `${inputId}-root`,
							inputId,
							ariaLabel:
								region.location === "" ? region.code : `${region.code}, ${region.location}`,
						}),
						h.span([h.Class("font-mono")], [region.code]),
						h.span([h.Class("ml-auto text-xs text-muted-foreground")], [region.location]),
					]),
				],
			)
		}),
	)
}

const serviceGrid = (h: H, connection: V2AwsConnection, selection: AwsSelection): Html =>
	h.ul(
		[h.Class("grid grid-cols-1 gap-2 @2xl/page:grid-cols-2"), h.AriaLabel("Services")],
		Arr.map(AWS_METRIC_NAMESPACES, (namespace) => {
			const isPicked = selection.namespaces.includes(namespace)
			const id = `aws-namespace-${Str.toLowerCase(Str.replace("/", "-")(namespace))}`
			return h.li(
				[
					h.Class(
						cn(
							"flex items-center justify-between gap-3 rounded-md border border-border p-3",
							!isPicked && "text-muted-foreground",
						),
					),
				],
				[
					vstack(h, { gap: "0.5", shrink: true }, [
						h.span([h.Class("text-sm"), h.Id(`${id}-label`)], [NAMESPACE_LABEL[namespace]]),
						typography(h, { size: "xs", tone: "muted", mono: true }, [namespace]),
					]),
					...switchControl(h, {
						id,
						inputId: `${id}-input`,
						isChecked: isPicked,
						labelledBy: `${id}-label`,
						onToggle: Message.ToggledAwsNamespace({ id: connection.id, namespace }),
					}),
				],
			)
		}),
	)

/** The regions and services the connection would stream, as picked so far. */
export const dataPicker = (h: H, model: Model, connection: V2AwsConnection): ReadonlyArray<Html> => {
	const selection = selectionOf(connection, model.awsCard.metrics)
	return [
		vstack(h, { gap: "3", as: "section", attributes: [h.AriaLabel("Regions to stream")] }, [
			vstack(h, { gap: "1" }, [
				heading(h, { level: 3, variant: "subsection" }, ["Regions"]),
				typography(h, { size: "xs", tone: "muted", as: "p" }, [
					"Each region gets its own metric stream. Regions added in AWS later stay off.",
				]),
			]),
			regionList(h, connection, selection),
		]),
		vstack(h, { gap: "3", as: "section", attributes: [h.AriaLabel("Services to stream")] }, [
			vstack(h, { gap: "1" }, [
				heading(h, { level: 3, variant: "subsection" }, ["Services"]),
				typography(h, { size: "xs", tone: "muted", as: "p" }, [
					"CloudWatch namespaces in the picked regions. Off means no metrics.",
				]),
			]),
			serviceGrid(h, connection, selection),
		]),
	]
}
