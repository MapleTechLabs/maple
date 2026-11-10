import "@rrweb/replay/dist/style.css"
import type { ReplayEngineFactory } from "../engine/replay-engine"
import { rrwebEngineFactory } from "../engine/rrweb-engine"
import { videoEngineFactory } from "../engine/video-engine"
import type { ReplayFormat } from "./replay-window"

// Loaded with `import()` from the player Mount only: rrweb and its stylesheet never reach
// the startup chunk. The engines live in ../engine.

export const ENGINE_FACTORIES = {
	rrweb: rrwebEngineFactory,
	video: videoEngineFactory,
} satisfies Record<ReplayFormat, ReplayEngineFactory>
