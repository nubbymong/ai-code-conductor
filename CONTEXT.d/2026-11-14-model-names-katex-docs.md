## 2026-11-14 -- Model names, the katex override and stale stack versions (2.1.3-beta.3, item E)

One branch, three small things.

### Model names (planning #310)

The two cases the same day's matching change left open (`2026-11-14-model-match-longest-pattern.md`, "Not done here").

**A dated id read as the next version.** A name that is no entry's id or alias goes to the longest id it starts with. `claude-fable-5-20260101`, the dated id of Fable 5, starts with `claude-fable-5-2`, so it was shown as Fable 5.2. Tokenomics picks a price key the same way, so the turn was priced as Fable 5.2 as well. Now an id that ends in a digit is not the start of a name whose next character is a digit too: the number carries on, so it is another number. One helper, `nameStartsWithId` in `src/shared/model-registry.ts`, serves the matcher and both price-key lookups (`toPriceModel` in `src/main/tokenomics/tk-parse.ts`, `normalizeModelForPricing` in `src/main/tokenomics/tk-pricing.ts`), so the three hold one rule.

**A version written with a dot.** A gateway writes `anthropic/claude-opus-4.7`. The version patterns are written with a hyphen (`opus-4-7`), so none was found in such a name and it went to the entry with the family's plain pattern: Opus 4.7 was shown as Opus 5.5. The pattern step now reads the name two ways, as written and with each dot between two digits as a hyphen, and the reading that covers more counts. Each reading keeps the rule that a pattern which stops inside a version number does not count, so `claude-opus-4.75` and `claude-opus-4.7.1` are not Opus 4.7. A pattern that is itself written with a dot is still found in the name as written.

**What moves, against the bundled file.**

- The dated id of Fable 5 goes to Fable 5 (still an id-prefix match).
- An older model with a two-part version, written with a dot, goes to its own entry by pattern: with nothing around it (`claude-opus-4.7`, `claude-sonnet-4.5`) or behind a gateway's name (`anthropic/claude-opus-4.7`).
- `anthropic/claude-fable-5.2` and `anthropic/claude-fable-5.1` go to their own entries (they were Fable 5).
- No name changes family, nothing that was placed is unplaced, and a match by pattern is still reported as one, so the places that do not trust such a match for a label or an effort list behave as before.

**Kept.** `resources/model-registry.json` is not changed (a copy of it is published on the model-data branch). The rules `src/main/model-registry-data.ts` holds a fetched model file to are as they were; they ask the same matcher. A dated form of a shipped id is still refused as a new model's name by its own check, which never rested on where the matcher put the name.

**Not done here.**

- Turns Tokenomics has already stored keep the price key they were given when they were read. Only dated Fable 5 turns read since the Fable 5.2 entry was added (#663) carry the wrong key. Re-keying stored rows is a database change of its own.
- A 5.x model written with a dot and nothing around it (`claude-opus-5.5`, `claude-sonnet-5.5`, `claude-fable-5.2`) starts with the id of the base model (`claude-opus-5`), and the id-prefix step comes before the pattern step, so it is still read as the base model. Behind a gateway's name it is read correctly. Changing that means deciding what the id-prefix step does with a dot, which also decides how Tokenomics prices such a name.
- Tokenomics has no pattern step. A gateway's or a partner platform's name that starts with no price key has no price, as before.

**Tests.** `tests/unit/model-registry-resolve.test.ts`: a new group for the dated id (Fable 5, every model's dated id, Fable 5.2's own names, the rule on a small list) and for the dotted version (the names above, every model with a two-part version behind a gateway's name, versions that carry on, the two readings on a small list, names with a dot that were placed before). `tests/unit/tokenomics/tk-pricing.test.ts`: a dated Fable 5 turn on the path Tokenomics prices a turn on, a dated id of every priced model, and the lookup with no shorter key to take. 11 of the new cases failed before the change. `tests/unit/model-data-resolution-rule.test.ts` has the dotted form of every shipped model in its name list; it and `tests/unit/model-data-schema.test.ts` pass, with four titles and two comments reworded where they said the matcher put the dated id of Fable 5 on Fable 5.2.

### katex override

mermaid pins katex `^0.16.45`, which has a public low-severity advisory; the patched line is 0.18. `package.json` now overrides `katex` to `^0.18.2`, and the lockfile resolves 0.18.10 (0.18.11 is marked deprecated upstream). This closes the item the beta.2 dependency note left for the next beta.

- Where it is used: the app source names neither katex nor mermaid. The only path is the Agent Canvas drawing library, whose Mermaid import loads mermaid, which loads katex only when a diagram's text holds a `$$...$$` span.
- What mermaid asks of it: one call, `renderToString`, with MathML output. Checked side by side with 0.16.45: the MathML output is the same, and the `katex` class mermaid's one style rule names is still there. The 0.18 line renamed some inner HTML classes, which the app does not style.
- katex 0.18 depends on a newer `commander` for its own command-line file, which nothing here runs. It asks for a newer Node than CI uses, so an install may print an engine warning; nothing fails on it.

### Stale stack versions in the agent briefs

`AGENTS.md` said Electron 42 and `.github/copilot-instructions.md` said Electron 43 and 33, React 18 and xterm.js 5.5. Both now say what `package.json` has: Electron 44, React 19, xterm.js 6.
