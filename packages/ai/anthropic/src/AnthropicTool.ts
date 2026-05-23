/**
 * Anthropic provider-defined tools for use with the LanguageModel.
 *
 * Provides tools that are natively supported by Anthropic's API, including
 * Bash, Code Execution, Computer Use, Memory, and Text Editor functionality.
 *
 * @since 4.0.0
 */
import * as Schema from "effect/Schema"
import * as Tool from "effect/unstable/ai/Tool"
import * as Generated from "./Generated.ts"

/**
 * Union of all Anthropic provider-defined tools.
 *
 * @category models
 * @since 4.0.0
 */
export type AnthropicTool =
  | ReturnType<typeof Bash_20241022>
  | ReturnType<typeof Bash_20250124>
  | ReturnType<typeof CodeExecution_20250522>
  | ReturnType<typeof CodeExecution_20250825>
  | ReturnType<typeof ComputerUse_20241022>
  | ReturnType<typeof ComputerUse_20250124>
  | ReturnType<typeof ComputerUse_20251124>
  | ReturnType<typeof Memory_20250818>
  | ReturnType<typeof TextEditor_20241022>
  | ReturnType<typeof TextEditor_20250124>
  | ReturnType<typeof TextEditor_20250429>
  | ReturnType<typeof TextEditor_20250728>
  | ReturnType<typeof ToolSearchRegex_20251119>
  | ReturnType<typeof ToolSearchBM25_20251119>
  | ReturnType<typeof WebFetch_20250910>
  | ReturnType<typeof WebSearch_20250305>

// =============================================================================
// Bash
// =============================================================================

/**
 * Anthropic Bash tool (2024-10-22 version).
 *
 * **Details**
 *
 * Allows the model to execute bash commands in a sandboxed environment.
 * Requires the "computer-use-2024-10-22" beta header.
 *
 * @category Bash
 * @since 4.0.0
 */
export const Bash_20241022 = Tool.providerDefined({
  id: "anthropic.bash_20241022",
  customName: "AnthropicBash",
  providerName: "bash",
  requiresHandler: true,
  success: Schema.String,
  parameters: Schema.Struct({
    command: Schema.String,
    restart: Schema.optional(Schema.Boolean)
  })
})

/**
 * Anthropic Bash tool (2025-01-24 version).
 *
 * **Details**
 *
 * Allows the model to execute bash commands in a sandboxed environment.
 * Requires the "computer-use-2025-01-24" beta header.
 *
 * @category Bash
 * @since 4.0.0
 */
export const Bash_20250124 = Tool.providerDefined({
  id: "anthropic.bash_20250124",
  customName: "AnthropicBash",
  providerName: "bash",
  requiresHandler: true,
  success: Schema.String,
  parameters: Schema.Struct({
    command: Schema.String,
    restart: Schema.optional(Schema.Boolean)
  })
})

// =============================================================================
// Code Execution
// =============================================================================

// -----------------------------------------------------------------------------
// Code Execution 20250522 Parameters
// -----------------------------------------------------------------------------

/**
 * Schema for a code execution request that asks Anthropic to run source code as a programmatic tool call.
 *
 * @category Code Execution
 * @since 4.0.0
 */
export const CodeExecutionProgrammaticToolCall = Schema.Struct({
  type: Schema.Literal("programmatic-tool-call"),
  /**
   * The code to execute.
   */
  code: Schema.String
})
/**
 * Input payload for a programmatic code execution tool call, including the source code to execute.
 *
 * @category Code Execution
 * @since 4.0.0
 */
export type CodeExecutionProgrammaticToolCall = typeof CodeExecutionProgrammaticToolCall.Type

/**
 * Schema for a code execution request that runs a bash command.
 *
 * @category Code Execution
 * @since 4.0.0
 */
export const CodeExecutionBashCommand = Schema.Struct({
  type: Schema.Literal("bash_code_execution"),
  /**
   * The bash command to execute.
   */
  command: Schema.String
})
/**
 * Input payload for a bash command executed through Anthropic code execution.
 *
 * @category Code Execution
 * @since 4.0.0
 */
export type CodeExecutionBashCommand = typeof CodeExecutionBashCommand.Type

/**
 * Text editor view command for code execution.
 *
 * @category Code Execution
 * @since 4.0.0
 */
export const CodeExecutionTextEditorView = Schema.Struct({
  type: Schema.Literal("text_editor_code_execution"),
  command: Schema.Literal("view"),
  /**
   * Path to the file to view.
   */
  path: Schema.String
})
/**
 * Input payload for viewing a file through the text editor code execution tool.
 *
 * @category Code Execution
 * @since 4.0.0
 */
export type CodeExecutionTextEditorView = typeof CodeExecutionTextEditorView.Type

/**
 * Text editor create command for code execution.
 *
 * @category Code Execution
 * @since 4.0.0
 */
export const CodeExecutionTextEditorCreate = Schema.Struct({
  type: Schema.Literal("text_editor_code_execution"),
  command: Schema.Literal("create"),
  /**
   * Path where the file should be created.
   */
  path: Schema.String,
  /**
   * The content to write to the new file.
   */
  file_text: Schema.optional(Schema.NullOr(Schema.String))
})
/**
 * Input payload for creating a file through the text editor code execution tool, optionally including initial file text.
 *
 * @category Code Execution
 * @since 4.0.0
 */
export type CodeExecutionTextEditorCreate = typeof CodeExecutionTextEditorCreate.Type

/**
 * Text editor str_replace command for code execution.
 *
 * @category Code Execution
 * @since 4.0.0
 */
