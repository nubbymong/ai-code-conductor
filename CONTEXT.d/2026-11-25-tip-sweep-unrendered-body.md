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
section must be on the page, with the summary the data gives it and every
highlight in its list, each with text and none with a mark; one line per
problem. A section with no card in the data is a line too.

Both sweeps are helper functions with stand-in tests: a tip with no body element,
a tip with a blank body, a card the page does not draw beside one it does, a
section the page is not showing, an empty section, a shorter list, a missing
summary, an item with no text, a mark left as text. The stand-ins are red against
the old sweep logic (each failed with the old read put back) and green with the
new. No product change; users see nothing.
