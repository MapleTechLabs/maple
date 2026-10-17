import { CircleInfoIcon, DatabaseIcon, ServerIcon } from "@maple/ui/components/icons"
import { Alert, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import {
	Card,
	CardDescription,
	CardFooter,
	CardHeader,
	CardPanel,
	CardTitle,
} from "@maple/ui/components/ui/card"
import { Delta } from "@maple/ui/components/ui/delta"
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyMessage,
	EmptyTitle,
} from "@maple/ui/components/ui/empty"
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemMedia,
	ItemTitle,
} from "@maple/ui/components/ui/item"
import { KeyValue, KeyValueList } from "@maple/ui/components/ui/key-value"
import { ListRow } from "@maple/ui/components/ui/list-row"
import { Meter, SegmentedBar } from "@maple/ui/components/ui/meter"
import { MiniBars } from "@maple/ui/components/ui/mini-bars"
import { Panel, PanelBody, PanelHeader } from "@maple/ui/components/ui/panel"
import { Separator } from "@maple/ui/components/ui/separator"
import { Skeleton, SkeletonList } from "@maple/ui/components/ui/skeleton"
import { StatFigure } from "@maple/ui/components/ui/stat-figure"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { TableSkeleton } from "@maple/ui/components/ui/table-skeleton"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@maple/ui/components/ui/tabs"

import { KitPage, KitRow, KitSection } from "./kit-layout"

const ALERT_VARIANTS = ["default", "info", "ok", "warn", "crit", "done"] as const
const BARS = [3, 5, 4, 8, 6, 9, 12, 7, 5, 6, 10, 14, 11, 8, 6, 4]
const ROWS = [
	{ service: "checkout-svc", rps: "412", errors: "1.8%", p95: "238 ms" },
	{ service: "payment-svc", rps: "188", errors: "4.2%", p95: "612 ms" },
	{ service: "inventory-svc", rps: "96", errors: "0.1%", p95: "41 ms" },
]