export const CodeExecutionTextEditorStrReplace = Schema.Struct({
  type: Schema.Literal("text_editor_code_execution"),
  command: Schema.Literal("str_replace"),
  /**
   * Path to the file to modify.
   */
  path: Schema.String,
  /**
   * The text to replace.
   */
  old_str: Schema.String,
  /**
   * The replacement text.
   */
  new_str: Schema.String
})
/**
 * Input payload for replacing text in a file through the text editor code execution tool.
 *
 * @category Code Execution
 * @since 4.0.0
 */
export type CodeExecutionTextEditorStrReplace = typeof CodeExecutionTextEditorStrReplace.Type

const CodeExecution_20250522_Parameters = Schema.Union([
  CodeExecutionProgrammaticToolCall,
  CodeExecutionBashCommand,
  CodeExecutionTextEditorView,
  CodeExecutionTextEditorCreate,
  CodeExecutionTextEditorStrReplace
])

// -----------------------------------------------------------------------------
// Code Execution 20250825 Parameters
// -----------------------------------------------------------------------------

/**
 * Schema for the 2025-08-25 code execution tool input, containing the code to execute.
 *
 * @category Code Execution
 * @since 4.0.0
 */
export const CodeExecution_20250825_Parameters = Schema.Struct({
  /**
   * The code to execute.
   */
  code: Schema.String
})
/**
 * Input payload for the 2025-08-25 Anthropic code execution tool.
 *
 * @category Code Execution
 * @since 4.0.0
 */
export type CodeExecution_20250825_Parameters = typeof CodeExecution_20250825_Parameters.Type

// -----------------------------------------------------------------------------
// Code Execution Tool Definitions
// -----------------------------------------------------------------------------

/**
 * Anthropic Code Execution tool (2025-05-22 version).
 *
 * **Details**
 *
 * Allows the model to execute code in a sandboxed environment with support
 * for multiple execution types including programmatic tool calls, bash
 * execution, and text editor operations.
 *
 * @category Code Execution
 * @since 4.0.0
 */
export const CodeExecution_20250522 = Tool.providerDefined({
  id: "anthropic.code_execution_20250522",
  customName: "AnthropicCodeExecution",
  providerName: "code_execution",
  parameters: CodeExecution_20250522_Parameters,
  success: Generated.BetaResponseCodeExecutionResultBlock,
  failure: Generated.BetaResponseCodeExecutionToolResultError
})

/**
 * Anthropic Code Execution tool (2025-08-25 version).
 *
 * **Details**
 *
 * Allows the model to execute code in a sandboxed environment.
 *
 * @category Code Execution
 * @since 4.0.0
 */
export const CodeExecution_20250825 = Tool.providerDefined({
  id: "anthropic.code_execution_20250825",
  customName: "AnthropicCodeExecution",
  providerName: "code_execution",
  parameters: CodeExecution_20250825_Parameters,
  success: Schema.Union([
    Generated.BetaResponseCodeExecutionResultBlock,
    Generated.BetaResponseBashCodeExecutionResultBlock,
    Generated.BetaResponseTextEditorCodeExecutionViewResultBlock,
    Generated.BetaResponseTextEditorCodeExecutionCreateResultBlock,
    Generated.BetaResponseTextEditorCodeExecutionStrReplaceResultBlock
  ]),
  failure: Schema.Union([
    Generated.BetaResponseCodeExecutionToolResultError,
    Generated.BetaResponseBashCodeExecutionToolResultError,
    Generated.BetaResponseTextEditorCodeExecutionToolResultError
  ])
})

// =============================================================================
// Computer Use
// =============================================================================

// -----------------------------------------------------------------------------
// Common Types
// -----------------------------------------------------------------------------

/**
 * An `[x, y]` pixel position.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export const Coordinate = Schema.Tuple([Schema.Number, Schema.Number])
/**
 * An `[x, y]` screen coordinate in pixels.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export type Coordinate = typeof Coordinate.Type

/**
 * A `[x1, y1, x2, y2]` position defining top-left and bottom-right corners.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export const Region = Schema.Tuple([Schema.Number, Schema.Number, Schema.Number, Schema.Number])
/**
 * An `[x1, y1, x2, y2]` screen region in pixels, from top-left to bottom-right.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export type Region = typeof Region.Type

/**
 * The direction of the scroll for scroll actions.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export const ScrollDirection = Schema.Literals(["up", "down", "left", "right"])
/**
 * Direction used by computer-use scroll actions: `"up"`, `"down"`, `"left"`, or `"right"`.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export type ScrollDirection = typeof ScrollDirection.Type

/**
 * Modifier keys that can be held during click/scroll actions.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export const ModifierKey = Schema.Literals(["alt", "ctrl", "meta", "shift"])
/**
 * Modifier key that can be held during computer-use click or scroll actions.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export type ModifierKey = typeof ModifierKey.Type

// -----------------------------------------------------------------------------
// ComputerUse_20241022_Args
// -----------------------------------------------------------------------------

const ComputerUse_20241022_Args = Schema.Struct({
  /**
   * The width of the display being controlled by the model in pixels.
   */
  displayWidthPx: Schema.Number,

  /**
   * The height of the display being controlled by the model in pixels.
   */
  displayHeightPx: Schema.Number,

  /**
   * The display number to control (only relevant for X11 environments). If
   * specified, the tool will be provided a display number in the tool
   * definition.
   */
  displayNumber: Schema.optional(Schema.Number)
})

const ComputerUse_20251124_Args = Schema.Struct({
  ...ComputerUse_20241022_Args.fields,
  enableZoom: Schema.optional(Schema.Boolean)
})

// -----------------------------------------------------------------------------
// Computer Use 20241022 Actions
// -----------------------------------------------------------------------------

/**
 * Press a key or key combination (e.g. `"Return"`, `"ctrl+c"`, `"ctrl+s"`).
 *
 * @category Computer Use
 * @since 4.0.0
 */
