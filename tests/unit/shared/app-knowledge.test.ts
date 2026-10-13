/**
 * The rules `app-knowledge.ts` states about itself, enforced.
 *
 * This file is the SINGLE SOURCE for two user-facing surfaces: the in-app
 * Feature Guide, and the documentation folder the Ask Conductor session is
 * launched in. So its contents are read by users and pasted into a Claude
 * session's context, and its header lays down rules accordingly: user
 * documentation only, no internal paths, no build secrets, no architecture
 * internals, no em dashes. None of that was checked by anything.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { APP_KNOWLEDGE_SECTIONS } from '../../../src/shared/app-knowledge'
import { TIPS_LIBRARY } from '../../../src/renderer/tips-library'
import { trainingSteps } from '../../../src/renderer/training-steps'
import { changelog } from '../../../src/renderer/changelog'
import { CODEX_CONDUCTOR_TOOLS } from '../../../src/main/providers/codex/conductor-tools'
import { codexModelOptions } from '../../../src/renderer/codex-models'
import type { ModelRegistry } from '../../../src/shared/model-registry'
import registryJson from '../../../resources/model-registry.json'

describe('app knowledge is publishable', () => {
  it('has unique, stable-looking ids and a title and body for every section', () => {
    const ids = APP_KNOWLEDGE_SECTIONS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of APP_KNOWLEDGE_SECTIONS) {
      expect(s.id, `${s.id} id shape`).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(s.title.trim().length, `${s.id} has a title`).toBeGreaterThan(0)
      expect(s.body.trim().length, `${s.id} has a body`).toBeGreaterThan(80)
    }
  })

  it('uses no em dashes', () => {
    // The file's own rule. They read badly in the terminal-rendered Feature
    // Guide and this text is public-facing.
    for (const s of APP_KNOWLEDGE_SECTIONS) {
      expect(`${s.title} ${s.body}`, `${s.id} em dash`).not.toMatch(/—/)
    }
  })

  it('leaks no absolute or personal paths', () => {
    // A Windows drive path, a POSIX absolute path or a home reference here
    // would be one developer's machine, shipped to every user and pasted into
    // an agent's context.
    //
    // Checked by SEGMENT as well as by separator, because a Windows path
    // pasted into a JS string loses its backslashes to escape processing:
    // 'C:\Users\you' is the four characters C, :, U... at runtime. Matching
    // only on a separator misses exactly the mistake someone would make.
    for (const s of APP_KNOWLEDGE_SECTIONS) {
      const text = `${s.title} ${s.body}`
      expect(text, `${s.id} drive path`).not.toMatch(/[A-Za-z]:[\\/]/)
      expect(text, `${s.id} mangled drive path`).not.toMatch(/\b[A-Za-z]:[\\/]?(Users|home|Documents)/i)
      expect(text, `${s.id} home path`).not.toMatch(/(^|\s)~[\\/]/)
      expect(text, `${s.id} users path`).not.toMatch(/[\\/](home|Users)[\\/]/)
      expect(text, `${s.id} windows profile dir`).not.toMatch(/AppData|Roaming|ProgramData/i)
      // A generic POSIX absolute path, which the checks above do not cover.
      // Two segments minimum, so the slash commands this text legitimately
      // names (/config) are not false positives.
      expect(text, `${s.id} posix absolute path`).not.toMatch(/(^|\s)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/)
    }
  })

  it('names no source files or internal modules', () => {
    // "architecture internals" in practice means naming the code. A user
    // cannot act on `src/main/…`, and Ask Conductor quoting it is worse.
    for (const s of APP_KNOWLEDGE_SECTIONS) {
      const text = `${s.title} ${s.body}`
      expect(text, `${s.id} source path`).not.toMatch(/\bsrc\//)
      expect(text, `${s.id} source file`).not.toMatch(/\.tsx?\b/)
    }
  })

  it('carries no "not affiliated with Anthropic" line (#383)', () => {
    // Owner call 2026-08-22: the disclaimer is gone from the app and docs, and
    // this text is pasted into the Ask Conductor session, so it must not keep
    // repeating it from there.
    for (const s of APP_KNOWLEDGE_SECTIONS) {
      expect(`${s.title} ${s.body}`, `${s.id} affiliation line`).not.toMatch(/affiliated|endorsed by/i)
    }
  })

  it('explains which settings file wins, and that a running session keeps its own', () => {
    // The concept behind #314: a setting that appears to do nothing is
    // usually being overridden, and a change never reaches a session that is
    // already running. Both have to be findable by asking in plain English.
    const section = APP_KNOWLEDGE_SECTIONS.find((s) => s.id === 'settings-scope')
    expect(section, 'settings-scope section exists').toBeTruthy()
    const body = section!.body

    // The precedence chain, weakest to strongest, each named.
    for (const file of ['settings.local.json', 'settings.json', 'organisation']) {
      expect(body, `mentions ${file}`).toContain(file)
    }
    expect(body, 'says the nearest one wins').toMatch(/nearest|strongest|wins/i)
    expect(body, 'says /config writes the project-local file').toContain('/config')
    // Both halves of "when it takes effect", asserted separately: an
    // alternation passed here even with the running-session claim deleted,
    // because "starts" appears elsewhere in the same paragraph.
    expect(body, 'says settings are read at session start').toMatch(/when a session starts/i)
    expect(body, 'says a running session is unaffected').toMatch(/already running/i)

    // The multi-account wrinkle, which is ours and documented nowhere else.
    expect(body, 'says the personal file is copied per account').toMatch(/copied|copy/i)
    expect(body, 'says which things are shared instead').toMatch(/shared/i)
  })
})

// P3.10 round 1 (S2): the Feature Guide and Ask Conductor say what P3.10 made
// true: the Session Watchdog covers local Codex sessions too, under the one
// switch, without the safeguard check; and Codex's one-time Hooks need review
// step is explained where a user would look (what to choose, what declining
// costs, how to trust later).
describe('app knowledge after P3.10 (round 1, S2)', () => {
  const body = (id: string) => APP_KNOWLEDGE_SECTIONS.find((s) => s.id === id)!.body

  it('the Session Watchdog covers Codex sessions under the one switch, and says what differs', () => {
    const w = body('session-watchdog')
    expect(w).not.toMatch(/only for Claude sessions/i)
    expect(w).not.toMatch(/never a plain terminal, a Codex session/i)
    expect(w).toMatch(/for Codex sessions/)
    expect(w).toMatch(/one Session Watchdog switch in Settings covers both assistants/)
    expect(w).toMatch(/safeguard check does not apply to Codex/)
    // Round 4 (P6): the overload backoff as the defaults and What's New give it.
    expect(w).toMatch(/from 30 seconds up to 5 minutes/)
    expect(w).toMatch(/gives up after two hours of waiting in all/)
    expect(w).not.toMatch(/capped number of attempts/)
  })

  it('Codex\'s hooks review is explained: what to choose, what declining costs, how to trust later', () => {
    const k = body('known-issues')
    expect(k).toMatch(/Hooks need review/)
    expect(k).toMatch(/Trust all and continue/)
    expect(k).toMatch(/Continue without trusting/)
    expect(k).toMatch(/attention dot does not light up/)
    expect(k).toMatch(/To trust them later/)
    // Round 2 (R9): it says the hooks send the app each event's details, as Claude Code's do.
    expect(k).toMatch(/sends the app, on this computer only, the details Codex gives each of these events, as Claude Code.s hooks do/)
    // Round 3 (F8): a tool that has run sends its result too, and the hooks also feed the notification rules.
    expect(k).toMatch(/or has run \(the same, and what it returned\)/)
    expect(k).toMatch(/for the attention dot, for its notification rules and to follow which conversation/)
    expect(k).not.toMatch(/only tells the app/)
  })
})

// P3.11 (row 62): a Codex config takes extra CLI arguments; the Feature Guide
// and Ask Conductor say how they reach Codex and what the app refuses, and how
// to give a folder named with a plain word. Round 1 (S3, B2, Q1): the rule on
// its own terms; the dialog says why and Save waits; a saved value that is
// refused is dropped when the session starts (it starts without it).
describe('app knowledge after P3.11', () => {
  it('says a Codex config takes extra CLI arguments, one argument per word, and what is refused', () => {
    const s = APP_KNOWLEDGE_SECTIONS.find((x) => x.id === 'sessions')!.body
    expect(s).toMatch(/For Codex, each word of the extra CLI arguments reaches Codex as one argument/)
    expect(s).toMatch(/the model, -c and the other settings flags, the permission and working-folder flags/)
    expect(s).toMatch(/a profile, another provider or endpoint/)
    expect(s).toMatch(/one of its commands/)
    expect(s).toMatch(/--add-dir=docs/)
    expect(s).toMatch(/What the app sets, or what changes the account, is refused: the model/)
    expect(s).toMatch(/the dialog says why under the field, and Save waits until it is fixed/)
    expect(s).toMatch(/a saved value that is refused is dropped when the session starts, and the session starts without it/)
    expect(s).toMatch(/--add-dir \.\/docs/)
    expect(s).not.toMatch(/does not start/)
    expect(s).not.toMatch(/as the app.s own flags are for Claude Code/)
  })
})

// P3.12 (rows 31, 32, 65): the Logs page indexes a local Codex session's
// conversation (from its own account folder); a Codex session's name is kept
// next to a conversation the app knows for certain, with the rename
// workaround in Known issues; the GitHub Session Context reads its own
// conversation. Nothing still says Codex conversations are not indexed.
describe('app knowledge after P3.12', () => {
  const body = (id: string) => APP_KNOWLEDGE_SECTIONS.find((x) => x.id === id)!.body
  it('says the Logs page indexes Codex conversations, each from its own account folder, with the per-config switch', () => {
    expect(body('codex')).toMatch(/The Logs page indexes a local Codex session's conversation as it does a Claude session's/)
    expect(body('codex')).toMatch(/read from that session's own Codex account folder, never another account's/)
    expect(body('codex')).toMatch(/the Index conversation logs switch in a Codex config turns it off for that config/)
    expect(body('codex')).toMatch(/A Codex session's GitHub Session Context reads its own conversation too/)
    expect(body('pages')).toMatch(/Logs is a full chat-transcript viewer over your Claude and Codex sessions/)
    expect(body('privacy')).toMatch(/reads Claude's and Codex's own transcript files locally/)
  })
  it('says a Codex session\'s name is kept with a conversation the app knows for certain, and the rename workaround', () => {
    expect(body('codex')).toMatch(/is kept next to that conversation, so the list still shows it after the tab is closed/)
    expect(body('known-issues')).toMatch(/A Codex conversation's name can drop out of Restart and pick a conversation after its tab is closed/)
    expect(body('known-issues')).toMatch(/Rename the session again once it has settled on its conversation/)
  })
  it('no longer says Codex conversations are not indexed', () => {
    for (const s of APP_KNOWLEDGE_SECTIONS) {
      expect(s.body, s.id).not.toMatch(/does not index Codex|Codex conversations are not indexed/)
    }
  })
})

// P3.14 (row 17): a Codex account on paid credits shows its balance on its
// Usage card, in Codex credits (a count, not money). The known issue that said
// the row was missing is gone.
describe('app knowledge after P3.14', () => {
  const body = (id: string) => APP_KNOWLEDGE_SECTIONS.find((x) => x.id === id)!.body
  it('no longer says a Codex account on paid credits has no credits row', () => {
    for (const s of APP_KNOWLEDGE_SECTIONS) {
      expect(s.body, s.id).not.toMatch(/no credits row yet/i)
      expect(s.body, s.id).not.toMatch(/Codex accounts on paid credits show their allowance/)
    }
    // Claude's own credits-row known issue is a different thing and stays.
    expect(body('known-issues')).toMatch(/The credits row can be missing for an account on extra usage while one of its sessions is open/)
  })
  it('says the Usage page shows a Codex balance in Codex credits, under the bars, from the newest main report that states them', () => {
    expect(body('accounts')).toMatch(/A Codex account on paid credits shows its balance under its bars, in Codex credits \(a count, not money\)/)
    expect(body('accounts')).toMatch(/taken from the newest main report that states them, so a newer report that says the account has no credits takes the row away and one that says nothing about credits leaves the older figure/)
    expect(body('accounts')).not.toMatch(/taken from the same report as its main bars/)
    expect(body('accounts')).toMatch(/Unlimited/)
    // Round 1: no claim about the balance's age beyond that.
    expect(body('accounts')).not.toMatch(/carries the same age/)
  })
  it('says a conversation moved with Switch Account shows none of the earlier account\'s limits, plan or credits on the new account\'s card until it reports', () => {
    expect(body('accounts')).toMatch(/A conversation you move to another Codex account with Switch Account brings the earlier account's history with it, so the new account's card counts only what that account reports after the move/)
    expect(body('accounts')).toMatch(/until its session reports, the card shows none of the earlier account's limits, plan or credits/)
    // Round 3: while that note cannot be read or written, the move and Sign in again still go on.
    // The VM saw the earlier account's figures for the whole run with the note unreadable
    // from the start, so the sentence says how long, not that it is brief.
    expect(body('accounts')).toMatch(/If the app cannot read or write its note of which conversations were moved, the move and Sign in again still go on, with the note kept in memory until it can be written; a conversation moved in an earlier run may then show the earlier account's figures on the new account's card until that account's session reports or the note can be read, which may be the whole run\./)
    expect(body('accounts')).not.toMatch(/it will not carry a conversation then/)
    expect(body('accounts')).not.toMatch(/it shows no last-seen Codex figures until it can/)
  })
})

// P3.15 (rows 70, 71): what the VM run showed. Alt+V with the terminal focused
// goes to the assistant, which pastes the image itself; with focus elsewhere
// the app saves the image and types its path (the tip said it always pasted a
// path into Claude's prompt). Codex's Windows sandbox: only the administrator
// setup lets Codex edit on its own; the non-admin one, or none, asks before
// every edit on Standard and fails on Auto; an elevated app stalls it. Codex's
// own behaviour, given as a known issue with its workaround, and a tip.
describe('app knowledge and tips after P3.15', () => {
  const body = (id: string) => APP_KNOWLEDGE_SECTIONS.find((x) => x.id === id)!.body
  const tip = (id: string) => TIPS_LIBRARY.find((t) => t.id === id)!.variants.primary
  it('the Alt+V tip says what happens with the session focused and with focus elsewhere, for both assistants', () => {
    const t = tip('tip.paste-image')
    expect(t.body).not.toMatch(/Claude.s prompt/)
    // Round 1 (spec 4): the focused key is evidenced for sessions on this computer;
    // over SSH the app's own path (focus outside the terminal) is the one named.
    expect(t.body).toMatch(/Click into a session on this computer and press \*\*Alt\+V\*\*: the key goes to the assistant, which pastes the image itself/)
    expect(t.body).toMatch(/On an SSH session, press \*\*Alt\+V\*\* with focus outside the terminal: the app saves the image on this computer and asks Claude to fetch it over the connection/)
    expect(t.body).toMatch(/With focus elsewhere in the app, \*\*Alt\+V\*\* saves the image and types a line with its path into the session/)
    expect(t.body).toMatch(/On a Codex session the app types it only into an empty Codex prompt, and says why when it cannot/)
    const guide = trainingSteps.flatMap((s) => s.highlights ?? []).find((l) => l.startsWith('Alt+V'))!
    expect(guide).not.toMatch(/Claude.s prompt/)
    expect(guide).toMatch(/in a local session, the assistant pastes it itself; with focus elsewhere, the app saves it and types its path \(over SSH, it asks Claude to fetch it\)/)
  })
  it('the known issue gives the Windows sandbox workaround: the administrator setup once, what the other choice does, and never an elevated app', () => {
    const k = body('known-issues')
    expect(k).toMatch(/On Windows, Codex edits files on its own only once its sandbox has been set up with administrator permission/)
    // Round 1 (spec 2): what Codex itself says; the UAC prompt was never seen on the VM.
    expect(k).toMatch(/Choose 1\. Set up default sandbox, which Codex says needs administrator permission/)
    expect(k).not.toMatch(/Windows asks for administrator permission once/)
    // Round 1 (spec 3): no question once a folder is trusted or 2 was chosen; the way back is not confirmed, and what to do meanwhile.
    expect(k).toMatch(/asks only when you trust a new folder, so a folder you trusted before, or an earlier choice of 2, brings no question/)
    // Round 2 (J6): the command Codex lists for it (the CLI fixtures' slash popup), not yet confirmed.
    // Round 4 (P6): only after a choice of 2; the administrator prompt blocks Codex's input (the VM at 98455d52).
    // Round 5 (R2): what the VM saw (the prompt left unanswered); a No was never tried, so nothing is said of it.
    expect(k).toMatch(/After a choice of 2, Codex also lists a \/setup-default-sandbox command \(set up elevated agent sandbox\): it asks Windows for administrator permission, and Codex takes no input until that is answered; left unanswered, the session stays stuck, so unless you answer yes, close its tab\./)
    expect(k).not.toMatch(/without a yes the session stays stuck/)
    expect(k).toMatch(/Whether it then lets Codex edit on its own is not yet confirmed; until it is, approve each edit when Codex asks, and use Standard rather than Auto/)
    expect(k).not.toMatch(/has not been confirmed yet/)
    expect(k).toMatch(/2\. Use non-admin sandbox/)
    expect(k).toMatch(/on Standard Codex asks before every edit/)
    expect(k).toMatch(/on Auto every edit fails/)
    expect(k).toMatch(/the same in a terminal outside the app/)
    expect(k).toMatch(/Do not run the app as administrator/)
  })
  it('round 3: the known issue for a tab that stays open after Codex quits, with its workaround (the VM at 98455d52)', () => {
    const k = body('known-issues')
    expect(k).toMatch(/On Windows, a Codex session's tab can stay open after Codex has quit/)
    expect(k).toMatch(/a command Codex started in the background is still running/)
    expect(k).toMatch(/Close the tab: that ends the command too/)
  })
  it('round 2 (J6): the command named is the one both supported CLIs list in their slash popup', () => {
    for (const v of ['0.153.4', '0.155.1']) {
      const popup = fs.readFileSync(path.resolve(__dirname, '..', '..', 'fixtures', 'codex', 'cli', v, 'tui-slash-popup.txt'), 'utf8')
      expect(popup, v).toMatch(/^ +\/setup-default-sandbox +set up elevated agent sandbox\s*$/m)
    }
  })
  it('a tip for Codex users says the same in short', () => {
    const t = TIPS_LIBRARY.find((x) => x.variants.primary.title === 'Codex Edits on Windows')!
    // Shown to the users the other Codex tips are shown to.
    expect(t.requires).toEqual(TIPS_LIBRARY.find((x) => x.variants.primary.title === 'Restart a Codex Session')!.requires)
    expect(t.requires?.length).toBe(1)
    // Round 1 (a nit): offered on Windows only.
    expect(t.platforms).toEqual(['win32'])
    const p = t.variants.primary
    expect(p.shortText.length).toBeLessThan(60)
    expect(p.body).toMatch(/On Windows, when Codex asks to set up its sandbox, choose \*\*1\. Set up default sandbox\*\*/)
    expect(p.body).toMatch(/on \*\*Standard\*\* it asks before every edit, and on \*\*Auto\*\* edits fail/)
    expect(p.body).toMatch(/Do not run the app as administrator/)
    expect(p.body).toMatch(/\(Codex says it needs administrator permission\)/)
    expect(p.body).toMatch(/After choosing 2, Codex also lists \*\*\/setup-default-sandbox\*\*: it asks for administrator permission, and Codex takes no input until you answer \(without a yes, close the tab\); whether it then lets Codex edit on its own is not yet confirmed/)
    expect(p.body).toMatch(/asks only when you trust a new folder\. After choosing 2, Codex also lists \*\*\/setup-default-sandbox\*\*[^.]*\. If it never asks you, approve each edit when Codex asks about it, and use \*\*Standard\*\* rather than \*\*Auto\*\*/)
    expect(`${p.title} ${p.body}`).not.toMatch(/\u2014/)
  })
})

