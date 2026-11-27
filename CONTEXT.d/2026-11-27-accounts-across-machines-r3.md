## 2026-11-27 -- Accounts across machines: review round 3 fixes (beta.20 phase 5)

- R3-1: Adopt now follows one rule, in main and on every surface. Adopt is
  offered, and Adopt runs, only while EVERY folder on the machine with
  another install's mark is for one of this computer's accounts
  (`mayBeEarlierInstall`).
  - Why this rule: it is the stricter of the two. A folder there for an
    account this computer does not hold shows that another computer's app
    uses that login. This account's folder is then most likely that
    computer's too, and adopting it would take over that computer's
    sign-ins.
  - In main: the launch refusal is `adoptable` only under that rule, and
    otherwise says the folder is used by the app on another computer.
    accountsAdopt refuses outside the rule. A sign-in tab's note follows
    the machine's last read (no exec).
  - In the renderer: the notice checks the machine's read too, as the cards
    and the Switch Account list do.
- R3-2: when Adopt adopted something, its result says to Restart the tab.
  It names the tab when Adopt was chosen from that tab's notice.
- R3-3: the Adopt button's hover text names every folder it adopts on that
  machine.
