# ADR-075 — Chat feed Markdown, streaming, links and reading position

Status: accepted, 2026-11-18. Amends ADR-073 (what folds) and ADR-067 (the `hermes-ui` fence shape).

## Context

The review of the feed found that the hand-written Markdown grammar broke on
ordinary answers (nested lists, list-item continuation, long fences, tables
followed by a heading, escapes, entities, code spans over a line break, bare
links), that a streaming answer re-read all its text on every update, that a
half-typed `**` flashed as italics, that links were inert, that a pending steer
could end the visible turn, and that the page lost the reader's place.

## Decision

- **Parser.** `marked` 18.0.3 replaces the regex grammar, used for its token
  stream only: its HTML output is never used. Tokens are converted to the
  existing node types (`components/markdown.ts`), so the DOM is still built by
  Svelte and nothing is inserted as HTML. Raw HTML in a message is shown as
  escaped text (only `<br>` is a line break). Character references use an own
  small decoder, because a general one would need a DOM. Math (`$..$`, `$$..$$`,
  `\(..\)`, `\[..\]`) is an inline extension that keeps a formula opaque to
  emphasis; without the rich owner it is shown as typed. A completed formula
  is typeset by KaTeX on first use (`formula.ts`, ADR-077) and keeps its TeX
  source as the fallback; the unfinished end of a streaming text stays source
  until it is complete. An image is a link to the picture unless the owner is
  rich.
- **Cost guard.** marked's inline lexer is quadratic on some delimiter-dense
  text. A paragraph longer than 2 KB that is mostly delimiters and over a cost
  limit is shown as plain text. A lexer error shows the message as typed.
- **Streaming.** One parser per message keeps the parsed blocks that cannot
  change and parses only the tail again, so a long answer is not O(n^2). A list
  or quote at the end stays open, because a later indented line can join it.
  A link reference definition turns the parser to whole-text mode. An open
  fence shows as code and a closing fence being typed is not code. A run of
  `*`, `_` or `~` at the very end of the text waits for its next character.
  Blocks keep stable keys (`block:N`, `widget:N`), so a widget keeps its DOM.
- **Links.** Only the host opens addresses. The transcript takes an
  `onOpenLink(url) => Promise<boolean>` and passes it through the conversation
  presentation context. An `http(s)` link is a focusable `role="link"`. When
  there is no opener, or it refuses, the address is copied and a toast says so.
  Other destinations (relative paths, `file:`, `javascript:`) are shown as code
  with a copy action and never opened. The host side is "Opening links" below.
- **Opening links.** The page cannot open an address by itself. The host command
  `chat_open_link_v1 { url }` (`contracts/chat-link-v1.ts`, `chat_link.rs`) parses
  the address again, accepts only `http` and `https` with a host, no user name or
  password, at most 2048 bytes and no whitespace or control character, and refuses
  safe mode. It then asks the person in a native dialog ("Open this link in your
  browser?", Yes and No) that shows the exact address the browser would receive,
  with an international host name in its ASCII form. Only Yes opens it, through the
  launcher Nano's own links use (`ShellExecuteW`, `open`, `xdg-open`, never a
  shell string). The dialog is the host's and not WebView content, so a page
  cannot answer it or open anything silently. One dialog is open at a time and the
  address is never logged. No answers `opened: false` and nothing is copied. When
  the host cannot ask (safe mode, a refused address, a dialog already open, no
  browser) the address is copied and a toast says so. Intelligent UI link nodes
  use the same route (ADR-077). The Lab validates the same way and shows a toast
  "Would open <site>" instead of a dialog. The remote viewer has no route.
- **Service data.** `serviceJson` classifies by protocol origin only (an
  assistant-kind block with a tool name), never by what the text looks like. The
  Codex memory citation (`<oai-mem-citation>...`) is removed where an answer is
  shown or copied, never inside a fence, and the history is left as the harness
  wrote it.
- **Folding (amends ADR-073).** A pending steer (a user block still `streaming`)
  joins the running turn and never ends it or makes a note the final answer;
  trailing pending steers are shown after the folded turn. Completed empty
  reasoning is left out of grouping (a failed or interrupted one stays). A reply
  inside the fold uses the same body as the chat: a shortened notice and a
  "Show full answer" action. A failed or interrupted compaction says so and
  shows its summary.
- **Reading position.** An active text selection pauses automatic scrolling
  until the reader returns to the end. The saved position is a row id and an
  offset inside it, and restoring reveals the page that holds that row. A
  running tool's output box follows its own end unless the reader scrolled it.

## Consequences

- `marked` is a dependency (a lockfile update is needed).
- A `hermes-ui` fence opened with a tab is indented code under CommonMark and
  is no longer an interface; spaces (up to three) still work.
- An unclosed `\(` shows as `(`, a plain CommonMark escape, until its closing
  mark arrives.
- A table pipe inside a code span splits the cell unless written `\|`, as in
  GFM.
- Follow, selection and reading-anchor behaviour needs a real DOM; unit tests
  cover the parser, grouping and helpers, and the Lab and native checks cover
  the rest.
