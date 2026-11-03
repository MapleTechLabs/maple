import { Array as Arr, String as Str } from "effect"
export class LogCluster {
	logTemplateTokens: string[]
	clusterId: number
	size: number

	constructor(logTemplateTokens: string[], clusterId: number) {
		this.logTemplateTokens = [...logTemplateTokens]
		this.clusterId = clusterId
		this.size = 1
	}

	getTemplate(): string {
		return Arr.join(this.logTemplateTokens, " ")
	}

	toString(): string {
		return `ID=${Str.padEnd(5)(String(this.clusterId))} : size=${Str.padEnd(10)(String(this.size))}: ${this.getTemplate()}`
	}
}