// P3.16 (the PR 3 user-facing sweep): what PR 3 made true is said where a user
// looks (the Feature Guide, Ask Conductor, the tips, the guide cards and What's
// New), the known issues it ships with have their workarounds, and nothing still
// says what PR 3 made untrue (a Codex Restart starts a new conversation, the
// Logs page does not index Codex, the gpt-5 list, the assistant-only Alt+V).
describe('the PR 3 user-facing sweep (P3.16)', () => {
  const body = (id: string) => APP_KNOWLEDGE_SECTIONS.find((s) => s.id === id)!.body
  const tip = (id: string) => TIPS_LIBRARY.find((t) => t.id === id)!
  // The Codex tips by title, as the P3.15 block finds them: their ids, and the
  // feature id they wait on, would name a dotted codex path in this file.
  const titled = (title: string) => TIPS_LIBRARY.find((t) => t.variants.primary.title === title)!
  const codexTipGate = titled('Restart a Codex Session').requires
  const stepText = (id: string) => JSON.stringify(trainingSteps.find((s) => s.id === id)!)
  // The 2.1.1-beta.2 entry, found by its highlight so that a later release's
  // entry above it moves nothing here.
  const top = changelog.find((e) => e.highlights?.startsWith('Codex becomes a full second assistant'))!
  const readme = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'README.md'), 'utf8')
  // The pins match the facts by key phrases, so a copy edit that keeps the fact
  // keeps them green.

  // Gate 3 (spec item 3, F2): the count includes the first analysis, so an
  // update is analysed at most three times in all, not three times again.
  it('Sentinel (P3.9 round 4): an update whose findings cannot be matched is analysed at most three times in all', () => {
    const s = body('sentinel')
    expect(s).toMatch(/analysed again at the next start, at most three analyses in all, after which it is recorded as checked with a note saying so/)
    expect(s).not.toMatch(/up to three times/)
  })

  // Fixer 11 (ADR-009 lens D round 2 finding 5, gate 3 F11): the start-up
  // check no longer analyses a downgrade, for either assistant; a Re-run does.
  // Fixer 12 (gate 3 F14 and F15, ADR-009 lens D round 3 NIT 1, R3-1): the rule
  // goes by the newest version checked, and a Re-run makes the installed
  // version the newest one checked; the changelog says it of Claude Code, the
  // assistant that had Sentinel before this release.
  it('Sentinel (fixers 11 and 12): at start only a version newer than the newest checked is analysed; a downgrade runs no analysis; Re-run resets the newest checked', () => {
    const s = body('sentinel')
    // Fixer 13 (gate 3 F16, fixer 12 quality NIT 1): the Re-run moves the
    // newest checked once its analysis is done, and an unmatched one of a
    // version no start analyses asks for another Re-run.
    expect(s).toMatch(/At start it analyses only a version newer than the newest one it has checked, so going back to an older version runs no analysis and the panel names the version installed\. Re-run analyses the installed version and, once that analysis is done, makes it the newest one checked, so a newer version you go back to afterwards is an update again, with the same limit of three analyses\. When a version no start analyses has a finding that cannot be matched, the panel asks you to use Re-run again\./)
    expect(s).not.toMatch(/the last one it checked/)
    const all = top.changes.map((c) => c.description).join('\n')
    expect(all).toMatch(/Sentinel no longer runs an analysis at start when you go back to an older Claude Code version \(Codex works the same way\): it analyses only a version newer than the newest one it has checked/)
    expect(all).toMatch(/Re-run in the Sentinel panel analyses the installed version and, once that analysis is done, makes it the newest one checked\./)
    expect(all).not.toMatch(/the last one it checked|older Claude Code or Codex version/)
  })

  it('accounts (P3.2, P3.3): the chip opens the identity editor; Sign in again works while signed in, and what it leaves', () => {
    const a = body('accounts')
    expect(a).toMatch(/round chip to open its editor/)
    // Any two accounts on different identities can be linked, two Codex ones too.
    expect(a).toMatch(/Link another account to tie it to another of your accounts, Claude or Codex/)
    expect(a).not.toMatch(/your account of the other assistant/)
    expect(a).toMatch(/names each of them with Go to/)
    const c = body('codex')
    expect(c).toMatch(/listed under Archived, each with Restore/)
    expect(c).toMatch(/still signed in signs in again inside a new folder/)
    expect(c).toMatch(/moves there only once the new sign-in is verified/)
    // The kept old sign-in shows after a move that worked, and the account can
    // still be used; only one signed in a different way is held back.
    expect(c).toMatch(/Once the account has moved, its row reads Needs attention: the old sign-in is kept/)
    expect(c).toMatch(/can still be picked for sessions/)
    expect(c).toMatch(/one signed in a different way than before cannot be picked until you confirm it/)
    expect(c).toMatch(/An inactive account, or one signed in a different way than before, is greyed/)
    expect(c).not.toMatch(/one that needs attention/)
    expect(c).toMatch(/archiving the account removes it/)
    // 2.1.1-beta.3 (F11): the retired sign-in has no Sign in again.
    expect(c).toMatch(/Sign in again is not offered on it\./)
    expect(c).not.toMatch(/When a Codex account is signed out or expired, Sign in again/)
    expect(c).not.toMatch(/The app never signs in to it for you/)
    const recovery = titled('Check Sign-in and Sign In Again').variants.primary.body
    expect(recovery).toMatch(/signs in inside a new folder and moves there only once that sign-in works/)
    expect(recovery).not.toMatch(/signs a signed-out or expired account back in/)
  })

  it('Codex sessions (P3.5 to P3.8, P3.13): models, Plan mode, Compact, the model pill, the status line and Multi Spawn', () => {
    const c = body('codex')
    expect(c).toMatch(/The model list is the one the supported Codex versions offer/)
    expect(c).toMatch(/only the effort levels it runs/)
    expect(c).toMatch(/Read-only, Standard, Plan mode, Auto and Unrestricted/)
    expect(c).toMatch(/Compact on the status line types Codex's own \/compact/)
    expect(c).toMatch(/the model pill opens Codex's own model and effort picker/)
    expect(c).toMatch(/Restart carries on with the same conversation/)
    expect(body('statusline')).toMatch(/lines changed \(counted from the edits Codex makes\)/)
    expect(body('statusline')).toMatch(/carried on across restarts/)
    expect(body('sessions')).toMatch(/works the same for a Codex config/)
    expect(body('session-watchdog')).toMatch(/errors in the current turn only/)
  })

  it('Alt+V (P3.15, P3.16a U6 and N9): the plain-terminal and partner-shell routes, in the Feature Guide, the tip and the guide card', () => {
    const k = body('shortcuts')
    expect(k).toMatch(/Alt\+V types only the image's path into a plain terminal, or into a local session's partner shell/)
    expect(k).toMatch(/quoted for the shell, with no Enter/)
    // PR-level ADR-009 round 1 (A1): off Windows, a path is typed only into a shell of the sh family.
    expect(k).toMatch(/On macOS and Linux the path is typed only into an sh, bash, zsh, dash or ksh shell/)
    expect(k).toMatch(/Any other shell there, a plain terminal over SSH, an SSH session's partner shell \(it runs on the host\), or a terminal that is not running gets nothing/)
    expect(k).toMatch(/the hint says where the image was saved/)
    // The copied-file route reads File Explorer's and Finder's clipboard only.
    expect(k).toMatch(/an image file you copied in File Explorer or Finder/)
    expect(k).not.toMatch(/file manager/)
    const t = tip('tip.paste-image').variants.primary.body
    expect(t).toMatch(/\*\*Alt\+V\*\* types only the image's path into a plain terminal, or into a local session's partner shell/)
    expect(t).toMatch(/quoted for the shell, with no Enter/)
    expect(t).toMatch(/On macOS and Linux the path is typed only into an sh, bash, zsh, dash or ksh shell/)
    expect(t).toMatch(/Any other shell there, a plain terminal over SSH, or an SSH session's partner shell \(it runs on the host\) gets nothing/)
    expect(t).toMatch(/an image file you copied in File Explorer or Finder/)
    expect(t).not.toMatch(/file manager/)
    const guide = trainingSteps.flatMap((s) => s.highlights ?? []).find((l) => l.startsWith('Alt+V'))!
    expect(guide).toMatch(/a plain terminal, or a local session's partner shell in a partner view, gets only the quoted path \(an SSH session's partner gets nothing; the hint says where the image was saved\)/)
    expect(guide).toMatch(/with no Enter/)
    // Fixer 7b (N5): off Windows, only a shell of the sh family gets the path.
    expect(guide).toMatch(/on macOS and Linux, only an sh, bash, zsh, dash or ksh shell/)
  })

  it('known issues (P3.10, P3.16a): the Codex lock screen, the Windows folder spelling and vision in one copy, each with its workaround', () => {
    const k = body('known-issues')
    expect(k).toMatch(/one tab at a time write to a conversation/)
    expect(k).toMatch(/with Codex 0\.155\.1, Codex shows its own lock screen/)
    expect(k).toMatch(/close the tab that shows the lock screen/)
    expect(k).toMatch(/give a Claude config its working folder as Windows spells it/)
    expect(k).toMatch(/with the folder picker, or type it exactly as File Explorer shows it/)
    expect(k).toMatch(/drive letter in upper case/)
    // Vision: only copies run from source can share a vision browser (the
    // installed app runs one copy, and a copy run from source has a browser of
    // its own beside it).
    expect(k).toMatch(/one copy of the app at a time when you run the app from source/)
    expect(k).toMatch(/Two copies run from source at once/)
    expect(k).toMatch(/starting vision in one copy can close the browser the other copy opened/)
    expect(k).toMatch(/The installed app is not affected/)
    expect(k).toMatch(/press Start browser on the Conductor MCP page/)
    expect(k).not.toMatch(/another build beside the installed one/)
  })

  it('privacy: what is written while indexing is off is never indexed, for both; the Codex name file', () => {
    const p = body('privacy')
    expect(p).toMatch(/while indexing was off is never indexed later, for Claude and Codex alike/)
    expect(p).toMatch(/kept in a small file beside its conversation/)
  })

  it('the tips a user would not find alone (P3.2, P3.6, P3.8), and the corrected ones', () => {
    const editor = tip('tip.account-identity-editor').variants.primary.body
    expect(editor).toMatch(/click the round chip at the left of an account row, Claude or Codex/)
    expect(editor).toMatch(/ties it to another of your accounts, Claude or Codex/)
    expect(editor).not.toMatch(/your account of the other assistant/)
    // Shown to the users the other Codex tips are shown to.
    expect(codexTipGate?.length).toBe(1)
    const switching = titled('Switch a Codex Session\'s Account')
    expect(switching.requires).toEqual(codexTipGate)
    expect(switching.variants.primary.body).toMatch(/click the \*\*account pill\*\* at the far left of its status line/)
    expect(switching.variants.primary.body).toMatch(/inactive, or signed in a different way than before, is greyed/)
    expect(titled('Codex\'s Own Commands, From the App').requires).toEqual(codexTipGate)
    expect(titled('Codex\'s Own Commands, From the App').variants.primary.body).toMatch(/start in \*\*Plan mode\*\*/)
    // The overload backoff as the Watchdog has it since P3.10 round 3.
    expect(tip('tip.session-watchdog').variants.primary.body).toMatch(/from 30 seconds up to 5 minutes/)
    expect(tip('tip.session-watchdog').variants.primary.body).toMatch(/gives up after two hours of waiting in all/)
    expect(tip('tip.session-watchdog').variants.primary.body).not.toMatch(/with capped attempts/)
    const net = tip('tip.transparency.network-activity').variants.primary.body
    expect(net).toMatch(/current Claude and Codex model pricing/)
    expect(net).toMatch(/`status\.openai\.com` while Codex is on/)
    // Sentinel's reads (Codex's release notes among them) and Codex's own usage
    // check are on the list too.
    expect(net).toMatch(/\*\*Sentinel\*\* \(off by default\)/)
    expect(net).toMatch(/Codex's public release notes \(`api\.github\.com`\)/)
    expect(net).toMatch(/\*\*Codex usage check\*\* \(`chatgpt\.com`/)
    expect(tip('tip.multi-account').variants.primary.body).toMatch(/moves between your Codex accounts the same way/)
  })

  it('the guide cards: the Codex card, the Logs card and the cards that name both assistants', () => {
    const codex = stepText('codex-provider')
    expect(codex).not.toMatch(/gpt-5\.4|gpt-5 series|Six gpt-5 models/)
    expect(codex).not.toMatch(/does not index Codex conversations yet/)
    expect(codex).toMatch(/the Logs page indexes Codex conversations as it does Claude/)
    expect(codex).toMatch(/Switch Account/)
    expect(codex).toMatch(/Plan mode/)
    // The model list is built into the app (the supported versions' list), not
    // read from the Codex that is installed.
    expect(codex).toMatch(/the models the supported Codex versions offer, permission presets/)
    expect(codex).toMatch(/The supported Codex versions' \*\*model list\*\*/)
    expect(codex).not.toMatch(/installed Codex offers|Codex's own \*\*model list\*\*/)
    expect(readme).toMatch(/the models the supported Codex versions offer in the model dropdown/)
    expect(readme).not.toMatch(/installed Codex offers/)
    expect(stepText('logs')).toMatch(/a local Codex session's conversation \(from its Codex account's sessions folder\)/)
    expect(stepText('logs')).not.toMatch(/tool calls, and thinking/)
    expect(stepText('multi-account')).toMatch(/every account of each assistant that is on, in a section per assistant when both are/)
    expect(stepText('multi-account')).not.toMatch(/shows every Claude and Codex account/)
    expect(stepText('multi-account')).toMatch(/Settings, Accounts \(click an account's chip/)
    expect(stepText('multi-account')).not.toMatch(/->/)
    const accounts = stepText('provider-accounts')
    expect(accounts).toMatch(/An assistant that is off keeps its accounts listed/)
    expect(accounts).toMatch(/link it to another of your accounts, Claude or Codex/)
    expect(accounts).toMatch(/Needs attention: signed in a different way than before/)
    expect(stepText('ai-usage-meter')).toMatch(/rate-limit windows of this run's sessions/)
    // The popover shows only the assistants that are on (row 14, OD27 M1 D5).
    expect(stepText('ai-usage-meter').match(/side by side when both are on/g) ?? []).toHaveLength(3)
    expect(tip('tip.github.ai-usage-meter').variants.primary.body).toMatch(/5h \/ 7d rate-limit windows, side by side when both are on/)
  })

  it('What\'s New (2.1.1-beta.2): a Codex Restart keeps its conversation, and PR 3\'s changes are listed', () => {
    expect(top, 'the entry whose highlight starts "Codex becomes a full second assistant"').toBeDefined()
    expect(top.highlights).toMatch(/Sentinel watches Codex too/)
    const all = top.changes.map((c) => c.description).join('\n')
    expect(all).not.toMatch(/Restart starts a new conversation/)
    expect(all).toMatch(/Restart carries on with the same conversation/)
    for (const said of [
      /a Codex session moves to another one as a Claude session does/,
      /A Codex session's status line shows Lines changed/,
      /Codex models and efforts match Codex's own/,
      /A Codex config can start in Plan mode/,
      /Sentinel covers Codex/,
      /Allow Multi Spawn and Quick Start work for Codex configs/,
      /shows its credits under its bars on the Usage page/,
      /Click an account's round chip to edit its name, colour and group/,
      /link it to another of your accounts, Claude or Codex/,
      /an account signed in a different way than before cannot be picked until you confirm it/,
      /Sign in again works on a Codex account that is still signed in/,
      /a Codex pill, read from OpenAI's public status page/,
      /a local Codex session keeps its scrollback/,
      /Alt\+V with focus outside the terminal types only the image's path into a plain terminal/,
      /On macOS and Linux it types it only into an sh, bash, zsh, dash or ksh shell; with any other shell there, or over SSH, it types nothing/,
      /the app now finds its conversation for Logs/,
      // P3.16 final-head VM findings D1 to D3.
      /A new Claude conversation now appears in Logs and in search from its first message/,
      /The AI usage popover now opens above its chip in the session status strip/,
      /The Services panel no longer lists an ended session again/,
    ]) expect(all).toMatch(said)
    expect(all).not.toMatch(/come from Codex itself|your account of the other assistant|retries a Claude session again/)
    for (const text of [top.highlights ?? '', ...top.changes.map((c) => c.description)]) expect(text, text.slice(0, 40)).not.toMatch(/\u2014/)
  })
})

// [host] PR 4 ADR-009 round 2: a log_dir folder is shown selected in the
// folder that holds it, never opened, so the Feature Guide says so.
describe('app knowledge after PR 4 (ADR-009 round 2)', () => {
  it('says the log_dir folder is shown in the folder that holds it, not opened', () => {
    const body = APP_KNOWLEDGE_SECTIONS.find((x) => x.id === 'troubleshooting')!.body
    expect(body).toMatch(/the log_dir folder when one is set, which the app shows selected in the folder that holds it rather than opening it/)
    expect(body).toMatch(/the app says so when it will not open or show it/)
    expect(body).not.toMatch(/The app opens only a plain folder/)
  })

  it('[host] says where the canvas skills go for this computer\'s own Codex sign-in, when they leave, and what a same-named skill of the user\'s own gets (question 5, answered C)', () => {
    const all = APP_KNOWLEDGE_SECTIONS.map((x) => x.body).join('\n')
    expect(all).toMatch(/The app copies its three canvas skills into your own Codex folder for an account 2\.1\.1-beta\.2 registered for the Codex sign-in already on this computer\./)
    expect(all).toMatch(/That account gets them in your own Codex skills folder \(~\/\.codex\/skills, or the skills folder inside the folder CODEX_HOME names\), where Codex lists them for every session that uses that folder, however it is started\./)
    expect(all).toMatch(/they are removed when you turn Codex or the built-in tools off, and kept up to date while both are on\./)
    expect(all).toMatch(/A skill of your own with the same name \(agent-canvas, canvas-plan or conductor-vision\) is never touched/)
    // Option A's words are gone: no developer instructions, no picker clause.
    expect(all).not.toMatch(/developer_instructions|Through the resume picker, the guidance/)
  })
})

// [host] PR 4 VM checkpoint (F1): under the Auto preset Codex runs with
// `--ask-for-approval never`, so it cannot ask before a conductor tool that
// needs approval and refuses the call. Claude's Auto mode gets no per-tool
// approval for these tools from the app either, so Auto gets no keys (fail
// closed, OR4 decides) and the Feature Guide says so, with the workaround.
describe('app knowledge after the PR 4 VM checkpoint (F1)', () => {
  it('says Codex on Auto cannot ask before the canvas render, the Vision tools or the in-app browser, and names Standard or Unrestricted', () => {
    const k = APP_KNOWLEDGE_SECTIONS.find((x) => x.id === 'known-issues')!.body
    expect(k).toMatch(/On the Auto preset, Codex cannot use the app's built-in tools other than the canvas snapshot and review: the Agent Canvas render, [^.]*the Vision tools, the push to the in-app browser/)
    expect(k).toMatch(/Auto starts Codex with no prompts at all, so it cannot ask before these tools and refuses each call instead/)
    expect(k).toMatch(/The canvas snapshot and review tools still run on Auto/)
    expect(k).toMatch(/The workaround: use the Standard preset, where Codex asks before each of these tools, or Unrestricted, where they run without asking/)
  })

  // [host] PR 4 review (RVMFIX-1): every tool a Codex connection may be
  // offered is refused on Auto but the two the app lets run on every preset
  // (canvas_snapshot and canvas_review: CODEX_PREALLOWED_TOOLS, pinned in
  // spawn-canvas.test.ts), so the line names each of the others. A tool added
  // to the Codex list without a phrase here fails.
  it('the Auto line names every tool offered to Codex that Auto refuses: all but the canvas snapshot and review', () => {
    const k = APP_KNOWLEDGE_SECTIONS.find((x) => x.id === 'known-issues')!.body
    const line = /On the Auto preset, Codex cannot use [^.]*\./.exec(k)?.[0] ?? ''
    const named: Record<string, RegExp> = {
      canvas_render: /the Agent Canvas render/, canvas_resolve: /resolving notes/, canvas_verdict: /verdicts/,
      canvas_version_verdict: /verdicts/, canvas_pick: /recording which option you chose/, canvas_complete: /marking a plan complete/,
      open_in_app_browser: /the push to the in-app browser/, fetch_host_screenshot: /the host screenshot fetch/,
      claude_review: /the Claude review/,
    }
    const refused = CODEX_CONDUCTOR_TOOLS.map((t) => t.name).filter((n) => n !== 'canvas_snapshot' && n !== 'canvas_review')
    expect(refused.length).toBeGreaterThan(20)
    for (const tool of refused) expect(line, tool).toMatch(named[tool] ?? (tool.startsWith('vision_') ? /the Vision tools/ : /a phrase for this tool/))
    expect(line).toMatch(/other than the canvas snapshot and review/)
  })
})

// [host] P4.11 (row 54, the PR 4 user-facing sweep): the Codex "Beta" labels
// come off in the release where parity lands (recorded 2026-09-26), in the
// Feature Guide, Ask Conductor's documentation, the README and the user guide.
describe('the PR 4 user-facing sweep (P4.11)', () => {
  const root = path.resolve(__dirname, '..', '..', '..')
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
  const guide = fs.readFileSync(path.join(root, 'docs', 'USER_GUIDE.md'), 'utf8')

  it('no surface labels Codex Beta', () => {
    for (const s of APP_KNOWLEDGE_SECTIONS) {
      expect(s.title, s.id).not.toMatch(/beta/i)
      expect(s.body, s.id).not.toMatch(/Codex \(Beta\)|Codex support is Beta|\(Codex support is Beta\)/)
    }
    expect(APP_KNOWLEDGE_SECTIONS.find((s) => s.id === 'codex')!.title).toBe('Codex: sessions and accounts')
    for (const s of APP_KNOWLEDGE_SECTIONS) expect(s.body, s.id).not.toMatch(/see Codex \(Beta\)/)
    expect(readme).not.toMatch(/Still marked Beta/)
    expect(guide).not.toMatch(/\*\*Codex\*\* \(Beta\)/)
  })

  const body = (id: string) => APP_KNOWLEDGE_SECTIONS.find((s) => s.id === id)!.body
  const tip = (id: string) => TIPS_LIBRARY.find((t) => t.id === id)!.variants.primary
  // The policy wraps its lines, so phrases are matched with the wrapping undone.
  const privacy = fs.readFileSync(path.join(root, 'PRIVACY.md'), 'utf8').replace(/\s+/g, ' ')

  it('the Feature Guide filter is said where Ask Conductor reads it (review P411C-10, P411-2)', () => {
    expect(body('providers')).toMatch(/The Feature Guide and its tour show the cards for the assistants you use: with Codex alone, the cards for features that need Claude Code \(Dynamic Workflows and Multiple Accounts\) and Code review are not shown, and with Claude Code alone, Code review is not shown, since it needs both\./)
  })

  it('Artifacts: shown for an SSH Claude session signed in as a local account too, not only a local one', () => {
    expect(body('draw')).toMatch(/it appears for a Claude session signed into one of your accounts here, a local session or an SSH session signed in as an account you also use on this computer, and uses that account/)
    expect(body('draw')).not.toMatch(/appears for a local Claude session signed into an account/)
  })

  it('the tips for features that now work for both say so (P4.1, P4.2, P4.4, P4.5)', () => {
    expect(tip('tip.vision-system').shortText).toBe('Give your agent a browser to drive')
    expect(tip('tip.vision-system').body).toMatch(/gives your Claude and Codex sessions a real browser they can control/)
    expect(tip('tip.vision-system').body).not.toMatch(/gives Claude a real browser|that Claude can drive|showing Claude/)
    expect(tip('tip.memory-visualiser').shortText).toBe('Browse what your assistants remember about your projects')
    expect(tip('tip.cloud-agents').shortText).toBe('Dispatch an agent to work in the background')
    expect(TIPS_LIBRARY.find((t) => t.variants.primary.title === 'Codex Sessions')!.variants.primary.body).toMatch(/The Agent Canvas, Vision and the push to the Browser pane work in Codex sessions too./)
    expect(tip('tip.cloud-agents').body).toMatch(/runs headless agents on Claude Code or Codex in the background/)
    expect(tip('tip.transparency.vision-mcp').body).toMatch(/is offered the same vision, browser push, host screenshot and canvas tools, with `claude_review` in place of `codex_review`/)
  })

  it('the README says what PR 3 and PR 4 made true', () => {
    expect(readme).not.toMatch(/Ask Conductor, Cloud Agents and Insights are unavailable/)
    expect(readme).toMatch(/With Claude Code off, Insights runs for Codex accounts only, Ask Conductor runs on Codex, Cloud Agents runs Codex agents only/)
    expect(readme).not.toMatch(/Insights is unavailable/)
    expect(readme).toMatch(/Ask Conductor opens a real session, on Claude Code or Codex,/)
    expect(readme).not.toMatch(/review what Claude built|giving Claude eighteen|dispatch headless Claude|notices when Claude Code updates|straight into Claude|sends a prompt to Claude|driven by Claude's own hooks/)
    expect(readme).toMatch(/notices when Claude Code or Codex updates/)
    expect(readme).toMatch(/each Codex account's own memories/)
    expect(readme).toMatch(/Your agent, Claude or Codex, renders a design mockup/)
  })

  it('the user guide: what runs with Claude Code off, and the Codex known issues PR 4 ships with', () => {
    expect(guide).not.toMatch(/Ask Conductor, Cloud Agents and Insights are\s+unavailable/)
    expect(guide).toMatch(/With Claude Code off, Insights runs for Codex accounts only, Ask Conductor runs on\s+Codex, and Cloud Agents runs Codex agents only/)
    expect(guide).not.toMatch(/for Claude Code also Insights|Insights is unavailable/)
    expect(guide).not.toMatch(/for Claude Code also cloud agents and Insights/)
    // The guide wraps its lines, so a phrase is matched across a line break.
    const known = guide.slice(guide.indexOf('## Known issues with Codex'), guide.indexOf('## Logs & transcript viewer')).replace(/\s+/g, ' ')
    for (const said of [/On the Auto preset, Codex refuses the app's own tools/, /CCC copies its three canvas skills into your own Codex skills folder/, /cannot pass on emoji/, /documentation folder cannot be rebuilt/, /A Codex cloud agent run with Auto/]) expect(known).toMatch(said)
  })

  it('privacy: the staged skills, the copies in your own Codex folder and the record of it, the Memory page and log folders, and cloud agents', () => {
    expect(privacy).toMatch(/under `skills\/`/)
    const said = privacy.replace(/\s+/g, ' ')
    expect(said).toMatch(/it writes the same three into your own Codex folder, under `skills\/`/)
    expect(said).toMatch(/removes them when you turn Codex or the built-in tools off/)
    expect(said).toMatch(/notes that folder's path, and nothing else, in a small file in its own data folder/)
    expect(said).not.toMatch(/developer instructions|the app writes nothing there/)
    expect(privacy).toMatch(/\*\*The Memory page and Debug Logging read each Codex account's own folders\.\*\*/)
    expect(privacy).toMatch(/A cloud agent works the same way/)
  })
})

// [host] P4.11: the 2.1.1 entry lists what PR 4 and its sweep shipped, found
// by its highlight as the P3.16 block finds it.
describe('What\'s New after PR 4 (P4.11)', () => {
  const top = changelog.find((e) => e.highlights?.startsWith('Codex becomes a full second assistant'))!
  it('the 2.1.1 entry lists PR 4\'s features and the sweep\'s fixes, in plain ASCII', () => {
    expect(top.highlights).toMatch(/The Agent Canvas, Vision and the in-app browser, Ask Conductor, Cloud Agents and the Memory page work for Codex too, and Codex is no longer marked Beta\./)
    const all = top.changes.map((c) => c.description).join('\n')
    for (const said of [
      /The Agent Canvas works in Codex sessions as in Claude ones/,
      /Vision and the push to the in-app browser work in Codex sessions too/,
      /Cloud Agents run on Codex too/,
      /The Memory page lists each Codex account's own memories/,
      /Codex is no longer marked Beta/,
      /The Feature Guide and its tour show the cards for the assistants you use/,
      /with Claude Code alone, Code review is not shown, since it needs both/,
      /Claude Opus 5\.5, Claude Sonnet 5\.5 and Claude Haiku 5\.5 are in the model picker/,
      /The Usage page's Updated line now ages while the page stays open/,
      /now says 1 note, not 1 notes/,
    ]) expect(all).toMatch(said)
    for (const text of [top.highlights ?? '', ...top.changes.map((c) => c.description)]) expect(text, text.slice(0, 40)).toMatch(/^[\x20-\x7e]*$/)
  })

  // [host] The P4.11 copy review (P411C-2, -3, -5, -7, -8, -9): every line
  // says only what is true of what ships.
  it('the 2.1.1 lines claim no parity beyond the label, carry the Auto caveat, and list no fix for what never shipped', () => {
    const all = top.changes.map((c) => c.description).join('\n')
    expect(all).not.toMatch(/it now does what Claude Code does across the app/)
    expect(all).toMatch(/Codex is no longer marked Beta: the label is gone from setup, Settings, Accounts and the Feature Guide\./)
    const canvas = top.changes.find((c) => c.description.startsWith('The Agent Canvas works in Codex sessions'))!.description
    expect(canvas).toMatch(/On the Auto preset Codex refuses the canvas render and the canvas's other tools apart from the snapshot and review, because Auto cannot ask before them; use Standard or Unrestricted \(see Known issues\)\./)
    expect(all).not.toMatch(/Retry agent|Start session/)
    expect(all).toMatch(/Debug Logging opens each Codex account's log folder too, and shows a log_dir folder its settings name selected in the folder that holds it/)
    expect(all).toMatch(/A Codex session's right-click menu no longer offers Claude's account items \(Open artifacts, Authenticate claude\.ai and Sign in to Claude Code\), which acted on your primary Claude account, and its browser pane's start page no longer offers that account's claude\.ai\./)
    expect(all).not.toMatch(/A Codex tab's right-click menu/)
    const root = path.resolve(__dirname, '..', '..', '..')
    const surfaces = [
      all,
      fs.readFileSync(path.join(root, 'README.md'), 'utf8'),
      ...APP_KNOWLEDGE_SECTIONS.map((s) => s.body),
      ...TIPS_LIBRARY.map((t) => t.variants.primary.body),
      ...trainingSteps.map((s) => JSON.stringify(s)),
    ]
    for (const s of surfaces) expect(s).not.toMatch(/read-only for now/)
  })
})

// [host] The P4.11 copy review (P411C-1, -4, -6).
describe('the P4.11 review: images, privacy and the first-launch session', () => {
  const root = path.resolve(__dirname, '..', '..', '..')
  const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8')
  it('the README shows no superseded Memory page, and the release record names the README images WP2 changed', () => {
    expect(read('README.md')).not.toMatch(/shot-memory\.png/)
    const rq = read('docs', 'wp1', 'evidence', 'release-qualification.md').replace(/\s+/g, ' ')
    expect(rq).not.toMatch(/shows a surface WP2 changed, so all references stay/)
    // The record says what was done: the images recaptured on the 2.1.1-beta.2 candidate and
    // approved by the owner, the Memory image not recaptured, and the macOS variants recaptured
    // on a macOS build of that candidate and approved too, with no line left calling them owed.
    for (const img of ['shot-tokenomics.png', 'shot-sessions.png', 'shot-canvas.png']) expect(rq).toMatch(new RegExp('`docs/screenshots/' + img.replace('.', '\\.') + '` \\| [^|]+ \\| Recaptured on the 2\\.1\\.1-beta\\.2 candidate and approved by the owner on 2026-10-07'))
    expect(rq).toMatch(/`docs\/screenshots\/shot-memory\.png` \| [^|]+ \| Not recaptured: the README shows no Memory image/)
    expect(rq).not.toMatch(/\| Recaptured at the final head|being recaptured with the README|await the owner's approval/)
    expect(rq).toMatch(/The six README images and the four Feature Guide images \(`v2-shell-hero\.jpg`, `step-session-options\.jpg`, `step-tokenomics\.jpg`, `step-vision\.jpg`\) were then recaptured on the 2\.1\.1-beta\.2 candidate and approved by the owner on 2026-10-07\./)
    expect(rq).toMatch(/Their macOS variants `step-session-options-mac\.jpg`, `step-tokenomics-mac\.jpg` and `step-vision-mac\.jpg` were then recaptured on a macOS build of the 2\.1\.1-beta\.2 candidate, made on a Mac from a later head of this branch, and approved by the owner on 2026-10-07\./)
    expect(rq).toMatch(/`src\/renderer\/assets\/training\/step-vision\.jpg` \| [^|]+ \| [^|]*Its macOS variant `step-vision-mac\.jpg` was recaptured on a macOS build of the same candidate and approved by the owner on 2026-10-07 too\. \|/)
    expect(rq).not.toMatch(/-mac\.jpg`?[^.|]*(?:not yet recaptured|remain owed)|owed, on a Mac/)
  })

  it('privacy: when the staged skills are written and removed, in a managed account\'s folder and in your own (question 5, answered C)', () => {
    const p = read('PRIVACY.md').replace(/\s+/g, ' ')
    expect(p).toMatch(/Last updated: 4 October 2026/)
    expect(p).toMatch(/while the built-in tools are on, whichever of them are on, and removes them at that account's next launch with the built-in tools off/)
    expect(p).not.toMatch(/while the matching built-in tool is on/)
    expect(p).toMatch(/In either folder it rewrites or removes only the skill folders it marked as its own, never through a link, and never a skill of yours with the same name\./)
    // Option A's settings scan is gone, and PRIVACY no longer lists it.
    expect(p).not.toMatch(/cloud-config-bundle-cache\.json|without reading them|ProgramData\\OpenAI\\Codex/)
  })

  it('the first session on a new Codex account or folder: a neutral known issue with its workaround, in both places', () => {
    const k = APP_KNOWLEDGE_SECTIONS.find((s) => s.id === 'known-issues')!.body
    expect(k).toMatch(/The first Codex session in a new folder may not stay read-only\. In the session in which Codex asks its first-launch questions \(whether you trust the folder, and on Windows how to set up its sandbox\), Codex runs as on the Standard preset even when the session was started on Read-only: it can edit files in the folder, and commands you approve can run outside its sandbox\. This is Codex's own behaviour, and later sessions keep the preset you chose\. The workaround: once you have answered those questions, Restart the session before relying on Read-only\./)
    const guide = read('docs', 'USER_GUIDE.md').replace(/\s+/g, ' ')
    expect(guide).toMatch(/\*\*The first Codex session in a new folder may not stay read-only\.\*\*/)
  })
})

// [host] WP2 PR 4, P4.7 (row 68): what the app says about Insights for Codex,
// and row 58's signed artifacts record (decision A, item 4).
describe('Insights for Codex, said where Ask Conductor reads it (P4.7)', () => {
  const privacy = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'PRIVACY.md'), 'utf8').replace(/\s+/g, ' ')
  const sec = (id: string) => APP_KNOWLEDGE_SECTIONS.find((s) => s.id === id)!.body
  const tipOf = (id: string) => TIPS_LIBRARY.find((t) => t.id === id)!
  it('the pages section says how a Codex report is made, and what Run all covers', () => {
    expect(sec('pages')).toMatch(/Insights builds a qualitative digest of how your Claude Code and Codex sessions have been going/)
    expect(sec('pages')).toMatch(/for a Codex account the app makes the report itself: it counts that account's own Codex sessions, then asks Codex to write the cards, read-only and with no tools, on that account's own allowance/)
    expect(sec('pages')).toMatch(/every account of both assistants in one roll-up/)
    expect(sec('pages')).not.toMatch(/how your Claude sessions have been going/)
  })
  it('an Insights report keeps either assistant in use, and runs for Codex with Claude Code off', () => {
    expect(sec('providers')).toMatch(/a sign-in, a Sentinel check or analysis, or an Insights report\./)
    expect(sec('providers')).toMatch(/With Claude Code off, Insights runs for Codex accounts only/)
    expect(sec('providers')).not.toMatch(/for Claude Code also Insights|Insights is unavailable/)
  })
  it("the Insights tip is no longer Claude Code's alone", () => {
    expect(tipOf('tip.insights').provider).toBeUndefined()
    expect(tipOf('tip.insights').variants.primary.body).toMatch(/Claude Code's or Codex's/)
    expect(tipOf('tip.insights').variants.primary.body).not.toMatch(/Claude-powered|Claude usage/)
  })
  it("row 58's signed record: the Feature Guide and the artifacts tip name Codex's /export", () => {
    expect(sec('draw')).toMatch(/Codex has no artifacts of its own: in a Codex session, Codex's \/export saves the conversation as Markdown/)
    expect(tipOf('tip.artifacts-button').variants.primary.body).toMatch(/in a Codex session, Codex's `\/export` saves the conversation as Markdown/)
  })
  it('the privacy policy says what a Codex report reads and sends', () => {
    expect(privacy).toMatch(/A report on a Codex account reads that account's own conversation files \(its sessions folder\) on this computer/)
    expect(privacy).toMatch(/to Codex's model, as one read-only run of the Codex command-line tool with no tools, on that account's own sign-in and allowance/)
    expect(privacy).toMatch(/the previous report's figures as numbers only/)
  })
  it("the privacy policy says what Run all's written analysis is sent, in both directions, and where that run is kept", () => {
    expect(privacy).toMatch(/It is sent the comparison the app computed, and nothing else: each account's name as the roll-up shows it \(which can be its email\), its reporting period, its figures, and the first three items of each of its top lists\./)
    expect(privacy).toMatch(/its most-used tool and MCP server names \(a name that is not a plain identifier is sent as "other"\), its languages, and the short goal summaries Codex wrote for its report\./)
    expect(privacy).toMatch(/when the analysis runs on Claude Code, all of it, the Codex accounts' part included, goes to Anthropic under that Claude Code account/)
    expect(privacy).toMatch(/when it runs on a Codex account, all of it, the other accounts' goal summaries and MCP server names included, goes to OpenAI under that Codex account/)
    expect(privacy).toMatch(/On Claude Code it runs with no tools, keeps no transcript and loads none of your own settings or instruction files/)
    expect(privacy).toMatch(/Codex keeps it in that account's sessions folder, as it keeps a report's run\./)
    expect(privacy).not.toMatch(/and no conversation text, the same way/)
  })
})

// [host] Usage track MP10: which account Claude usage counts under, said
// exactly, a resumed session included.
describe('Claude usage by account, said where Ask Conductor reads it (MP10)', () => {
  const pages = () => APP_KNOWLEDGE_SECTIONS.find((s) => s.id === 'pages')!.body
  const guide = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'docs', 'USER_GUIDE.md'), 'utf8').replace(/\s+/g, ' ')
  it('a resumed session moves on to its new profile, and a Not recorded one resumed under a profile takes that account for its earlier usage', () => {
    expect(pages()).toMatch(/a session resumed under another account profile counts toward that one from then on, and what it used before keeps its account\./)
    expect(pages()).toMatch(/with one exception: when a local session listed as Not recorded is later resumed in the app under an account profile, its earlier usage moves to that profile's account too\./)
    expect(guide).toMatch(/A session resumed under another account profile counts toward that one from then on; what it used before keeps its account\./)
    expect(guide).toMatch(/with one exception: when a local session that reads \*Not recorded\* is later resumed in the app under an account profile, its earlier usage moves to that profile's account too\./)
  })
})

// [host] The 2.1.1-beta.2 entry states the hardening this release ships, one
// line per guarantee, found by its highlight as the blocks above find it. The
// pins match key phrases, so a copy edit that keeps the guarantee keeps them.
describe('What\'s New (2.1.1-beta.2): the hardening it ships, as guarantees', () => {
  const top = changelog.find((e) => e.highlights?.startsWith('Codex becomes a full second assistant'))!
  const all = () => top.changes.map((c) => c.description).join('\n')
  it('lists each guarantee, in plain ASCII', () => {
    for (const said of [
      /When the app's settings cannot be read, the built-in tools stay off until they can\./,
      /refused once their session ends; an SSH Persistent session that stays running on its host keeps its own across a restart of the app\./,
      /A Codex review now runs without the Codex settings file or the rules files of the account it runs on\./,
      /Failure text from a review, a Codex Insights run, a Codex cloud agent or a Sentinel analysis that runs on Codex hides credentials written inside URLs and session values\./,
      /cloud agent that runs on Codex, keeps its Codex account in use until anything it left running has been ended\./,
      /On Windows a Codex session's PATH keeps only absolute folders/,
      /On Windows a Claude session's PATH keeps only absolute folders too, and so does the PATH of the terminals in which the app sets up Claude Code, runs its \/insights command or runs an install or update command you confirmed, and of a cloud agent, a Sentinel or Insights run, a Claude review or the check of whether one can run, the sign-in check, the Claude Code version check during onboarding, the list of versions to pin and a pinned version's install\./,
      /only in the folders PATH names or in the Windows system folder, never in the current folder\./,
      /A Claude Code or Codex session in a network folder that its claude\.cmd, claude\.bat or codex\.cmd launcher cannot start from is refused, with the reason \(see Known issues in the Feature Guide\)\./,
      /Ask Conductor's conversation list stays inside its help folder/,
      /Names and paths shown from outside the app drop more invisible characters\./,
      /Sentinel's proposed model entries follow the same name rule as the model picker\./,
      /A Claude Code config's extra CLI arguments are now held to a rule of the same shape as a Codex config's/,
      /and so is a word Claude Code would read as a command or as a server to run the session on, or that starts or ends with a comma\./,
      /extra CLI arguments now come after the app's own options on its start line\. On Windows each word reaches a local Claude Code session as one argument, exactly as typed\./,
      /With Claude Code on Windows installed as claude\.cmd \(npm's launcher\) or claude\.bat, the resume list hands options to Claude Code exactly as written, or starts nothing and says why \(see Known issues in the Feature Guide\)\./,
      /starts under your login shell when it is sh, bash, zsh, dash or ksh/,
      /finds Claude Code where that shell finds it when asked to run a command, so a PATH change made only in interactive shells, such as nvm\.fish's default node, is not seen \(see Known issues in the Feature Guide\)\./,
      /On macOS and Linux, a terminal tab whose shell is outside the sh family, such as fish or PowerShell, opens in its folder, and the app types no folder line into it\./,
      /A session's status bar shows only its own status updates\./,
      /the log says why, and a status line of your own still shows/,
      /starts nothing and says so; it never runs on another account in its place\./,
      /Closing or ending an SSH session removes the files the app last wrote for it from the host it wrote them to, when the app can reach that host with a key or a saved password/,
      /answer only the app's own window\./,
      /an account's sign-in is written only into folders the app has made readable by you alone and checked/,
      /A web sign-in you cancel or leave unfinished never stays signed in after a restart/,
      /only right after your own click, tap, Enter or Space in the view\./,
      /Signing in to chatgpt\.com inside the app reaches the sign-in pages of one more sign-in method\./,
      /Insights keeps its reports only in its own folder/,
      /Insights shows no report, rather than waiting, when a report cannot be read\./,
      /The cross-account roll-up's written analysis is shown as plain text\./,
      /The app starts normally even when the Insights catalogue cannot be updated or has been edited into another shape\./,
    ]) expect(all()).toMatch(said)
    for (const c of top.changes) expect(c.description, c.description.slice(0, 40)).toMatch(/^[\x20-\x7e]*$/)
    // No control has set agent templates since 2.1, so What's New (the entry's highlights and its
    // change lines) does not offer them.
    expect(`${top.highlights ?? ''}\n${all()}`).not.toMatch(/agent templates?/i)
  })

  it('the review line names only what the review leaves out by its own flags, and no handler line claims more than its own channels', () => {
    expect(all()).not.toMatch(/review[^.]*without[^.]*hooks/i)
    expect(all()).not.toMatch(/as the others do/)
  })
})

// [host] On Windows the npm commands the app runs, or shows to copy, start
// with npm.cmd: in PowerShell a plain npm runs npm.ps1, which the default
// script policy refuses. What's New and the Feature Guide say so.
describe('npm.cmd on Windows, in What\'s New (2.1.1-beta.2) and the Feature Guide', () => {
  const top = changelog.find((e) => e.highlights?.startsWith('Codex becomes a full second assistant'))!
  it('What\'s New says only the npm commands (Claude Code\'s install, Codex\'s install and update) start with npm.cmd on Windows', () => {
    const said = top.changes.map((c) => c.description).join('\n')
    expect(said).toMatch(/On Windows the npm commands \(Claude Code's install, Codex's install and update\), whether the app runs them or shows them to copy, start with npm\.cmd, so they work where PowerShell's script policy blocks npm\./)
    // Claude Code has no npm update command (its recipes install only).
    expect(said).not.toMatch(/npm install and update commands, for Claude Code and Codex alike/)
    // The publishers' own installers come first and are not npm commands.
    expect(said).not.toMatch(/the Codex install and update commands[^.]*start with npm\.cmd/)
  })

  it('the Feature Guide gives the Codex npm commands as npm.cmd on Windows', () => {
    const s = APP_KNOWLEDGE_SECTIONS.find((x) => x.id === 'providers')!.body
    expect(s).toMatch(/On Windows the npm commands start with npm\.cmd instead of npm \(npm\.cmd install -g @openai\/codex\), which runs in PowerShell even where its script policy blocks npm\./)
  })
})

// [host] What the 2.1.1-beta.2 hardening adds where Ask Conductor and the
// Feature Guide read it: the extra CLI arguments rule for Claude Code, a
// session whose account is gone, and each known issue it ships with, with
// its workaround.
describe('app knowledge for the 2.1.1-beta.2 hardening', () => {
  const body = (id: string) => APP_KNOWLEDGE_SECTIONS.find((s) => s.id === id)!.body
  it('says what a Claude Code config\'s extra CLI arguments refuse, and how to give a folder or a value', () => {
    const s = body('sessions')
    expect(s).toMatch(/For Claude Code, the extra CLI arguments come after the app's own options, and what the app sets, or what changes the conversation, where or how the session runs, its permission mode or the settings it reads, is refused, whether Claude Code's help lists it or not/)
    expect(s).toMatch(/--cloud, --bare and --safe-mode among them\./)
    expect(s).toMatch(/a word that starts with an address, a name and a colon as a web address does, which Claude Code can read as a server to run the session on: give a folder as --add-dir=docs, and an option's value after an = sign\./)
    expect(s).toMatch(/an option's value after an = sign\. So is a word that starts or ends with a comma: give a comma only inside a word, such as --allowedTools=Bash,Edit\./)
  })

  it('says a Claude session whose account is gone starts nothing, in the words the app shows', () => {
    expect(body('accounts')).toMatch(/starts nothing and says so: This session's Claude account is no longer set up here\. Choose an account for it and start it again\. It never runs on another account in its place\./)
  })

  it('each known issue it ships with carries its workaround', () => {
    const k = body('known-issues')
    for (const said of [
      /cannot start through its claude\.cmd or claude\.bat launcher, or codex\.cmd, so the app refuses it and says why\. Workaround: open the folder from a mapped drive letter, or install the native Claude Code or the standalone Codex\./,
      /Ask Conductor cannot start, on either assistant, when the resources folder's path holds a ; on Windows \(a : on macOS and Linux\) or a control character; it says so and starts nothing\. Workaround: choose a resources folder whose path has none\./,
      /With Claude Code on Windows installed as claude\.cmd \(npm's launcher\) or claude\.bat, a session that opens the resume list cannot pass an option that holds a % sign or a control character/,
      /holds a % sign or a control character: it starts nothing, and names the option where it can\. Workaround: remove the % sign, or install the native Claude Code\./,
      /other variables set only in that shell's own configuration are not passed on\. Workaround: set them in \.zshenv \(macOS\) or \.bashrc \(Linux\) in your home folder as well\./,
      /a folder added to PATH only in interactive fish shells, such as nvm\.fish's default node version, is not seen, and a Claude Code installed with npm under that node reads as not found\./,
      /Workaround: add the line nvm use --silent \$nvm_default_version to your config\.fish outside any is-interactive block\./,
      /also add Claude Code's folder to PATH in \.zprofile \(macOS\) or \.profile \(Linux; \.bash_profile if you have one\) in your home folder; until then the app may report Claude Code as not found/,
      /add the folder that holds it \(for Claude Code, the folder with claude\.exe, claude\.cmd or claude\.bat\) to your PATH as a full path, then restart the app\./,
      /only when you name it with \.\\ in front \(\.\\build\.cmd rather than build\.cmd\)\. Terminal tabs you open are unchanged\./,
      /a status line of your own still shows\. Workaround: choose a resources folder whose path has none of these\./,
      /give an option's value after an = sign when the value starts with letters and a colon/,
      /and write a list with no space after its commas \(--allowedTools=Bash,Edit rather than --allowedTools=Bash, Edit\)\./,
      /that account cannot be used and nothing is written there\. Workaround: make your Windows user the owner of AI Code Conductor's resources folder/,
      /resources folder \(the folder chosen for its data when it was set up\) and of everything in it \(in the folder's Properties, choose Security, then Advanced, change the owner and tick Replace owner on subcontainers and objects\), or move that folder to an NTFS disk, then restart the app\./,
      /make sure Windows PowerShell, whoami and icacls are allowed to run for your user/,
      /Insights runs only when the insights folder in your resources folder is a real folder, not a link or junction/,
      /and on macOS and Linux one you own whose permissions let only you write to it\./,
      /On macOS the app keeps your accounts' sign-in folders in your resources folder to you alone, and the Insights and Sentinel folders there writable only by you, through their owner and permissions\. That holds when the resources folder and the folder that holds it are on a volume that honours ownership/,
      /Workaround: keep the resources folder on your Mac's own disk, or on a drive whose Get Info has Ignore ownership on this volume turned off/,
      /On Windows, an account cannot be used when a file, folder or link directly in its own folder, its Claude Code folder or its identity copy belongs to another Windows account and the app can neither make it yours nor copy that folder into a new one of yours/,
      /but never a link, a sign-in file \(\.credentials\.json or \.claude\.json\) or a file with a second name \(a hard link\)\. Workaround: take ownership of it or remove it, then restart the app\./,
    ]) expect(k).toMatch(said)
    // Sessions start through node (the resume picker), so the native installer
    // alone does not help a user whose only node is an interactive-only one.
    expect(k).not.toMatch(/native Claude Code installer, which needs no node/)
  })

  it('says on macOS that the sign-in folders stay yours only while only you can write to the resources folder, and how to keep it so', () => {
    const k = body('known-issues')
    expect(k).toMatch(/That holds when the resources folder and the folder that holds it are on a volume that honours ownership, only you can write to them, and no access entry on them, or passed down to them from a folder above, lets another user in\./)
    expect(k).toMatch(/Ignore ownership on this volume turned off, as a folder only you can write to, and not inside a folder you have opened to other users with access entries/)
  })

  it('names each Windows program the sign-in folder check starts, so a check that gets no answer points at the right one', () => {
    const k = body('known-issues')
    expect(k).toMatch(/If the app cannot check those folders \(Windows PowerShell, or whoami or icacls, which the app starts when Windows PowerShell gives it no answer, did not answer in time or is not allowed to run\), it writes nothing there and says so/)
    expect(k).toMatch(/make sure Windows PowerShell, whoami and icacls are allowed to run for your user, since the app uses them to check those folders' rights\./)
  })
})

// [host] Installing from setup (owner decisions D1 to D4, 2026-10-10;
// ADR-024): both tools can be installed or updated with Run it for me or
// Copy, the publisher's own installer first and npm second, and the app
// finds a new install without a restart. What's New and the Feature Guide
// say so, in the words the app shows.
describe('installing from setup, in What\'s New (2.1.1-beta.2) and the Feature Guide', () => {
  const top = changelog.find((e) => e.highlights?.startsWith('Codex becomes a full second assistant'))!
  const body = (id: string) => APP_KNOWLEDGE_SECTIONS.find((s) => s.id === id)!.body

  it('What\'s New says both tools install from setup with Run it for me or Copy, the publisher\'s installer first, found without a restart', () => {
    const said = top.changes.map((c) => c.description).join('\n')
    expect(said).toMatch(/Claude Code and Codex can both be installed from setup\. Every install or update command has Run it for me, which runs it in a visible terminal once you confirm it, and Copy\./)
    expect(said).toMatch(/The tool's own installer comes first \(Anthropic's from claude\.ai, OpenAI's from chatgpt\.com\), and its confirmation says it downloads a script from there and runs it; npm comes second, and says so when Node\.js is not found\./)
    expect(said).toMatch(/Setup checks again when the command ends, also when it fails or you press Ctrl\+C on Windows, and finds the new install without restarting the app\./)
    expect(said).toMatch(/Settings, Accounts and the CLI help at the foot of the window offer the same\. The setup screens where you choose the app's folders and install and set up Claude Code have Exit; the pages after them do not\./)
    expect(said).not.toMatch(/The first-run setup screens that check for Claude Code have Exit/)
    expect(said).not.toMatch(/Every setup screen has Exit/)
  })

  it('the Feature Guide says how the install commands run, in order, and when the app looks again', () => {
    const p = body('providers')
    expect(p).toMatch(/When Claude Code or Codex is missing, or Codex is too old, its row lists the install or update commands from the publisher's own instructions, each with Run it for me and Copy\./)
    expect(p).toMatch(/The publisher's own installer comes first \(for Claude Code, Anthropic's native installer from claude\.ai; for Codex, OpenAI's installer from chatgpt\.com\), then npm/)
    expect(p).toMatch(/Run it for me asks first, and for an installer it says that it downloads a script from that site and runs it; then it types the command into a visible terminal tab, never with administrator rights, and checks again when the command ends\./)
    expect(p).toMatch(/An npm command needs Node\.js: when Node\.js is not found, it says so and its Run it for me is off, while Copy still works\./)
    expect(p).toMatch(/On Windows, Check again and the check after an install first read the PATH Windows now gives new programs, so a tool installed while the app was open is found without restarting it\./)
    expect(p).not.toMatch(/the app never runs them/)
  })

  it('the Feature Guide says the setup screen installs Claude Code and carries on, with Check again and Exit, and never a restart that cannot help', () => {
    expect(body('providers')).toMatch(/If Claude Code is not installed, the first setup screen says so and lists its install commands, Anthropic's native installer first and npm second, each with Run it for me and Copy: Run it for me runs the command in a terminal on that screen once you confirm it, and setup checks again when it ends and carries on as soon as Claude Code is found\./)
    const t = body('troubleshooting')
    expect(t).toMatch(/The page lists the install commands, each with Run it for me and Copy, says which check it ran, and has Check again; setup checks again by itself when a command it ran ends, and carries on once Claude Code is found\./)
    // 2.1.1-beta.3: the pages after the setup screens have the window's own buttons.
    expect(t).toMatch(/The setup screens where you choose the app's folders and install and set up Claude Code have Exit, which closes the window \(and quits the app on Windows and Linux\)\. These screens and the pages after them/)
    expect(t).toMatch(/all have the window's own minimize, maximize and close at the top right on Windows and Linux/)
    expect(t).not.toMatch(/the pages after them do not/)
    expect(t).not.toMatch(/The first-run setup screens that check for Claude Code have Exit/)
    expect(t).not.toMatch(/Every setup screen has Exit/)
    expect(t).not.toMatch(/restart the app so it picks up the new PATH/)
    expect(t).not.toMatch(/gives you the install command to copy/)
  })
})

// The PATH finding of the first-run test (2026-10-10; ADR-024): Anthropic's
// installer leaves Claude Code in its own folder, off PATH. What's New, the
// Feature Guide, the tour, the tips and Known issues say what the app does
// then, in the words it shows, and none still says the commands are only to
// copy.
describe("an installer's folder off PATH, in What's New, the Feature Guide, the tour, the tips and Known issues", () => {
  const top = changelog.find((e) => e.highlights?.startsWith('Codex becomes a full second assistant'))!
  const body = (id: string) => APP_KNOWLEDGE_SECTIONS.find((s) => s.id === id)!.body

  it("What's New says setup names the folder and adds it to PATH on Windows, or shows the line elsewhere", () => {
    const said = top.changes.map((c) => c.description).join('\n')
    expect(said).toMatch(/Anthropic's installer does not put its folder on your PATH: setup then says Claude Code is installed there, and on Windows Add it to PATH for me adds that one folder to your PATH; on a Mac or Linux it shows the line to add to your shell file\./)
    expect(said).not.toMatch(/install or update commands from OpenAI's own instructions to copy/)
    expect(said).not.toMatch(/can run the npm or Homebrew install or update command/)
  })

  it('the Feature Guide names the folder, Add it to PATH for me and Not now, the shell line, and when a restart helps', () => {
    const p = body('providers')
    expect(p).toMatch(/Anthropic's native installer puts Claude Code in %USERPROFILE%\\\.local\\bin on Windows \(~\/\.local\/bin on a Mac or Linux\) and does not add that folder to your PATH\./)
    // 2.1.1-beta.3 (F5): Copy gives a command to run once.
    expect(p).toMatch(/on Windows, Add it to PATH for me adds that one folder to the end of your PATH for your Windows account and checks again, and Not now leaves your PATH as it is; on a Mac or Linux it shows a command to run once in a terminal, with Copy, which adds the folder to the shell file your login shell reads; the app never changes that file itself\./)
    expect(p).toMatch(/The app advises quitting and starting it again only when that would help/)
  })

  it('Known issues carries the live workarounds this ships with', () => {
    const k = body('known-issues')
    expect(k).toMatch(/On a Mac or Linux, an npm install command can say Node\.js was not found when Node\.js is set up only in your interactive shell file/)
    expect(k).toMatch(/Workaround: press Copy and run the command in a terminal, or use the installer listed first, which does not need Node\.js\./)
    expect(k).toMatch(/On a Mac or Linux, pressing Ctrl\+C in an install tab can leave that tab at a shell prompt, so the app does not check again by itself\. Workaround: press Check again, or type exit in the tab\./)
  })

  it('the tour and the tips say each command has Run it for me and Copy, not only Copy', () => {
    const highlights = trainingSteps.flatMap((t) => (t as { highlights?: string[] }).highlights ?? []).join('\n')
    expect(highlights).toMatch(/Its row lists the install or update commands, the publisher's own installer first, each with \*\*Run it for me\*\* and \*\*Copy\*\*/)
    expect(highlights).not.toMatch(/install or update commands to copy, then \*\*Check again\*\*/)
    const tips = JSON.stringify(TIPS_LIBRARY)
    expect(tips).toMatch(/each with \*\*Run it for me\*\* and \*\*Copy\*\*\. Run it for me checks again when the command ends/)
    expect(tips).not.toMatch(/install or update command to copy, then \*\*Check again\*\*/)
  })

  it('the known issue for Codex review on the sign-in already on this computer says where the app explains it, and keeps its workaround', () => {
    const k = body('known-issues')
    expect(k).toMatch(/Until you add a Codex account, Claude sessions have no Codex review\. The Codex review row in Settings, General, Built-in Tools says why, and so does the Codex section of Settings, Accounts, under Code reviews use, with the next step\./)
    expect(k).toMatch(/The workaround: add a Codex account in Settings, Accounts \(Add Codex account\), then choose Make reviewer in its menu if the sign-in already on this computer is still your default\./)
  })
})

// The 2.1.1-beta.3 surface sweep: what the beta.3 fixes made true is said where
// Ask Conductor and the Feature Guide read it, the retired Codex sign-in is
// described only as something a 2.1.1-beta.2 user may still have, and every
// known issue it ships with carries its workaround.
describe('app knowledge after the 2.1.1-beta.3 sweep', () => {
  const body = (id: string) => APP_KNOWLEDGE_SECTIONS.find((s) => s.id === id)!.body

  // F19: "plain" means Terminal only. An SSH session is named by
  // what a dropped link does to it, never as a plain one.
  it('no entry calls an SSH or remote session plain', () => {
    for (const s of APP_KNOWLEDGE_SECTIONS) {
      expect(`${s.title} ${s.body}`, s.id).not.toMatch(/\bplain (ssh|remote|session)\b/i)
    }
  })

  it('a Codex account is always added in the app; the computer\'s own sign-in is only a beta.2 leftover with no Sign in again', () => {
    expect(body('providers')).not.toMatch(/or lets you use the Codex sign-in already on this computer/)
    const c = body('codex')
    expect(c).not.toMatch(/can be used too, but the app never takes it in on its own/)
    expect(c).toMatch(/a Codex account is always one you add in the app/)
    expect(c).toMatch(/Only 2\.1\.1-beta\.2 offered Use this sign-in/)
    expect(c).toMatch(/Replace this sign-in with a Codex account/)
    expect(c).toMatch(/Sign in again is not offered on it\./)
    expect(c).not.toMatch(/signs it in again in place/)
    expect(c).toMatch(/Sign Codex out on this computer\.\.\., at the end, signs the Codex CLI out everywhere on this computer/)
  })

  // Owner decision 3 (2026-10-11): a 2.1.0 Codex user adds an app-managed
  // account once, and is told only what really reaches the earlier history.
  it('a 2.1.0 Codex user adds a Codex account once, and codex resume in a terminal reaches the earlier conversations', () => {
    const c = body('codex')
    expect(c).toMatch(/a 2\.1\.0 Codex user adds a Codex account once, in the app/)
    expect(c).toMatch(/run codex resume/)
    expect(c).toMatch(/for the Codex CLI to resume, not the app/)
  })

  it('an SSH session\'s partner runs on the host, and Alt+V types nothing into it', () => {
    expect(body('sessions')).toMatch(/On an SSH session it is a plain shell on the session's host/)
    expect(body('shortcuts')).toMatch(/an SSH session's partner shell \(it runs on the host\)/)
  })

  it('these known issues ship with their workarounds', () => {
    const k = body('known-issues')
    expect(k).toMatch(/With session-log indexing turned off, a restored tab can come back to the resume picker instead of its own conversation\. Pick the conversation there, or run \/resume in the tab\./)
    expect(k).toMatch(/On a host whose sign-in banner, message of the day or shell startup draws a box with rounded corners, partner command buttons type nothing/)
    expect(k).toMatch(/where partner buttons type nothing, type the command in the partner view/)
    expect(k).toMatch(/After a crash, the app's Something went wrong page has no minimize, maximize or close buttons on Windows and Linux/)
    expect(k).toMatch(/Press Try to recover to go back to the app, or close the window with Alt\+F4 or from the taskbar\./)
  })

  it('the other beta.3 known issues carry their workarounds', () => {
    const k = body('known-issues')
    for (const said of [
      /type the command at the prompt yourself: \/compact, \/model followed by the model, or \/effort followed by the level\./,
      /Constrained Language Mode/,
      /A restored tab of a Codex session that ran on the Codex sign-in already on this computer/,
      /choose Launch in that confirmation instead, then use Switch account on the running session/,
      /Windows remote hosts do not raise the attention indicator in this release\. Workaround: keep the session visible/,
      /when node is only a shell alias \(for example alias node=nodejs\)/,
      /PowerShell profile that takes more than about 10 seconds to load/,
    ]) expect(k).toMatch(said)
    expect(body('troubleshooting')).toMatch(/Without Node\.js a new session starts Claude Code or Codex directly, with no resume list\./)
  })

  // The installer (O4): where the Data and Resources folders are chosen,
  // and that an upgrade preselects every page rather than skipping any.
  it('says what the Windows installer asks, in order, and that an upgrade preselects each page', () => {
    const p = body('providers')
    expect(p).toMatch(/On Windows the installer opens with a Welcome page, then asks for the Data folder \(sessions, logs and configuration data\) and the Resources folder/)
    expect(p).toMatch(/On an upgrade, every one of those pages comes up with the earlier install's choices already selected\./)
    expect(p).not.toMatch(/unless an earlier install already settled it/)
  })
})

// The 2.1.1-beta.3 tips: none offers the computer's own Codex sign-in or Sign
// in again on it, the Feature Guide tip describes What's New as it now works,
// and the partner and SSH marks are worded as the code behaves.
describe('tips after the 2.1.1-beta.3 sweep', () => {
  const tip = (id: string) => TIPS_LIBRARY.find((t) => t.id === id)!.variants.primary
  const titled = (title: string) => TIPS_LIBRARY.find((t) => t.variants.primary.title === title)!.variants.primary
  it('no tip offers the Codex sign-in already on this computer, or Sign in again on it', () => {
    const all = JSON.stringify(TIPS_LIBRARY)
    expect(all).not.toMatch(/already on this computer \(in `~\/\.codex`/)
    expect(all).not.toMatch(/on its row, which first signs out every app that uses that sign-in/)
    expect(titled('Check Sign-in and Sign In Again').body).toMatch(/\*\*Sign in again\*\* is not offered on it\./)
    expect(titled('Hello Codex, Again').body).not.toMatch(/does not count/)
  })
  it("the Feature Guide tip says an update shows a short summary, and the full notes stay in What's New", () => {
    const b = titled('Feature Guide').body
    expect(b).not.toMatch(/the same notes you are shown after an update/)
    // Owner rule (2026-10-11): every prerelease of a release shows its whole
    // story, so the tip says so, as the Feature Guide and the README do.
    expect(b).toMatch(/After an update you see a short summary of what is new since the version you came from, and every prerelease of a release shows that release's whole story/)
    expect(b).not.toMatch(/since your last version/)
    const top = changelog.find((e) => e.version === '2.1.1-beta.3')!
    expect(top.highlights).toMatch(/What's New shows what is new since the release you came from, and every prerelease of 2\.1\.1 shows the whole 2\.1\.1 story\./)
    expect(top.highlights).not.toMatch(/only what is new since the version you came from/)
  })
  it('the remote attention tip names the host classes it covers, as the changelog and the known issues do', () => {
    const b = tip('tip.remote-attention').body
    expect(b).toMatch(/An SSH session to a Linux or macOS host lights the attention indicator when Claude is waiting on you, just like a local one\./)
    expect(b).toMatch(/Windows hosts are not covered yet\./)
  })
  it('the partner, SSH and Node.js tips say what the code does', () => {
    expect(tip('tip.partner-terminal').body).toMatch(/On an SSH session it is a plain shell on the host, in the config's remote folder there/)
    expect(tip('tip.partner-terminal').body).not.toMatch(/home for SSH sessions/)
    expect(tip('tip.ssh-persistence').body).not.toMatch(/for a plain one/)
    expect(tip('tip.resume-list-needs-node').body).toMatch(/Without Node\.js the session starts Claude Code or Codex directly instead/)
    expect(tip('tip.claude-powershell-profile').body).toMatch(/restart the app so it looks again/)
  })
  it('the partner card says an SSH session\'s partner runs on the host, and the What\'s New marks line names SSH by its kind', () => {
    const card = JSON.stringify(trainingSteps.find((s) => s.id === 'combined-mode')!)
    expect(card).not.toMatch(/at home over SSH/)
    expect(card).toMatch(/on an SSH session it runs on the host, in the config's remote folder/)
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'src', 'renderer', 'onboarding', 'WhatsNewV2Step.tsx'), 'utf8')
    expect(src).not.toMatch(/Plain SSH, persistent and container sessions/)
  })
})

// The 2.1.1-beta.3 README and user guide: the computer's own Codex sign-in is
// no longer offered, Node.js is optional, the pages after setup have the
// window's own buttons, and codex resume reaches the earlier Codex history.
describe('README and user guide after the 2.1.1-beta.3 sweep', () => {
  const root = path.resolve(__dirname, '..', '..', '..')
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
  const guide = fs.readFileSync(path.join(root, 'docs', 'USER_GUIDE.md'), 'utf8').replace(/\s+/g, ' ')
  it('the README no longer offers the computer\'s own Codex sign-in, and says Node.js is optional', () => {
    expect(readme).not.toMatch(/can be used too, confirmed at each launch/)
    expect(readme).not.toMatch(/used only after you choose \*\*Use this sign-in\*\*/)
    expect(readme).toMatch(/Codex accounts are always added in the app, as Claude accounts are/)
    expect(readme).toMatch(/`codex resume` in a terminal picks them up/)
    expect(readme).toMatch(/\| \*\*Node\.js\*\* \(optional\) \|/)
  })
  it('the README security table and remote paragraph say no more than is true', () => {
    // A session on an account 2.1.1-beta.2 registered for ~/.codex does sign in
    // from it once the launch is confirmed, so "never used for sign-in" was false.
    expect(readme).not.toMatch(/`~\/\.codex` is never used for sign-in/)
    expect(readme).toMatch(/Your own `~\/\.codex` is no longer offered as an account; one that 2\.1\.1-beta\.2 registered for it is used for a session only when you confirm that launch, and never for a review/)
    // Windows remotes report status like the others but do not raise attention yet.
    expect(readme).not.toMatch(/macOS remotes all behave identically/)
    expect(readme).toMatch(/Windows, Linux and macOS remotes all report status identically/)
  })
  it('the user guide: window buttons after setup, no Sign in again on the retired sign-in, and codex resume', () => {
    expect(guide).not.toMatch(/the pages after them do not/)
    expect(guide).toMatch(/all have the window's own minimize, maximize and close at the top right on Windows and Linux/)
    expect(guide).toMatch(/\*\*Sign in again\*\* is not offered on it\./)
    expect(guide).toMatch(/run `codex resume`/)
    expect(guide).toMatch(/Node\.js is optional for running sessions\./)
  })
})

// The 2.1.1-beta.3 text pass before the code freeze. Each case pins one of
// its changes.
describe('surfaces after the 2.1.1-beta.3 text pass', () => {
  const root = path.resolve(__dirname, '..', '..', '..')
  const all = APP_KNOWLEDGE_SECTIONS.map((s) => s.body).join('\n')
  const tip = (id: string) => TIPS_LIBRARY.find((t) => t.id === id)!.variants.primary
  const guide = fs.readFileSync(path.join(root, 'docs', 'USER_GUIDE.md'), 'utf8').replace(/\s+/g, ' ')
  const when = 'on the Claude Code row in Settings, Accounts when it shows one'
  const body = (id: string) => APP_KNOWLEDGE_SECTIONS.find((s) => s.id === id)!.body

  // The Claude Code row offers Check again only while Claude Code is missing,
  // unchecked or unusable (ProvidersCard offersCheckAgain), so wherever Claude
  // Code is found the step is a restart, and Check again is only conditional.
  it('restart the app is the step where Claude Code is found, and Check again only where the row shows one', () => {
    const p = tip('tip.claude-powershell-profile').body
    expect(p).not.toMatch(/After you change the profile, press \*\*Check again\*\* in \*\*Settings, Accounts\*\*/)
    expect(p).toMatch(/After you change the profile, restart the app so it looks again \(or press \*\*Check again\*\* on the Claude Code row in \*\*Settings, Accounts\*\* when it shows one\)\./)
    const n = tip('tip.resume-list-needs-node').body
    expect(n).not.toMatch(/press Check again on a setup page/)
    expect(n).toContain(`On Windows, restart the app after installing (or press Check again ${when}), then open a new session to get the list back.`)
    expect(all).not.toMatch(/restart the app or press Check again on a setup page \(or in Settings\)/)
    expect(all).not.toMatch(/until you press Check again in Settings, Accounts \(or restart the app\)/)
    expect(all).not.toMatch(/If you change your profile, press Check again\./)
    expect(all).not.toMatch(/Check again on a setup page/)
    expect(all).toContain(`add the folder that holds node.exe to your PATH for your Windows account, then restart the app (or press Check again ${when}), or in a Claude Code session type /resume.`)
    expect(all).toContain(`after you install Node.js, restart the app before you open a new session (or press Check again ${when})`)
    expect(all).toContain('It asks once and keeps the answer until you restart the app or press Check again')
    expect(all).toContain(`If you change your profile, restart the app (or press Check again ${when}).`)
    expect(all).toContain(`Sessions keep using the Claude Code the app found until you restart the app (or press Check again ${when}).`)
    expect(guide).not.toMatch(/It asks once: press \*\*Check again\*\* after you change your profile\./)
    expect(guide).not.toMatch(/or press \*\*Check again\*\* on a setup page before opening a new session/)
    expect(guide).toContain('It asks once: after you change your profile, restart CCC (or press **Check again** on the Claude Code row in Settings, Accounts when it shows one).')
    expect(guide).toContain('On Windows, after you install Node.js, restart CCC before opening a new session (or press **Check again** on the Claude Code row in Settings, Accounts when it shows one).')
  })

  // A Codex account has no second try with new folders, so its sentence must
  // not follow the Claude-only one with "the same applies".
  it('the Codex account folder sentence stands on its own, after the Claude Code rebuild sentence', () => {
    expect(all).not.toMatch(/The same applies to a Codex account's folder/)
    expect(all).toContain("only when that fails too is the account refused, and it cannot sign in until the folders are fixed as above. If the app cannot make a Codex account's new sign-in folder readable by you alone, adding the account, or signing it in again, stops with The account folder could not be prepared., and the app's log says which folder could not be made private and why.")
  })

  const beta3 = () => changelog.find((e) => e.version === '2.1.1-beta.3')!.changes
  it("What's New for 2.1.1-beta.3 says the gh fallback of the update check finds new releases", () => {
    expect(beta3()).toContainEqual({ type: 'fix', description: 'Update checks that fall back to the GitHub command-line tool (gh) now find new releases.' })
  })

  // 2.1.1-beta.2 already saved a drive root whole; what changed is that %, !
  // and a backtick are no longer taken out. Saving the folder is not the
  // status line setup, whose own limit on those characters still stands.
  it("What's New for 2.1.1-beta.3 says a folder path holding %, ! or a backtick is saved as chosen, and the status line limit stays", () => {
    expect(beta3()).toContainEqual({ type: 'fix', description: 'On Windows, a data or resources folder whose path holds a percent sign (%), an exclamation mark (!) or a backtick is now saved exactly as you chose it. Before, the app left those characters out when it saved the folder, so after a restart it could look in a different folder.' })
    const savingRows = beta3().filter((c) => /saved exactly as you chose it|now saves correctly/.test(c.description))
    expect(savingRows).toHaveLength(1)
    for (const c of savingRows) expect(c.description).not.toMatch(/drive root/i)
    expect(all).toContain("The app's status line is not set up when the path of the resources folder or of your home folder holds a $, a backtick, a double quote or a control character, or a % or ! on Windows, or a backslash on macOS and Linux; the log says so, and a status line of your own still shows. Workaround: choose a resources folder whose path has none of these. A home folder path that holds one has no workaround yet.")
  })

  // aicc_planning#87: tmux's scrollback view keeps an offset from the bottom,
  // not a place in the history, so it drifts while output arrives. A local
  // session holds still, so "exactly as local" was not true.
  it('the SSH Persistent wheel entry no longer says exactly as local, and scrolling back during output is a known issue with its workaround', () => {
    expect(all).not.toMatch(/exactly as it scrolls local history/)
    expect(all).toContain('the wheel scrolls back through remote history, and no arrow key is sent. Unlike local history, that view does not hold your place while output is still arriving (see the entry on scrolling back during output, below).')
    expect(all).toContain('Scrolling back in an SSH Persistent session while output is still arriving does not hold your place.')
    expect(all).toContain('Nothing is lost: it is still in the history, further up. Workaround: let the output finish before you scroll back, or scroll further up to find your place again.')
  })

  // The dialogs check the command and each argument field on their own, but
  // the launch fills in the joined line, so a backslash in one field leaves a
  // {secret} in another unfilled with no warning at save.
  it('a {secret} left unfilled by a backslash or backtick in another field is a known issue with its workaround', () => {
    expect(body('known-issues')).toContain('A {secret} in a terminal config\'s command, or a command button\'s command, is left as written when another field of the same command (its arguments) holds a backslash or a backtick, or the other way round, and the dialog does not warn when you save. Workaround: use forward slashes in paths, and no backticks, anywhere in the command and its arguments.')
  })

  // F16: macOS and Linux share one rule (secureFoldersPosix, the 0700
  // sign-in folders, the Insights and Sentinel owner checks): the folder's
  // own owner and permissions. So both say only when that holds, never more.
  it('says on Linux, as on macOS, only when the sign-in folders are yours alone, with the folder that holds the resources folder in the condition', () => {
    const k = body('known-issues')
    expect(k).toContain('That holds when the resources folder and the folder that holds it are on a volume that honours ownership, only you can write to them, and no access entry on them, or passed down to them from a folder above, lets another user in.')
    expect(k).toContain("On Linux the app keeps your accounts' sign-in folders in your resources folder to you alone, and the Insights and Sentinel folders there writable only by you, through their owner and permissions. That holds when the resources folder and the folder that holds it are on a volume that honours file ownership and permissions, and only you can write to them. Workaround: keep the resources folder on a Linux file system, in a folder only you can write to (inside your home folder, for example), not on a FAT, exFAT or NTFS drive or a network share mounted without file permissions.")
    expect(k.indexOf('On Linux the app keeps')).toBeGreaterThan(k.indexOf('On macOS the app keeps'))
  })
})

// The 2.1.1-beta.3 fixes: one coherent pass over the user-facing text of
// every fix since that text pass. The What's New entry is grouped by area,
// every note lands where Ask Conductor reads it, two corrections hold (no
// Skip during connect, and a project file the app does not add is never said
// not to run), and each known issue that ships carries its workaround.
describe('surfaces after the 2.1.1-beta.3 fixes', () => {
  const body = (id: string) => APP_KNOWLEDGE_SECTIONS.find((s) => s.id === id)!.body
  const all = APP_KNOWLEDGE_SECTIONS.map((s) => s.body).join('\n')
  const rows = () => changelog.find((e) => e.version === '2.1.1-beta.3')!.changes.map((c) => c.description)
  const at = (re: RegExp) => rows().findIndex((d) => re.test(d))
  const together = (re: RegExp) => {
    const hits = rows().map((d, i) => (re.test(d) ? i : -1)).filter((i) => i >= 0)
    expect(hits.length, String(re)).toBeGreaterThan(0)
    expect(hits[hits.length - 1] - hits[0] + 1, `${re} rows sit together`).toBe(hits.length)
  }

  it("What's New for 2.1.1-beta.3 lists the fixes, in plain ASCII", () => {
    for (const said of [
      "An SSH session's status line no longer misses an update that arrives split across two reads.",
      'On an SSH session, terminal output that follows an incomplete status line marker is now shown at once',
      "On Windows, a new session's resume list now always starts the Node.js the app found, or skips the list and says why in the app's log",
      'On Windows, Claude Code now starts in a project folder whose name holds [ or ] (for example app[v2]).',
      'First-run setup no longer moves on as if a folder were set when it was not saved. If a folder is empty, is not a full path, or cannot be created or saved, the folder step stays open and says which folder',
      "the resume picker resumes a worktree's conversation in the folder that was checked when the session started",
      'and does not resume one in a worktree whose folder was missing when the session started (see Known issues in the Feature Guide).',
      "an SSH session to a Linux or macOS host now also gets the remote project's own Claude Code hooks added to its settings file",
      "a session now adds to its settings file the project's Claude Code hooks from the same files Claude Code reads for it",
      'Claude Code hooks in a settings file saved with a UTF-8 byte-order mark, or as UTF-16LE, now run in sessions the app starts',
      'An SSH session now reads your ~/.claude/settings.json on a Linux, macOS or Windows host as Claude Code does',
      'A Claude Code verdict still waiting when its session ends or restarts gets that notice too',
      "in a Claude Code cloud agent's error output and in an Insights run's terminal output, as other failure text does, also when one arrives split across two reads.",
      'When you quit the app, a check or run that is waiting on that first run, or asks for one then, no longer goes on to start.',
      'Once the app has started quitting, the Claude Code setup terminal, background Claude Code runs, cloud agents and the account sign-in check no longer start',
      'on Windows, when another program, such as a sync, backup or antivirus tool, has the old copy open, the app writes the new contents into that copy instead',
      "The app's status line, the resume list and Codex's hooks now start only from the app's own copy of their scripts.",
      'or in place of the lib folder the Codex resume list loads its helper from',
      'A Claude Code version pinned in an older release is no longer used; sessions and cloud agents start your installed Claude Code.',
      "It opens in the config's remote folder once it recognises the host's first shell prompt",
    ]) expect(rows().some((d) => d.includes(said)), said).toBe(true)
    for (const gone of [
      /found walking up/,
      /The app holds it until the turn ends, and only sends it early if two minutes pass/,
      /Once the app is quitting, nothing that is waiting on that first run/,
      /now always stops the setup terminal/,
      /The app's log line for a Claude Code cloud agent's error output/,
      /SSH sessions now also run the remote project's own Claude Code hooks \(from its/,
      /\(on Windows\) its path cannot be saved in the registry/,
      /set to an older Claude Code version now runs that version/,
    ]) expect(rows().some((d) => gone.test(d)), String(gone)).toBe(false)
    for (const d of rows()) expect(/^[\x20-\x7e]*$/.test(d), `non-ASCII: ${d.slice(0, 60)}`).toBe(true)
  })

  // These rows and entries were reworded for beta.3. Pin them whole, so a later
  // change to any of them is made here on purpose too.
  it("What's New for 2.1.1-beta.3: the Windows launch, resume picker and helper script rows, and their known issues, read exactly as approved", () => {
    for (const exact of [
      "On Windows, a new session's resume list now always starts the Node.js the app found, or skips the list and says why in the app's log, and a session that uses the npm-installed Claude Code looks for Node.js only in the folders PATH names by their full path, even after your PowerShell profile has changed PATH.",
      "On Windows, Claude Code now starts in a project folder whose name holds [ or ] (for example app[v2]). When Claude Code itself is installed in a folder whose path holds [ or ], a session that starts it directly stops and says why; install Claude Code in a folder without them.",
      "Managed accounts: the resume picker resumes a worktree's conversation in the folder that was checked when the session started, also when the worktree is reached through a link, and does not resume one in a worktree whose folder was missing when the session started (see Known issues in the Feature Guide).",
      "At start, each of the app's helper scripts in the resources folder is brought up to date on its own, so one that cannot be put in place no longer holds the others back. A changed script is put in place as a new file; on Windows, when another program, such as a sync, backup or antivirus tool, has the old copy open, the app writes the new contents into that copy instead, so it is still brought up to date. On macOS and Linux a copy whose permissions were loosened is replaced with one only you can read.",
      "The app's status line, the resume list and Codex's hooks now start only from the app's own copy of their scripts. If something else sits in the scripts folder in a script's place, or in place of the lib folder the Codex resume list loads its helper from, the session starts directly, without the app's status line, or without hooks, and the app log names the file or folder.",
    ]) expect(rows(), exact.slice(0, 60)).toContain(exact)
    const entries = APP_KNOWLEDGE_SECTIONS.flatMap((s) => s.body.split('\n'))
    for (const exact of [
      "On Windows, a folder path that holds [ or ] limits how a Claude Code session can start. When Claude Code is installed in such a folder, a session that starts it directly stops and says why; a session that opens the resume list is not affected. When the Node.js found on PATH is in such a folder, a new Claude Code session starts Claude Code directly, without the resume list, and the app log says so. Workaround: install Claude Code and Node.js in folders without [ or ].",
      "On Windows, the npm-installed Claude Code can say node is not recognized when your PowerShell profile adds Node.js to PATH only by a relative folder (such as node_modules\\.bin or .): a session that starts it looks for Node.js only in the folders PATH names by their full path. Workaround: add the Node.js folder to PATH by its full path (such as the nodejs folder in Program Files), or install the native Claude Code.",
      "A new session opened without the resume list or the app's status line, or a Codex session had no hooks, and the log names a script file or folder. The app runs its status line, the resume list and a Codex session's hooks only from its own copy of each script in the scripts folder inside your resources folder. If something else sits there in a script's place (a folder, a symbolic link or junction, or a second name for the same file), the app does not run it: the session starts directly, without the app's status line, or without hooks, and the app log has one line naming the file. The app puts its own copy back at the next start on its own, a copy marked read-only included, except where a folder that is not empty sits in a script's place: the app never deletes what a folder holds. To fix it, close the app, move that folder out of the scripts folder, and start the app again.",
      "The same goes for the lib folder inside the scripts folder, which a Codex session's resume list loads a helper from: if anything other than a plain folder sits there (a symbolic link, a junction or a file), the resume list is skipped, Codex starts directly, and the app log says the scripts/lib folder is not a real folder. At the next start the app removes a link there (never what it points to) and puts a plain folder in its place, and the resume list is back from the start after that: restart the app once more if it is still missing. A file there, or a folder it cannot replace, it leaves alone, and the log says the lib folder could not be made a real folder: close the app, move that file or folder out of the scripts folder, and start the app again.",
      "If the app could not bring one of these scripts up to date at start (for example another program held the old copy open), it does not run that copy: the log says the script could not be brought up to date this run, and sessions start without what it serves until the app starts again. Close the other program, or let it finish, then restart the app.",
    ]) expect(entries, exact.slice(0, 60)).toContain(exact)
  })

  it("What's New for 2.1.1-beta.3 is grouped by area", () => {
    const sentinel = /^(Sentinel |The same goes for Codex model notices|A copied Sentinel |A Sentinel model notice|With Codex on and no Codex check|When Sentinel's )/
    expect(rows().filter((d) => sentinel.test(d)).length).toBe(6)
    together(sentinel)
    together(/^Agent Canvas:/)
    together(/partner/i)
    together(/Claude Code hooks|settings\.json/)
    together(/helper scripts|their scripts/)
    together(/^Managed (sessions|accounts)/)
    // The folder-saving row sits with first-run setup, not at the end.
    expect(at(/is now saved exactly as you chose it/) + 1).toBe(at(/^First-run setup no longer moves on as if a folder were set/))
    expect(at(/^Codex accounts are now always added in the app/)).toBe(0)
    expect(at(/fall back to the GitHub command-line tool/)).toBe(rows().length - 1)
  })

  it("the SSH partner: the Feature Guide says when it opens in the remote folder, and Known issues has the cases and their workarounds, with no Skip", () => {
    expect(body('sessions')).toContain("opening in the config's remote folder there once it recognises the host's first shell prompt: one that ends in $, #, >, ~, or a % on its own or after a space, as long as you have not typed anything in the partner before then (a password typed by hand counts). Otherwise it opens in your home folder there, and you can type cd and the folder (see Known issues and workarounds, which also covers a Mac host whose shell is zsh).")
    const k = body('known-issues')
    for (const said of [
      "It opens in the config's remote folder only when it recognises the host's first shell prompt as that prompt appears: a prompt that ends in $, #, >, ~, or a % on its own or after a space",
      'a zsh prompt whose % follows other text directly (such as box% or [user@box]~%) included',
      'when the first prompt, or the line just above it, names a sign-in word (password, passphrase, passcode, a one-time, verification or authenticator code, OTP, TOTP, token, PIN, 2FA or MFA)',
      'when the app typed a saved password and the shell prompt that follows is only $, #, > or %, or a two-line prompt whose last line is only one of them',
      'or a two-line prompt whose last line is only one of them. With a bare prompt like that after a saved password, the partner can take up to about 13 seconds to settle;',
      'It types that folder line (cd and the folder) only before you type anything in the partner: the first key you type there (a letter, Enter, an arrow key or a paste), or a password you type there by hand, gives the line up for that connection, so it never lands in a command you are typing.',
      'the partner can take that prompt for its shell and type its folder line into it; answer the prompt again, then type cd and the folder at the shell.',
      'if the prompt then says the password was wrong, that line was taken as the password, which counts as one attempt.',
      "where it did not type the saved password, type the password at the partner's prompt yourself, then type cd and the folder;",
    ]) expect(k).toContain(said)
    // The UI offers no Skip while a partner connects.
    for (const s of APP_KNOWLEDGE_SECTIONS) expect(s.body, s.id).not.toMatch(/After Skip|press(es|ed)? Skip during connect/)
    const partner = k.slice(k.indexOf("An SSH session's partner shell is a connection of its own"))
    expect(partner.slice(0, partner.indexOf('\n'))).not.toMatch(/\bSkip\b/)
  })

  // Live run at 3ecc8230: on a macOS host whose shell is zsh, reached from the
  // app on Windows, the partner opened in the home folder at 80 and 200
  // columns. The prompt arrives redrawn with cleared rows after it, so the
  // read ends in an empty line, partnerPromptTail reads '' and the idle
  // fallback opens it at home, typing nothing. The text said that prompt opens
  // in the folder; it now lists it with the cases that open at home. The redraw
  // is zsh's own (its PROMPT_SP), not something macOS adds, so the text also
  // says it may happen on another host whose shell is zsh (only the Mac was
  // seen; lane review NIT). Pinned whole, so a later change to the paragraph
  // is made here on purpose too.
  it('the SSH partner on a Mac host whose shell is zsh: no surface says its prompt opens in the folder, and Known issues lists it with the cases that open at home', () => {
    const PARTNER_PARA = "An SSH session's partner shell is a connection of its own to the host. It does not survive a dropped connection the way an SSH Persistent session does. It opens in the config's remote folder only when it recognises the host's first shell prompt as that prompt appears: a prompt that ends in $, #, >, ~, or a % on its own or after a space. It types that folder line (cd and the folder) only before you type anything in the partner: the first key you type there (a letter, Enter, an arrow key or a paste), or a password you type there by hand, gives the line up for that connection, so it never lands in a command you are typing. The terminal's own automatic replies to the host do not count as typing. Otherwise it opens in your home folder. That happens on a Windows host; on a Mac host whose shell is zsh (the Mac's default), and possibly on another host whose shell is zsh, at least when the app runs on Windows: that prompt ends in a % after a space, but it arrives redrawn with empty lines after it, which the partner does not read as a prompt; on a host whose prompt ends in anything else (some prompt themes end in an arrow or another symbol, or draw on the right of the line), a zsh prompt whose % follows other text directly (such as box% or [user@box]~%) included; on a host whose sign-in banner, message of the day or shell startup draws a box with rounded corners; when the host is slow to show its first prompt (a slow link, or an extra sign-in step such as a verification code); when the first prompt, or the line just above it, names a sign-in word (password, passphrase, passcode, a one-time, verification or authenticator code, OTP, TOTP, token, PIN, 2FA or MFA), which also covers a shell prompt that contains one, such as a host named pin, and a notice just above the prompt that your password expires soon; when the app typed a saved password and the shell prompt that follows is only $, #, > or %, or a two-line prompt whose last line is only one of them. With a bare prompt like that after a saved password, the partner can take up to about 13 seconds to settle; typing in it meanwhile is fine, and nothing is typed for you. On a host whose first prompt is not a shell but ends in one of those marks and names none of those words, such as a jump-host menu ending in > or a code prompt worded differently, the partner can take that prompt for its shell and type its folder line into it; answer the prompt again, then type cd and the folder at the shell. With a saved password, a sign-in banner whose last line ends in one of those marks (a row of # signs, or a percentage written after a space, such as 45 %), with no line break before the password prompt, is taken for the shell prompt too: the partner does not type the saved password, and its folder line (cd and the folder) can arrive ahead of the password prompt; if the prompt then says the password was wrong, that line was taken as the password, which counts as one attempt. On a host that asks for a verification code or a key passphrase, or when you type the password by hand and take more than about 13 seconds, a partner command button pressed while that sign-in prompt is waiting types its command into the prompt. On a host whose sign-in banner, message of the day or shell startup draws a box with rounded corners, partner command buttons type nothing, and the note says the partner has not reported its shell prompt. Workaround: after a drop, show the partner and press Restart to open it again; where it opened in your home folder, type cd and the folder; where it did not type the saved password, type the password at the partner's prompt yourself, then type cd and the folder; sign in to the partner first, and press partner buttons only once its shell prompt shows; where partner buttons type nothing, type the command in the partner view."
    const paras = body('known-issues').split('\n')
    expect(paras.filter((p) => p.startsWith("An SSH session's partner shell is a connection of its own"))).toEqual([PARTNER_PARA])
    expect(PARTNER_PARA).toMatch(/^[\x20-\x7E]+$/)
    expect(rows()).toContainEqual(expect.stringContaining("It opens in the config's remote folder once it recognises the host's first shell prompt, such as bash's, as long as you have not typed anything in the partner before then (a password typed by hand counts), and in your home folder there otherwise (see Known issues in the Feature Guide, which also covers a Mac host whose shell is zsh)."))
    const claim = /zsh prompt on a Mac|as in the default zsh prompt/i
    for (const s of APP_KNOWLEDGE_SECTIONS) expect(s.body, s.id).not.toMatch(claim)
    for (const e of changelog) for (const c of e.changes) expect(c.description, e.version).not.toMatch(claim)
    expect(JSON.stringify(TIPS_LIBRARY)).not.toMatch(claim)
    expect(JSON.stringify(trainingSteps)).not.toMatch(claim)
  })

  it('remote project hooks: the lookup is described as it is, and a file the app does not add is never said not to run', () => {
    const r = body('remote-sessions')
    expect(r).not.toMatch(/found walking up from the session's folder/)
    expect(r).not.toMatch(/one-time value/)
    expect(r).toContain('ccc-attn-<session>.key (a key for this connection only, readable by you alone)')
    expect(r).toContain("an SSH session to a Linux or macOS host also gets the remote project's own Claude Code hooks added to its settings file")
    expect(r).toContain('which the app finds by asking git on the host; a .git folder or file nearer the session\'s folder than the checkout git names marks the checkout instead, as it does for Claude Code.')
    expect(r).toContain("What an SSH session's setup does to your user settings (~/.claude/settings.json) and to Claude Code's config file (~/.claude.json) on the host.")
    expect(r).toContain('user-settings-left for settings.json, claude-json-left for .claude.json')
    expect(body('settings-scope')).toContain('Which Claude Code hooks the app adds to a session. While the HTTP Hooks Gateway switch is on,')
    expect(body('settings-scope')).toContain("In every case Claude Code still reads the project's own settings files itself")
    const k = body('known-issues')
    expect(k).toContain("the app does not add a project's hooks to the session's settings file when its .claude folder or settings file")
    expect(k).toContain('An SSH session to a Windows host does not get the project\'s hooks added to its settings file by the app')
    expect(k).toContain('on an SSH host where git is not installed, a session started in a subfolder of a git checkout')
    for (const s of APP_KNOWLEDGE_SECTIONS) {
      expect(s.body, s.id).not.toMatch(/project's hooks are skipped when/i)
      expect(s.body, s.id).not.toMatch(/project's own hooks \([^)]*\) do not run there/i)
    }
  })

  it("local project hooks: the checkout's own file is the only parent folder file said to be read, and the host's log is named one way", () => {
    const row = rows().find((d) => d.startsWith('While the HTTP Hooks Gateway switch is on, a session now adds to its settings file'))!
    expect(row).toContain("the checkout's own .claude/settings.local.json (for a worktree, the main checkout's). No other file in a parent folder's .claude is added, as Claude Code does not read those either")
    expect(row).not.toMatch(/Hooks in a parent folder's \.claude are not added/)
    const scope = body('settings-scope')
    expect(scope).toContain("No other file in a parent folder's .claude is read (Claude Code does not read those either)")
    expect(scope).not.toMatch(/A parent folder's \.claude is never read/)
    for (const sec of APP_KNOWLEDGE_SECTIONS) expect(sec.body, sec.id).not.toMatch(/conductor-shim\.log in the remote's Claude folder/)
    expect(rows().some((d) => d.includes('~/.claude/conductor-shim.log on the host'))).toBe(false)
    expect(rows().find((d) => d.startsWith('An SSH session now reads your ~/.claude/settings.json'))).toContain("noted in conductor-shim.log in the host's Claude folder (~/.claude; inside the container for a container session).")
  })

  it("the partner tip and the Combined Mode card say an SSH partner opens in the remote folder once it recognises the host's prompt", () => {
    const tip = TIPS_LIBRARY.find((t) => t.id === 'tip.partner-terminal')!.variants.primary.body
    expect(tip).toContain("If it does not recognise the host's shell prompt, or you type in it before that prompt shows (a password typed by hand counts), it opens in your home folder there instead (see Known issues in the Feature Guide).")
    const card = JSON.stringify(trainingSteps.find((st) => st.id === 'combined-mode')!)
    expect(card).toContain("in the config's remote folder once it recognises the host's shell prompt")
  })

  it('canvas decisions in a Claude Code session: the Feature Guide and the known issue say when they are typed, and when the canvas says one was not sent', () => {
    expect(body('canvas-review-model')).toContain("In a Claude Code session, the line that tells the agent about your decision is typed only once Claude Code waits at its ready, empty prompt. With Claude Code's turn events (the default), it is held to the end of the agent's turn")
    const k = body('known-issues')
    expect(k).not.toMatch(/A canvas verdict can still be missed while the agent is mid-answer/)
    expect(k).not.toMatch(/its own interface can swallow that line/)
    expect(k).toContain('A canvas verdict can reach the agent late, or not at all.')
    expect(k).toContain('If a session ends or restarts with several decisions still waiting, the canvas lists them in the order you made them (it keeps the latest five notices on each canvas).')
    expect(k).toContain('If more than 32 decisions are waiting for a turn to end, only the latest 32 are kept, and the others are dropped without a notice.')
    expect(k).toContain("A Codex decision still waiting for a turn to end when its session ends or restarts is shown as not sent too; one already waiting for Codex's prompt when its session ends is dropped without that notice.")
    expect(k).toContain('say it in chat ("I approved version 4", or "I sent version 4 back, there are 3 notes")')
  })

  it('Compact, model and effort: the screens on which nothing is typed, and vim mode in the Claude controls known issue', () => {
    expect(body('statusline')).toContain("or the screen is one the app does not recognise (for example an earlier Claude Code screen left above a shell, or vim mode's visual mode), nothing is typed")
    const k = body('known-issues')
    expect(k).toContain('A canvas decision waits in the same case; if the agent has not picked it up, say it in chat (see the canvas verdict entry above).')
    expect(k).toContain("If your own Claude Code settings hide vim mode's indicator, its VISUAL mode looks like the ready prompt too.")
    expect(k).toContain('Press i to go to INSERT mode first, or type the command yourself.')
  })

  it('the resume picker: a missing worktree folder, the folder it starts in, and short 8.3 names as a known issue with its workaround', () => {
    const k = body('known-issues')
    expect(k).toContain('or in any worktree (including the one the session last ran in) whose folder was not there when the session started, saying so if you pick one')
    expect(k).toContain('A conversation it does resume starts in the folder that was checked, also when the worktree is reached through a link).')
    expect(k).toContain('If the folder of the worktree the session last ran in is not there when the session starts, the session starts in its configured folder')
    // Owner question 17 (mandatory known issue), after the working folder entry it builds on.
    const short = 'On Windows, the resume picker cannot resume a conversation from a worktree that git lists with a short 8.3 folder name in its path (such as PROGRA~1).'
    expect(k).toContain(short)
    expect(k).toContain('Workaround: to avoid this for new conversations, add worktrees with their full folder names, as File Explorer shows them')
    const anchor = k.indexOf('On Windows, give a Claude config its working folder as Windows spells it.')
    expect(anchor).toBeGreaterThanOrEqual(0)
    expect(k.indexOf(short)).toBeGreaterThan(anchor)
    expect(all).not.toMatch(/this computer's own Claude Code sign-in/)
  })

  it('Windows launch: [ or ] in a path, node for the npm Claude Code, and a folder setup cannot save', () => {
    const k = body('known-issues')
    expect(k).toContain('On Windows, a folder path that holds [ or ] limits how a Claude Code session can start.')
    expect(k).toContain('Workaround: install Claude Code and Node.js in folders without [ or ]')
    expect(k).toContain('(such as node_modules\\.bin or .): a session that starts it looks for Node.js only in the folders PATH names by their full path.')
    expect(k).toContain('Setup can say a folder could not be saved. Check that the folder is a full path.')
    expect(k).toContain('type a network share with backslashes (\\\\server\\share), not forward slashes.')
    expect(k).toContain('If that file cannot be written, for example because the home folder is read-only or full, setup says the folder could not be saved. Workaround: free some space, or make the home folder writable, then press Continue again.')
    expect(body('providers')).toContain("Setup's first step saves two folders: the data directory and the resources directory.")
    expect(body('providers')).toContain('If either folder is empty, is not a full path, cannot be created or cannot be saved, setup stays on that step and says which folder could not be saved.')
    expect(all).not.toMatch(/\(on Windows\) its path cannot be saved in the registry/)
    expect(all).not.toMatch(/Setup can say a folder could not be saved on Windows\./)
  })

  it('a Claude Code version pinned in an older release: the Feature Guide and the known issue say the installed one starts, with the workaround', () => {
    expect(body('sessions')).toContain('A config set in an older release to a particular Claude Code version starts the installed Claude Code, as every other config does (see Known issues and workarounds).')
    expect(body('known-issues')).toContain('If a saved config was set, in an older release, to use a particular Claude Code version, that setting is no longer used')
    expect(body('known-issues')).toContain('Workaround: to run a particular Claude Code version, install that version yourself and make it the only Claude Code in the folders PATH names')
    expect(all).not.toMatch(/runs that version everywhere it starts/)
    expect(all).not.toMatch(/for an older Claude Code version the app keeps/)
  })

  it('the scripts folder: what the app will not run, and how to clear what sits in a script\'s place or the lib folder\'s', () => {
    const t = body('troubleshooting')
    expect(t).toContain("A new session opened without the resume list or the app's status line, or a Codex session had no hooks, and the log names a script file or folder. The app runs its status line, the resume list and a Codex session's hooks only from its own copy of each script")
    expect(t).toContain('the app never deletes what a folder holds.')
    expect(t).toContain('the app log says the scripts/lib folder is not a real folder.')
    expect(t).toContain('close the app, move that file or folder out of the scripts folder, and start the app again.')
  })
})

// The last user-facing pass for 2.1.1-beta.3: the notes of the fixes that
// came last. The partner's folder line, the settings and
// config files the SSH setup leaves as they are, the folder step on every
// platform, the scripts folder made private at start, the project's new home,
// and the known issues each of them ships with. New rows and entries are
// pinned whole, so a later change to any of them is made here on purpose too.
describe('surfaces for the last 2.1.1-beta.3 fixes', () => {
  const body = (id: string) => APP_KNOWLEDGE_SECTIONS.find((s) => s.id === id)!.body
  const all = APP_KNOWLEDGE_SECTIONS.map((s) => s.body).join('\n')
  const entries = APP_KNOWLEDGE_SECTIONS.flatMap((s) => s.body.split('\n'))
  const rows = () => changelog.find((e) => e.version === '2.1.1-beta.3')!.changes.map((c) => c.description)

  it("What's New for 2.1.1-beta.3: the new rows read exactly as written, and the partner row says typing first keeps it at home", () => {
    for (const exact of [
      "On a Linux or macOS SSH host, the session's setup now keeps your ~/.claude.json's owner and links when it marks the session folder as trusted: the file keeps its owner (a new one is created 0600, as Claude Code creates it), and a ~/.claude.json that is a link stays a link, with the file it points at updated. A ~/.claude.json it could not change in place (for example one that is read-only, has a second name (a hard link), or belongs to another user) is left as it is and noted in conductor-shim.log in the host's Claude folder (~/.claude; inside the container for a container session), and Claude Code then asks once whether you trust the folder (see Known issues in the Feature Guide).",
      'At each start the app now makes the folder its session scripts run from private to your account. The scripts are the status line, the resume lists and the Codex hooks. If it cannot, sessions start without those extras and the app log says why (see Known issues in the Feature Guide).',
      'The project now lives at github.com/nubbymong/ai-code-conductor, and old links to it redirect there. The app finds updates there on its own; if no update shows, restart the app once.',
      "First-run setup no longer moves on as if a folder were set when it was not saved. If a folder is empty, is not a full path, or cannot be created or saved, the folder step stays open and says which folder, so you can choose another one.",
    ]) expect(rows(), exact.slice(0, 60)).toContain(exact)
    const partner = rows().find((d) => d.startsWith("The partner terminal of an SSH session now opens on the session's host"))!
    expect(partner).toContain('as long as you have not typed anything in the partner before then (a password typed by hand counts), and in your home folder there otherwise')
    const settings = rows().find((d) => d.startsWith('An SSH session now reads your ~/.claude/settings.json'))!
    expect(settings).toContain('A file it cannot read as JSON, or could not change in place (for example one that is read-only, has a second name (a hard link), or on a Linux or macOS host belongs to another user), is left as it is')
    expect(settings).toContain('on a Linux or macOS host it also keeps its permission bits and owner, and on a Windows host it takes the permissions of its folder (~/.claude)')
    // The new rows sit with their areas: the trust flag row right after the
    // settings row, the scripts folder row after the scripts rows, and the
    // new home row just before the update check row, which stays last.
    const at = (start: string) => rows().findIndex((d) => d.startsWith(start))
    expect(at('On a Linux or macOS SSH host, the session\'s setup now keeps your ~/.claude.json')).toBe(at('An SSH session now reads your ~/.claude/settings.json') + 1)
    expect(at('At each start the app now makes the folder its session scripts run from private')).toBe(at("The app's status line, the resume list and Codex's hooks now start only") + 1)
    expect(at('The project now lives at github.com/nubbymong/ai-code-conductor')).toBe(rows().length - 2)
    for (const d of rows()) expect(/^[\x20-\x7e]*$/.test(d), `non-ASCII: ${d.slice(0, 60)}`).toBe(true)
  })

  it('the local project hooks row keeps the home folder rule apart from where to put hooks for every session, and says writable by', () => {
    const row = rows().find((d) => d.startsWith('While the HTTP Hooks Gateway switch is on, a session now adds to its settings file'))!
    expect(row).toContain("No other file in a parent folder's .claude is added, as Claude Code does not read those either; put hooks meant for every session in the session folder's .claude or in ~/.claude/settings.json. Project hooks are never taken from your home folder or a folder above it.")
    expect(row).toContain("writable by your own per-user group is fine, but not by a group other accounts share, such as macOS's staff group.")
    expect(row).not.toMatch(/a folder above it: put hooks/)
    expect(body('settings-scope')).toContain('see the known issues about project hooks if one does not run in an app session.')
  })

  it("conductor-shim.log is placed inside the container for a container session, wherever the host's Claude folder is named", () => {
    const texts = [...APP_KNOWLEDGE_SECTIONS.map((s) => s.body), ...rows()]
    let named = 0
    for (const t of texts) {
      let i = t.indexOf("conductor-shim.log in the host's Claude folder (~/.claude")
      while (i >= 0) {
        named++
        const after = t.slice(i + "conductor-shim.log in the host's Claude folder (~/.claude".length)
        expect(after.startsWith('; inside the container for a container session)'), t.slice(i, i + 120)).toBe(true)
        i = t.indexOf("conductor-shim.log in the host's Claude folder (~/.claude", i + 1)
      }
    }
    expect(named).toBeGreaterThanOrEqual(9)
  })

  it('the remote settings entry says which files the setup leaves as they are, and why', () => {
    const r = body('remote-sessions')
    expect(r).toContain('Both changes are made only when you could change the file in place: it must open for writing (not read-only, not append-only, and writing not denied to you, for example by a Windows ACL), must have no second name (a hard link), and on a Linux or macOS host must belong to the user the session runs as.')
    expect(r).toContain('On a Linux or macOS host it also marks the session\'s folder as trusted in .claude.json, so Claude Code does not ask about it; only that flag is added, and a missing .claude.json is created 0600, as Claude Code creates it.')
    expect(r).toContain('each with the reason (for example readonly, hardlink, owner or group). The session still starts.')
  })

  it('the folder step is described for every platform, with no example path that could be one machine\'s', () => {
    expect(body('providers')).toContain("Each must be a full path, for example one with a drive letter or a network share (\\\\server\\share) on Windows, or one starting with / on macOS and Linux.")
    expect(body('providers')).toContain("Windows saves the folders in the registry; macOS and Linux save them in the app's settings file in your home folder.")
    expect(body('providers')).toContain('Continue, the folder fields and Browse wait while the folders are being saved.')
  })

  it('the scripts folder known issues and the reviewer menu read as the app behaves', () => {
    for (const exact of [
      'Status line, resume list or Codex hooks missing when the resources folder is on a FAT drive or a network share that cannot keep file permissions. At each start the app makes the scripts folder inside your resources folder private to your account, and it runs session scripts only from there. A FAT or exFAT drive cannot keep those permissions, and some network shares cannot either. Then the app does not use its status line, the resume list or the Codex hooks, and sessions start without them. The app log has a line starting "[scripts] the scripts folder in the resources folder could not be made this user\'s alone". If the reason in that line is a time limit rather than the drive, restart the app first: the check runs again at each start. Workaround: choose a resources folder on a local drive that keeps file permissions (NTFS on Windows), for example one inside your user folder, then restart the app.',
      'A tab restored at start opened without the status line or the resume list. At each start the app checks its scripts folder before sessions use it, and a session that starts meanwhile waits up to 5 seconds for that check. On a slow or busy computer the check can take longer. A tab restored at start then runs that session without the app\'s status line, the resume list or the Codex hooks, and the app log has a line saying the scripts folder is still being checked. Workaround: restart the tab once the app has finished starting. If restarting the tab does not bring them back, restart the app.',
      "A resources folder chosen in the app's first-run setup gets its scripts folder checked, and the app's session scripts put in it, only at the app's next start. Until then, new sessions start without the app's status line, the resume list and the Codex hooks. Workaround: once setup is done, quit the app and start it again.",
    ]) expect(entries, exact.slice(0, 60)).toContain(exact)
    expect(body('code-review')).toContain("Choose it with Make reviewer in the account's menu, for a Codex or a Claude account, in Settings, Accounts.")
    expect(all).not.toMatch(/on a Claude account's row/)
  })

  it('the SSH settings and config files the app leaves as they are, the npm launcher resume through a link to a share, and a slow share at start, each with its workaround', () => {
    for (const exact of [
      "If your user settings on an SSH host (~/.claude/settings.json) still hold entries an older version of the app put there (a statusLine that runs conductor-ssh-statusline.js, or conductor or conductor-vision MCP server entries), and the app could not change the file in place (for example it is read-only, has a second name (a hard link), or belongs to another user), the app leaves those entries in place and notes why in conductor-shim.log in the host's Claude folder (~/.claude; inside the container for a container session). Workaround: remove those entries from the file yourself.",
      "On a Linux or macOS SSH host where the app could not change Claude Code's config file (~/.claude.json) in place (for example it is read-only, has a second name (a hard link), or belongs to another user), the app leaves that file as it is and does not mark the session's folder as trusted; a claude-json-left line in conductor-shim.log in the host's Claude folder (~/.claude; inside the container for a container session) says why. Claude Code then asks once whether you trust the folder: answer yes. If two sessions to that folder start at the same time, answer in one of them first, then reconnect the other.",
      'On Windows, when the app manages your Claude accounts (see Multiple Claude accounts) and Claude Code is installed through npm (claude.cmd) or as claude.bat, the resume picker cannot resume a conversation from a worktree reached through a folder link (a symbolic link or a junction) to a network share: it starts nothing and says it cannot start Claude Code in a network folder through its npm launcher. Workaround: start the session again and begin a new conversation, reach the worktree through a mapped drive letter rather than a folder link, or install the native Claude Code.',
    ]) expect(entries, exact.slice(0, 60)).toContain(exact)
    expect(body('known-issues')).toContain('A worktree folder on a network share that answers too slowly while the session starts can be treated the same way: resuming there is refused and the session says to start it again, which works once the share answers in time.')
  })

  it('the SSH partner: typing in it before its first prompt keeps it at home, a hand-typed password included, as its own known issue with the workaround', () => {
    const partnerHomeIssue = "An SSH session's partner shell opens in your home folder there, not in the config's remote folder, whenever you type the password into it by hand: the partner types its folder line only before you type anything in it, and a password typed by hand counts as typing. Workaround: save the password in the SSH config, so the app types it for you, or type cd and the folder in the partner yourself."
    expect(entries).toContain(partnerHomeIssue)
    const k = body('known-issues')
    expect(k.indexOf(partnerHomeIssue)).toBeGreaterThan(k.indexOf("An SSH session's partner shell is a connection of its own"))
    expect(k).toContain('The terminal\'s own automatic replies to the host do not count as typing.')
    expect(all).not.toMatch(/when you type the password by hand, either taking more than about 13 seconds or on a host that shows nothing/)
    expect(all).not.toMatch(/and when you type anything in the partner before its first prompt is recognised/)
    expect(all).not.toMatch(/With such a bare prompt after a saved password/)
  })

  // A share that keeps file permissions works as a resources folder, so the
  // scripts folder entry and the README say only that a share which cannot
  // keep them fails, as the share entries in Known issues already do.
  it('a resources folder on a network share is said to fail only when the share cannot keep file permissions', () => {
    const root = path.resolve(__dirname, '..', '..', '..')
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
    expect(readme).toContain('| **Resources folder** | On a drive that keeps file permissions (NTFS on Windows), not a FAT or exFAT drive or a network share that does not keep them; otherwise the app\'s status line, the resume list and the Codex hooks are not used |')
    expect(readme).not.toMatch(/not a network share or a FAT or exFAT drive/)
    expect(all).not.toMatch(/A network share, or a FAT or exFAT drive, cannot keep those permissions\./)
    expect(all).not.toMatch(/missing when the resources folder is on a network share or a FAT drive\./)
    expect(body('known-issues')).toContain('A resources folder on a network share that cannot be made owner-only is refused the same way.')
  })

  // A Claude account's Make reviewer is a menu item, as a Codex account's is
  // (AccountsPanel's RowMenu), so the User Guide says so too.
  it('the User Guide names Make reviewer in the account\'s menu for both providers, as the Feature Guide does', () => {
    const root = path.resolve(__dirname, '..', '..', '..')
    const guide = fs.readFileSync(path.join(root, 'docs', 'USER_GUIDE.md'), 'utf8').replace(/\s+/g, ' ')
    expect(guide).toContain("Set it with **Make reviewer** in the account's menu, for a Codex or a Claude account.")
    expect(guide).toContain("so *This computer's Codex* (the row kept for a 2.1.1-beta.2 **Use this sign-in**) never does.")
    expect(guide).not.toMatch(/on a Claude account's row/)
    expect(guide).not.toMatch(/this computer's own Codex sign-in never does/)
  })

  // The rewritten file's group is the one a new file in that folder gets,
  // which need not be your own; and the attention hook's log is in the
  // container for a container session, as every other conductor-shim.log
  // mention says.
  it('the remote settings entry names the group a rewritten file gets, and the attention log place for a container session', () => {
    const r = body('remote-sessions')
    expect(r).toContain("a file in a group you are not in is written in the group a new file in that folder gets when the file's own group has the same access to it as everyone else, and is left as it is when it has more or less (0640, 0664 or 0604, for example).")
    expect(r).toContain('writes one claude-json-mode line in conductor-shim.log with the mode the file had')
    expect(r).not.toMatch(/takes your own group when that group has no more access/)
    expect(r).toContain('The hook writes a trace line to conductor-shim.log in that same folder on the remote host (inside the container for a container session) when it cannot reach the terminal')
  })
})

// The Codex reviewer is sent the change itself and runs no commands; the
// ~/.claude.json owner-only row joins the trust flag row; the Combined Mode
// card carries the partner's typing-first rule, as the tip and Known issues do.
describe('surfaces for the Codex review fix and the last 2.1.1-beta.3 text', () => {
  const body = (id: string) => APP_KNOWLEDGE_SECTIONS.find((s) => s.id === id)!.body
  const rows = () => changelog.find((e) => e.version === '2.1.1-beta.3')!.changes.map((c) => c.description)
  const at = (start: string) => rows().findIndex((d) => d.startsWith(start))

  it("What's New for 2.1.1-beta.3: the Codex review row and the ~/.claude.json owner-only row read exactly as written, the latter right after the trust flag row", () => {
    expect(rows()).toContain('Codex code reviews now receive the change itself and run no commands, so they work on Windows too, where a Codex review could not look at the change and asked for it instead. Uncommitted changes to tracked files and a range arrive as the git diff, as they do for a Claude review, and files you name arrive with their content. A change larger than 512 KB is refused, never cut.')
    const ownerOnly = "An SSH session's setup now keeps ~/.claude.json on a Linux or macOS host readable only by you, and sets it back to that if its permissions were widened."
    expect(rows().find((d) => d.startsWith(ownerOnly))).toBe(`${ownerOnly} On every connect, permissions on that file for its group or for other users are removed and yours are kept (0644 becomes 0600), with a line in conductor-shim.log in the host's Claude folder (~/.claude; inside the container for a container session). A ~/.claude.json with a second name (a hard link), or that belongs to another user, is left as it is.`)
    expect(at(ownerOnly)).toBe(at("On a Linux or macOS SSH host, the session's setup now keeps your ~/.claude.json") + 1)
    expect(rows().join('\n')).not.toContain('the file keeps its permission bits and owner')
  })

  it('the Feature Guide says what each reviewer is sent and that the Codex reviewer runs no commands', () => {
    const cr = body('code-review')
    expect(cr).toContain('The app sends the reviewer the change itself: the git diff of the uncommitted changes to tracked files, or of a range you name. For files you name, the Codex reviewer is sent their content, and the Claude reviewer reads them in the project. A change larger than 512 KB is refused, never cut.')
    expect(cr).toContain("The Codex reviewer runs no commands and cannot read or change files: it reviews what it is sent, plus the project's AGENTS.md if there is one, which Codex loads by itself. The Claude reviewer can also read other files in the project.")
    expect(cr).not.toMatch(/Codex reviewer (reads|runs git)/)
  })

  it("the Combined Mode card says the partner opens in the remote folder only if you have not typed in it first", () => {
    const card = JSON.stringify(trainingSteps.find((st) => st.id === 'combined-mode')!)
    expect(card).toContain("in the config's remote folder once it recognises the host's shell prompt, if you have not typed in it first")
  })
})

// VM row 4.10 (2.1.1-beta.3 qualification): on Windows, a data or resources
// folder whose full path holds a character outside plain English letters,
// digits and ordinary punctuation is not found at start, and the app starts
// without what it holds. Until the fix ships, the known issue says who is hit
// (the default folders too, under a user folder with such a name), what they
// see, and the way out, in the words the app and the installer show. The
// entry is pinned whole, so any change to it is made here on purpose too.
describe('known issue: a Windows data or resources folder path outside plain English letters (VM row 4.10)', () => {
  const root = path.resolve(__dirname, '..', '..', '..')
  const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8')
  const k = () => APP_KNOWLEDGE_SECTIONS.find((s) => s.id === 'known-issues')!.body
  const ENTRY = "On Windows, the app does not find its data or resources folder when the full path of that folder holds a character other than a plain English letter, a digit or ordinary punctuation, such as an accented letter (an e with an acute accent, for example), a curly apostrophe, or Chinese or Japanese characters. That includes the default folders, which the installer puts inside your Windows user folder, when the name of that folder (usually your Windows user name) holds such a character. macOS and Linux are not affected. It happens at every start. The app does not ask for its folders again, but your saved configs, accounts and sessions can look missing: the app either says Your configuration could not be loaded or starts as if it were new, and it can show the Claude CLI Setup screen and the onboarding pages that follow setup on a new install. Everything in the folder you chose is still there, and setting the app up again while it starts this way does not bring it back. Workaround: note the version that Settings, About shows, then close the app and make a new folder whose full path holds only plain English letters, digits, spaces, dots, hyphens and underscores, on this computer's own disk (not a USB drive, a FAT or exFAT drive or a network share). If the name of your Windows user folder holds none of those other characters, a folder inside it will do; if it holds one, make the new folder outside it, for example a folder named AICC-data at the top of your C: drive. Move what is inside the affected folder into the new one (with the default folders, what is inside the data folder, which holds the resources folder); the app does not move anything for you. Then download the installer for that version, or a newer one, from the Releases page on GitHub (the release marked Latest there can be older than yours), run it, and on its Data folder and Resources folder pages choose the folders in their new place. This is being fixed in a later release."
  // The paragraph as Known issues and workarounds holds it, found by its
  // opening words, so the cases after the first read the text the app ships
  // and not ENTRY: they still hold if the exact match is ever loosened.
  const para = () => {
    const p = k().split('\n').find((x) => x.startsWith('On Windows, the app does not find its data or resources folder '))
    expect(p, 'the entry is in Known issues and workarounds').toBeDefined()
    return p!
  }
  // The body of one NSIS Function, up to its FunctionEnd.
  const nsisFunction = (nsh: string, name: string) => {
    const from = nsh.indexOf(`\nFunction ${name}\n`)
    expect(from, `Function ${name} is in the installer script`).toBeGreaterThan(-1)
    return nsh.slice(from, nsh.indexOf('\nFunctionEnd', from))
  }

  it('is one known-issues paragraph, read exactly as written, in plain ASCII, right after the entry for a folder setup cannot save', () => {
    const paras = k().split('\n')
    const at = paras.indexOf(ENTRY)
    expect(at, 'the entry is in Known issues and workarounds').toBeGreaterThan(-1)
    expect(paras[at - 1]).toBe('')
    expect(paras[at - 2]).toMatch(/^Setup can say a folder could not be saved\./)
    expect(ENTRY).toMatch(/^[\x20-\x7E]+$/)
  })

  it('names the notice, the setup screen, the version to download and the installer pages by the words the app and the installer show', () => {
    const p = para()
    expect(p).toContain('the app either says Your configuration could not be loaded or starts as if it were new')
    expect(read('src', 'renderer', 'components', 'ConfigLoadFailedNotice.tsx')).toContain('>Your configuration could not be loaded<')
    expect(p).toContain('it can show the Claude CLI Setup screen')
    expect(read('src', 'renderer', 'components', 'SetupDialog.tsx')).toContain('title="Claude CLI Setup"')
    const settings = read('src', 'renderer', 'components', 'SettingsPage.tsx')
    expect(settings).toContain("{ id: 'about', label: 'About' }")
    expect(settings).toContain('<span className="text-sm text-text">Version</span>')
    const nsh = read('build', 'installer.nsh').replace(/\r\n/g, '\n')
    expect(nsh).toContain('MUI_HEADER_TEXT "Data folder"')
    expect(nsh).toContain('MUI_HEADER_TEXT "Resources folder"')
    // Both pages show on every run of the installer by hand, an install over
    // the same version included: neither page skips itself.
    expect(nsh).toContain('\nPage custom DataDirPage DataDirPageLeave\n')
    expect(nsh).toContain('\nPage custom ResourcesDirPage ResourcesDirPageLeave\n')
    expect(nsisFunction(nsh, 'DataDirPage')).not.toMatch(/\bAbort\b/)
    expect(nsisFunction(nsh, 'ResourcesDirPage')).not.toMatch(/\bAbort\b/)
    // The installer's fresh-install defaults sit in the user's own local app
    // data folder, which is why the default folders are named as affected.
    expect(nsh).toContain('StrCpy $1 "$LOCALAPPDATA\\AI Code Conductor"')
    expect(nsh).toContain('StrCpy $1 "$LOCALAPPDATA\\AI Code Conductor\\resources"')
  })

  // What a start into an empty folder can show: the setup screen for Claude
  // Code, then the onboarding pages (the guide's own name for them). Not the
  // setup's first page (its folder step, which does not come back), and not
  // the Welcome tour, which opens only when asked for.
  it('says the onboarding pages can show, by the name the guide gives them, and not a welcome page or the Welcome tour', () => {
    const p = para()
    expect(p).toContain('it can show the Claude CLI Setup screen and the onboarding pages that follow setup on a new install')
    expect(p).not.toMatch(/welcome (page|tour)/i)
    expect(APP_KNOWLEDGE_SECTIONS.find((s) => s.id === 'troubleshooting')!.body).toContain('(the onboarding pages, ')
  })

  // The workaround closes the app, so the version is read from it first.
  it('has the version read in Settings, About before the app is closed, and the installer downloaded for that version', () => {
    const p = para()
    const w = p.slice(p.indexOf('Workaround: '))
    expect(w).toMatch(/^Workaround: note the version that Settings, About shows, then close the app and make a new folder /)
    expect(w).toContain('Then download the installer for that version, or a newer one, from the Releases page on GitHub')
    expect(w.match(/Settings, About/g)).toHaveLength(1)
  })

  // Who is hit is decided by the name of the user FOLDER, and the workaround
  // decides where the new folder goes by that same name: a Windows user
  // renamed later keeps the old folder name, and with a Microsoft sign-in the
  // folder is named from the email address, so the two names can differ.
  it('decides where the new folder goes by the name of the Windows user folder, the same name that sets the issue off', () => {
    const p = para()
    expect(p).toContain('when the name of that folder (usually your Windows user name) holds such a character')
    expect(p).toContain('If the name of your Windows user folder holds none of those other characters, a folder inside it will do; if it holds one, make the new folder outside it, ')
    expect(p).not.toMatch(/If your Windows user name holds/)
  })

  it("puts the new folder on this computer's own disk, as the entries for the scripts folder and the sign-in folders need", () => {
    expect(para()).toContain("on this computer's own disk (not a USB drive, a FAT or exFAT drive or a network share)")
    expect(k()).toContain('A FAT or exFAT drive cannot keep those permissions, and some network shares cannot either.')
    expect(k()).toContain('A resources folder on a network share that cannot be made owner-only is refused the same way.')
  })
})

// S18 (2026-10-12): GPT-6-Sol and GPT-6-Luna join the Codex model picker for
// Codex 0.156.1, and GPT-5.5 retires from Codex with ChatGPT sign-in on
// October 14, 2026 (OpenAI's Codex models page, read 2026-10-12). The What's New
// row and the known issue are pinned whole. The models and the picker choice
// they name must be ones the Codex picker offers under those labels, so this
// text needs the registry entries that add the two models.
describe('surfaces for GPT-6-Sol and GPT-6-Luna, and the GPT-5.5 retirement', () => {
  const beta3 = () => changelog.find((e) => e.version === '2.1.1-beta.3')!.changes
  const rows = () => beta3().map((c) => c.description)
  const ROW = 'GPT-6-Sol and GPT-6-Luna are in the Codex model picker. Codex lists both from version 0.156.1, the newest Codex this release is tested with. OpenAI names them as the replacements for GPT-5.5, which retires from Codex with ChatGPT sign-in on October 14, 2026 (see Known issues in the Feature Guide).'
  const ENTRY = 'GPT-5.5 retires from Codex with ChatGPT sign-in on October 14, 2026, OpenAI says; the retirement does not apply to the OpenAI API. Codex itself still lists GPT-5.5, so it stays in the model picker, but from that date a Codex config set to GPT-5.5 on an account signed in with ChatGPT needs another model. Workaround: edit the config and pick a model your account offers: GPT-6-Sol, which OpenAI names as the replacement on Plus, Pro, Business, Enterprise and Edu plans when available, or "Default: follows Codex".'

  it("What's New for 2.1.1-beta.3 has the row, read exactly as written, in plain ASCII, right after the Codex review row", () => {
    expect(rows()).toContain(ROW)
    expect(ROW).toMatch(/^[\x20-\x7E]+$/)
    expect(rows().indexOf(ROW)).toBe(rows().findIndex((d) => d.startsWith('Codex code reviews now receive the change itself')) + 1)
    expect(beta3().find((c) => c.description === ROW)!.type).toBe('improvement')
  })

  it('Known issues has the GPT-5.5 retirement, read exactly as written, in plain ASCII, after the Codex over SSH entry', () => {
    const paras = APP_KNOWLEDGE_SECTIONS.find((s) => s.id === 'known-issues')!.body.split('\n')
    const at = paras.indexOf(ENTRY)
    expect(at, 'the entry is in Known issues and workarounds').toBeGreaterThan(-1)
    expect(ENTRY).toMatch(/^[\x20-\x7E]+$/)
    expect(paras[at - 1]).toBe('')
    expect(paras[at - 2]).toMatch(/^Codex does not run over SSH in this release\./)
  })

  it('names models and a choice the Codex picker offers, under the labels it shows, GPT-5.5 still among them', () => {
    const labels = codexModelOptions(registryJson as unknown as ModelRegistry).map((o) => o.label)
    for (const l of ['GPT-6-Sol', 'GPT-6-Luna', 'GPT-5.5', 'Default: follows Codex']) expect(labels, l).toContain(l)
  })

  // Lane review (MINOR): OpenAI's page names GPT-6-Sol for Plus, Pro, Business,
  // Enterprise and Edu "when available", and GPT-6-Luna for Free and Go only
  // "in the desktop app when available". The known issue says no more than the
  // page: Sol keeps its qualifier, and Luna is not offered as a pick for the
  // Codex this app runs.
  it('the known issue keeps the page\'s "when available" on GPT-6-Sol and does not offer GPT-6-Luna, which the page names only for its desktop app', () => {
    const para = APP_KNOWLEDGE_SECTIONS.find((s) => s.id === 'known-issues')!.body.split('\n').find((p) => p.startsWith('GPT-5.5 retires from Codex'))!
    expect(para).toContain('GPT-6-Sol, which OpenAI names as the replacement on Plus, Pro, Business, Enterprise and Edu plans when available')
    expect(para).not.toContain('GPT-6-Luna')
    expect(para).toContain('pick a model your account offers')
  })
})
