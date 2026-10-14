import { useMemo, useRef, useState } from "react"
import { useReducedMotion } from "motion/react"
import { useTheme } from "@maple/ui/hooks/use-theme"
import { Button } from "@maple/ui/components/ui/button"
import { IconButton } from "@maple/ui/components/ui/icon-button"
import { MiddleTruncate } from "@maple/ui/components/ui/middle-truncate"
import { ToggleGroup, ToggleGroupItem } from "@maple/ui/components/ui/toggle-group"
import {
	ArrowRotateAnticlockwiseIcon,
	CubeIcon,
	LayersIcon,
	MediaPauseIcon,
	MediaPlayIcon,
} from "@/components/icons"
import { resolveMachineBadge } from "./factory-badge"
import { ServiceMap3D, type CameraCommand } from "./scene"
import type { Topology3D, Edge3D } from "./types"
import { mapPalette, paperBackground } from "./appearance"
import { factoryRoutes, decorateRoutes, type RoutingTopology } from "./factory-routing"
import {
	connectedIds,
	formatRate,
	formatLatency,
	HEALTH_COLOR,
	spatialLayout,
	type SpatialView,
	type SpatialTopology,
} from "./spatial-layout"

const VIEW_COPY = {
	atlas: {
		title: "Atlas",
		description: "Infrastructure, organized by namespace.",
		encoding: "Machine height · request volume",
	},
	cascade: {
		title: "Cascade",
		description: "Layers follow the longest dependency path.",
		encoding: "Layer height · dependency depth",
	},
} as const

// Labels are timber signs. Styling lives in classes because the camera rig
// rewrites inline style every frame, keeping only position and colour.
const NAIL =
	"before:absolute before:top-1/2 before:size-[2px] before:-translate-y-1/2 before:rounded-full before:bg-current after:absolute after:top-1/2 after:size-[2px] after:-translate-y-1/2 after:rounded-full after:bg-current"
const SIGN_CLASS = "rounded-[3px] px-1.5 font-medium"
const TAG_CLASS =
	"rounded-l-[7px] rounded-r-[2px] border-current/50 pr-1 pl-2.5 before:absolute before:top-1/2 before:left-[3px] before:size-[3px] before:-translate-y-1/2 before:rounded-full before:border before:border-current/70 after:absolute after:bottom-full after:left-[4px] after:h-1.5 after:w-px after:bg-current/50"
const PLANK_CLASS = `rounded-[2px] px-2.5 py-px font-semibold before:left-[4px] after:right-[4px] ${NAIL}`

const PANEL_CLASS = "rounded-[3px] border border-(--map-sign-ink)/35 bg-(--map-sign) text-(--map-sign-ink)"

function edgeLatency(edge: Edge3D) {
	return edge.p95LatencyMs !== undefined
		? `${formatLatency(edge.p95LatencyMs)} p95`
		: `${formatLatency(edge.avgLatencyMs)} avg · ${formatLatency(edge.maxLatencyMs)} max`
}

