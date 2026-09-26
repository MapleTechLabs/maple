import {
	useCallback,
	useDeferredValue,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	type RefObject,
} from "react"
import {
	ReactFlow,
	applyNodeChanges,
	type Edge,
	type Node,
	type NodeChange,
	type NodePositionChange,
	type ReactFlowInstance,
	type Viewport,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"

import { getValueHue } from "../../lib/colors"
import { Button } from "../ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../ui/resizable"
import { ServiceMapBackground } from "./service-map-background"
import { ServiceMapControls } from "./service-map-controls"
import { applyDeclutter, type DeclutterFocus, type DeclutterState } from "./service-map-declutter"
import { ServiceMapEdge } from "./service-map-edge"
import {
	layoutServiceMapWithElk,
	toLayoutFailure,
	type ElkLayoutResult,
	type PreviousPositions,
	type ServiceMapLayoutFailure,
} from "./service-map-elk"
import { upsertSnapshot, type ServiceMapLayout, type ServiceMapViewPrefs } from "./service-map-layout-state"
import { ServiceMapLoading } from "./service-map-loading"
import { ServiceMapMiniMap } from "./service-map-minimap"
import { NamespaceGroupNode, type NamespaceGroupData } from "./service-map-namespace-group"
import { ServiceMapNode } from "./service-map-node"
import {
	createParticleRegistry,
	ParticleRegistryProvider,
	ServiceMapParticleCanvas,
	type ParticleRegistry,
} from "./service-map-particles"
import { ServiceMapToolbar } from "./service-map-toolbar"
import {
	computeNodePositions,
	DB_NODE_PREFIX,
	DEFAULT_LAYOUT_CONFIG,
	getPlatformColor,
	getServiceMapNodeColor,
	isNsAggregateId,
	NS_AGGREGATE_PREFIX,
	NS_LABEL_HEIGHT,
	NS_PADDING_X,
	NS_PADDING_Y,
	topologyKey,
	type LayoutConfig,
	type ServiceEdgeData,
	type ServiceMapColorMode,
	type ServiceNodeData,
} from "./service-map-utils"

// The interactive map shared by the cloud app and Maple Local: declutter, ELK
// layout, persisted drags/camera, namespace boxes, toolbar and legend. Hosts own
// the data, where layout state is stored, and what the selected-node panel shows.

const nodeTypes = {
	serviceNode: ServiceMapNode,
	namespaceGroup: NamespaceGroupNode,
}

const edgeTypes = {
	serviceEdge: ServiceMapEdge,
}

const NAMESPACE_GROUP_PREFIX = "nsgroup:"
const nsGroupId = (namespace: string) => `${NAMESPACE_GROUP_PREFIX}${encodeURIComponent(namespace)}`

// Long enough to swallow a wheel-zoom's burst of gesture-end events and the
// programmatic fit that follows a layout, short enough that a camera is never
// meaningfully at risk of being lost.
const VIEWPORT_PERSIST_DEBOUNCE_MS = 400

// Fallback node dimensions used before ReactFlow has measured a node, so the
// dotted boxes appear on first paint and refine once real sizes arrive.
const FALLBACK_NODE_WIDTH = 220
const FALLBACK_NODE_HEIGHT = 70

/** Receives layout-engine failures (`event` names the failure); must be referentially stable. */
export type ServiceMapLayoutReporter = (event: string, failure: ServiceMapLayoutFailure) => void

export interface ServiceMapDetailPanelContext {
	/** The selected node id: a service name, or a `db:` / `nsagg:` synthetic id. */
	selectedId: string
	colorMode: ServiceMapColorMode
	onClose: () => void
	/** Focus the map on the selected node's 1-hop neighborhood. */
	onFocus: () => void
}

export interface ServiceMap3DRenderProps {
	nodes: Node<ServiceNodeData>[]
	edges: Edge<ServiceEdgeData>[]
	dimmedNodeIds: ReadonlySet<string>
	dimmedEdgeIds: ReadonlySet<string>
	selectedId: string | null
	onSelect: (id: string | null) => void
}

export interface ServiceMapFlowCanvasProps {
	viewMode?: "2d" | "3d"
	/** The full graph, usually from `buildFlowElements`. */
	nodes: Node<ServiceNodeData>[]
	edges: Edge<ServiceEdgeData>[]
	/** Focusable, legend-listed service ids (real services only, no db nodes). */
	services: string[]
	/** Manual drag positions and camera per layout signature. */
	layout: ServiceMapLayout
	onLayoutChange: (update: (prev: ServiceMapLayout) => ServiceMapLayout) => void
	viewPrefs: ServiceMapViewPrefs
	onViewPrefsChange: (update: (prev: ServiceMapViewPrefs) => ServiceMapViewPrefs) => void
	/** Controlled focus. When omitted, focus falls back to local state. */
	focus?: DeclutterFocus | null
	onFocusChange?: (focus: DeclutterFocus | null) => void
	/** Forces the low-traffic threshold, bypassing `viewPrefs` (bench harness). */
	minTrafficPctOverride?: number
	/** Shown when the graph has no nodes at all. */
	emptyState: ReactNode
	/** Content of the side panel opened by clicking a node. */
	renderDetailPanel: (context: ServiceMapDetailPanelContext) => ReactNode
	/** Renderer for `viewMode="3d"`; the 2D canvas is built in. */
	render3D?: (props: ServiceMap3DRenderProps) => ReactNode
	/** Show the layout-spacing sliders (dev builds). */
	showLayoutDebug?: boolean
	onLayoutError?: ServiceMapLayoutReporter
	onLayoutWarning?: ServiceMapLayoutReporter
}

const SLIDER_DEFS: Array<{ key: keyof LayoutConfig; label: string; min: number; max: number; step: number }> =
	[
		{ key: "layerGapX", label: "Layer Gap X", min: 100, max: 800, step: 10 },
		{ key: "nodeGapY", label: "Node Gap Y", min: 0, max: 200, step: 5 },
		{ key: "componentGapY", label: "Component Gap Y", min: 20, max: 400, step: 10 },
		{ key: "disconnectedGapX", label: "Disconnected Gap X", min: 20, max: 300, step: 10 },
		{ key: "disconnectedMarginY", label: "Disconnected Margin Y", min: 20, max: 400, step: 10 },
		{ key: "nodeWidth", label: "Node Width (layout)", min: 100, max: 400, step: 10 },
		{ key: "nodeHeight", label: "Node Height (layout)", min: 30, max: 200, step: 5 },
	]

function LayoutDebugPanel({
	config,
	onChange,
}: {
	config: LayoutConfig
	onChange: (config: LayoutConfig) => void
}) {
	const [open, setOpen] = useState(false)

	return (
		<div className="absolute top-2 right-2 z-50">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="px-2 py-1 text-[10px] font-mono bg-card/90 backdrop-blur-sm border border-border rounded text-muted-foreground hover:text-foreground transition-colors"
			>
				{open ? "Close" : "Debug"}
			</button>
			{open && (
				<div className="absolute top-8 right-0 w-64 bg-card/95 backdrop-blur-sm border border-border rounded-lg p-3 space-y-3 shadow-lg">
					<div className="flex items-center justify-between">
						<span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
							Layout Config
						</span>
						<button
							type="button"
							onClick={() => onChange({ ...DEFAULT_LAYOUT_CONFIG })}
							className="text-[10px] text-primary hover:text-primary/80 transition-colors"
						>
							Reset
						</button>
					</div>
					{SLIDER_DEFS.map(({ key, label, min, max, step }) => (
						<div key={key} className="space-y-1">
							<div className="flex items-center justify-between">
								<label className="text-[10px] text-muted-foreground">{label}</label>
								<span className="text-[10px] font-mono text-foreground tabular-nums">
									{config[key]}
								</span>
							</div>
							<input
								type="range"
								min={min}
								max={max}
								step={step}
								value={config[key]}
								onChange={(e) => onChange({ ...config, [key]: Number(e.target.value) })}
								className="w-full h-1 accent-primary"
							/>
						</div>
					))}
					<div className="pt-1 border-t border-border">
						<pre className="text-[9px] font-mono text-muted-foreground whitespace-pre-wrap select-all">
							{JSON.stringify(config, null, 2)}
						</pre>
					</div>
				</div>
			)}
		</div>
	)
}

interface LayoutRequest {
	key: string
	nodes: Node<ServiceNodeData>[]
	edges: Edge<ServiceEdgeData>[]
	config: LayoutConfig
}

/**
 * Metric refreshes replace the node objects even when the layout inputs have not
 * changed. Keep the request identity pinned to the topology/config signature so
 * those refreshes do not restart ELK's worker.
 */
function useLayoutRequest(
	rawNodes: Node<ServiceNodeData>[],
	flowEdges: Edge<ServiceEdgeData>[],
	config: LayoutConfig,
	key: string,
): LayoutRequest {
	const [stored, setStored] = useState<LayoutRequest>(() => ({
		key,
		nodes: rawNodes,
		edges: flowEdges,
		config,
	}))
	if (stored.key === key) return stored

	const next = { key, nodes: rawNodes, edges: flowEdges, config }
	setStored(next)
	return next
}

type ElkLayoutSnapshot =
	| { status: "pending"; layout: null }
	| { status: "fallback"; layout: null }
	| { status: "ready"; layout: ElkLayoutResult }

const ELK_PENDING: ElkLayoutSnapshot = { status: "pending", layout: null }
const ELK_FALLBACK: ElkLayoutSnapshot = { status: "fallback", layout: null }

interface ElkLayoutStore {
	getSnapshot: () => ElkLayoutSnapshot
	getServerSnapshot: () => ElkLayoutSnapshot
	subscribe: (listener: () => void) => () => void
}

/**
 * ELK is an external async engine, so expose it as an external store. This keeps
 * async work out of render and avoids adding another state-synchronizing effect.
 * After two seconds the synchronous layout is revealed; a late ELK result still
 * replaces it once available.
 */
function createElkLayoutStore(
	request: LayoutRequest,
	getPrevious: () => PreviousPositions | undefined,
	onError: ServiceMapLayoutReporter | undefined,
	onWarning: ServiceMapLayoutReporter | undefined,
): ElkLayoutStore {
	let snapshot = ELK_PENDING
	let started = false
	const listeners = new Set<() => void>()

	const publish = (next: ElkLayoutSnapshot) => {
		if (snapshot === next) return
		snapshot = next
		for (const listener of listeners) listener()
	}

	const start = () => {
		if (started) return
		started = true
		const graceTimer = setTimeout(() => publish(ELK_FALLBACK), 2000)

		// Read the previous layout at START time, not at store-creation time: the
		// store is memoized on the request, so a captured value could be a layout
		// older than the one currently on screen.
		layoutServiceMapWithElk(request.nodes, request.edges, request.config, getPrevious(), onWarning)
			.then((layout) => {
				clearTimeout(graceTimer)
				publish({ status: "ready", layout })
			})
			.catch((error) => {
				clearTimeout(graceTimer)
				onError?.("service_map.elk_layout_failed", toLayoutFailure(error))
				publish(ELK_FALLBACK)
			})
	}

	return {
		getSnapshot: () => snapshot,
		getServerSnapshot: () => ELK_PENDING,
		subscribe: (listener) => {
			listeners.add(listener)
			start()
			return () => listeners.delete(listener)
		},
	}
}

/**
 * Runs ELK for `request`, anchored to the layout currently on screen.
 *
 * `lastLayout` is the shared anchor: the positions most recently APPLIED to the
 * canvas, whichever engine produced them. Anchoring ELK on the synchronous
 * layout's output matters as much as the reverse: on a machine where the worker
 * is slow, the fallback is what the user is looking at, and ELK landing later
 * should adjust that rather than replace it.
 *
 * It is read through a stable getter rather than folded into the request, which
 * would change the request's identity and re-run the layout it exists to steady.
 */
function useElkLayout(
	request: LayoutRequest,
	lastLayout: RefObject<PreviousPositions | undefined>,
	onError: ServiceMapLayoutReporter | undefined,
	onWarning: ServiceMapLayoutReporter | undefined,
): ElkLayoutSnapshot {
	const getPrevious = useCallback(() => lastLayout.current, [lastLayout])
	const store = useMemo(
		() => createElkLayoutStore(request, getPrevious, onError, onWarning),
		[request, getPrevious, onError, onWarning],
	)
	return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot)
}

