#!/usr/bin/env bun
import { BunRuntime } from "@effect/platform-bun"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Layer } from "effect"
import * as Command from "effect/unstable/cli/Command"
import { cli } from "./cli"
import { makeLocalWarehouseExecutor, DEFAULT_LOCAL_URL } from "./core/executor"

const baseUrl = process.env.MAPLE_LOCAL_URL ?? DEFAULT_LOCAL_URL
const MainLayer = Layer.mergeAll(makeLocalWarehouseExecutor(baseUrl), BunServices.layer)

Command.run(cli, { version: "0.1.0" }).pipe(Effect.provide(MainLayer), BunRuntime.runMain)