export const ComputerUseKeyAction = Schema.Struct({
  action: Schema.Literal("key"),
  /**
   * The key to press.
   */
  text: Schema.String
})
/**
 * Computer-use action payload for pressing a key or key combination.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export type ComputerUseKeyAction = typeof ComputerUseKeyAction.Type

/**
 * Perform a left click at the current mouse position or the specified coordinates.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export const ComputerUseLeftClickAction = Schema.Struct({
  action: Schema.Literal("left_click"),
  /**
   * The `[x, y]` coordinate on the screen to left click (defaults to the current
   * mouse position if omitted).
   */
  coordinate: Schema.optional(Coordinate)
})
/**
 * Computer-use action payload for performing a left click, optionally at a specific coordinate.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export type ComputerUseLeftClickAction = typeof ComputerUseLeftClickAction.Type

/**
 * Move the mouse cursor to the specified coordinates.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export const ComputerUseMouseMoveAction = Schema.Struct({
  action: Schema.Literal("mouse_move"),
  /**
   * The `[x, y]` coordinate on the screen to move to.
   */
  coordinate: Coordinate
})
/**
 * Computer-use action payload for moving the mouse cursor to a specific coordinate.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export type ComputerUseMouseMoveAction = typeof ComputerUseMouseMoveAction.Type

/**
 * Capture the current display.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export const ComputerUseScreenshotAction = Schema.Struct({
  action: Schema.Literal("screenshot")
})
/**
 * Computer-use action payload for capturing the current display.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export type ComputerUseScreenshotAction = typeof ComputerUseScreenshotAction.Type

/**
 * Type a text string.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export const TypeAction = Schema.Struct({
  action: Schema.Literal("type"),
  /**
   * The text to type.
   */
  text: Schema.String
})
/**
 * Computer-use action payload for typing a text string.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export type TypeAction = typeof TypeAction.Type

const ComputerUse_20241022_Actions = Schema.Union([
  ComputerUseKeyAction,
  ComputerUseLeftClickAction,
  ComputerUseMouseMoveAction,
  ComputerUseScreenshotAction,
  TypeAction
])

// -----------------------------------------------------------------------------
// Computer Use 20250124 Actions
// -----------------------------------------------------------------------------

/**
 * Perform a double click.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export const ComputerUseDoubleClickAction = Schema.Struct({
  action: Schema.Literal("double_click"),
  /**
   * The coordinate to double click (defaults to the current mouse position if
   * omitted).
   */
  coordinate: Schema.optional(Coordinate)
})
/**
 * Computer-use action payload for performing a double click, optionally at a specific coordinate.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export type ComputerUseDoubleClickAction = typeof ComputerUseDoubleClickAction.Type

/**
 * Hold a key for a specified duration during computer-use execution.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export const ComputerUseHoldKeyAction = Schema.Struct({
  action: Schema.Literal("hold_key"),
  /**
   * The key to hold (e.g. `"shift"`, `"ctrl"`).
   */
  text: Schema.String,
  /**
   * The number of seconds to hold the key.
   */
  duration: Schema.Number
})
/**
 * Computer-use action payload for holding a key for a specified duration.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export type ComputerUseHoldKeyAction = typeof ComputerUseHoldKeyAction.Type

/**
 * Click and drag from start coordinate to end coordinate.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export const ComputerUseLeftClickDragAction = Schema.Struct({
  action: Schema.Literal("left_click_drag"),
  /**
   * The `[x, y]` coordinate to start dragging from.
   */
  start_coordinate: Coordinate,
  /**
   * The `[x, y]` coordinate to drag to.
   */
  coordinate: Coordinate
})
/**
 * Computer-use action payload for dragging from a start coordinate to an end coordinate.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export type ComputerUseLeftClickDragAction = typeof ComputerUseLeftClickDragAction.Type

/**
 * Press the left mouse button down (without releasing).
 *
 * **When to use**
 *
 * Use this for fine-grained click control.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export const ComputerUseLeftMouseDownAction = Schema.Struct({
  action: Schema.Literal("left_mouse_down"),
  /**
   * The coordinate at which the left mouse button should be held down (defaults
   * to the current mouse position if omitted).
   */
  coordinate: Schema.optional(Coordinate)
})
/**
 * Computer-use action payload for pressing and holding the left mouse button, optionally at a specific coordinate.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export type ComputerUseLeftMouseDownAction = typeof ComputerUseLeftMouseDownAction.Type

/**
 * Release the left mouse button.
 *
 * **When to use**
 *
 * Use this for fine-grained click control.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export const ComputerUseLeftMouseUpAction = Schema.Struct({
  action: Schema.Literal("left_mouse_up"),
  /**
   * The coordinate at which the left mouse button should be released (defaults
   * to the current mouse position if omitted).
   */
  coordinate: Schema.optional(Coordinate)
})
/**
 * Computer-use action payload for releasing the left mouse button, optionally at a specific coordinate.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export type ComputerUseLeftMouseUpAction = typeof ComputerUseLeftMouseUpAction.Type

/**
 * Perform a middle click.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export const ComputerUseMiddleClickAction = Schema.Struct({
  action: Schema.Literal("middle_click"),
  /**
   * The coordinate to middle click (defaults to the current mouse position if
   * omitted).
   */
  coordinate: Schema.optional(Coordinate)
})
/**
 * Computer-use action payload for performing a middle click, optionally at a specific coordinate.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export type ComputerUseMiddleClickAction = typeof ComputerUseMiddleClickAction.Type

/**
 * Perform a right click.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export const ComputerUseRightClickAction = Schema.Struct({
  action: Schema.Literal("right_click"),
  /**
   * The coordinate to right click (defaults to the current mouse position if
   * omitted).
   */
  coordinate: Schema.optional(Coordinate)
})
/**
 * Computer-use action payload for performing a right click, optionally at a specific coordinate.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export type ComputerUseRightClickAction = typeof ComputerUseRightClickAction.Type

/**
 * Scroll a given amount in a specified direction.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export const ComputerUseScrollAction = Schema.Struct({
  action: Schema.Literal("scroll"),
  /**
   * The coordinate to start scrolling from (defaults to the current mouse
   * position if omitted).
   */
  coordinate: Schema.optional(Coordinate),
  /**
   * The direction to scroll.
   */
  scroll_direction: ScrollDirection,
  /**
   * The amount to scroll (in pixels or scroll units).
   */
  scroll_amount: Schema.Number
})
/**
 * Computer-use action payload for scrolling by a specified amount in a specified direction, optionally from a coordinate.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export type ComputerUseScrollAction = typeof ComputerUseScrollAction.Type

/**
 * Perform a triple click.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export const ComputerUseTripleClickAction = Schema.Struct({
  action: Schema.Literal("triple_click"),
  /**
   * The coordinate to triple click (defaults to the current mouse position if
   * omitted).
   */
  coordinate: Schema.optional(Coordinate)
})
/**
 * Computer-use action payload for performing a triple click, optionally at a specific coordinate.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export type ComputerUseTripleClickAction = typeof ComputerUseTripleClickAction.Type

/**
 * Pause between performing actions.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export const ComputerUseWaitAction = Schema.Struct({
  action: Schema.Literal("wait"),
  /**
   * The number of seconds to wait.
   */
  duration: Schema.Number
})
/**
 * Computer-use action payload for pausing for a specified duration.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export type ComputerUseWaitAction = typeof ComputerUseWaitAction.Type

const ComputerUse_20250124_Actions = Schema.Union([
  ...ComputerUse_20241022_Actions.members,
  ComputerUseDoubleClickAction,
  ComputerUseHoldKeyAction,
  ComputerUseLeftClickDragAction,
  ComputerUseLeftMouseDownAction,
  ComputerUseLeftMouseUpAction,
  ComputerUseMiddleClickAction,
  ComputerUseRightClickAction,
  ComputerUseScrollAction,
  ComputerUseTripleClickAction,
  ComputerUseWaitAction
])

// -----------------------------------------------------------------------------
// Computer Use 20251124 Actions
// -----------------------------------------------------------------------------

/**
 * Zoom into a specific region of the screen at full resolution.
 *
 * **Details**
 *
 * Requires `enableZoom: true` in the tool definition.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export const ComputerUseZoomAction = Schema.Struct({
  action: Schema.Literal("zoom"),
  /**
   * Region to zoom into, defined as `[x1, y1, x2, y2]` coordinates where
   * `(x1, y1)` is the top-left corner and `(x2, y2)` is the bottom-right corner.
   */
  region: Region
})
/**
 * Computer-use action payload for zooming into a specific screen region.
 *
 * **Details**
 *
 * The enclosing computer-use tool must be configured with `enableZoom: true`.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export type ComputerUseZoomAction = typeof ComputerUseZoomAction.Type

const ComputerUse_20251124_Actions = Schema.Union([
  ...ComputerUse_20250124_Actions.members,
  ComputerUseZoomAction
])

// -----------------------------------------------------------------------------
// Computer Use Tool Definitions
// -----------------------------------------------------------------------------

/**
 * Computer use tool for Claude 3.5 Sonnet v2 (deprecated).
 *
 * **Details**
 *
 * Requires the "computer-use-2024-10-22" beta header.
 * Basic actions only: screenshot, left_click, type, key, mouse_move.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export const ComputerUse_20241022 = Tool.providerDefined({
  id: "anthropic.computer_use_20241022",
  customName: "AnthropicComputerUse",
  providerName: "computer_use",
  requiresHandler: true,
  args: ComputerUse_20241022_Args,
  parameters: ComputerUse_20241022_Actions,
  success: Schema.String
})

/**
 * Computer use tool for Claude 4 models and Claude Sonnet 3.7.
 *
 * **Details**
 *
 * Requires the "computer-use-2025-01-24" beta header.
 * Includes basic actions plus enhanced actions: scroll, left_click_drag,
 * right_click, middle_click, double_click, triple_click, left_mouse_down,
 * left_mouse_up, hold_key, wait.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export const ComputerUse_20250124 = Tool.providerDefined({
  id: "anthropic.computer_20250124",
  customName: "AnthropicComputerUse",
  providerName: "computer",
  requiresHandler: true,
  args: ComputerUse_20241022_Args,
  parameters: ComputerUse_20250124_Actions,
  success: Schema.String
})

/**
 * Computer use tool for Claude Opus 4.5 only.
 *
 * **Details**
 *
 * Requires the "computer-use-2025-11-24" beta header.
 * Includes all actions from computer_20250124 plus the zoom action for
 * detailed screen region inspection. Requires `enableZoom: true` in args.
 *
 * @category Computer Use
 * @since 4.0.0
 */
