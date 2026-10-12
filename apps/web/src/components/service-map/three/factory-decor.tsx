import { memo, useMemo, useRef, useState } from "react"
import { useFrame } from "@react-three/fiber"
import * as THREE from "three"
import { useMountEffect } from "@/hooks/use-mount-effect"
import type { InkPalette, MachineFinish } from "./appearance"
import { InkBox, InkLines, InkSolid } from "./factory-primitives"
import { MapleForest } from "./maple-scenery-forest"
import { type Bounds, hash } from "./maple-scenery-kit"
import type { FactoryLink } from "./factory-routing"
import type { SpatialLayout } from "./spatial-layout"
import type { Vec3 } from "./types"

/** A flat, double-sided triangle with an ink edge: pennants, bunting, pinwheel blades.
 * Keyed on its corners, so moved corners remount rather than leak the old buffer. */
function Flag(props: { corners: [Vec3, Vec3, Vec3]; color: string; ink: string }) {
	return <FlagBody key={props.corners.flat().join(",")} {...props} />
}

function FlagBody({ corners, color, ink }: { corners: [Vec3, Vec3, Vec3]; color: string; ink: string }) {
	const [geometry] = useState(() => {
		const flag = new THREE.BufferGeometry()
		flag.setAttribute("position", new THREE.Float32BufferAttribute(corners.flat(), 3))
		return flag
	})
	useMountEffect(() => () => geometry.dispose())
	const [a, b, c] = corners
	return (
		<>
			<mesh geometry={geometry}>
				<meshBasicMaterial
					color={color}
					side={THREE.DoubleSide}
					polygonOffset
					polygonOffsetFactor={1}
					polygonOffsetUnits={1}
				/>
			</mesh>
			<InkLines points={[...a, ...b, ...b, ...c, ...c, ...a]} ink={ink} />
		</>
	)
}

/** Three puffs rise, swell and dissolve above a chimney. Frozen when paused. */
export function Smoke({ position, finish }: { position: Vec3; finish: MachineFinish }) {
	const puffs = useRef<Array<THREE.Group | null>>([])
	const elapsed = useRef(0)
	const geometry = useMemo(() => new THREE.IcosahedronGeometry(0.13, 0), [])
	useFrame((_, delta) => {
		if (finish.running) elapsed.current += Math.min(delta, 0.05)
		puffs.current.forEach((puff, i) => {
			if (!puff) return
			const t = (elapsed.current * 0.32 + i / 3) % 1
			puff.position.set(t * 0.3, t * 1.1, -t * 0.1)
			puff.scale.setScalar(Math.max(0.001, Math.sin(Math.PI * t) * (0.7 + t * 0.6)))
		})
	})
	return (
		<group position={[...position]}>
			{[0, 1, 2].map((i) => (
				<group
					key={i}
					ref={(puff) => {
						puffs.current[i] = puff
					}}
				>
					<InkSolid geometry={geometry} color={finish.tape} ink={finish.ink} />
				</group>
			))}
		</group>
	)
}

/** A four-bladed paper pinwheel on a stick, turned toward the camera. */
export function Pinwheel({ position, finish }: { position: Vec3; finish: MachineFinish }) {
	const rotor = useRef<THREE.Group>(null)
	useFrame((_, delta) => {
		if (finish.running && rotor.current) rotor.current.rotation.z -= Math.min(delta, 0.05) * 2.2
	})
	const [x, y, z] = position
	return (
		<group>
			<InkLines points={[x, y - 0.62, z, x, y, z]} ink={finish.ink} />
			<group position={[x, y, z]} rotation={[0, Math.PI / 4, 0]}>
				<group ref={rotor}>
					{[0, 1, 2, 3].map((blade) => (
						<group key={blade} rotation={[0, 0, (blade * Math.PI) / 2]}>
							<Flag
								corners={[
									[0, 0, 0.01],
									[0.3, 0, 0.01],
									[0.3, 0.26, 0.01],
								]}
								color={finish.gifts[blade % finish.gifts.length] ?? finish.face}
								ink={finish.ink}
							/>
						</group>
					))}
				</group>
			</group>
		</group>
	)
}

