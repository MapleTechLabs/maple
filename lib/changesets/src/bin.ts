#!/usr/bin/env bun
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Changesets } from "./changesets.ts"
import { main } from "./cli.ts"

main.pipe(
	// Application root: the only place the layer graph is provided.
	// oxlint-disable-next-line effecttsgo/strict-effect-provide
	Effect.provide(Changesets.layer.pipe(Layer.provideMerge(NodeServices.layer))),
	NodeRuntime.runMain({ disableErrorReporting: true }),
)
