// Maple's declarations for the upstream validator (not part of the upstream skill).
export declare const LIMITS: { readonly inputBytes: number; readonly arrayItems: number; readonly validationErrors: number }
export declare function validateDocument(findings: unknown, schema: unknown): Array<string>
export declare function isSafeRelativeSourcePath(value: unknown): boolean