export const ComputerUse_20251124 = Tool.providerDefined({
  id: "anthropic.computer_20251124",
  customName: "AnthropicComputerUse",
  providerName: "computer",
  requiresHandler: true,
  args: ComputerUse_20251124_Args,
  parameters: ComputerUse_20251124_Actions,
  success: Schema.String
})

// =============================================================================
// Memory
// =============================================================================

// -----------------------------------------------------------------------------
// Common Types
// -----------------------------------------------------------------------------

/**
 * A `[start, end]` line range for viewing file contents.
 *
 * **Details**
 *
 * Lines are 1-indexed. Use -1 for end to read to the end of the file. For
 * example, `[1, 50]` views lines 1-50 and `[100, -1]` views from line 100 to
 * the end of the file.
 *
 * @category Memory
 * @since 4.0.0
 */
export const ViewRange = Schema.Tuple([Schema.Number, Schema.Number])
/**
 * A `[start, end]` 1-indexed line range for viewing file contents, using `-1` as the end value to read through the end of the file.
 *
 * @category Memory
 * @since 4.0.0
 */
export type ViewRange = typeof ViewRange.Type

// -----------------------------------------------------------------------------
// Memory 20250818 Commands
// -----------------------------------------------------------------------------

/**
 * Creates a new file.
 *
 * @category Memory
 * @since 4.0.0
 */
