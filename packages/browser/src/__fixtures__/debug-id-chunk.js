/* oxlint-disable */
// A built chunk after `maple sourcemaps inject`: it throws for real, then carries the appended snippet.
window.__chunkError = Promise.resolve()
	.then(function crash() {
		throw new Error("from chunk")
	})
	.catch(function (error) {
		return error
	})
// prettier-ignore
!function(){try{var g="undefined"!=typeof globalThis?globalThis:"undefined"!=typeof window?window:"undefined"!=typeof self?self:{},s=(new g.Error).stack;s&&(g._mapleDebugIds=g._mapleDebugIds||{},g._mapleDebugIds[s]="0b6c7a1e-58a4-4c1e-9d0b-2f3c4d5e6f70")}catch(e){}}()
//# debugId=0b6c7a1e-58a4-4c1e-9d0b-2f3c4d5e6f70
