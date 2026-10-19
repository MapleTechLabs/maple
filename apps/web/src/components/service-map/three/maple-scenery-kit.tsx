import { useState } from "react"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { createSketch, type Sketch } from "./maple-scenery-sketch"

export { type Bounds, hash, prototypes, type Sketch, sketchOf } from "./maple-scenery-sketch"

/** Draws a sketch once. Callers key it on whatever the drawing depends on. */
export function SketchDrawing({ draw, ink }: { draw: (sketch: Sketch) => void; ink: string }) {
	const [{ mesh, outline }] = useState(() => {
		const sketch = createSketch()
		draw(sketch)
		return sketch.build()
	})
	useMountEffect(() => () => {
		mesh.dispose()
		outline.dispose()
	})
	return (
		<group>
			<mesh geometry={mesh}>
				<meshBasicMaterial
					vertexColors
					polygonOffset
					polygonOffsetFactor={1}
					polygonOffsetUnits={1}
				/>
			</mesh>
			<lineSegments geometry={outline}>
				<lineBasicMaterial color={ink} />
			</lineSegments>
		</group>
	)
}
