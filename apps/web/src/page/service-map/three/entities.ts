import * as THREE from "three"
import { Array as Arr } from "effect"
import { disposeTree, type FrameCallback, type Scope } from "./kit"

// Keyed scene children: each entity owns its frames and is rebuilt only when its key changes.
// Painted textures (parcels, buckets, logs) are shared by the whole layer, so a hundred belts
// paint one parcel, not a hundred; they are freed with the layer. What one build owns (a belt's
// route data) is freed with that build.

export interface EntitySpec {
	readonly id: string
	/** Everything the build reads; an unchanged key keeps the built object. */
	readonly key: string
	readonly build: (scope: Scope) => THREE.Object3D
}

interface Entity {
	readonly key: string
	readonly scope: Scope
	readonly root: THREE.Object3D
}

export interface EntityLayer {
	readonly root: THREE.Group
	/** Builds new and changed entities, disposes removed and replaced ones, keeps spec order. */
	readonly sync: (specs: ReadonlyArray<EntitySpec>) => void
	readonly get: (id: string) => THREE.Object3D | undefined
	readonly ids: () => ReadonlyArray<string>
	readonly frame: FrameCallback
	readonly dispose: () => void
}

export const entityLayer = (): EntityLayer => {
	const root = new THREE.Group()
	const state = { entries: new Map<string, Entity>() }
	const shared = new Map<string, THREE.Texture>()
	const sync = (specs: ReadonlyArray<EntitySpec>) => {
		const next = new Map<string, Entity>()
		Arr.forEach(specs, (spec) => {
			if (next.has(spec.id)) return
			const current = state.entries.get(spec.id)
			if (current !== undefined && current.key === spec.key) {
				next.set(spec.id, current)
				return
			}
			const scope: Scope = { frames: [], textures: new Map(), shared }
			next.set(spec.id, { key: spec.key, scope, root: spec.build(scope) })
		})
		state.entries.forEach((entity, id) => {
			if (next.get(id) === entity) return
			root.remove(entity.root)
			disposeTree(entity.root, new Set(shared.values()))
			entity.scope.textures.forEach((texture) => texture.dispose())
			entity.scope.textures.clear()
			entity.scope.frames.length = 0
		})
		state.entries = next
		root.clear()
		next.forEach((entity) => root.add(entity.root))
	}
	return {
		root,
		sync,
		get: (id) => state.entries.get(id)?.root,
		ids: () => Arr.fromIterable(state.entries.keys()),
		frame: (delta) =>
			state.entries.forEach((entity) => Arr.forEach(entity.scope.frames, (frame) => frame(delta))),
		dispose: () => {
			sync([])
			shared.forEach((texture) => texture.dispose())
			shared.clear()
		},
	}
}
