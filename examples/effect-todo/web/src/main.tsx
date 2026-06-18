import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App.tsx"
import { RegistryContext } from "./lib/effect-atom.ts"
import { appRegistry } from "./lib/registry.ts"
import "./index.css"

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<RegistryContext.Provider value={appRegistry}>
			<App />
		</RegistryContext.Provider>
	</StrictMode>,
)
