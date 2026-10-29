import "../styles.css"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import { Program, Runtime } from "foldkit"
import { localApiBaseForLocation } from "../lib/constants"
import { ApplicationBlock, Flags } from "./application"

const program = Program.make({
	block: ApplicationBlock,
	Flags,
	container: document.getElementById("app"),
	devTools: { dispatch: true },
})

Runtime.run(program.provide(FetchHttpClient.layer), {
	flags: Effect.sync(() => Flags.make({ apiBase: localApiBaseForLocation(window.location) })),
})