export const MemoryCreateCommand = Schema.Struct({
  command: Schema.Literal("create"),
  /**
   * The path to the file that should be created.
   */
  path: Schema.String
})
/**
 * Memory tool command payload for creating a new file at a path.
 *
 * @category Memory
 * @since 4.0.0
 */
export type MemoryCreateCommand = typeof MemoryCreateCommand.Type

/**
 * Delete a file or directory.
 *
 * @category Memory
 * @since 4.0.0
 */
export const MemoryDeleteCommand = Schema.Struct({
  command: Schema.Literal("delete"),
  /**
   * The path to the file to delete.
   */
  path: Schema.String
})
/**
 * Memory tool command payload for deleting a file or directory at a path.
 *
 * @category Memory
 * @since 4.0.0
 */
export type MemoryDeleteCommand = typeof MemoryDeleteCommand.Type

/**
 * Insert text at a specific line.
 *
 * @category Memory
 * @since 4.0.0
 */
export const MemoryInsertCommand = Schema.Struct({
  command: Schema.Literal("insert"),
  /**
   * The path to the file to insert text into.
   */
  path: Schema.String,
  /**
   * The line at which the text should be inserted.
   */
  insert_line: Schema.Number,
  /**
   * The text to insert.
   */
  insert_text: Schema.String
})
/**
 * Memory tool command payload for inserting text at a specific line in a file.
 *
 * @category Memory
 * @since 4.0.0
 */
export type MemoryInsertCommand = typeof MemoryInsertCommand.Type

/**
 * Rename or move a file or directory.
 *
 * @category Memory
 * @since 4.0.0
 */
export const MemoryRenameCommand = Schema.Struct({
  command: Schema.Literal("rename"),
  /**
   * The old path to the file or directory.
   */
  old_path: Schema.String,
  /**
   * The new path to the file or directory.
   */
  new_path: Schema.String
})
/**
 * Memory tool command payload for renaming or moving a file or directory.
 *
 * @category Memory
 * @since 4.0.0
 */
export type MemoryRenameCommand = typeof MemoryRenameCommand.Type

/**
 * Replace text in a file.
 *
 * @category Memory
 * @since 4.0.0
 */
export const MemoryStrReplaceCommand = Schema.Struct({
  command: Schema.Literal("str_replace"),
  /**
   * The path to the file in which the replacement should occur.
   */
  path: Schema.String,
  /**
   * The text to replace.
   */
  old_str: Schema.String,
  /**
   * The replacement text.
   */
  new_str: Schema.String
})
/**
 * Memory tool command payload for replacing text in a file.
 *
 * @category Memory
 * @since 4.0.0
 */
export type MemoryStrReplaceCommand = typeof MemoryStrReplaceCommand.Type

/**
 * Shows directory contents or file contents with optional line ranges.
 *
 * @category Memory
 * @since 4.0.0
 */
export const MemoryViewCommand = Schema.Struct({
  command: Schema.Literal("view"),
  /**
   * The path to the file to view.
   */
  path: Schema.String,
  /**
   * The specific lines to view.
   */
  view_range: Schema.optional(ViewRange)
})
/**
 * Memory tool command payload for viewing a file or directory, optionally with a file line range.
 *
 * @category Memory
 * @since 4.0.0
 */
export type MemoryViewCommand = typeof MemoryViewCommand.Type

const Memory_20250818_Commands = Schema.Union([
  MemoryCreateCommand,
  MemoryDeleteCommand,
  MemoryInsertCommand,
  MemoryRenameCommand,
  MemoryStrReplaceCommand,
  MemoryViewCommand
])

// -----------------------------------------------------------------------------
// Memory Tool Definitions
// -----------------------------------------------------------------------------

/**
 * Memory tool for persistent file operations across conversations.
 *
 * **Details**
 *
 * Provides commands for creating, viewing, editing, renaming, and deleting
 * files within the model's memory space.
 *
 * @category Memory
 * @since 4.0.0
 */
export const Memory_20250818 = Tool.providerDefined({
  id: "anthropic.memory_20250818",
  customName: "AnthropicMemory",
  providerName: "memory",
  parameters: Memory_20250818_Commands,
  success: Schema.String
})

// =============================================================================
// Text Editor
// =============================================================================

// -----------------------------------------------------------------------------
// Text Editor Commands
// -----------------------------------------------------------------------------

/**
 * View the contents of a file or list directory contents.
 *
 * **Details**
 *
 * When used on a file, returns the file contents, optionally limited to a line
 * range. When used on a directory, lists all files and subdirectories.
 *
 * @category Text Editor
 * @since 4.0.0
 */
export const TextEditorViewCommand = Schema.Struct({
  command: Schema.Literal("view"),
  /**
   * Absolute or relative path to the file or directory to view.
   */
  path: Schema.String,
  /**
   * Optional line range to view (only applies to files, not directories).
   * Lines are 1-indexed. Use -1 for end to read to end of file.
   */
  view_range: Schema.optional(ViewRange)
})
/**
 * Text editor command payload for viewing file contents or listing directory contents.
 *
 * @category Text Editor
 * @since 4.0.0
 */
