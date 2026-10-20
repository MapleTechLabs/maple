import "@rrweb/replay/dist/style.css"
import type { ReplayEngineFactory } from "../../../components/replays/engine/replay-engine"
import { rrwebEngineFactory } from "../../../components/replays/engine/rrweb-engine"
import { videoEngineFactory } from "../../../components/replays/engine/video-engine"
import type { ReplayFormat } from "./replay-window"

// Loaded with `import()` from the player Mount only (S2): rrweb and its stylesheet never reach
// the startup chunk. The engines live in components/replays/engine.

export const ENGINE_FACTORIES = {
	rrweb: rrwebEngineFactory,
	video: videoEngineFactory,
} satisfies Record<ReplayFormat, ReplayEngineFactory>