export function ServiceMap3DViewport({
	topology,
	selectedId,
	onSelect,
	sample = false,
}: {
	topology: Topology3D
	selectedId: string | null
	onSelect: (id: string | null) => void
	sample?: boolean
}) {
	const [view, setView] = useState<SpatialView>("atlas")
	const [traffic, setTraffic] = useState(true)
	const [command, setCommand] = useState<CameraCommand>({ action: "reset", serial: 0 })
	const labels = useRef(new Map<string, HTMLElement>())
	const reducedMotion = useReducedMotion()
	const { theme } = useTheme()
	const dark = theme === "dark"
	const palette = mapPalette(dark)
	// Sign colours as CSS variables, so overlay chrome can follow the palette from classes.
	const signColors = {
		"--map-sign": palette.sign,
		"--map-sign-ink": palette.signInk,
	} satisfies Record<`--${string}`, string>
	const flowing = traffic && !reducedMotion
	// Metrics can refresh without replacing the layout or resetting the user's camera.
	const topologyKey = JSON.stringify({
		nodes: topology.nodes
			.map(({ id, namespace, kind }) => ({ id, namespace, kind }))
			.sort((a, b) => a.id.localeCompare(b.id)),
		edges: topology.edges
			.map(({ source, target }) => ({ source, target }))
			.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target)),
	})
	// SAFETY: topologyKey is serialized immediately above from typed renderer nodes and edges.
	const layoutTopology = useMemo(
		() => JSON.parse(topologyKey) as SpatialTopology & RoutingTopology,
		[topologyKey],
	)
	const layout = useMemo(() => spatialLayout(layoutTopology, view), [layoutTopology, view])
	const routes = useMemo(() => factoryRoutes(layoutTopology, layout), [layoutTopology, layout])
	const links = useMemo(() => decorateRoutes(routes, topology.edges), [routes, topology.edges])
	const nodesById = useMemo(() => new Map(topology.nodes.map((node) => [node.id, node])), [topology.nodes])
	const related = connectedIds(topology, selectedId)
	const copy = VIEW_COPY[view]
	const camera = (action: CameraCommand["action"]) =>
		setCommand((current) => ({ action, serial: current.serial + 1 }))
	return (
		<div className="flex h-full min-h-0 flex-col" data-service-map-renderer="3d">
			<div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
				<ToggleGroup
					value={[view]}
					onValueChange={(values) => {
						const next = values.find((value) => value !== view)
						if (next === "atlas" || next === "cascade") setView(next)
					}}
					variant="outline"
					size="xs"
					aria-label="Map perspective"
				>
					<ToggleGroupItem value="atlas">
						<CubeIcon size={14} />
						Atlas
					</ToggleGroupItem>
					<ToggleGroupItem value="cascade">
						<LayersIcon size={14} />
						Cascade
					</ToggleGroupItem>
				</ToggleGroup>
				<span className="ml-3 hidden text-2xs text-muted-foreground sm:block">{copy.encoding}</span>
				<Button
					size="sm"
					variant="ghost"
					className="ml-auto text-xs"
					aria-pressed={flowing}
					disabled={Boolean(reducedMotion)}
					onClick={() => setTraffic((current) => !current)}
				>
					{flowing ? <MediaPauseIcon /> : <MediaPlayIcon />}
					{reducedMotion ? "Reduced motion" : flowing ? "Pause traffic" : "Resume traffic"}
				</Button>
			</div>
			<section
				className="relative min-h-0 flex-1 overflow-hidden"
				aria-label={`${copy.title} 3D service map`}
				style={{ ...paperBackground(palette), ...signColors }}
			>
				<ServiceMap3D
					topology={topology}
					layout={layout}
					links={links}
					view={view}
					selectedId={selectedId}
					onSelect={onSelect}
					flowing={flowing}
					palette={palette}
					command={command}
					labels={labels}
				/>
				<div className="pointer-events-none absolute inset-0 overflow-hidden" aria-label="Map nodes">
					{topology.nodes.map((node) => {
						const badge = resolveMachineBadge(node)
						return (
							<button
								key={node.id}
								type="button"
								ref={(element) => {
									if (element) labels.current.set(node.id, element)
									else labels.current.delete(node.id)
								}}
								title={badge ? `${node.label} · ${badge.label}` : node.label}
								className={`pointer-events-auto absolute top-0 left-0 flex max-w-40 border font-mono text-4xs leading-normal whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-ring ${SIGN_CLASS} ${selectedId === node.id ? "border-current" : "border-current/60 hover:border-current"}`}
								style={{
									visibility: "hidden",
									opacity: node.dimmed || (related && !related.has(node.id)) ? 0.4 : 1,
									backgroundColor: palette.sign,
									color: palette.signInk,
								}}
								onClick={() => onSelect(selectedId === node.id ? null : node.id)}
								aria-label={`Select ${node.label}${badge ? `, ${badge.label}` : ""}`}
								aria-pressed={selectedId === node.id}
							>
								<MiddleTruncate text={node.label} tail={10} />
							</button>
						)
					})}
					{links
						.filter((link) => !link.edge.relation)
						.filter((link) =>
							selectedId
								? link.edge.source === selectedId || link.edge.target === selectedId
								: link.prominent,
						)
						.map((link) => (
							<button
								key={link.id}
								type="button"
								ref={(element) => {
									if (element) labels.current.set(link.id, element)
									else labels.current.delete(link.id)
								}}
								className={`pointer-events-auto absolute top-0 left-0 flex cursor-pointer items-center border font-mono text-4xs leading-normal tabular-nums hover:border-current focus-visible:outline-2 focus-visible:outline-ring ${TAG_CLASS}`}
								style={{
									visibility: "hidden",
									backgroundColor: palette.sign,
									color: palette.signInk,
								}}
								title={`${nodesById.get(link.edge.source)?.label} → ${nodesById.get(link.edge.target)?.label} · ${formatRate(link.edge.callsPerSecond, link.edge.hasSampling)} calls · ${edgeLatency(link.edge)}`}
								aria-label={`Inspect connection to ${nodesById.get(link.edge.target)?.label}, ${formatRate(link.edge.callsPerSecond, link.edge.hasSampling)}`}
								onClick={() => onSelect(link.edge.target)}
							>
								{formatRate(link.edge.callsPerSecond, link.edge.hasSampling)}
							</button>
						))}
					{layout.districts.map((district) => (
						<span
							key={`${view}:${district.id}`}
							ref={(element) => {
								if (element) labels.current.set(`district:${district.id}`, element)
								else labels.current.delete(`district:${district.id}`)
							}}
							className={`absolute top-0 left-0 font-mono text-4xs uppercase tracking-widest ${PLANK_CLASS}`}
							style={{
								visibility: "hidden",
								backgroundColor: palette.trunk,
								color: palette.tape,
							}}
						>
							{district.label}
						</span>
					))}
				</div>
				<div
					ref={(element) => {
						if (element) labels.current.set("overlay:hud", element)
						else labels.current.delete("overlay:hud")
					}}
					className={`pointer-events-none absolute top-4 left-4 px-3 py-2 ${PANEL_CLASS}`}
				>
					<h2 className="font-display text-base font-medium">{copy.title}</h2>
					<p className={`mt-1 text-2xs opacity-75`}>{copy.description}</p>
				</div>
				<div
					ref={(element) => {
						if (element) labels.current.set("overlay:legend", element)
						else labels.current.delete("overlay:legend")
					}}
					className={`pointer-events-none absolute bottom-14 left-4 flex flex-wrap gap-3 px-3 py-2 text-3xs sm:bottom-4 ${PANEL_CLASS}`}
				>
					{(["healthy", "elevated", "degraded"] as const).map((status) => (
						<span key={status} className="flex items-center gap-1.5 capitalize">
							<span
								className="size-1.5 rounded-full"
								style={{ backgroundColor: HEALTH_COLOR[status] }}
							/>
							{status}
						</span>
					))}
				</div>
				<fieldset
					ref={(element) => {
						if (element) labels.current.set("overlay:controls", element)
						else labels.current.delete("overlay:controls")
					}}
					className={`absolute right-4 bottom-4 flex gap-1 p-1 ${PANEL_CLASS}`}
					aria-label="Camera controls"
				>
					<IconButton size="icon-xs" label="Zoom out" onClick={() => camera("out")}>
						−
					</IconButton>
					<IconButton size="icon-xs" label="Zoom in" onClick={() => camera("in")}>
						+
					</IconButton>
					<IconButton size="icon-xs" label="Reset camera" onClick={() => camera("reset")}>
						<ArrowRotateAnticlockwiseIcon />
					</IconButton>
				</fieldset>
			</section>
			<div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t px-4 py-2 text-3xs text-muted-foreground">
				<span>Drag to pan · scroll to zoom</span>
				<span>
					{selectedId
						? `${related?.size ?? 0} connected nodes · click the canvas to clear`
						: sample
							? "Narrow belts · calls / Wide belts · queues · sample traffic"
							: "Rates from selected time range · ~ sampled estimate"}
				</span>
			</div>
		</div>
	)
}