export function ServiceMapFlowCanvas({
	viewMode = "2d",
	nodes: rawNodes,
	edges: flowEdges,
	services,
	layout,
	onLayoutChange: setLayout,
	viewPrefs,
	onViewPrefsChange: setViewPrefs,
	focus: focusProp,
	onFocusChange,
	minTrafficPctOverride,
	emptyState,
	renderDetailPanel,
	render3D,
	showLayoutDebug = false,
	onLayoutError,
	onLayoutWarning,
}: ServiceMapFlowCanvasProps) {
	const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null)
	const [layoutConfig, setLayoutConfig] = useState<LayoutConfig>({ ...DEFAULT_LAYOUT_CONFIG })
	const [colorMode, setColorMode] = useState<ServiceMapColorMode>("service")

	const [internalFocus, setInternalFocus] = useState<DeclutterFocus | null>(null)
	const focus = focusProp !== undefined ? focusProp : internalFocus
	const setFocus = onFocusChange ?? setInternalFocus

	// Stable registry that edges publish their geometry into and the single
	// particle canvas reads each frame. Created once per canvas instance.
	const registryRef = useRef<ParticleRegistry | null>(null)
	if (registryRef.current === null) registryRef.current = createParticleRegistry()
	const registry = registryRef.current

	// Declutter stage: collapse namespaces → focus subgraph → traffic filter.
	// Everything downstream (topology key, layout, persisted positions, particles,
	// minimap, namespace boxes) operates on the EFFECTIVE graph, so declutter
	// changes that alter the node set naturally re-key the layout signature while
	// focus-dim (topology unchanged) costs no re-layout.
	const minTrafficPct = minTrafficPctOverride ?? viewPrefs.minTrafficPct
	const declutterState: DeclutterState = useMemo(
		() => ({
			minTrafficPct,
			focus,
			collapsedNamespaces: viewPrefs.collapsedNamespaces,
		}),
		[minTrafficPct, viewPrefs.collapsedNamespaces, focus],
	)
	const exemptIds = useMemo(
		() => (selectedServiceId ? new Set([selectedServiceId]) : new Set<string>()),
		[selectedServiceId],
	)
	const declutter = useMemo(
		() => applyDeclutter(rawNodes, flowEdges, declutterState, exemptIds),
		[rawNodes, flowEdges, declutterState, exemptIds],
	)
	const effectiveNodes = declutter.nodes
	const effectiveEdges = declutter.edges

	// A focus target that no longer exists (service renamed / aged out of the
	// window) silently clears; the vanished focus chip is the feedback.
	useEffect(() => {
		if (declutter.focusMissing) setFocus(null)
	}, [declutter.focusMissing, setFocus])

	// Collapse and focus-hide can remove the selected node, so drop the selection
	// (the traffic filter alone never does; the selection is exempt).
	useEffect(() => {
		if (selectedServiceId && !effectiveNodes.some((n) => n.id === selectedServiceId)) {
			setSelectedServiceId(null)
		}
	}, [selectedServiceId, effectiveNodes])

	// Positions depend ONLY on topology + layout config. Memoize the expensive
	// hierarchical layout on a topology key so metric refreshes (new array
	// identities, same shape) don't re-run barycenter sweeps. The memo body runs
	// each render but short-circuits on an unchanged key.
	const topoKey = useMemo(
		() => topologyKey(effectiveNodes, effectiveEdges),
		[effectiveNodes, effectiveEdges],
	)
	// Namespace assignment is part of node DATA, not topology, so it isn't covered
	// by topoKey. Fold a namespace signature into the cache key so re-bucketing
	// happens when a service's namespace changes even if the shape is unchanged.
	const nsKey = useMemo(
		() =>
			effectiveNodes
				.flatMap((node) => (node.data.namespace ? [`${node.id}=${node.data.namespace}`] : []))
				.sort()
				.join(","),
		[effectiveNodes],
	)
	// The trailing token is a layout-engine version: changing it invalidates
	// persisted drag snapshots captured against a previous engine's base positions
	// (mixing coordinate systems scatters nodes).
	const layoutSignature = `${topoKey}|${nsKey}|${JSON.stringify(layoutConfig)}|elk3`

	// Persisted drag positions / viewport are absolute coordinates tied to a
	// specific layout. Honour them ONLY while their captured signature still
	// matches the live layout. Otherwise (topology / namespace / config change,
	// or pre-signature localStorage data) the stale coords scatter nodes out of
	// their namespace clusters and overlap the dotted boxes, so fall back to the
	// clean ELK layout. Stable across metric refreshes (topoKey is the topology
	// memo key), so ordinary refreshes keep manual arrangements.
	const persisted = useMemo(
		() =>
			layout.snapshots.find((s) => s.signature === layoutSignature) ?? {
				signature: layoutSignature,
				positions: {},
				viewport: null,
			},
		[layout, layoutSignature],
	)
	// ELK's layered layout runs in a worker. The deterministic synchronous layout
	// remains the timeout/error fallback, so a worker failure never blanks the map.
	const layoutRequest = useLayoutRequest(effectiveNodes, effectiveEdges, layoutConfig, layoutSignature)
	// The layout currently on screen, and the anchor every later layout is built
	// from. Written by an effect once positions are actually applied.
	const lastLayoutRef = useRef<PreviousPositions | undefined>(undefined)
	const elkSnapshot = useElkLayout(layoutRequest, lastLayoutRef, onLayoutError, onLayoutWarning)
	// Snapshot the anchor ONCE per layout signature rather than reading the ref
	// during render. Reading it live fed the ref's own writes back into the
	// `layoutedNodes` memo: each write produced a fresh Map, which invalidated
	// the memo, which re-ran the effect, an idle render loop that cost ~50fps and
	// ~700ms of blocking time per 4s while the map just sat there.
	const [carriedSnapshot, setCarriedSnapshot] = useState<{
		signature: string
		positions: PreviousPositions | undefined
	}>(() => ({ signature: layoutSignature, positions: undefined }))
	if (carriedSnapshot.signature !== layoutSignature) {
		setCarriedSnapshot({ signature: layoutSignature, positions: lastLayoutRef.current })
	}
	const carriedPositions = carriedSnapshot.positions
	// Wait for the first final/fallback layout so the initial graph never jumps.
	// Once revealed, keep the current map visible during later ELK recomputes,
	// matching the previous behavior for filter and topology changes.
	const [layoutHasEverSettled, setLayoutHasEverSettled] = useState(false)
	const currentLayoutSettled = elkSnapshot.status !== "pending"
	if (!layoutHasEverSettled && currentLayoutSettled) setLayoutHasEverSettled(true)
	const layoutRevealed = layoutHasEverSettled || currentLayoutSettled
	// Anchored to the last layout for the same reason ELK is: the synchronous
	// layout is what a slow or worker-less client actually sees, and without the
	// anchor a one-edge delta re-ranks connected components and slides the whole
	// graph. `carriedPositions` is a ref read, so it is deliberately not a dep;
	// the memo re-runs on `layoutRequest`, which is exactly when a new layout is
	// wanted.
	const fallbackPositions = useMemo(
		() =>
			computeNodePositions(
				layoutRequest.nodes,
				layoutRequest.edges,
				layoutRequest.config,
				lastLayoutRef.current,
			),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[layoutRequest],
	)
	const layoutedNodes = useMemo(() => {
		// While a NEW layout is computing, hold every node the previous ELK layout
		// knew about exactly where it is. Falling straight through to the
		// synchronous layout meant a topology change moved the whole graph twice:
		// once to the fallback coordinates the instant the request changed, then
		// again when ELK landed a second or two later.
		//
		// The carry covers `pending` only. Once ELK gives up (`fallback`), switch to
		// the synchronous layout rather than holding indefinitely: it is now anchored
		// on the same previous positions, so it lands near where the graph already
		// was AND places this topology's new nodes coherently. Holding forever would
		// keep old nodes pinned while new ones arrived at un-reconciled coordinates,
		// which is worse than a small settled adjustment.
		const bridge =
			elkSnapshot.layout?.positions ?? (elkSnapshot.status === "pending" ? carriedPositions : undefined)
		return effectiveNodes.map((node) => ({
			...node,
			position: bridge?.get(node.id) ?? fallbackPositions.get(node.id) ?? node.position,
		}))
	}, [effectiveNodes, elkSnapshot.layout, elkSnapshot.status, carriedPositions, fallbackPositions])

	// Record what was actually applied, so the next layout (from either engine)
	// is anchored on it. Nodes bridged from the previous layout keep their old
	// coordinates here, which is the point: the anchor tracks the screen.
	useEffect(() => {
		const applied = new Map<string, { x: number; y: number }>()
		for (const node of layoutedNodes) applied.set(node.id, node.position)
		lastLayoutRef.current = applied
	}, [layoutedNodes])

	// Merge layout positions with selection + color-mode + focus-dim state.
	// Persisted drag positions (keyed by node id) override the deterministic
	// auto-layout.
	const nodesWithSelection = useMemo(() => {
		return layoutedNodes.map((node) => ({
			...node,
			position: persisted.positions[node.id] ?? node.position,
			data: {
				...node.data,
				selected: node.id === selectedServiceId,
				colorMode,
				dimmed: declutter.dimmedNodeIds.has(node.id),
			},
		}))
	}, [layoutedNodes, selectedServiceId, colorMode, persisted.positions, declutter.dimmedNodeIds])

	// Edges leaving the focus neighborhood render near-invisible (and stop
	// claiming particle budget), flagged via edge data.
	const renderedEdges = useMemo(() => {
		if (declutter.dimmedEdgeIds.size === 0) return effectiveEdges
		return effectiveEdges.map((edge) =>
			declutter.dimmedEdgeIds.has(edge.id) && edge.data
				? { ...edge, data: { ...edge.data, dimmed: true } }
				: edge,
		)
	}, [effectiveEdges, declutter.dimmedEdgeIds])

	// Track nodes with full ReactFlow state (dimensions, positions from drag, etc.)
	const [nodeState, setNodeState] = useState(() => ({
		source: nodesWithSelection,
		nodes: nodesWithSelection,
	}))
	let nodes = nodeState.nodes

	// Sync layout changes into node state (preserving measured dimensions)
	if (nodeState.source !== nodesWithSelection) {
		const dimMap = new Map<
			string,
			{ width?: number; height?: number; measured?: { width?: number; height?: number } }
		>()
		for (const node of nodeState.nodes) {
			dimMap.set(node.id, { width: node.width, height: node.height, measured: node.measured })
		}
		nodes = nodesWithSelection.map((node) => {
			const dims = dimMap.get(node.id)
			return dims ? { ...node, width: dims.width, height: dims.height, measured: dims.measured } : node
		})
		setNodeState({ source: nodesWithSelection, nodes })
	}

	// Programmatic fitView after ALL nodes are measured (the fitView prop fires too early).
	// Skip auto-fit entirely when a saved viewport exists so the restored camera survives.
	const rfInstance = useRef<ReactFlowInstance | null>(null)
	// Capture the camera that existed when this signature became live. A fallback
	// fit can itself trigger onMoveEnd before a late ELK result lands; that camera
	// is not a user-saved camera and must not suppress ELK's final refit.
	const [viewportSnapshot, setViewportSnapshot] = useState(() => ({
		signature: layoutSignature,
		viewport: persisted.viewport,
	}))
	let savedViewport = viewportSnapshot.viewport
	if (viewportSnapshot.signature !== layoutSignature) {
		savedViewport = persisted.viewport
		setViewportSnapshot({ signature: layoutSignature, viewport: savedViewport })
	}
	const hasSavedViewport = savedViewport != null
	// Camera-gate key, NOT a React key. It carries the ELK status so a late ELK
	// result re-fits the camera onto the final layout, but the canvas itself is
	// never remounted for it; see the `key`-less <ReactFlow> below.
	const flowLayoutKey = `${layoutSignature}:${elkSnapshot.status === "ready" ? "ready" : "fallback"}`
	const fitViewState = useRef({ signature: flowLayoutKey, fitted: hasSavedViewport })
	// The very first fit snaps (nothing was on screen to shift); every later one
	// animates, because it is moving a map the user is already looking at.
	const hasFittedOnce = useRef(false)

	// React Flow used to be keyed by `flowLayoutKey`, so every topology delta and
	// every fallback→ELK flip tore the canvas down and rebuilt it: camera reset to
	// `defaultViewport`, full re-measure, then a deferred fit: the visible
	// "paint, jump, reframe" shift. Positions now flow through `nodes` instead, so
	// the fit has to be driven from an effect: on a position-only update React Flow
	// emits no `dimensions` change to hang it off.
	//
	// Runs after every commit; `nodes` gaining measurements re-triggers it. An
	// unmeasured node is excluded from fitView's bounds, so wait for all of them.
	useEffect(() => {
		if (fitViewState.current.signature !== flowLayoutKey) {
			fitViewState.current = { signature: flowLayoutKey, fitted: hasSavedViewport }
		}
		if (fitViewState.current.fitted) return
		if (nodes.length === 0 || !nodes.every((n) => n.measured?.width && n.measured?.height)) return
		fitViewState.current.fitted = true
		const animate = hasFittedOnce.current
		hasFittedOnce.current = true
		const raf = requestAnimationFrame(() =>
			rfInstance.current?.fitView(animate ? { duration: 300 } : undefined),
		)
		return () => cancelAnimationFrame(raf)
	}, [flowLayoutKey, nodes, hasSavedViewport])

	// `defaultViewport` only applies at mount, so restoring a saved camera for a
	// signature that becomes live later (previously a side effect of the remount)
	// is now explicit.
	const restoredViewportSignature = useRef<string | null>(null)
	useEffect(() => {
		if (restoredViewportSignature.current === layoutSignature) return
		restoredViewportSignature.current = layoutSignature
		if (savedViewport) rfInstance.current?.setViewport(savedViewport)
	}, [layoutSignature, savedViewport])

	const onNodesChange = useCallback(
		(changes: NodeChange[]) => {
			setNodeState((current) => ({
				...current,
				nodes: applyNodeChanges(changes, current.nodes) as typeof current.nodes,
			}))

			// Persist finished drags only (dragging === false), keyed by node id.
			const dragEnds = changes.filter(
				(c): c is NodePositionChange =>
					c.type === "position" && c.dragging === false && c.position != null,
			)
			if (dragEnds.length > 0) {
				setLayout((prev) =>
					upsertSnapshot(prev, layoutSignature, (snap) => {
						const positions = { ...snap.positions }
						for (const c of dragEnds) {
							if (c.position) positions[c.id] = { x: c.position.x, y: c.position.y }
						}
						return { ...snap, positions }
					}),
				)
			}
		},
		[layoutSignature, setLayout],
	)

	// Persisting the camera JSON-encodes the whole snapshot LRU (every node
	// position across four layouts) into localStorage, so writing on each
	// gesture-end turned a burst of them into a burst of long tasks. A wheel zoom
	// emits many; so does a programmatic fit. Measured on CI, an otherwise idle map
	// that had just been re-framed spent ~600ms blocked across 6 React commits and
	// 3-6 long tasks in a 4s window.
	//
	// Only the last camera in a burst is worth keeping, so coalesce them. The
	// cleanup flushes on unmount and before the layout signature changes, using
	// that render's signature, so a camera is never written under the wrong layout
	// or dropped on navigation.
	const pendingViewport = useRef<Viewport | null>(null)
	const viewportWriteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const flushViewport = useCallback(() => {
		if (viewportWriteTimer.current !== null) {
			clearTimeout(viewportWriteTimer.current)
			viewportWriteTimer.current = null
		}
		const viewport = pendingViewport.current
		pendingViewport.current = null
		if (!viewport) return
		setLayout((prev) => upsertSnapshot(prev, layoutSignature, (snap) => ({ ...snap, viewport })))
	}, [layoutSignature, setLayout])

	const onMoveEnd = useCallback(
		(_: unknown, viewport: Viewport) => {
			pendingViewport.current = viewport
			if (viewportWriteTimer.current !== null) clearTimeout(viewportWriteTimer.current)
			viewportWriteTimer.current = setTimeout(flushViewport, VIEWPORT_PERSIST_DEBOUNCE_MS)
		},
		[flushViewport],
	)

	useEffect(() => flushViewport, [flushViewport])

	const handleNodeClick = useCallback(
		(_: ReactMouseEvent, node: Node) => {
			// Namespace boxes are non-selectable, but guard anyway so a stray click
			// never selects a synthetic group node.
			if (node.type === "namespaceGroup") return
			// Clicking a collapsed-namespace aggregate expands it back into services.
			if (isNsAggregateId(node.id)) {
				const ns = decodeURIComponent(node.id.slice(NS_AGGREGATE_PREFIX.length))
				setViewPrefs((prev) => ({
					...prev,
					collapsedNamespaces: prev.collapsedNamespaces.filter((n) => n !== ns),
				}))
				return
			}
			setSelectedServiceId((prev) => (prev === node.id ? null : node.id))
		},
		[setViewPrefs],
	)

	const handlePaneClick = useCallback(() => {
		setSelectedServiceId(null)
	}, [])

	// "Re-sort": discard any manual drag positions + saved camera and snap every
	// node back to the computed auto-layout, then fit the fresh layout into view.
	// Clearing positions re-derives node positions AND the namespace boxes over a
	// couple of render passes, so the fit is deferred to an effect that runs once
	// the nodes have actually settled (a fixed timeout races that cascade).
	const resortFitPending = useRef(false)
	const handleResort = useCallback(() => {
		resortFitPending.current = true
		// Drop only the CURRENT signature's snapshot; other declutter states keep
		// their manual arrangements.
		setLayout((prev) => ({
			snapshots: prev.snapshots.filter((s) => s.signature !== layoutSignature),
		}))
	}, [layoutSignature, setLayout])

	useEffect(() => {
		if (!resortFitPending.current) return
		// Wait until every node carries measured dimensions, else fitView frames a
		// partial extent (unmeasured nodes are excluded from the bounds).
		if (nodes.length === 0 || !nodes.every((n) => n.measured?.width)) return
		resortFitPending.current = false
		const raf = requestAnimationFrame(() => rfInstance.current?.fitView({ duration: 300 }))
		return () => cancelAnimationFrame(raf)
	}, [nodes])

	// Derive a dotted box per namespace from the node positions/sizes, so the boxes
	// follow drags and hug the service cards. Only service nodes carrying a namespace
	// participate; databases and namespace-less services stay unboxed.
	//
	// Boxes are derived from `nodes` at DEFERRED priority. During the mount
	// measurement cascade (and drags), ReactFlow updates `nodes` many times in quick
	// succession; recomputing the boxes synchronously resized their DOM on every
	// single measurement, which ReactFlow's own node ResizeObserver then re-observed
	// mid-frame, producing a burst of benign "ResizeObserver loop completed with
	// undelivered notifications" warnings (173 in one session). useDeferredValue lets
	// the boxes lag the urgent measurement render by a frame so each resize lands in
	// its own commit, collapsing the burst. The ~1-frame lag is imperceptible and the
	// boxes still settle tight around the nodes.
	const deferredNodes = useDeferredValue(nodes)
	const handleCollapseNamespace = useCallback(
		(ns: string) => {
			setViewPrefs((prev) =>
				prev.collapsedNamespaces.includes(ns)
					? prev
					: { ...prev, collapsedNamespaces: [...prev.collapsedNamespaces, ns] },
			)
		},
		[setViewPrefs],
	)
	const namespaceGroupNodes = useMemo<Node<NamespaceGroupData>[]>(() => {
		const extents = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>()
		for (const node of deferredNodes) {
			if (node.id.startsWith(DB_NODE_PREFIX)) continue
			const ns = (node.data as ServiceNodeData).namespace
			if (!ns) continue
			const w = node.measured?.width ?? node.width ?? FALLBACK_NODE_WIDTH
			const h = node.measured?.height ?? node.height ?? FALLBACK_NODE_HEIGHT
			const { x, y } = node.position
			const ext = extents.get(ns)
			if (ext) {
				ext.minX = Math.min(ext.minX, x)
				ext.minY = Math.min(ext.minY, y)
				ext.maxX = Math.max(ext.maxX, x + w)
				ext.maxY = Math.max(ext.maxY, y + h)
			} else {
				extents.set(ns, { minX: x, minY: y, maxX: x + w, maxY: y + h })
			}
		}
		const boxes: Node<NamespaceGroupData>[] = []
		for (const [ns, ext] of extents) {
			const width = ext.maxX - ext.minX + NS_PADDING_X * 2
			const height = ext.maxY - ext.minY + NS_LABEL_HEIGHT + NS_PADDING_Y * 2
			boxes.push({
				id: nsGroupId(ns),
				type: "namespaceGroup",
				position: { x: ext.minX - NS_PADDING_X, y: ext.minY - (NS_LABEL_HEIGHT + NS_PADDING_Y) },
				data: {
					label: ns,
					hue: getValueHue(ns) ?? 0,
					onCollapse: () => handleCollapseNamespace(ns),
				},
				draggable: false,
				selectable: false,
				focusable: false,
				// z 0 (same layer as service nodes) keeps the box above the pane/edges
				// so the dashed border + label paint; ordering it first in the nodes
				// array (below) keeps it behind the service cards.
				zIndex: 0,
				// These boxes are derived each render and never live in the controlled
				// `nodes` state, so ReactFlow's measured dims never round-trip back. Supply
				// width/height/measured explicitly or it keeps them
				// `visibility: hidden` (unmeasured) forever.
				width,
				height,
				measured: { width, height },
				// pointerEvents:none on the WRAPPER (ReactFlow applies node.style to it)
				// so drags/clicks over empty box interior pass through to the pane
				// (panning) and to the service cards beneath.
				style: { width, height, pointerEvents: "none" },
			})
		}
		return boxes
	}, [deferredNodes, handleCollapseNamespace])

	// Boxes first so they paint behind the service nodes. The service nodes use the
	// LIVE `nodes` (must stay current); only the derived boxes run a frame behind.
	const renderedNodes = useMemo(() => [...namespaceGroupNodes, ...nodes], [namespaceGroupNodes, nodes])

	if (nodes.length === 0) {
		// The graph exists but declutter hid everything; offer a reset instead of
		// the "no instrumentation" empty state.
		if (rawNodes.length > 0) {
			return (
				<div className="flex h-full items-center justify-center">
					<div className="space-y-3 text-center">
						<p className="text-sm font-medium text-foreground">
							Everything is hidden by the current filters
						</p>
						<p className="text-xs text-muted-foreground">
							{rawNodes.length} services are below the traffic threshold or outside the focus.
						</p>
						<Button
							variant="outline"
							size="sm"
							onClick={() => {
								setViewPrefs((prev) => ({ ...prev, minTrafficPct: 0 }))
								setFocus(null)
							}}
						>
							Reset filters
						</Button>
					</div>
				</div>
			)
		}
		return <>{emptyState}</>
	}

	if (!layoutRevealed && viewMode === "2d") {
		return <ServiceMapLoading />
	}

	return (
		// `data-elk-status` reports whether the positions on screen are ELK's final
		// answer ("ready") or the synchronous stand-in it publishes after a 2s grace
		// ("fallback"). The perf bench needs the difference: edges exist in the DOM
		// as soon as the fallback lands, so "the map has rendered" is true well
		// before "the map has stopped moving", and on a slow runner ELK finished
		// INSIDE the idle measurement window and billed its commits as a render
		// loop. Cheap enough to keep in production, where it also says which layout
		// a screenshot or a bug report was taken against.
		<div className="flex flex-col h-full" data-elk-status={elkSnapshot.status}>
			<ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0">
				<ResizablePanel defaultSize={selectedServiceId ? 65 : 100} minSize={40}>
					<div className="flex flex-col h-full">
						<ServiceMapToolbar
							showPresentationControls={viewMode === "2d"}
							colorMode={colorMode}
							onColorModeChange={setColorMode}
							onResort={handleResort}
							services={services}
							focus={focus}
							onFocusChange={setFocus}
							minTrafficPct={minTrafficPct}
							onMinTrafficPctChange={(pct) =>
								setViewPrefs((prev) => ({ ...prev, minTrafficPct: pct }))
							}
							hiddenNodeCount={declutter.hiddenNodeCount}
							hiddenEdgeCount={declutter.hiddenEdgeCount}
						/>
						<div className="flex-1 min-h-0 relative">
							{viewMode === "3d" ? (
								render3D?.({
									nodes: effectiveNodes,
									edges: effectiveEdges,
									dimmedNodeIds: declutter.dimmedNodeIds,
									dimmedEdgeIds: declutter.dimmedEdgeIds,
									selectedId: selectedServiceId,
									onSelect: (id) => {
										if (id && isNsAggregateId(id)) {
											const ns = decodeURIComponent(
												id.slice(NS_AGGREGATE_PREFIX.length),
											)
											setViewPrefs((prev) => ({
												...prev,
												collapsedNamespaces: prev.collapsedNamespaces.filter(
													(n) => n !== ns,
												),
											}))
										} else setSelectedServiceId(id)
									},
								})
							) : (
								<>
									{/* Dev-only: the sliders write `layoutConfig`, which is part of
							    `layoutSignature`, so every tick re-runs ELK. */}
									{showLayoutDebug && (
										<LayoutDebugPanel config={layoutConfig} onChange={setLayoutConfig} />
									)}
									<ParticleRegistryProvider value={registry}>
										<ReactFlow
											nodes={renderedNodes}
											edges={renderedEdges}
											onNodesChange={onNodesChange}
											onNodeClick={handleNodeClick}
											onPaneClick={handlePaneClick}
											onMoveEnd={onMoveEnd}
											defaultViewport={savedViewport ?? undefined}
											onInit={(instance) => {
												// SAFETY: this ref intentionally erases the node/edge generics after ReactFlow initialization.
												rfInstance.current = instance as unknown as ReactFlowInstance
											}}
											nodeTypes={nodeTypes}
											edgeTypes={edgeTypes}
											nodesDraggable
											nodesConnectable={false}
											connectOnClick={false}
											elementsSelectable={false}
											// 0.05 lets fitView frame very large graphs (hundreds of
											// services) instead of clipping at the zoom floor.
											minZoom={0.05}
											maxZoom={2}
											proOptions={{ hideAttribution: true }}
										>
											<ServiceMapParticleCanvas />
											<ServiceMapControls />
											<ServiceMapMiniMap key={colorMode} colorMode={colorMode} />
											<ServiceMapBackground />
										</ReactFlow>
									</ParticleRegistryProvider>
								</>
							)}
						</div>

						{viewMode === "2d" && <ServiceMapLegend colorMode={colorMode} services={services} />}
					</div>
				</ResizablePanel>

				{selectedServiceId && (
					<>
						<ResizableHandle withHandle />
						<ResizablePanel defaultSize={35} minSize={25}>
							{renderDetailPanel({
								selectedId: selectedServiceId,
								colorMode,
								onClose: () => setSelectedServiceId(null),
								onFocus: () =>
									setFocus({ serviceId: selectedServiceId, hops: 1, mode: "dim" }),
							})}
						</ResizablePanel>
					</>
				)}
			</ResizablePanelGroup>
		</div>
	)
}

