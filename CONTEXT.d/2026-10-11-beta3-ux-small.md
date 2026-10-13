## 2026-10-11 -- three small UX fixes for 2.1.1-beta.3 (links, SSH card, secret message)

- **Terminal link right-click (aicc_planning 126):** xterm calls a link's
  `activate` on the mouseup of any button, so a right-click opened the link as
  well as showing "Copy link address". `decorateTerminalLinks` now opens only
  on button 0 that is not `isContextMenuGesture` (src/renderer/lib/pointer.ts),
  so macOS Ctrl + click opens nothing too. **Decision:** a middle-click no
  longer opens a link; the ticket accepts that. OSC 8 hyperlinks go through
  xterm's own link provider, not this decorator, and keep xterm's default
  confirm-then-window.open (denied by the main window); a follow-up if Claude
  Code is seen emitting them.
- **SSH card subtitle (aicc_planning 88):** "Another machine, plain session"
  read as "no AI". Now "Another machine, ends on disconnect", matching the SSH
  Persistent card. The optional provider-row hint was dropped as scope creep:
  the subtitle alone fixes the defect. So the ticket's second acceptance
  criterion (telling, from the dialog alone, that a plain remote shell is
  Terminal only + SSH) is deliberately not met in this release. The guided
  tour's saved-config card and the sidebar-marks showcase page used the same
  "plain" for SSH and now say what a dropped link does instead; the Feature
  Guide, Ask Conductor and tip copy are left to the surface sweep. Old
  changelog entries keep their wording (the release record is not rewritten).
- **Secret escape message (aicc_planning 82):** the rule stays whole-text (any
  backslash or backtick anywhere in the text leaves every `{secret}` literal);
  only the message and doc comments changed, since they promised a per-line
  remedy that cannot work. A per-line rule was ruled out: it would widen where
  a secret is substituted and make this a security-review change.
- **Follow-up, not done here:** the dialogs check the command and each argument
  field on its own, while the launch substitutes the joined line, so a
  backslash in one field leaves a `{secret}` in another literal with no
  warning at save. The failure direction is safe (the token stays visible); a
  joined check would refuse saves that pass today, so it is left for triage.
