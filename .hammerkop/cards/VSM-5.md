# VSM-5: Work Tab. Show action buttons on click

> Written by Hammerkop from the card (http://localhost:4310/c/VSM-5/work-tab-show-action-buttons-on-click). Edit the card there, not this file: Hammerkop writes it again whenever the card changes.

- Branch: `card/vsm-5-work-tab-show-action-buttons-on-click`

## Description

On the Work tab, each row in the 'Work in progress' list hides its action buttons until the row is clicked, the way Sessions rows show their details. A single click on a row shows its buttons (Open, Commit work, Push, Create PR / Open PR, Merge into, Clean up, Log) and a second click hides them. Only one row is open at a time. Double-click still opens the row in the editor and does not change which row is open. The row under the mouse gets the Sessions selected highlight (`--bg-selected`) and keeps it until the mouse moves to another row; the open row keeps it too. The action buttons in the Output panel that appears after a run stay as they are, always shown. Arrow-key navigation is out of scope. Code: src/renderer/src/work.tsx (rows at about lines 509-541, `actions()` at line 255) and src/renderer/src/styles.css (`.work-item` at about line 1845). The Sessions pattern to copy is `SessionRow` in src/renderer/src/App.tsx:503-577.

## Acceptance criteria

1. When the Work tab loads with worktree rows, no row in the 'Work in progress' list shows any action button (no 'Open', 'Commit work', 'Push', 'Create PR', 'Merge into', 'Clean up' or 'Log' button inside a `.work-item`).
2. A single click (click event with detail 1) on a row shows that row's action buttons, exactly the set the row would show today for its state (for example, an 'uncommitted' worktree row shows Open, Commit work, Clean up and Log).
3. A second single click on the open row hides its action buttons again.
4. With row A open, a single click on row B hides A's buttons and shows B's, so at most one row shows action buttons at any time.
5. Clicking any action button inside an open row (for example 'Log', or the merge arrow that opens the branch menu) runs that button's action and does not close the row. Clicking inside the branch menu does not close the row either.
6. Double-clicking a row that is not orphaned calls `api.openWork(key)` once, and afterwards the row's buttons are open or closed just as they were before the double-click (the double-click's first click does not toggle them).
7. Double-clicking an orphaned row does not call `api.openWork`, which is the current behaviour. A single click on an orphaned row still shows its buttons (Clean up, Log).
8. Double-clicking an action button inside an open row (including on the svg inside the merge-arrow button) does not call `api.openWork` and does not toggle the row.
9. Moving the mouse over a row gives it the class `selected`. No other row has `selected` from hovering, and the row keeps it until the mouse moves over another row.
10. The open row has the class `selected` even when the mouse is over another row (the hovered row has it too).
11. In styles.css, `.work-item.selected` uses `background: var(--bg-selected)`, and the old `.work-item:hover { background: var(--bg-hover) }` rule is removed. Rows show the pointer cursor.
12. A row stays open after the list is read again (the 20-second refresh, window focus, or `onWorkChanged`), as long as a row with the same key is still there.
13. When a row closes, a merge menu that was open for it is closed too: after the row is opened again, the branch menu is not shown until the merge arrow is clicked again.
14. Each row's tooltip (`title`) is the worktree path, then a newline, then 'Click: actions · Double-click: open in the editor'. On orphaned rows it is the path, then a newline, then 'Click: actions'.
15. After a successful run, the action buttons in the Output panel (`.work-run` header) are shown without any click, as they are today.
16. docs/USAGE.md (the 'The buttons on a worktree' section) says that clicking a row shows its buttons and double-clicking opens it, and CHANGELOG.md has an entry under [Unreleased] for this change.

## Checklist

- [x] Add `jsdom` and `@testing-library/react` as devDependencies. Leave the vitest config's default environment as `node`; the new test file opts in with a `// @vitest-environment jsdom` comment at its top.
- [x] In work.tsx `WorkView`, add `openKey` (the open row) and `hoverKey` (the row under the mouse) state, both `string | null`.
- [x] On each `.work-item` row, add an `onClick` that toggles `openKey` only when `e.detail === 1`. Change `onDoubleClick` to undo the first click's toggle and then open the row in the editor if it is not orphaned, copying `SessionRow` in App.tsx. Add `onMouseMove` that sets `hoverKey` when the row is not already the hovered row.
- [x] Render `actions(i, true)` in the row only when `openKey === i.key`. On the `.work-actions` container, stop propagation of click and double-click events (or check this in the row handlers) so that buttons and the branch menu neither toggle nor open the row. When a row closes, or another row opens, set `mergeMenu` to null if it belongs to the row that closed.
- [x] Give the row the class `selected` when `i.key === hoverKey || i.key === openKey`. Set its title to the path plus the click and double-click hint, with 'Click: actions' only on orphaned rows.
- [x] In styles.css, replace `.work-item:hover` with `.work-item.selected { background: var(--bg-selected) }` and add `cursor: pointer` to `.work-item`.
- [x] Write test/ui/work.test.tsx using jsdom and Testing Library. Before dynamically importing work.tsx, stub `window.api`, because the module reads `window.api` when it loads: `getWork` resolves to a `WorkOverview` fixture with at least an uncommitted row, an orphaned row and a pending-merge row whose repo has two or more other branches; `onWorkRun` and `onWorkChanged` return no-op unsubscribe functions; `openWork` is a spy resolving `{ ok: true }`. Cover every acceptance criterion: fire click events with `detail: 1` and `detail: 2` plus dblclick to simulate a double-click, mouseMove for hover, and for the refresh criterion re-trigger `load` by calling the callback registered through `onWorkChanged`.
- [x] Update docs/USAGE.md (the 'The buttons on a worktree' section and the **Open** bullet) and add an [Unreleased] entry to CHANGELOG.md.
- [x] Run `npm test` and the typecheck/lint scripts in package.json, and fix anything that fails.
