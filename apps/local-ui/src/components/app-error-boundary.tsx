// A render error in one view must not blank the whole app. React only offers
// this as a class component; `resetKey` (the route) clears it on navigation.

import { Component, type ErrorInfo, type ReactNode } from "react"
import { Button } from "@maple/ui/components/ui/button"
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@maple/ui/components/ui/empty"
import { CircleWarningIcon } from "@maple/ui/components/icons"

interface Props {
	readonly resetKey: string
	readonly children: ReactNode
}

interface State {
	readonly error: Error | null
	readonly resetKey: string
}

export class AppErrorBoundary extends Component<Props, State> {
	override state: State = { error: null, resetKey: this.props.resetKey }

	static getDerivedStateFromError(error: unknown): Partial<State> {
		return { error: error instanceof Error ? error : new Error(String(error)) }
	}

	static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
		return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey }
	}

	override componentDidCatch(error: Error, info: ErrorInfo): void {
		console.error("View crashed", error, info.componentStack)
	}

	override render(): ReactNode {
		const { error } = this.state
		if (!error) return this.props.children
		return (
			<Empty className="h-full">
				<EmptyMedia variant="icon">
					<CircleWarningIcon className="text-destructive" />
				</EmptyMedia>
				<EmptyHeader>
					<EmptyTitle>This view hit an error</EmptyTitle>
					<EmptyDescription className="font-mono text-xs break-all">
						{error.message}
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button variant="outline" size="sm" onClick={() => this.setState({ error: null })}>
						Try again
					</Button>
				</EmptyContent>
			</Empty>
		)
	}
}