/** A pennant on a short pole, flying toward the camera's right. */
export function Pennant({
	position,
	color,
	finish,
}: {
	position: Vec3
	color: string
	finish: MachineFinish
}) {
	const [x, y, z] = position
	return (
		<group>
			<InkLines points={[x, y, z, x, y + 0.7, z]} ink={finish.ink} />
			<Flag
				corners={[
					[x, y + 0.7, z],
					[x, y + 0.46, z],
					[x + 0.3, y + 0.58, z + 0.06],
				]}
				color={color}
				ink={finish.ink}
			/>
		</group>
	)
}

/** A sagging string of party flags across a wall's front face. */
export function Bunting({ from, to, finish }: { from: Vec3; to: Vec3; finish: MachineFinish }) {
	const flags = 6
	const at = (t: number) => {
		const sag = Math.sin(Math.PI * t) * 0.16
		return [
			from[0] + (to[0] - from[0]) * t,
			from[1] + (to[1] - from[1]) * t - sag,
			from[2] + (to[2] - from[2]) * t,
		] as const
	}
	const string = Array.from({ length: 12 }, (_, i) => [...at(i / 12), ...at((i + 1) / 12)]).flat()
	return (
		<group>
			<InkLines points={string} ink={finish.ink} />
			{Array.from({ length: flags }, (_, i) => {
				const a = at((i + 0.15) / flags),
					b = at((i + 0.85) / flags),
					mid = at((i + 0.5) / flags)
				return (
					<Flag
						key={i}
						corners={[[...a], [...b], [mid[0], mid[1] - 0.2, mid[2]]]}
						color={finish.gifts[i % finish.gifts.length] ?? finish.face}
						ink={finish.ink}
					/>
				)
			})}
		</group>
	)
}

/** A candy-striped awning over an x-facing door. */
export function Awning({ position, finish }: { position: Vec3; finish: MachineFinish }) {
	const [x, y, z] = position
	const stripe = finish.gifts[0] ?? finish.signal
	return (
		<group>
			{[0, 1, 2, 3, 4].map((i) => (
				<InkBox
					key={i}
					size={[0.18, 0.05, 0.12]}
					position={[x + 0.08, y + 0.22 - 0.012 * i, z - 0.24 + i * 0.12]}
					color={i % 2 === 0 ? stripe : finish.tape}
					ink={finish.ink}
				/>
			))}
		</group>
	)
}

/** A planter of tiny blooms below a z-facing window. */
export function FlowerBox({ position, finish }: { position: Vec3; finish: MachineFinish }) {
	const [x, y, z] = position
	return (
		<group>
			<InkBox
				size={[0.42, 0.1, 0.12]}
				position={[x, y, z + 0.06]}
				color={finish.kraft}
				ink={finish.ink}
			/>
			{[-0.14, 0, 0.14].map((dx, i) => (
				<InkBox
					key={dx}
					size={[0.08, 0.08, 0.08]}
					position={[x + dx, y + 0.1, z + 0.06]}
					color={finish.gifts[(i + 1) % finish.gifts.length] ?? finish.face}
					ink={finish.ink}
				/>
			))}
		</group>
	)
}

/** A hanging lantern on a bracket beside an x-facing door, lit in Maple amber. */
export function Lantern({ position, finish }: { position: Vec3; finish: MachineFinish }) {
	const [x, y, z] = position
	return (
		<group>
			<InkLines
				points={[x, y + 0.2, z, x + 0.14, y + 0.2, z, x + 0.14, y + 0.2, z, x + 0.14, y + 0.12, z]}
				ink={finish.ink}
			/>
			<InkBox
				size={[0.1, 0.13, 0.1]}
				position={[x + 0.14, y + 0.05, z]}
				color={finish.gifts[2] ?? finish.signal}
				ink={finish.ink}
			/>
			<InkBox
				size={[0.13, 0.03, 0.13]}
				position={[x + 0.14, y + 0.125, z]}
				color={finish.face}
				ink={finish.ink}
			/>
		</group>
	)
}

