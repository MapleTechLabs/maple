import { useRef } from "react"
import { useReactFlow, useStoreApi } from "@xyflow/react"
import { useMountEffect } from "../../hooks/use-mount-effect"
import { MaximizeIcon, MinusIcon, PlusIcon } from "../icons"

/** React Flow camera controls without transform-driven React renders. */
export function ServiceMapControls() {
	const zoomInRef = useRef<HTMLButtonElement | null>(null)
	const zoomOutRef = useRef<HTMLButtonElement | null>(null)
	const flow = useReactFlow()
	const store = useStoreApi()

	useMountEffect(() => {
		const update = () => {
			const { transform, minZoom, maxZoom } = store.getState()
			if (zoomInRef.current) zoomInRef.current.disabled = transform[2] >= maxZoom
			if (zoomOutRef.current) zoomOutRef.current.disabled = transform[2] <= minZoom
		}
		update()
		return store.subscribe(update)
	})

	return (
		<div
			className="react-flow__panel react-flow__controls vertical bottom left"
			data-testid="rf__controls"
			aria-label="Control panel"
		>
			<button
				ref={zoomInRef}
				type="button"
				className="react-flow__controls-button react-flow__controls-zoomin"
				title="Zoom in"
				aria-label="Zoom in"
				onClick={() => void flow.zoomIn()}
			>
				<PlusIcon className="size-3" />
			</button>
			<button
				ref={zoomOutRef}
				type="button"
				className="react-flow__controls-button react-flow__controls-zoomout"
				title="Zoom out"
				aria-label="Zoom out"
				onClick={() => void flow.zoomOut()}
			>
				<MinusIcon className="size-3" />
			</button>
			<button
				type="button"
				className="react-flow__controls-button react-flow__controls-fitview"
				title="Fit view"
				aria-label="Fit view"
				onClick={() => void flow.fitView()}
			>
				<MaximizeIcon className="size-3" />
			</button>
		</div>
	)
}
