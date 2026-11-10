/**
 * How a Durable Object runtime takes the Worker's bound ports. A turn or an approval builds its
 * own runtime outside any request, so the limiters and the audit queue reach it only this way.
 */
import { Layer } from "effect"
import type { AiSessionPortsLayer } from "../worker/bindings"

/** Puts the session's ports under a runtime's graph; a caller with none (a local script) adds nothing. */
export const provideSessionPorts = (ports: AiSessionPortsLayer | undefined) =>
	Layer.provideMerge(ports ?? Layer.empty)