/** A sugaring spout tapped into a vat with its sap bucket hanging below. */
export function MapleTap({ position, finish }: { position: Vec3; finish: MachineFinish }) {
	const bucket = useMemo(() => new THREE.CylinderGeometry(0.11, 0.08, 0.2, 6), [])
	const [x, y, z] = position
	return (
		<group>
			<InkBox
				size={[0.14, 0.04, 0.04]}
				position={[x + 0.07, y, z]}
				color={finish.face}
				ink={finish.ink}
			/>
			<InkLines points={[x + 0.12, y, z, x + 0.12, y - 0.12, z]} ink={finish.ink} />
			<InkSolid
				geometry={bucket}
				position={[x + 0.12, y - 0.22, z]}
				color={finish.face}
				ink={finish.ink}
			/>
			<InkLines points={ringAt([x + 0.12, y - 0.13, z], 0.105, 6)} ink={finish.ink} />
		</group>
	)
}

function ringAt([x, y, z]: Vec3, radius: number, sides: number) {
	return Array.from({ length: sides }, (_, i) => {
		const a = (i * Math.PI * 2) / sides,
			b = ((i + 1) * Math.PI * 2) / sides
		return [
			x + radius * Math.sin(a),
			y,
			z + radius * Math.cos(a),
			x + radius * Math.sin(b),
			y,
			z + radius * Math.cos(b),
		]
	}).flat()
}

/** Split firewood stacked three, two, one, end grain toward the camera's right. */
export function LogPile({ finish, base }: { finish: MachineFinish; base: number }) {
	const log = useMemo(() => new THREE.CylinderGeometry(0.15, 0.15, 1.1, 8), [])
	const logs = [
		[-0.3, 0],
		[0, 0],
		[0.3, 0],
		[-0.15, 1],
		[0.15, 1],
		[0, 2],
	] as const
	return (
		<group>
			{logs.map(([z, row]) => {
				const y = base + 0.15 + row * 0.26
				return (
					<group key={`${z}:${row}`}>
						<InkSolid
							geometry={log}
							position={[0, y, z + 0.25]}
							rotation={[0, 0, Math.PI / 2]}
							color={finish.kraft}
							ink={finish.ink}
						/>
						<InkLines points={endGrain([0.551, y, z + 0.25])} ink={finish.ink} />
					</group>
				)
			})}
		</group>
	)
}

/** Growth rings on the cut end of an x-aligned log. */
function endGrain([x, y, z]: Vec3) {
	return Array.from({ length: 8 }, (_, i) => {
		const a = (i * Math.PI) / 4,
			b = ((i + 1) * Math.PI) / 4
		return [
			x,
			y + 0.07 * Math.sin(a),
			z + 0.07 * Math.cos(a),
			x,
			y + 0.07 * Math.sin(b),
			z + 0.07 * Math.cos(b),
		]
	}).flat()
}

/** A clump of red-capped toadstools. */
export function Toadstools({ position, finish }: { position: Vec3; finish: MachineFinish }) {
	const cap = useMemo(() => new THREE.CylinderGeometry(0.03, 0.13, 0.1, 8), [])
	const [x, y, z] = position
	return (
		<group>
			{(
				[
					[0, 0, 1],
					[0.2, 0.12, 0.75],
					[-0.1, 0.22, 0.6],
				] as const
			).map(([dx, dz, scale]) => (
				<group key={`${dx}:${dz}`} position={[x + dx, y, z + dz]} scale={scale}>
					<InkBox
						size={[0.07, 0.16, 0.07]}
						position={[0, 0.08, 0]}
						color={finish.tape}
						ink={finish.ink}
					/>
					<InkSolid
						geometry={cap}
						position={[0, 0.2, 0]}
						color={finish.gifts[0] ?? finish.signal}
						ink={finish.ink}
					/>
				</group>
			))}
		</group>
	)
}

