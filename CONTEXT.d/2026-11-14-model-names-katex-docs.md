## 2026-11-14 -- Model names, the katex override and stale stack versions (2.1.3-beta.3, item E)

One branch, three small things.

### Model names (planning #310)

The cases the same day's matching change left open (`2026-11-14-model-match-longest-pattern.md`, "Not done here"). All three are one mistake: a name went to another version's entry.

**A dated id read as the next version.** A name that is no entry's id or alias goes to the longest id it starts with. `claude-fable-5-20260101`, the dated id of Fable 5, starts with `claude-fable-5-2`, so it was shown as Fable 5.2. Tokenomics picks a price key the same way, so the turn was priced as Fable 5.2 as well. Now an id that ends in a digit is not the start of a name whose next character is a digit too: the number carries on, so it is another number.

**A version written with a dot, behind a gateway's name.** A gateway writes `anthropic/claude-opus-4.7`. The version patterns are written with a hyphen (`opus-4-7`), so none was found in such a name and it went to the entry with the family's plain pattern: Opus 4.7 was shown as Opus 5.5. The pattern step now reads the name two ways, as written and with each dot between two digits as a hyphen, and the reading that covers more counts. Each reading keeps the rule that a pattern which stops inside a version number does not count, so `anthropic/claude-opus-4.75` and `anthropic/claude-opus-4.7.1` are not Opus 4.7. A pattern that is itself written with a dot is still found in the name as written.

**A version written with a dot, with nothing around it.** The id step comes before the pattern step, and it read the name only as written. `claude-opus-5.5` as written starts with `claude-opus-5` and no longer id (a dot follows, not a digit), so it was Opus 5, by a match the app trusts for a label, a price and an effort list. `claude-sonnet-5.5`, `claude-fable-5.2` and `claude-fable-5.1` went to their base models the same way. The id step now reads the name the same two ways. The longest id of either reading takes the name; of two as long, the one the name as written starts with. So a name written with a dot goes where the same name written with a hyphen goes.

One helper, `longestIdNameStartsWith` in `src/shared/model-registry.ts`, holds both id rules (where an id ends, and the dot). It serves the matcher and both price-key lookups (`toPriceModel` in `src/main/tokenomics/tk-parse.ts`, `normalizeModelForPricing` in `src/main/tokenomics/tk-pricing.ts`), so the three cannot disagree.

**What moves, against the bundled file.**

- The dated id of Fable 5 goes to Fable 5 (still a match by id).
- A model with a two-part version, written with a dot and nothing around it, goes to its own entry by its id, with or without a date or `[1m]` after it. `claude-opus-5.5`, `claude-sonnet-5.5`, `claude-fable-5.2` and `claude-fable-5.1` were read as their base models. The older ones (`claude-opus-4.7`, `claude-sonnet-4.5`) were already their own entry, by a pattern; they are now a match by id, which the app trusts as it trusts a dated id (the label, the effort list, the row the picker marks).
- Behind a gateway's name (`anthropic/claude-opus-4.7`, `anthropic/claude-fable-5.2`) such a model goes to its own entry by a pattern, and is still reported as a match by pattern.
- In Tokenomics a model written with a dot and nothing around it takes its own price key. The 5.x names took their base model's key (Opus 5.5 was priced as Opus 5, Fable 5.2 as Fable 5). The older ones started with no key and had no price.
- A three-part version with nothing around it (`claude-opus-4.7.1`) goes to the two-part model it starts with, Opus 4.7, as `claude-opus-4-7-1` always has. Behind a gateway's name it still goes to the family's plain pattern.
- No name changes family, and nothing that was placed is unplaced.

**Kept.**

- `resources/model-registry.json` is not changed (a copy of it is published on the model-data branch).
- The exact-id and alias steps take the name as written. An id is compared as it is written, so an id with a dot in it (the Codex ids `gpt-5.5`, `gpt-5.2`, `gpt-5.6-sol`) is found in the name as written, as before. A hyphen is never read as a dot. A dot that is not between two digits (`claude-opus-5.x`) is not read as a hyphen.
- No entry lists a Claude 3 model, so `claude-3.5-sonnet` and `claude-3-5-sonnet-20241022` still go to their family's plain pattern. In Tokenomics such a name has a price only when the fetched price list has a key for it, as before.
- The rules `src/main/model-registry-data.ts` holds a fetched model file to are as they were; they ask the same matcher. A dated form of a shipped id is still refused as a new model's name by its own check, which never rested on where the matcher put the name.

**Not done here.**

- Turns Tokenomics has already stored keep the price key they were given when they were read, and a daily, hourly or per-session total keeps the key of the first turn it counted. So a dated Fable 5 turn read by a build that had the Fable 5.2 entry (#663) and not this change is still priced as Fable 5.2, and so are later turns of that model counted into the same totals. The Codex re-key at every open (`src/main/tokenomics/tk-db.ts`) is not a pattern for this: a Codex key is the model's own name, which the database can work out alone. A Claude key depends on the price list, which the database does not have when it opens and which changes when the fetched prices arrive, so "the key this model would take now" would move rows back and forth between a built-in key and a fetched one. It needs its own design: which list a stored key is held to, and whether a total should keep a key at all.
- Tokenomics has no pattern step. A gateway's or a partner platform's name that starts with no price key has no price, as before.

**Tests.** `tests/unit/model-registry-resolve.test.ts`: a group for the dated id (Fable 5, every model's dated id, Fable 5.2's own names, the rule on a small list), for the dotted version behind a gateway's name (every model with a two-part version, versions that carry on, the two readings of the pattern step on a small list, names with a dot that were placed before) and for the dotted version with nothing around it (the four 5.x names, every model with a two-part version, the two readings of the id step on a small list, an id with a dot, the tie, the exact-id and alias steps, a dot not between two digits, Claude 3 names and the Codex ids). `tests/unit/tokenomics/tk-pricing.test.ts`: a dated Fable 5 turn on the path Tokenomics prices a turn on, a dated id of every priced model, the lookup with no shorter key to take, and the same for a model written with a dot. 11 of the new cases failed before the first change and 9 before the second; three mutations of the helper (a tie given to the other reading, the second reading without the digit rule, the second reading alone) each fail them. `tests/unit/model-data-resolution-rule.test.ts` has the dotted form of every shipped model in its name list; it and `tests/unit/model-data-schema.test.ts` pass, with four titles and two comments reworded where they said the matcher put the dated id of Fable 5 on Fable 5.2.

### katex override

mermaid pins katex `^0.16.45`, which has a public low-severity advisory; the patched line is 0.18. `package.json` now overrides `katex` to `^0.18.2`, and the lockfile resolves 0.18.10 (0.18.11 is marked deprecated upstream). This closes the item the beta.2 dependency note left for the next beta.

- Where it is used: the app source names neither katex nor mermaid. The only path is the Agent Canvas drawing library, whose Mermaid import loads mermaid, which loads katex only when a diagram's text holds a `$$...$$` span.
- What mermaid asks of it: one call, `renderToString`, with MathML output. Checked side by side with 0.16.45: the MathML output is the same, and the `katex` class mermaid's one style rule names is still there. The 0.18 line renamed some inner HTML classes, which the app does not style.
- katex 0.18 depends on a newer `commander` for its own command-line file, which nothing here runs. It asks for a newer Node than CI uses, so an install may print an engine warning; nothing fails on it.

### Stale stack versions in the agent briefs

`AGENTS.md` said Electron 42 and `.github/copilot-instructions.md` said Electron 43 and 33, React 18 and xterm.js 5.5. Both now say what `package.json` has: Electron 44, React 19, xterm.js 6.
