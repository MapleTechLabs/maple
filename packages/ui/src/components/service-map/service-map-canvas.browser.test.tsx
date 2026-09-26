import { useState, type ReactNode } from "react"
import { describe, expect, it } from "vitest"
import { fireEvent, render, waitFor } from "@testing-library/react"
import { ServiceMapFlowCanvas, type ServiceMapDetailPanelContext } from "./service-map-canvas"
import {
	DEFAULT_SERVICE_MAP_VIEW_PREFS,
	EMPTY_SERVICE_MAP_LAYOUT,
	type ServiceMapLayout,
	type ServiceMapViewPrefs,
} from "./service-map-layout-state"
import { buildFlowElements } from "./service-map-utils"

const graph = buildFlowElements({
	edges: [
		{
			sourceService: "api",
			targetService: "auth",
			callCount: 100,
			estimatedCallCount: 100,
			errorCount: 0,
			errorRate: 0,
			avgDurationMs: 5,
			maxDurationMs: 10,
			hasSampling: false,
			samplingWeight: 1,
		},
	],
	serviceOverviews: [],
	durationSeconds: 3600,
})

function Harness({
	nodes = graph.nodes,
	renderDetailPanel = () => null,
}: {
	nodes?: typeof graph.nodes
	renderDetailPanel?: (context: ServiceMapDetailPanelContext) => ReactNode
}) {
	const [layout, setLayout] = useState<ServiceMapLayout>(EMPTY_SERVICE_MAP_LAYOUT)
	const [prefs, setPrefs] = useState<ServiceMapViewPrefs>(DEFAULT_SERVICE_MAP_VIEW_PREFS)
	return (
		<div style={{ width: 900, height: 600 }}>
			<ServiceMapFlowCanvas
				nodes={nodes}
				edges={nodes.length > 0 ? graph.edges : []}
				services={nodes.map((n) => n.id)}
				layout={layout}
				onLayoutChange={setLayout}
				viewPrefs={prefs}
				onViewPrefsChange={setPrefs}
				emptyState={<p>nothing here</p>}
				renderDetailPanel={renderDetailPanel}
			/>
		</div>
	)
}

describe("ServiceMapFlowCanvas", () => {
	it("lays out and renders the service nodes", async () => {
		const { container } = render(<Harness />)
		await waitFor(() => expect(container.querySelector("[data-elk-status]")).not.toBeNull(), { timeout: 8000 })
		await waitFor(() => expect(container.querySelectorAll(".react-flow__node-serviceNode")).toHaveLength(2))
		expect(container.textContent).toContain("api")
		expect(container.textContent).toContain("auth")
	})

	it("renders the host's empty state for an empty graph", () => {
		const { getByText } = render(<Harness nodes={[]} />)
		expect(getByText("nothing here")).toBeTruthy()
	})

	it("opens the host's detail panel for a clicked node", async () => {
		const { container, findByText } = render(
			<Harness renderDetailPanel={({ selectedId }) => <p>panel for {selectedId}</p>} />,
		)
		await waitFor(() => expect(container.querySelector('[data-id="auth"]')).not.toBeNull(), { timeout: 8000 })
		const node = container.querySelector('[data-id="auth"]')
		expect(node).not.toBeNull()
		if (node) fireEvent.click(node)
		expect(await findByText("panel for auth")).toBeTruthy()
	})
})
