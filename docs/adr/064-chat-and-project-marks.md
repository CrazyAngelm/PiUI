# ADR-064 — Chat and project marks, and a chat menu in the sidebar

Status: accepted, 2026-11-16.

## Context

Projects had a three-dots menu in the sidebar; chats did not. Renaming and
deleting a chat meant opening it first. A long list of similar projects and chats
also had nothing to tell them apart except their titles.

## Decision

- **Chat menu.** Each sidebar chat row gets an options menu (shown on hover and
  keyboard focus, never inside the row's own button): Rename, Mark, and Delete
  chat. Delete follows the chat header's rules: absent for a pipeline-run member,
  a Fusion sidekick in use and a remote browser; disabled while the chat runs or
  in safe mode. It opens the same confirmation as the header menu. Rename opens a
  small dialog and calls the existing rename command. Renaming a chat that is
  not running changes only its PiUI record and refreshes its displayed title;
  it does not start a harness or change native history files.
- **Marks.** A project or a chat can carry one mark: an emoji, or a shape
  (circle, square, diamond, triangle, star, hexagon) in one of nine colors. The
  mark replaces a project's folder icon and precedes a chat's title in the
  sidebar and in the chat header. It is decorative and has no caption. Colors are
  tokens (`--piui-mark-*`) defined for dark and light.
- **Storage.** Marks are local UI metadata in `localStorage` under
  `piui.marks.v1` (`{ projects, sessions }` keyed by id). Reads validate every
  entry and drop what is malformed. Deleting a chat or removing a project forgets
  its mark; a catalog that merely failed to load prunes nothing.
- **Cost.** The picker and the rename dialog load on first use. The first screen
  gains only the mark store, a mark renderer and the menu wiring.

## Consequences

- Marks are per device and are lost with the WebView profile. They are never sent
  to a harness, the host, Nano or an exported system file, and they do not change
  any native history.
- A mark follows the chat or project id; a recreated project (added again after
  removal) starts without one.
- No host, IPC or contract change.
