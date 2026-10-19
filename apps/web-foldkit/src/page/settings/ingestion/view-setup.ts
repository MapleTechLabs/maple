import type { Html, HtmlBuilder } from "foldkit/html"
import * as GuidedSetup from "../../kit/guided-setup"
import { Message } from "./message"
import type { Model } from "./model"

// `FrameworkPicker compact` and `ConnectInstructions variant="flush"` (`page/kit/guided-setup.ts`).

type H = HtmlBuilder<Message>

export const frameworkIconStrip = (h: H): Html => GuidedSetup.frameworkIconStrip(h)

export const frameworkPicker = (h: H, selected: string): Html =>
	GuidedSetup.frameworkPicker(h, {
		selected,
		compact: true,
		onSelect: (framework) => Message.ClickedFramework({ framework }),
	})

export const connectInstructions = (h: H, model: Model, apiKey: string): Html =>
	GuidedSetup.connectInstructions(h, {
		slot: "ingestion",
		framework: model.framework,
		apiKey,
		setupTabs: model.setupTabs,
		packageTabs: model.packageTabs,
		snippetCopies: model.snippetCopies,
		toSetupTabs: (message) => Message.GotSetupTabsMessage({ message }),
		toPackageTabs: (message) => Message.GotPackageTabsMessage({ message }),
		toSnippetCopy: (snippet, message) => Message.GotSnippetCopyMessage({ snippet, message }),
		variant: "flush",
	})
