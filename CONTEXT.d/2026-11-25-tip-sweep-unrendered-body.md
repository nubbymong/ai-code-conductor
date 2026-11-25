## 2026-11-25 -- test(tips): the tip and Feature Guide sweeps fail a body that did not render (#426)

The beta.17 hand round added two sweeps that read text off the screen and
check it for bold or code marks left as text:
`tests/unit/renderer/tip-card-e5.test.tsx` (every tip body) and
`tests/unit/renderer/feature-guide-summary-rich.test.tsx` (every card's
summary and highlights). Both could pass when nothing rendered. The tip sweep
read a missing body element as an empty string, which holds no mark. The guide
sweep checked whatever summary and highlights elements it found, so a section
that drew no cards, or a card that drew no summary or list, was never looked at.

Tip sweep: each tip text must put a `tip-card-body` element on screen, with text
in it, before the mark check; a miss is one line naming the tip, the variant and
the field. The sweep also counts the texts it sent through the card, and an empty
count fails. Guide sweep: it now runs from the data. Each card the data puts in a
section must be on the page, with a summary element when the data gives it a
summary and one list item per highlight the data gives it, each with text and
none with a mark; one line per problem. A section with no card in the data is a
line too. The sweep runs three times: with both assistants, with Claude Code
alone and with Codex alone, each time over the cards the page takes for that
choice (`stepsForAssistants`), so the Codex-only copy the guide draws is read
too (five cards: Session Configuration, Ask Conductor, Conductor MCP, Cloud
Agents and Tips & Shortcuts; the Settings card's Codex-only copy changes only its bullets, which the
guide does not draw beside its highlights). The sections come from
`SECTION_LABELS`, not a list typed into the test. A bold code mark put into the
Tips card's Codex-only highlights fails the three-choice sweep (one line, on the
Codex choice) and passed the old both-only sweep.

Both sweeps are helper functions with stand-in tests: a tip with no body element,
a tip with a blank body, a card the page does not draw beside one it does, a
section the page is not showing, an empty section, a shorter list, a missing
summary, an item with no text, a mark left as text. The stand-ins are red against
the old sweep logic (each failed with the old read put back) and green with the
new. No product change; users see nothing.
