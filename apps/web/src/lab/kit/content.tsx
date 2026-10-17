import { BellIcon, CheckIcon, MagnifierIcon } from "@maple/ui/components/icons"
import { Avatar, AvatarFallback } from "@maple/ui/components/ui/avatar"
import {
	Breadcrumb,
	BreadcrumbEllipsis,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@maple/ui/components/ui/breadcrumb"
import { Bubble, BubbleContent, BubbleGroup } from "@maple/ui/components/ui/bubble"
import { Button } from "@maple/ui/components/ui/button"
import { Calendar } from "@maple/ui/components/ui/calendar"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { Marker, MarkerContent, MarkerIcon } from "@maple/ui/components/ui/marker"
import {
	Message,
	MessageAvatar,
	MessageContent,
	MessageGroup,
	MessageHeader,
} from "@maple/ui/components/ui/message"
import { MiddleTruncate } from "@maple/ui/components/ui/middle-truncate"
import { PageLayout } from "@maple/ui/components/ui/page-layout"
import { ScrollArea } from "@maple/ui/components/ui/scroll-area"
import { SettingRow } from "@maple/ui/components/ui/setting-row"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { Switch } from "@maple/ui/components/ui/switch"
import { Trace, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "@maple/ui/components/ui/trace"
import { TruncatedId } from "@maple/ui/components/ui/truncated-id"
import { TruncatedText } from "@maple/ui/components/ui/truncated-text"

import { KitPage, KitRow, KitSection } from "./kit-layout"

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
const LONG_URL =
	"https://api.maple.dev/v1/organizations/org_2f9a/dashboards/checkout-latency/widgets/p95-by-route"
const MONTH = new Date(2026, 9, 1)
const SELECTED = new Date(2026, 9, 14)
const TODAY = new Date(2026, 9, 17)
const SCROLL_ROWS = Array.from(
	{ length: 12 },
	(_, index) => `span-${String(index + 1).padStart(2, "0")} GET /api/cart`,
)

export function KitContentLab() {
	return (
		<KitPage
			title="Kit: content"
			description="Text, identity, conversation and layout primitives from @maple/ui."
		>
			<KitSection title="Page layout header">
				<div className="overflow-hidden rounded-md border">
					<PageLayout.Root>
						<PageLayout.Header
							title="Services"
							description="Every service that sent spans in the selected window."
						>
							<PageLayout.HeaderActions>
								<Button variant="outline" size="sm">
									Export
								</Button>
							</PageLayout.HeaderActions>
						</PageLayout.Header>
					</PageLayout.Root>
				</div>
			</KitSection>
			<KitSection title="Eyebrow and breadcrumb">
				<KitRow>
					<Eyebrow>Default eyebrow</Eyebrow>
					<Eyebrow variant="label">Label eyebrow</Eyebrow>
				</KitRow>
				<Breadcrumb>
					<BreadcrumbList>
						<BreadcrumbItem>
							<BreadcrumbLink href="#dashboards">Dashboards</BreadcrumbLink>
						</BreadcrumbItem>
						<BreadcrumbSeparator />
						<BreadcrumbItem>
							<BreadcrumbEllipsis />
						</BreadcrumbItem>
						<BreadcrumbSeparator />
						<BreadcrumbItem>
							<BreadcrumbPage>Checkout latency</BreadcrumbPage>
						</BreadcrumbItem>
					</BreadcrumbList>
				</Breadcrumb>
			</KitSection>
			<KitSection title="Avatar, spinner, marker">
				<KitRow>
					<Avatar>
						<AvatarFallback>DM</AvatarFallback>
					</Avatar>
					<Avatar className="size-6">
						<AvatarFallback>AB</AvatarFallback>
					</Avatar>
					<Spinner />
					<Spinner className="size-6" />
				</KitRow>
				<div className="flex max-w-md flex-col gap-3">
					<Marker>
						<MarkerIcon>
							<BellIcon />
						</MarkerIcon>
						<MarkerContent>Alert fired at 12:00 UTC</MarkerContent>
					</Marker>
					<Marker variant="separator">
						<MarkerContent>Yesterday</MarkerContent>
					</Marker>
					<Marker variant="border">
						<MarkerContent>Border marker</MarkerContent>
					</Marker>
				</div>
			</KitSection>
			<KitSection title="Message and bubble">
				<MessageGroup className="max-w-xl">
					<Message>
						<MessageAvatar>
							<Avatar className="size-6">
								<AvatarFallback>M</AvatarFallback>
							</Avatar>
						</MessageAvatar>
						<MessageContent>
							<MessageHeader>Maple</MessageHeader>
							<BubbleGroup>
								<Bubble variant="muted">
									<BubbleContent>
										payment-svc errors rose to 4.2% after the 11:40 deploy.
									</BubbleContent>
								</Bubble>
							</BubbleGroup>
						</MessageContent>
					</Message>
					<Message align="end">
						<MessageContent>
							<Bubble align="end">
								<BubbleContent>Which route is failing?</BubbleContent>
							</Bubble>
						</MessageContent>
					</Message>
				</MessageGroup>
				<KitRow>
					{(
						[
							"default",
							"secondary",
							"muted",
							"tinted",
							"outline",
							"ghost",
							"destructive",
						] as const
					).map((variant) => (
						<Bubble key={variant} variant={variant}>
							<BubbleContent>{variant}</BubbleContent>
						</Bubble>
					))}
				</KitRow>
			</KitSection>
			<KitSection title="Trace">
				<Trace className="max-w-md">
					<TraceLine>
						<TraceIcon>
							<CheckIcon />
						</TraceIcon>
						<TraceTitle>Searched traces</TraceTitle>
						<TraceDescription>service.name = payment-svc</TraceDescription>
					</TraceLine>
					<TraceLine status="error">
						<TraceIcon>
							<MagnifierIcon />
						</TraceIcon>
						<TraceTitle>Read logs</TraceTitle>
						<TraceDescription>query timed out</TraceDescription>
					</TraceLine>
					<TraceLine status="pending">
						<TraceTitle>Group by route</TraceTitle>
					</TraceLine>
				</Trace>
			</KitSection>
			<KitSection title="Truncation">
				<div className="flex max-w-sm flex-col gap-2 text-sm">
					<TruncatedId value={TRACE_ID} kind="trace" />
					<TruncatedId value={TRACE_ID} kind="trace" ellipsis copy />
					<TruncatedText text={LONG_URL} mono />
					<MiddleTruncate text={LONG_URL} tail={18} mono />
				</div>
			</KitSection>
			<KitSection title="Setting row">
				<div className="flex max-w-xl flex-col gap-3">
					<SettingRow
						label="Weekly digest"
						description="A summary of incidents every Monday."
						control={<Switch defaultChecked />}
					/>
					<SettingRow
						framed
						active
						label="Framed, active"
						description="Framed setting row."
						control={<Switch />}
					/>
					<SettingRow disabled label="Disabled" control={<Switch disabled />} />
				</div>
			</KitSection>
			<KitSection title="Scroll area">
				<ScrollArea className="h-40 max-w-md rounded-md border">
					<div className="flex flex-col p-2 font-mono text-xs">
						{SCROLL_ROWS.map((row) => (
							<span key={row} className="py-1">
								{row}
							</span>
						))}
					</div>
				</ScrollArea>
			</KitSection>
			<KitSection title="Calendar">
				<Calendar
					mode="single"
					defaultMonth={MONTH}
					selected={SELECTED}
					today={TODAY}
					className="w-fit rounded-md border"
				/>
			</KitSection>
		</KitPage>
	)
}
