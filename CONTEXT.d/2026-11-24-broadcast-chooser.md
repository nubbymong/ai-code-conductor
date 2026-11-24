## 2026-11-24 -- Every broadcast press asks: All, or pick the sessions

Plan 2.1.3-beta.17, section C2 (aicc_planning#413, #399's follow-up). Beta.16 shipped the
broadcast: a button with "Send to every open session" sent on a plain click with no question,
and a Shift+click on any other simple Global prompt asked only "Send to N open sessions?". The
owner, 2026-11-24: "when the user clicks a broadcast button they should be given the option of
all or select session to make this easier".

- **The chooser** (`src/renderer/components/command-bar/BroadcastChooser.tsx`, on the
  command bar's ConfirmCard). Every broadcast press opens it: 'Send "<label>" to', All (N) as
  the primary button, or Choose sessions, which lists each open agent tab with a tick box (the
  tab's name as the tab strip shows it, its agent from `provider-names.ts`, the host of an SSH
  tab as a badge, "this tab" for the pressed one), then Send for the ticked ones. Cancel and
  Escape send nothing. The overflow list asks the same way (it hands the Shift key on).
- **Enter** answers the primary button of what is shown: All, or Send once the list is open,
  so an Enter after unticking a tab never reaches it (the plan said "Enter is All"; the list
  view's Enter is the one place this differs, recorded as a deviation). A held Enter's repeat
  answers nothing; the bar reads the answer once, so a second Enter sends nothing more.
- **Who** (`src/renderer/lib/commandBroadcast.ts`). The list is the tabs a broadcast reached
  when the press asked (`broadcastChoices`), shown live: one that ends drops out when the
  chooser redraws, one opened since is not added, so All answers what the chooser showed. The
  answer is filtered again at the press (`liveBroadcastPick`), so a tab that ended while the
  chooser was up gets nothing. Terminal-only tabs, Ask Conductor and ended tabs are never
  listed, as before. With no agent tab to send to, the pressed tab says so and nothing asks.
- **The pressed tab** keeps what a press gave it (its page watch, the one note with the count);
  its agent pane is shown only when it is one of the tabs the press goes to. The keyboard goes
  to the pane it shows afterwards: the agent pane (once it is shown, as a single press waits for
  it), or the partner shell it was showing when it was not picked. Beta.16 sent that hand-off in
  the same moment as the pane switch, so it was dropped; the fix covers both cases.
- **Design points, on the defaults while the owner is away, one commit each:** the list starts
  with every listed tab ticked (`chooserStartPick`); a button keeps no pick from its last press
  (the bar numbers each press and keys the chooser by it). An owner answer later changes one
  commit.
- **Words:** the edit dialog's hint, the pill's label ("Sends to every open session, or the
  ones you pick") and the chip's tooltip say a press asks. The changelog, app-knowledge, tips,
  training steps and README lines are applied in the aggregate's own commit.
