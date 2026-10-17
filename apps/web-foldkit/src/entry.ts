import "./styles.css"

import { Runtime } from "foldkit"
import { labEnabled, labPathOf, startLab } from "./lab/boot"
import { Flags, flags, init, Message, Model, subscriptions, update, view } from "./main"
import { ResourcesLive } from "./platform/api-clients"

const container = document.getElementById("app") ?? document.body

const startApplication = () =>
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

// `/lab/<path>` boots that lab page's own program instead of the app (parity scenarios, benches).
const labPath = labEnabled ? labPathOf(location.pathname) : undefined
if (labPath === undefined) startApplication()
else void startLab(labPath, container)
