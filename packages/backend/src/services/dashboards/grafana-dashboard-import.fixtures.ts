// Hand-written Grafana dashboards for the importer tests, trimmed to what each case exercises.
import { Array as Arr } from "effect"

const promDs = { type: "prometheus", uid: "$datasource" }

const thresholds = (steps: ReadonlyArray<readonly [string, number | null]>) => ({
	mode: "absolute",
	steps: Arr.map(steps, ([color, value]) => ({ color, value })),
})

/** A Node Exporter style board: a root note, an open row of stats and charts, a collapsed row. */
export const nodeExporterDashboard = {
	title: "Node overview",
	description: "Host metrics from node_exporter",
	tags: ["linux", "node"],
	schemaVersion: 39,
	time: { from: "now-24h", to: "now" },
	refresh: "1m",
	templating: {
		list: [
			{ name: "datasource", type: "datasource", query: "prometheus" },
			{
				name: "job",
				type: "query",
				datasource: promDs,
				query: { query: "label_values(node_uname_info, job)", refId: "A" },
				current: { text: "node", value: "node" },
			},
			{
				name: "node",
				label: "Host",
				type: "query",
				datasource: promDs,
				query: 'label_values(node_uname_info{job="$job"}, instance)',
				includeAll: true,
				current: { text: "All", value: "$__all" },
			},
			{ name: "resolution", type: "interval", query: "1m,5m,1h" },
			{
				name: "mountpoint",
				type: "custom",
				query: "/,/home,/var",
				current: { text: "/", value: "/" },
			},
		],
	},
	panels: [
		{
			id: 1,
			type: "text",
			title: "About",
			gridPos: { x: 0, y: 0, w: 24, h: 3 },
			options: { mode: "markdown", content: "Fleet **health** at a glance." },
		},
		{
			id: 2,
			type: "row",
			title: "Quick CPU / Mem / Disk",
			collapsed: false,
			gridPos: { x: 0, y: 3, w: 24, h: 1 },
			panels: [],
		},
		{
			id: 3,
			type: "stat",
			title: "CPU busy",
			datasource: promDs,
			gridPos: { x: 0, y: 4, w: 3, h: 4 },
			fieldConfig: {
				defaults: {
					unit: "percent",
					decimals: 1,
					thresholds: thresholds([
						["green", null],
						["orange", 85],
						["red", 95],
					]),
				},
			},
			targets: [
				{
					refId: "A",
					expr: '100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle",instance="$node"}[$__rate_interval])))',
					legendFormat: "__auto",
				},
			],
		},
		{
			id: 4,
			type: "gauge",
			title: "Root FS used",
			datasource: promDs,
			gridPos: { x: 3, y: 4, w: 3, h: 4 },
			fieldConfig: {
				defaults: {
					unit: "percentunit",
					min: 0,
					max: 1,
					thresholds: thresholds([
						["green", null],
						["dark-red", 0.9],
					]),
				},
			},
			targets: [
				{
					refId: "A",
					expr: '1 - node_filesystem_avail_bytes{mountpoint="${mountpoint}"} / node_filesystem_size_bytes',
				},
			],
		},
		{
			id: 5,
			type: "stat",
			title: "Uptime",
			datasource: promDs,
			gridPos: { x: 6, y: 4, w: 2, h: 4 },
			fieldConfig: { defaults: { unit: "s" } },
			targets: [
				{ refId: "A", expr: 'time() - node_boot_time_seconds{instance="$node"}', hide: true },
				{ refId: "B", expr: "node_time_seconds - node_boot_time_seconds" },
			],
		},
		{
			id: 6,
			type: "timeseries",
			title: "CPU basic",
			datasource: promDs,
			gridPos: { x: 8, y: 4, w: 16, h: 8 },
			interval: "30s",
			fieldConfig: {
				defaults: {
					unit: "percentunit",
					custom: { drawStyle: "line", stacking: { mode: "normal" } },
				},
			},
			options: { legend: { showLegend: true, placement: "bottom" } },
			targets: [
				{
					refId: "A",
					expr: 'sum by (mode) (rate(node_cpu_seconds_total{instance="$node",job="$job"}[$__rate_interval]))',
					legendFormat: "{{mode}}",
				},
				{ refId: "B", expr: "count(node_cpu_seconds_total)", legendFormat: "cores" },
			],
		},
		{
			id: 7,
			type: "row",
			title: "Network",
			collapsed: true,
			gridPos: { x: 0, y: 12, w: 24, h: 1 },
			panels: [
				{
					id: 8,
					type: "timeseries",
					title: "Traffic",
					datasource: promDs,
					gridPos: { x: 0, y: 13, w: 12, h: 7 },
					fieldConfig: { defaults: { unit: "bps", custom: { drawStyle: "bars" } } },
					targets: [
						{
							refId: "A",
							expr: "rate(node_network_receive_bytes_total[$resolution])",
							legendFormat: "{{device}}",
							interval: "1m",
						},
					],
				},
				{
					id: 9,
					type: "table",
					title: "Interfaces",
					datasource: promDs,
					gridPos: { x: 12, y: 13, w: 12, h: 7 },
					targets: [{ refId: "A", expr: "node_network_up", format: "table", instant: true }],
				},
			],
		},
	],
}