export type TextEditorViewCommand = typeof TextEditorViewCommand.Type

/**
 * Create a new file with specified content.
 *
 * **Gotchas**
 *
 * Fails if the file already exists. Parent directories must exist.
 *
 * @category Text Editor
 * @since 4.0.0
 */
export const TextEditorCreateCommand = Schema.Struct({
  command: Schema.Literal("create"),
  /**
   * Path where the file should be created.
   */
  path: Schema.String,
  /**
   * The content to write to the new file.
   */
  file_text: Schema.String
})
/**
 * Text editor command payload for creating a new file with the specified content.
 *
 * **Gotchas**
 *
 * The command fails if the file already exists or if parent directories are missing.
 *
 * @category Text Editor
 * @since 4.0.0
 */
export type TextEditorCreateCommand = typeof TextEditorCreateCommand.Type

/**
 * Replace a specific string in a file with a new string.
 *
 * **Gotchas**
 *
 * The `old_str` must match exactly (including whitespace and indentation)
 * and must be unique in the file.
 *
 * @category Text Editor
 * @since 4.0.0
 */
export const TextEditorStrReplaceCommand = Schema.Struct({
  command: Schema.Literal("str_replace"),
  /**
   * Path to the file to modify.
   */
  path: Schema.String,
  /**
   * The exact string to find and replace (must be unique in the file).
   */
  old_str: Schema.String,
  /**
   * The string to replace old_str with (can be empty to delete).
   */
  new_str: Schema.String
})
/**
 * Text editor command payload for replacing one exact, unique string in a file.
 *
 * @category Text Editor
 * @since 4.0.0
 */
export type TextEditorStrReplaceCommand = typeof TextEditorStrReplaceCommand.Type

/**
 * Insert text at a specific line number in a file.
 *
 * **Details**
 *
 * Inserts the new text AFTER the specified line number.
 *
 * @category Text Editor
 * @since 4.0.0
 */
export const TextEditorInsertCommand = Schema.Struct({
  command: Schema.Literal("insert"),
  /**
   * Path to the file to modify.
   */
  path: Schema.String,
  /**
   * The line number after which to insert (0 = beginning, 1-indexed).
   */
  insert_line: Schema.Number,
  /**
   * The text to insert.
   */
  new_str: Schema.String
})
/**
 * Text editor command payload for inserting text after a specific line number in a file.
 *
 * @category Text Editor
 * @since 4.0.0
 */
export type TextEditorInsertCommand = typeof TextEditorInsertCommand.Type

/**
 * Undo the last edit made to a file.
 *
 * **Details**
 *
 * Reverts the most recent str_replace, insert, or create operation on the file.
 *
 * **Gotchas**
 *
 * This command is available in text_editor_20241022 and text_editor_20250124,
 * but not in text_editor_20250728 (Claude 4 models).
 *
 * @category Text Editor
 * @since 4.0.0
 */
export const TextEditorUndoEditCommand = Schema.Struct({
  command: Schema.Literal("undo_edit"),
  /**
   * Path to the file to undo the last edit on.
   */
  path: Schema.String
})
/**
 * Text editor command payload for undoing the most recent edit to a file.
 *
 * **Gotchas**
 *
 * Available for `text_editor_20241022` and `text_editor_20250124`, but not for Claude 4 text editor versions.
 *
 * @category Text Editor
 * @since 4.0.0
 */
export type TextEditorUndoEditCommand = typeof TextEditorUndoEditCommand.Type

const TextEditor_StrReplaceEditor_Commands = Schema.Union([
  TextEditorViewCommand,
  TextEditorCreateCommand,
  TextEditorStrReplaceCommand,
  TextEditorInsertCommand,
  TextEditorUndoEditCommand
])

const TextEditor_StrReplaceBasedEdit_Commands = Schema.Union([
  TextEditorViewCommand,
  TextEditorCreateCommand,
  TextEditorStrReplaceCommand,
  TextEditorInsertCommand
])

// -----------------------------------------------------------------------------
// Text Editor Args
// -----------------------------------------------------------------------------

const TextEditor_StrReplaceBasedEdit_Args = Schema.Struct({
  /**
   * Maximum number of characters to return when viewing large files.
   * When a file exceeds this limit, it will be truncated.
   */
  max_characters: Schema.optional(Schema.Number)
})

// -----------------------------------------------------------------------------
// Text Editor Tool Definitions
// -----------------------------------------------------------------------------

/**
 * Text editor tool for Claude 3.5 Sonnet (deprecated).
 *
 * **Details**
 *
 * Requires the "computer-use-2024-10-22" beta header.
 *
 * @category Text Editor
 * @since 4.0.0
 */
export const TextEditor_20241022 = Tool.providerDefined({
  id: "anthropic.text_editor_20241022",
  customName: "AnthropicTextEditor",
  providerName: "str_replace_editor",
  requiresHandler: true,
  parameters: TextEditor_StrReplaceEditor_Commands,
  success: Schema.String
})

/**
 * Text editor tool for Claude Sonnet 3.7 (deprecated model).
 *
 * **Details**
 *
 * Requires the "computer-use-2025-01-24" beta header.
 *
 * @category Text Editor
 * @since 4.0.0
 */
export const TextEditor_20250124 = Tool.providerDefined({
  id: "anthropic.text_editor_20250124",
  customName: "AnthropicTextEditor",
  providerName: "str_replace_editor",
  requiresHandler: true,
  parameters: TextEditor_StrReplaceEditor_Commands,
  success: Schema.String
})

