# VSM-1: Pin sessions to the top of the list

> Written by Hammerkop from the card (http://localhost:4310/c/VSM-1/pin-sessions-to-the-top-of-the-list). Edit the card there, not this file: Hammerkop writes it again whenever the card changes.

- Branch: `card/vsm-1-pin-sessions-to-the-top-of-the-list`

## Description

> **In short:** Pinned sessions stay at the top of the list.

Let the user pin sessions so they stay at the top of the Sessions list. A pin is a per-session flag the user sets and clears; nothing removes it automatically, and it survives restarts. It is stored in the app's state.json next to `hidden`, following the same path as Hide: SeenStore (src/core/persist.ts) → SessionStore (src/core/store.ts) → IPC `set-pinned` (src/main/index.ts, src/preload/index.ts, src/shared/api.ts) → `pinned: boolean` on SessionView (src/shared/types.ts). Flat view: pinned sessions come first, newest activity first, then the rest as today. Grouped view: a 'Pinned' section comes above all the repo groups. Pinned sessions appear only there, not again in their repo's group. Pinned sessions always stay in the list whatever time range is selected, but every other filter still applies (colour, Open only, repo, label, hidden, search). Pinning does not affect the traffic light, the tray badge, the counts or the notifications. In the UI there is a Pin/Unpin button in the detail panel, a Ctrl+P shortcut for the selected row, and a pin icon on pinned rows. Update docs/SPEC.md (new section 3.10 plus a row in the 3.3.1 shortcut table) and docs/USAGE.md.

## Acceptance criteria

1. SeenStore: after `setPinned('a', true)`, `isPinned('a')` is true and `isPinned('b')` is false. After `setPinned('a', false)`, `isPinned('a')` is false.
2. SeenStore: after `setPinned('a', true)` and `flush()`, state.json contains a `pinned` object with key 'a', and a new SeenStore on the same data dir returns `isPinned('a') === true`. The existing `seen`, `unread` and `hidden` keys are still written unchanged.
3. SeenStore: a state.json without a `pinned` key, or with a `pinned` value that is not an object, loads without error and `isPinned` returns false for every id.
4. SessionStore: after `setPinned(id, true)`, `snapshot()` returns that session with `pinned: true`. After `setPinned(id, false)` it returns `pinned: false`. Sessions that were never pinned, Claude, Codex and Cowork alike, have `pinned: false`.
5. SessionStore: pinning a session does not change its `light`, does not change `snapshot().counts`, and does not change whether or where it appears in `urgent()`.
6. visibleSessions: given unpinned A (lastActivity 300), pinned B (100) and pinned C (200), with no filters and range 'all', the result order is C, B, A.
7. visibleSessions: with range 'today', a pinned grey session with no labels whose lastActivity is before today is included, and the same session unpinned is excluded.
8. visibleSessions: a pinned session is still excluded by each of these on its own: a lights filter that doesn't include its light; liveOnly when its status is 'closed'; a repos filter without its repoKey; a label filter it doesn't have; hidden=true while showHidden is false; and search hits that don't include its id.
9. Grouped view: when at least one visible session is pinned, the groups start with one group with key '__pinned' and label 'Pinned' holding exactly the pinned sessions, newest activity first. The repo groups follow in name order and contain no pinned sessions.
10. Grouped view: when no visible session is pinned, there is no 'Pinned' group and the output equals today's grouping. A repo whose sessions are all pinned gets no repo group.
11. displayOrder(sorted, true) and flattenGroups of the grouped output list the Pinned group's sessions first, so ↑/↓ and Ctrl+1…9 follow the on-screen order. displayOrder(sorted, false) returns the flat order, pinned first.
12. In the Pinned section of the grouped view, each row shows its repo name in the sub-line, as in the flat list, because the section heading isn't a repo.
13. The detail panel shows a 'Pin' button for an unpinned session and 'Unpin' for a pinned one. Clicking it calls `api.setPinned(id, !pinned)`.
14. Ctrl+P (Cmd+P on macOS) on the Sessions tab toggles the pin of the selected session and calls preventDefault. With no session selected it does nothing. On the other tabs it does nothing.
15. A pinned row shows a pin icon with the title 'Pinned'. An unpinned row shows no pin icon.

## Checklist

- [x] Add `pinned: boolean` to SessionView in src/shared/types.ts and default it to false wherever views are built (src/core/model.ts and any Codex/Cowork view builders).
- [x] SeenStore (src/core/persist.ts): load a `pinned` record from state.json, tolerating a missing or invalid value; add `isPinned(id)` and `setPinned(id, pinned, at = Date.now())`; include `pinned` in flush().
- [x] SessionStore (src/core/store.ts): set `view.pinned = this.seen.isPinned(id)` where `view.hidden` is set, and add `setPinned(id, pinned)` that updates SeenStore and calls rebuild like setHidden does.
- [x] IPC: add a `set-pinned` handler in src/main/index.ts, `setPinned(id, pinned)` in src/preload/index.ts and the `setPinned(id: string, pinned: boolean): Promise<void>` type in src/shared/api.ts.
- [x] src/renderer/src/view.ts: in visibleSessions, let pinned sessions pass the time range and sort pinned first, then lastActivity descending. In groupSessions, put pinned sessions in a leading `{ key: '__pinned', label: 'Pinned' }` group, only when there are any, and leave them out of the repo groups. Update the doc comments.
- [x] Renderer UI: add the Pin/Unpin button to Detail (src/renderer/src/components.tsx) next to Hide, wired through an `onPin` prop on SessionRow; add the pin icon on pinned rows; show the repo on rows in the Pinned section (pass `grouped=false` for that group in App.tsx); add the Ctrl+P handler in App.tsx's onKeyDown; add any small CSS needed in styles.css.
- [x] Tests: SeenStore persistence and tolerance in test/core/persist.test.ts; SessionStore pinned flag, counts and urgent() unchanged in test/core/store.test.ts; ordering, time-range bypass, the other filters, the Pinned group and displayOrder in test/ui/view.test.ts. Each acceptance criterion that can be tested at these levels gets its own test.
- [x] Docs: add section 3.10 'Pinned sessions' to docs/SPEC.md, add Ctrl+P to the 3.3.1 shortcut table, describe pinning in docs/USAGE.md, and add a CHANGELOG.md entry under Unreleased.
