import "./styles.css"

import { ResourcesLive } from "./platform/resources"
import { Program, Runtime } from "foldkit"
import { ApplicationBlock, Flags, flags } from "./main"

const container = document.getElementById("app") ?? document.body

const program = Program.make({
	block: ApplicationBlock,
	Flags,
	container,
	routing: {
		onUrlRequest: ApplicationBlock.Message.ClickedLink,
		onUrlChange: ApplicationBlock.Message.ChangedUrl,
	},
	devTools: { dispatch: true },
})

Runtime.run(program.provide(ResourcesLive), { flags })
