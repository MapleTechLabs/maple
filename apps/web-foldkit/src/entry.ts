import "./styles.css"

import { Runtime } from "foldkit"
import { Flags, flags, init, Message, Model, subscriptions, update, view } from "./main"
import { ResourcesLive } from "./platform/api-clients"

const application = Runtime.makeApplication({
	Model,
	Flags,
	init,
	update,
	view,
	subscriptions,
	resources: ResourcesLive,
	container: document.getElementById("app") ?? document.body,
	routing: {
		onUrlRequest: (request) => Message.ClickedLink({ request }),
		onUrlChange: (url) => Message.ChangedUrl({ url }),
	},
	devTools: { Message },
})

Runtime.run(application, { flags })