/**
 * Text editor tool for Claude 4 models using Anthropic's `str_replace_based_edit_tool`.
 *
 * **Details**
 *
 * Requires the "computer-use-2025-01-24" beta header.
 *
 * **Gotchas**
 *
 * This version does not support the `undo_edit` command.
 *
 * @category Text Editor
 * @since 4.0.0
 */
export const TextEditor_20250429 = Tool.providerDefined({
  id: "anthropic.text_editor_20250429",
  customName: "AnthropicTextEditor",
  providerName: "str_replace_based_edit_tool",
  requiresHandler: true,
  args: TextEditor_StrReplaceBasedEdit_Args,
  parameters: TextEditor_StrReplaceBasedEdit_Commands,
  success: Schema.String
})

/**
 * Text editor tool for Claude 4 models.
 *
 * **Gotchas**
 *
 * This version does not support the `undo_edit` command.
 *
 * @category Text Editor
 * @since 4.0.0
 */
export const TextEditor_20250728 = Tool.providerDefined({
  id: "anthropic.text_editor_20250728",
  customName: "AnthropicTextEditor",
  providerName: "str_replace_based_edit_tool",
  requiresHandler: true,
  args: TextEditor_StrReplaceBasedEdit_Args,
  parameters: TextEditor_StrReplaceBasedEdit_Commands,
  success: Schema.String
})

// =============================================================================
// Web Search
// =============================================================================

// -----------------------------------------------------------------------------
// Web Search Types
// -----------------------------------------------------------------------------

/**
 * User location for localizing search results.
 *
 * **When to use**
 *
 * Providing location helps return more relevant results for location-dependent
 * queries like weather, local businesses, events, etc.
 *
 * @category Web Search
 * @since 4.0.0
 */
export const WebSearchUserLocation = Schema.Struct({
  /**
   * Location type - currently only "approximate" is supported.
   */
  type: Schema.Literal("approximate"),
  /**
   * City name.
   */
  city: Schema.optional(Schema.String),
  /**
   * Region/state/province name.
   */
  region: Schema.optional(Schema.String),
  /**
   * ISO 3166-1 alpha-2 country code.
   */
  country: Schema.optional(Schema.String),
  /**
   * IANA timezone identifier.
   */
  timezone: Schema.optional(Schema.String)
})

// -----------------------------------------------------------------------------
// Web Search Args
// -----------------------------------------------------------------------------

/**
 * Configuration arguments for the web search tool.
 *
 * @category Web Search
 * @since 4.0.0
 */
export const WebSearch_20250305_Args = Schema.Struct({
  /**
   * Maximum number of searches allowed per API request.
   */
  maxUses: Schema.optional(Schema.Number),
  /**
   * Restrict search results to only these domains.
   *
   * Cannot be used together with `blockedDomains`.
   */
  allowedDomains: Schema.optional(Schema.Array(Schema.String)),
  /**
   * Exclude results from these domains.
   *
   * Cannot be used together with `allowedDomains`.
   */
  blockedDomains: Schema.optional(Schema.Array(Schema.String)),
  /**
   * User location for localizing search results.
   */
  userLocation: Schema.optional(WebSearchUserLocation)
})
/**
 * Configuration arguments for the Anthropic web search tool, including usage limits, domain filters, and optional user location.
 *
 * @category Web Search
 * @since 4.0.0
 */
export type WebSearch_20250305_Args = typeof WebSearch_20250305_Args.Type

// -----------------------------------------------------------------------------
// Web Search Parameters
// -----------------------------------------------------------------------------

/**
 * Input parameters for a web search.
 *
 * @category Web Search
 * @since 4.0.0
 */
export const WebSearchParameters = Schema.Struct({
  /**
   * The search query generated by Claude.
   */
  query: Schema.String
})
/**
 * Type of the parameters Claude supplies when invoking the Anthropic web search tool.
 *
 * **Details**
 *
 * Contains the generated search query used by `WebSearch_20250305`.
 *
 * @category Web Search
 * @since 4.0.0
 */
export type WebSearchParameters = typeof WebSearchParameters.Type

// -----------------------------------------------------------------------------
// Web Search Tool Definitions
// -----------------------------------------------------------------------------

/**
 * Web search tool for Claude models.
 *
 * **Details**
 *
 * Enables Claude to search the web for real-time information. This is a
 * server-side tool executed by Anthropic's infrastructure.
 * Generally available (no beta header required).
 *
 * @category Web Search
 * @since 4.0.0
 */
export const WebSearch_20250305 = Tool.providerDefined({
  id: "anthropic.web_search_20250305",
  customName: "AnthropicWebSearch",
  providerName: "web_search",
  args: WebSearch_20250305_Args,
  parameters: WebSearchParameters,
  success: Schema.Array(Generated.BetaResponseWebSearchResultBlock),
  failure: Generated.BetaResponseWebSearchToolResultError
})

// =============================================================================
// Web Fetch
// =============================================================================

// -----------------------------------------------------------------------------
// Web Fetch Types
// -----------------------------------------------------------------------------

/**
 * Citation configuration for web fetch.
 *
 * @category Web Fetch
 * @since 4.0.0
 */
export const WebFetchCitationsConfig = Schema.Struct({
  /**
   * Enable citations for fetched content.
   */
  enabled: Schema.Boolean
})
/**
 * Configuration payload for enabling or disabling citations on web fetch results.
 *
 * @category Web Fetch
 * @since 4.0.0
 */
export type WebFetchCitationsConfig = typeof WebFetchCitationsConfig.Type

// -----------------------------------------------------------------------------
// Web Fetch Args
// -----------------------------------------------------------------------------

/**
 * Configuration arguments for the web fetch tool.
 *
 * @category Web Fetch
 * @since 4.0.0
 */