/** An "export for sharing" file: `__inputs` and `${DS_*}` placeholders instead of real datasources. */
export const sharedExportDashboard = {
	__inputs: [
		{ name: "DS_PROMETHEUS", type: "datasource", pluginId: "prometheus" },
		{ name: "DS_LOKI", type: "datasource", pluginId: "loki" },
		{ name: "DS_CH", type: "datasource", pluginId: "grafana-clickhouse-datasource" },
	],
	title: "API service",
	schemaVersion: 38,
	time: { from: "now-30s", to: "now" },
	templating: { list: [{ name: "host-name", type: "textbox", query: "web-1" }] },
	panels: [
		{
			type: "timeseries",
			title: "Requests",
			datasource: "${DS_PROMETHEUS}",
			gridPos: { x: 0, y: 0, w: 12, h: 8 },
			fieldConfig: { defaults: { unit: "reqps" } },
			targets: [{ refId: "A", expr: 'sum(rate(http_requests_total{host="${host-name}"}[5m]))' }],
		},
		{
			type: "timeseries",
			title: "Error logs",
			datasource: { uid: "${DS_LOKI}" },
			gridPos: { x: 12, y: 0, w: 12, h: 8 },
			targets: [{ refId: "A", expr: 'count_over_time({app="api"} |= "error" [5m])' }],
		},
		{
			type: "logs",
			title: "Recent logs",
			datasource: { uid: "${DS_LOKI}" },
			gridPos: { x: 0, y: 8, w: 24, h: 6 },
			targets: [{ refId: "A", expr: '{app="api"}' }],
		},
		{ type: "nodeGraph", title: "Topology", gridPos: { x: 0, y: 14, w: 12, h: 6 } },
		{
			type: "table",
			title: "Slow spans",
			datasource: { type: "grafana-clickhouse-datasource", uid: "${DS_CH}" },
			gridPos: { x: 12, y: 14, w: 12, h: 6 },
			targets: [
				{
					refId: "A",
					rawSql: "SELECT SpanName, count() AS value FROM traces WHERE OrgId = 'x' AND $__timeFilter(Timestamp) GROUP BY SpanName",
				},
			],
		},
	],
}

/** The pre-5.0 schema: rows of panels sized by `span`, row heights in pixels. */
export const legacyRowsDashboard = {
	title: "Legacy board",
	schemaVersion: 14,
	rows: [
		{
			title: "Overview",
			showTitle: false,
			height: "250px",
			panels: [
				{
					type: "singlestat",
					title: "Up",
					span: 4,
					format: "none",
					targets: [{ refId: "A", expr: "up" }],
				},
				{
					type: "graph",
					title: "Load",
					span: 8,
					bars: false,
					lines: true,
					stack: true,
					yaxes: [{ format: "short" }],
					targets: [{ refId: "A", expr: "node_load1" }],
				},
			],
		},
		{
			title: "Details",
			showTitle: true,
			collapse: true,
			height: 300,
			panels: [
				{
					type: "graph",
					title: "Disk IO",
					span: 12,
					bars: true,
					targets: [{ refId: "A", expr: "rate(node_disk_io_time_seconds_total[5m])" }],
				},
			],
		},
	],
}
