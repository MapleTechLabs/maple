# S7: Overlay primitives on the Foldkit kit

Status: **passed** · 2026-10-17 · Phase 1b, from `fk/parity-harness`

`/lab/kit/overlays` and every `?item=` page (`apps/web-foldkit/src/lab/entries/kit/overlays.ts`)
against legacy-head, light and dark: **34/34 identical**, 0 strict px, 0 behavior and 0 a11y deltas
(index, dialog, alert-dialog, sheet, popover, hover-card, context-menu, select, combobox,
autocomplete, command, six toast types). Tooltip and dropdown-menu came later with the app shell
(`3c61850617`) on the same positioning and portal code: see below.
Scene tests for each overlay (46 tests); a Playwright smoke of the built page (focus trap and
return, Escape, outside press, fast arrow keys, typing) passes with no console errors.

## Design (`apps/web-foldkit/src/ui/`)

- **Base UI's DOM, not @foldkit/ui's.** @foldkit/ui Dialog/Popover/Anchor render a native
  `<dialog>`, a prepended `foldkit-portal-root`, `data-placement` and inline visibility. The kit is
  `h` plus one Mount per overlay; only `@foldkit/ui/animation` is reused, mapped to Base UI's
  `data-starting-style` / `data-ending-style` / `data-open` / `data-closed` (`overlay/transition.ts`).
- **Portals.** The portal root renders in place and its Mount appends it to `<body>`; snabbdom
  keeps patching the moved element. Submodel views return one node, so overlays take a
  `toView(parts)` callback: the parent places trigger, guards, hidden input and portal as siblings.
- **Positioning** (`overlay/position.ts`): Base UI's `useAnchorPositioning` on `@floating-ui/dom`
  (new direct dependency, 1.8.0, already in the lockfile through @foldkit/ui): the shift/flip order
  for centred popups, the flip padding bias, `size()` variables, a detached arrow for
  `--transform-origin`, DPR-rounded `translate` or raw `top`/`left` (Popover's adaptive origin).
  Context menus anchor a point, `fixed`, cross-axis shift. Select's `alignItemWithTrigger` is
  ported from `SelectPopup.mjs` (`overlay/select-align.ts`), to the transform-origin decimal.
- **`markOthers`** (`overlay/portal.ts`) is ported, not approximated: the inert marker outside the
  popup, `aria-hidden` outside popup + kept field + live regions. A combobox keeps its field, so
  Base UI hides the header and sibling sections, not `#app`.
- **Toasts**: one `Toast` Submodel in the root Model (`model.toasts`), both Notifications regions
  rendered in `#app` and portaled; heights measured like `recalculateHeight` (ResizeObserver Mount).
- Keys go to `update` with the entries (`PressedMenuKey`, `PressedListKey`, `PressedInputKey`);
  `update` picks the next index from the current Model and a focus Command follows.

## Tooltip and dropdown menu (app shell)

- **Tooltip** (`ui/tooltip.ts`): Base UI's open delay and shared triggers, anchored through
  `overlay/position.ts`; scene tests in `tooltip.scene.test.ts`.
- **Dropdown menu** (`ui/menu.ts`, `ui/menu-view.ts`, parts in `ui/dropdown-menu.ts`): one Base UI
  Menu Submodel with checkbox and radio items and a keyboard submenu; `menu.scene.test.ts`. The
  shell's org, user and help menus (`src/shell/menus.ts`) run on it.
- Navigation menu and resizable panel groups landed in the same commit, on the same primitives.

## Gotchas

| Gotcha                                                                                                                                  | Fix                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| A merged text node (`Toast type: default, ...`) shapes differently from React's three nodes for `{type}`: 13 strict px                  | Pass the literals and the value as separate children                           |
| The positioned page and its overlay both mount in one render; marking ran before the toast portals left `#app`, hiding the live regions | Wait a task; portals still in the page are neither marked nor kept             |
| Base UI injects `.base-ui-disable-scrollbar` as a `<style>` element                                                                     | Rule added to `src/styles.css`                                                 |
| `OnContextMenu` carries no coordinates                                                                                                  | `OnPointerDown` records the point first                                        |
| A view key handler closes over the last render: two keys in one frame reused a stale highlight or filter                                | Messages carry the entries; `update` computes against the current Model        |
| `OnKeyDownFocus` calls `document.querySelector`, which throws in Scene's node environment                                               | Focus through a Command after `update` (also fixes the point above)            |
| `CSS.escape` is a DOM global; views that call it fail in Scene                                                                          | Only in Mounts and Commands; ids are generated and safe                        |
| Scene dispatches keydown on the target only (no bubbling), and its selectors need quoted values (`[data-slot="x"]`)                     | Key handlers on the element that has focus or its popup; quote selectors       |
| Scene step arrays with Mount steps cannot be reused across scenes                                                                       | Build them with a function per scene                                           |
| Commands lifted with `Command.mapMessage` (exit transitions)                                                                            | `Command.resolve` takes the inner (Animation) Message                          |
| A Mount stream's later events (outside press, flip)                                                                                     | `Mount.resolve(Def, Message.PressedOutside())` feeds one as the Mount's result |
| oxlint `vitest(expect-expect)` sees no assertion when Scene `expect` steps are only in spread arrays                                    | One inline `expect(...)` per test                                              |

## Deferred

- ScrollArea overflow: variables stay 0 and scrollbars are not rendered (static content fits).
- Nested dialogs (`--nested-dialogs` is 0), modal Popover, popover arrows, anchored toasts (the
  region exists, no positioner), toast swipe and limit animation, Select scroll arrows and
  typeahead, combobox groups and async items, touch long-press context menus.
- Toast regions in the other lab entries (charts, logs, data-probe, bench): their Models need a
  `toasts` field; `ToastView.regions(h, model.toasts, toParent)` is the whole view side.