export const WebFetch_20250910_Args = Schema.Struct({
  /**
   * Maximum number of fetches allowed per API request.
   */
  maxUses: Schema.optional(Schema.Number),
  /**
   * Restrict fetches to only these domains.
   *
   * Cannot be used together with `blockedDomains`.
   */
  allowedDomains: Schema.optional(Schema.Array(Schema.String)),
  /**
   * Exclude fetches from these domains.
   *
   * Cannot be used together with `allowedDomains`.
   */
  blockedDomains: Schema.optional(Schema.Array(Schema.String)),
  /**
   * Enable citations for fetched content.
   */
  citations: Schema.optional(WebFetchCitationsConfig),
  /**
   * Maximum content length in tokens.
   */
  maxContentTokens: Schema.optional(Schema.Number)
})
/**
 * Configuration arguments for the Anthropic web fetch tool, including usage limits, domain filters, citation settings, and token limits.
 *
 * @category Web Fetch
 * @since 4.0.0
 */
export type WebFetch_20250910_Args = typeof WebFetch_20250910_Args.Type

// -----------------------------------------------------------------------------
// Web Fetch Parameters
// -----------------------------------------------------------------------------

/**
 * Input parameters for a web fetch.
 *
 * @category Web Fetch
 * @since 4.0.0
 */
export const WebFetchParameters = Schema.Struct({
  /**
   * URL to fetch. Must be a URL provided by the user or from prior search/fetch
   * results. Maximum URL length: 250 characters.
   */
  url: Schema.String
})
/**
 * Type of the parameters Claude supplies when invoking the Anthropic web fetch tool.
 *
 * @category Web Fetch
 * @since 4.0.0
 */
export type WebFetchParameters = typeof WebFetchParameters.Type

// -----------------------------------------------------------------------------
// Web Fetch Tool Definitions
// -----------------------------------------------------------------------------

/**
 * Web fetch tool for Claude models.
 *
 * **Details**
 *
 * Allows Claude to retrieve full content from web pages and PDF documents.
 * This is a server-side tool executed by Anthropic's infrastructure.
 * Requires the "web-fetch-2025-09-10" beta header.
 *
 * @category Web Fetch
 * @since 4.0.0
 */
export const WebFetch_20250910 = Tool.providerDefined({
  id: "anthropic.web_fetch_20250910",
  customName: "AnthropicWebFetch",
  providerName: "web_fetch",
  args: WebFetch_20250910_Args,
  parameters: WebFetchParameters,
  success: Generated.BetaResponseWebFetchResultBlock,
  failure: Generated.BetaResponseWebFetchToolResultError
})

// =============================================================================
// Tool Search
// =============================================================================

// -----------------------------------------------------------------------------
// Tool Search Parameters
// -----------------------------------------------------------------------------

/**
 * Input parameters for regex-based tool search.
 *
 * **Details**
 *
 * Claude constructs regex patterns using Python's `re.search()` syntax.
 * Maximum query length: 200 characters.
 *
 * @category Tool Search
 * @since 4.0.0
 */
export const ToolSearchRegexParameters = Schema.Struct({
  /**
   * Python regex pattern to search for tools.
   */
  query: Schema.String
})
/**
 * Type of the parameters Claude supplies when invoking regex-based Anthropic tool search.
 *
 * @category Tool Search
 * @since 4.0.0
 */
export type ToolSearchRegexParameters = typeof ToolSearchRegexParameters.Type

/**
 * Input parameters for BM25/natural language tool search.
 *
 * @category Tool Search
 * @since 4.0.0
 */
export const ToolSearchBM25Parameters = Schema.Struct({
  /**
   * Natural language query to search for tools.
   */
  query: Schema.String
})
/**
 * Type of the parameters Claude supplies when invoking BM25 natural-language Anthropic tool search.
 *
 * @category Tool Search
 * @since 4.0.0
 */
export type ToolSearchBM25Parameters = typeof ToolSearchBM25Parameters.Type

// -----------------------------------------------------------------------------
// Tool Search Tool Definitions
// -----------------------------------------------------------------------------

/**
 * Regex-based tool search for Claude models.
 *
 * **Details**
 *
 * Claude constructs regex patterns using Python's `re.search()` syntax to
 * find tools. The regex is matched against tool names, descriptions,
 * argument names, and argument descriptions.
 * Requires the "advanced-tool-use-2025-11-20" beta header.
 *
 * @category Tool Search
 * @since 4.0.0
 */
export const ToolSearchRegex_20251119 = Tool.providerDefined({
  id: "anthropic.tool_search_tool_regex_20251119",
  customName: "AnthropicToolSearchRegex",
  providerName: "tool_search_tool_regex",
  parameters: ToolSearchRegexParameters,
  success: Schema.Array(Generated.BetaRequestToolReferenceBlock),
  failure: Generated.BetaResponseToolSearchToolResultError
})

/**
 * BM25/natural language tool search for Claude models.
 *
 * **Details**
 *
 * Claude uses natural language queries to search for tools using the
 * BM25 algorithm. The search is performed against tool names, descriptions,
 * argument names, and argument descriptions.
 * Requires the "advanced-tool-use-2025-11-20" beta header.
 *
 * @category Tool Search
 * @since 4.0.0
 */
export const ToolSearchBM25_20251119 = Tool.providerDefined({
  id: "anthropic.tool_search_tool_bm25_20251119",
  customName: "AnthropicToolSearchBM25",
  providerName: "tool_search_tool_bm25",
  parameters: ToolSearchBM25Parameters,
  success: Schema.Array(Generated.BetaRequestToolReferenceBlock),
  failure: Generated.BetaResponseToolSearchToolResultError
})