/** A faceted broadleaf: lollipop in Whimsy, a blazing maple in Maple. */
function Tree({ position, crown, palette }: { position: Vec3; crown: string; palette: InkPalette }) {
	const geometry = useMemo(() => new THREE.IcosahedronGeometry(0.36, 0), [])
	const [x, y, z] = position
	const seed = hash(x, z)
	return (
		<group position={[x, y, z]} scale={0.85 + seed * 0.45}>
			<InkBox size={[0.1, 0.42, 0.1]} position={[0, 0.21, 0]} color={palette.trunk} ink={palette.ink} />
			<InkSolid
				geometry={geometry}
				position={[0, 0.66, 0]}
				rotation={[0, seed * 3, 0]}
				color={crown}
				ink={palette.ink}
			/>
		</group>
	)
}

/** Box clouds drift along the far side of the map and wrap at its edges. */
function Cloud({
	start,
	left,
	span,
	speed,
	palette,
	running,
}: {
	start: Vec3
	left: number
	span: number
	speed: number
	palette: InkPalette
	running: boolean
}) {
	const cloud = useRef<THREE.Group>(null)
	const offset = useRef(0)
	useFrame((_, delta) => {
		if (!cloud.current) return
		if (running) offset.current = (offset.current + Math.min(delta, 0.05) * speed) % span
		cloud.current.position.x = left + ((start[0] - left + offset.current) % span)
	})
	return (
		<group ref={cloud} position={[...start]}>
			<InkBox size={[1.6, 0.5, 0.9]} color={palette.cloud} ink={palette.ink} />
			<InkBox
				size={[0.9, 0.45, 0.7]}
				position={[-0.3, 0.4, 0.05]}
				color={palette.cloud}
				ink={palette.ink}
			/>
			<InkBox
				size={[0.6, 0.32, 0.6]}
				position={[0.5, 0.3, 0.1]}
				color={palette.cloud}
				ink={palette.ink}
			/>
		</group>
	)
}

export const Scenery = memo(function Scenery({
	layout,
	belts,
	palette,
	running,
}: {
	layout: SpatialLayout
	/** Belt routes, so planting can keep clear of every corridor. Metrics refresh
	 * this array; plan against `geometryKey`, not array identity. */
	belts: ReadonlyArray<FactoryLink>
	palette: InkPalette
	running: boolean
}) {
	if (layout.districts.length === 0) return null
	const corners = layout.districts.flatMap((district, d) => {
		const top = district.position[1] + 0.16
		const [cx, , cz] = district.position
		return [
			[-1, -1],
			[1, -1],
			[-1, 1],
			[1, 1],
		].map(([sx = 0, sz = 0], i) => ({
			key: `${district.id}:${i}`,
			position: [
				cx + sx * (district.width / 2 - 0.35),
				top,
				cz + sz * (district.depth / 2 - 0.35),
			] as const,
			crown: palette.foliage[(d + i) % palette.foliage.length] ?? palette.face,
		}))
	})
	const bounds: Bounds = {
		minX: Math.min(...layout.districts.map((d) => d.position[0] - d.width / 2)),
		maxX: Math.max(...layout.districts.map((d) => d.position[0] + d.width / 2)),
		minZ: Math.min(...layout.districts.map((d) => d.position[2] - d.depth / 2)),
		maxZ: Math.max(...layout.districts.map((d) => d.position[2] + d.depth / 2)),
		floor: -0.14,
	}
	const span = bounds.maxX - bounds.minX + 8
	// Clouds keep to the back horizon, so they never sit between the camera and a machine.
	const clouds = [0.1, 0.45, 0.8].map((t, i) => ({
		start: [
			bounds.minX + (bounds.maxX - bounds.minX) * t,
			3.2 + i * 0.9,
			bounds.minZ - 2.5 - i * 1.6,
		] as const,
		speed: 0.25 + i * 0.08,
	}))
	const forest = palette.style === "maple"
	return (
		<group>
			{forest
				? null
				: corners.map((tree) => (
						<Tree key={tree.key} position={tree.position} crown={tree.crown} palette={palette} />
					))}
			{forest ? (
				<MapleForest
					bounds={bounds}
					districts={layout.districts}
					belts={belts}
					palette={palette}
					running={running}
				/>
			) : (
				clouds.map((cloud, i) => (
					<Cloud
						key={i}
						start={cloud.start}
						left={bounds.minX - 4}
						span={span}
						speed={cloud.speed}
						palette={palette}
						running={running}
					/>
				))
			)}
		</group>
	)
})