const LEGEND_PLATFORMS = ["kubernetes", "cloudflare", "lambda", "web", "unknown"] as const

const serviceSwatchColor = (service: string) =>
	getServiceMapNodeColor({ label: service, kind: "service", errorRate: 0 }, "service")

/** Pointer hints, the service or platform color key, and the health dot key under the map. */
function ServiceMapLegend({ colorMode, services }: { colorMode: ServiceMapColorMode; services: string[] }) {
	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t bg-muted/30 px-3 py-2.5 text-[11px] text-muted-foreground shrink-0">
			{/* Pointer hints only: on touch the gestures are different, and the
			    two lines they cost are the whole legend's height on a phone. */}
			<span className="font-medium max-sm:hidden">Drag nodes to arrange</span>
			<span className="text-foreground/30 max-sm:hidden">|</span>
			<span className="font-medium max-sm:hidden">Scroll to zoom</span>
			{colorMode === "service" && services.length > 0 && (
				<>
					<span className="text-foreground/30 max-sm:hidden">|</span>
					{services.slice(0, 3).map((service) => (
						<div key={service} className="flex items-center gap-1.5">
							<div
								className="size-2.5 rounded-sm shrink-0"
								style={{ backgroundColor: serviceSwatchColor(service) }}
							/>
							<span className="font-medium">{service}</span>
						</div>
					))}
					{services.length > 3 && (
						<Popover>
							<PopoverTrigger className="font-medium hover:text-foreground transition-colors cursor-pointer">
								+{services.length - 3} more
							</PopoverTrigger>
							<PopoverContent align="start" className="w-64 p-3" side="top">
								<div className="grid grid-cols-2 gap-2 text-[11px]">
									{services.map((service) => (
										<div key={service} className="flex items-center gap-1.5 min-w-0">
											<div
												className="size-2.5 rounded-sm shrink-0"
												style={{ backgroundColor: serviceSwatchColor(service) }}
											/>
											<span className="truncate font-medium">{service}</span>
										</div>
									))}
								</div>
							</PopoverContent>
						</Popover>
					)}
				</>
			)}
			{colorMode === "platform" && (
				<>
					<span className="text-foreground/30">|</span>
					{LEGEND_PLATFORMS.map((p) => (
						<div key={p} className="flex items-center gap-1.5">
							<div
								className="size-2.5 rounded-sm shrink-0"
								style={{ backgroundColor: getPlatformColor(p === "unknown" ? undefined : p) }}
							/>
							<span className="font-medium capitalize">{p}</span>
						</div>
					))}
				</>
			)}
			<span className="flex-1" />
			<div className="flex items-center gap-3">
				<div className="flex items-center gap-1.5">
					<div className="size-2 rounded-full bg-severity-info" />
					<span>Healthy</span>
				</div>
				<div className="flex items-center gap-1.5">
					<div className="size-2 rounded-full bg-severity-warn" />
					<span>Degraded</span>
				</div>
				<div className="flex items-center gap-1.5">
					<div className="size-2 rounded-full bg-severity-error" />
					<span>Error</span>
				</div>
			</div>
		</div>
	)
}
