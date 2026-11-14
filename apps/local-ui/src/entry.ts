import "./styles.css"

import { ResourcesLive } from "./platform/resources"
import { Runtime } from "foldkit"
import { syncSkeletonSweeps } from "@maple/views/ui/skeleton-clock"
import { Flags, flags, init, Message, Model, subscriptions, update, view } from "./main"

syncSkeletonSweeps()

const container = document.getElementById("app") ?? document.body

Runtime.run(
	Runtime.makeApplication({
		Model,
		Flags,
		init,
		update,
		view,
		subscriptions,
		resources: ResourcesLive,
		container,
		routing: {
			onUrlRequest: (request) => Message.ClickedLink({ request }),
			onUrlChange: (url) => Message.ChangedUrl({ url }),
		},
		devTools: { Message },
	}),
	{ flags },
)
