import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"
import { Atom } from "effect/unstable/reactivity"

export const localStorageRuntime = Atom.runtime(KeyValueStore.layerStorage(() => localStorage))

/** For state that should outlive navigation but not the tab. */
export const sessionStorageRuntime = Atom.runtime(KeyValueStore.layerStorage(() => sessionStorage))