export function KitDisplayLab() {
	return (
		<KitPage title="Kit: display" description="Surfaces, data display and loading states from @maple/ui.">
			<KitSection title="Card and panel">
				<div className="grid grid-cols-2 gap-6">
					<Card>
						<CardHeader>
							<CardTitle>Ingest volume</CardTitle>
							<CardDescription>Spans received in the current billing cycle.</CardDescription>
						</CardHeader>
						<CardPanel>
							<StatFigure value="12.4M" unit="spans" size="lg" />
						</CardPanel>
						<CardFooter>
							<Button variant="outline" size="sm">
								View usage
							</Button>
						</CardFooter>
					</Card>
					<Panel>
						<PanelHeader
							title="Top services"
							scope={<Badge variant="meta">production</Badge>}
							action={
								<Button variant="ghost" size="xs">
									All
								</Button>
							}
						/>
						<PanelBody>
							{ROWS.map((row) => (
								<ListRow
									key={row.service}
									divided
									title={row.service}
									meta={`${row.rps} req/s`}
									trailing={<Delta ratio={0.12} />}
								/>
							))}
						</PanelBody>
					</Panel>
				</div>
			</KitSection>
			<KitSection title="Alert">
				<div className="grid grid-cols-2 gap-3">
					{ALERT_VARIANTS.map((variant) => (
						<Alert key={variant} variant={variant}>
							<CircleInfoIcon />
							<AlertTitle>Alert {variant}</AlertTitle>
							<AlertDescription>The ingest key was rotated 3 days ago.</AlertDescription>
						</Alert>
					))}
					<Alert size="sm" variant="warn">
						<CircleInfoIcon />
						<AlertDescription>Small alert, one line.</AlertDescription>
					</Alert>
				</div>
			</KitSection>
			<KitSection title="Empty">
				<div className="grid grid-cols-2 gap-6">
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<DatabaseIcon />
							</EmptyMedia>
							<EmptyTitle>No traces yet</EmptyTitle>
							<EmptyDescription>
								Send spans from any OpenTelemetry SDK to see them here.
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
					<EmptyMessage dashed>No dashboards match this filter.</EmptyMessage>
				</div>
			</KitSection>
			<KitSection title="Item and list row">
				<ItemGroup className="max-w-xl">
					<Item variant="outline">
						<ItemMedia variant="icon">
							<ServerIcon />
						</ItemMedia>
						<ItemContent>
							<ItemTitle>api-gateway</ItemTitle>
							<ItemDescription>3 instances, us-east-1</ItemDescription>
						</ItemContent>
						<ItemActions>
							<Button variant="outline" size="sm">
								Open
							</Button>
						</ItemActions>
					</Item>
					<Item variant="muted" size="sm">
						<ItemContent>
							<ItemTitle>Muted item, small</ItemTitle>
						</ItemContent>
					</Item>
				</ItemGroup>
				<div className="max-w-xl rounded-md border">
					<ListRow divided selected title="payment-svc" meta="selected" trailing="612 ms" />
					<ListRow
						divided
						density="compact"
						title="inventory-svc"
						meta="compact"
						trailing="41 ms"
					/>
				</div>
			</KitSection>
			<KitSection title="Key value">
				<KeyValueList divided className="max-w-md">
					<KeyValue label="Service">checkout-svc</KeyValue>
					<KeyValue label="Trace id" mono copyValue="4bf92f3577b34da6a3ce929d0e0e4736">
						4bf92f3577b34da6a3ce929d0e0e4736
					</KeyValue>
					<KeyValue label="Status">Error</KeyValue>
				</KeyValueList>
			</KitSection>
			<KitSection title="Meter, segmented bar, mini bars">
				<div className="flex max-w-md flex-col gap-3">
					<Meter value={0.62} label="Quota used" />
					<Meter value={0.91} tone="crit" label="Error budget" />
					<SegmentedBar
						label="Status mix"
						segments={[
							{ key: "ok", value: 82, className: "bg-severity-info" },
							{ key: "warn", value: 12, className: "bg-severity-warn" },
							{ key: "crit", value: 6, className: "bg-severity-error" },
						]}
					/>
					<MiniBars values={BARS} label="Requests per minute" className="h-8 w-48 text-primary" />
				</div>
			</KitSection>
			<KitSection title="Stat figure and delta">
				<KitRow>
					<StatFigure value="412" unit="req/s" size="sm" />
					<StatFigure value="238" unit="ms" size="md" mono />
					<StatFigure value="99.82" unit="%" size="lg" />
					<Delta ratio={0.12} />
					<Delta ratio={-0.08} />
					<Delta ratio={0.24} invert />
					<Delta ratio={0} />
				</KitRow>
			</KitSection>
			<KitSection title="Skeleton and table skeleton">
				<div className="grid grid-cols-2 gap-6">
					<div className="flex flex-col gap-2">
						<Skeleton className="h-4 w-48" />
						<Skeleton className="h-4 w-32" />
						<SkeletonList rows={3} label="Loading services" />
					</div>
					<TableSkeleton columns={3} rows={3} />
				</div>
			</KitSection>
			<KitSection title="Table">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Service</TableHead>
							<TableHead className="text-right">Req/s</TableHead>
							<TableHead className="text-right">Errors</TableHead>
							<TableHead className="text-right">p95</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{ROWS.map((row) => (
							<TableRow key={row.service}>
								<TableCell>{row.service}</TableCell>
								<TableCell className="text-right">{row.rps}</TableCell>
								<TableCell className="text-right">{row.errors}</TableCell>
								<TableCell className="text-right">{row.p95}</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</KitSection>
			<KitSection title="Tabs and separator">
				<Tabs defaultValue="overview">
					<TabsList>
						<TabsTab value="overview">Overview</TabsTab>
						<TabsTab value="traces">Traces</TabsTab>
						<TabsTab value="logs">Logs</TabsTab>
					</TabsList>
					<TabsPanel value="overview" className="pt-3 text-sm">
						Default tabs panel.
					</TabsPanel>
				</Tabs>
				<Separator />
				<Tabs defaultValue="rules">
					<TabsList variant="underline">
						<TabsTab value="inbox">Inbox</TabsTab>
						<TabsTab value="rules">Rules</TabsTab>
						<TabsTab value="routing">Routing</TabsTab>
					</TabsList>
					<TabsPanel value="rules" className="pt-3 text-sm">
						Underline tabs panel.
					</TabsPanel>
				</Tabs>
				<div className="flex h-6 items-center gap-3 text-sm">
					Left <Separator orientation="vertical" /> Right
				</div>
			</KitSection>
		</KitPage>
	)
}
