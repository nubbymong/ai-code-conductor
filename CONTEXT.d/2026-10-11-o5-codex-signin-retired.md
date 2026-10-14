## 2026-10-11 -- O5: the "use this computer's Codex sign-in" option is removed

Owner decision 2026-10-11, from the owner's findings on v2.1.1-beta.2: the
app no longer offers the Codex sign-in already on this computer (~/.codex, or
the folder CODEX_HOME names). A Codex account is always added in the app, as a
Claude account is. This supersedes the "This computer's sign-in" row of owner
decision U1 (docs/wp1/owner-decisions-2026-09-26.md, which now says so).

Why: that sign-in can never be vouched for (an external-default account is
realm-only by registry rule: the folder is shared with the Codex CLI and other
apps), so it needs a confirmation at every launch and can never review, yet
users took it as the easy option. Claude has no such offer: the app copies the
computer's Claude login into a managed Primary profile, which Codex cannot do
without reading Codex's sign-in files (U2 forbids that).

What changed (2.1.1-beta.3):

- Set up Codex offers only "Sign in to a new Codex account" with its methods:
  no read-only check of ~/.codex, no "Use this sign-in", no "Recommended" tag.
  An account beta.2 adopted does not count as set up there.
- Settings, Accounts has no block offering that sign-in (nor its "Yes, I use
  Codex" button: the Providers switch and Add Codex account still record the
  answer).
- Main: AccountsService.adoptExternalDefault and probeExternalDefault refuse
  with 'unsupported' and a plain message before anything is reserved, written
  or run. The IPC channels keep their shape. A test-only constructor option
  (beta2ExternalAdoptionForTests) lets the accounts harness write a beta.2
  record through the code that wrote it; the composition root never sets it,
  and a test on the real composition root proves the refusal.
- Existing beta.2 adopters (only beta.2 ever offered it): the account keeps
  working as before (confirmed at each launch, never a reviewer, no automatic
  archive, so configs bound to it do not go to "Needs attention"). Its row
  says it is being retired, with Add Codex account; every launch confirmation
  on it (the New session dialog, New agent, an Insights run, and the confirm
  before a later launch, which also has Open Accounts instead) says the same.
- Copy: Hello Codex's Accounts page and drawing, the Feature Guide Codex and
  code review cards, the "Do you use Codex?" Yes card and the no-account
  code review line no longer mention that sign-in. USER_GUIDE, PRIVACY and the
  WP2/WP1 records that cited "Use this sign-in" as shipped say it is retired.

Not changed here: app-knowledge, tips, changelog and README (one later
surface sweep applies those for beta.3). The external row's Sign out and Sign
in again stay as they were.

Cost to 2.1.0 Codex users, stated in the upgrade text: their Codex sign-in was
~/.codex, so they sign in once more in the app, and their earlier Codex
conversations stay in ~/.codex for the Codex CLI to resume, not the app.

Same day: archiving that account is final. Settings offers no Restore on
its archived row, which says why, and main refuses archived ->
inactive for an external-default realm with 'unsupported' (the test seam does
not re-enable it), so following the retire steps cannot be undone by one
click. Also: the refusal names the retired sign-in only for a provider that
had one (Claude gets a bare 'unsupported'); the row's retire line drops "in
Settings, Accounts" and, on an inactive row, asks only for Archive; Open
Accounts instead answers No to every other session launch queued on that
sign-in (a restart queues one per restored tab), leaving agent retries and
other accounts to be answered; the Do you use Codex? page states the 2.1.0
cost (sign in once more; earlier conversations stay with the Codex CLI); the
Set up Codex rules the removal orphaned are gone. The accounts harness keeps
beta.2 adoption on by default to seed beta.2 records; its doc now says that
default is not the shipped behaviour, and inverting it or deleting the seam
is left to the release's ADR-009 security review.

Then, the same day: Open Accounts instead answers only the question on
screen again, then opens Settings, Accounts, as the New session dialog's
Settings, Accounts link does. Answering No to every other session launch
queued on that sign-in too, as first built, was a new mechanism the O5
decision did not ask for, the button did not say it, and a queued Switch
account onto that sign-in would have been undone (the tab moved back) without
its question ever being shown. Each further launch is asked, one at a time,
as in beta.2. Archiving that account being final is now also written into
the O5 note in docs/wp1/owner-decisions-2026-09-26.md, pending the owner's
confirmation.
