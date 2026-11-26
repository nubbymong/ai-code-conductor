## 2026-11-26 -- remote: a helper tab names its account, and shows weekly limits and extra usage where this computer holds the account (3a)

2.1.3-beta.19 section 3 (aicc_planning#434), step 3a: built against section
1.1's field mode contract with a fake field mode in the unit tests; step 3b
merges 1.1's frozen head and its real field mode.

The label. Every start of a tab through the session helper, launch or attach,
runs one function, remote-helper/host-reads.ts readHostForStart: the
provider's host reads (the `reads` exec, as in beta.18) and, beside them, one
exec of the helper's field mode (the new `field` script: `aicc-helper field
--file "$h/<file>" --key <key>`, through the launcher, the helper's hash
checked first). File and key come from the provider package
(ProviderRemoteLaunch.accountField; Claude Code: `oauthAccount.emailAddress` of
`~/.claude.json`, the field the usual SSH status line reads). The answer is
the host's and untrusted: one line of at most 1 KiB with no control character,
or nothing; anything else is "not read". A host read that fails still fails
the start; the account read never does. Section 1.2's attach path calls the
same function, so the label and the bars' source are set again at each
attach.

The bars and extra usage come from this computer, never the host
(statusline-watcher.ts setHelperAccount, usage/remote-tab-usage.ts). The label
passes sanitiseRemoteAccountEmail. For an account this computer holds (an
account profile with that email, compared case-blind), the Account usage
page's figure (fetchAccountUsage: a running session's own status line figure
when one reports it, else its own read), read at most once per 60 s per
account however many tabs and status ticks ask, through sanitiseUsageBuckets
and sanitiseRateLimitExtra, and joined to each of the tab's status frames. For
one it does not hold (or no account named), the strip says "Model limits: not
available (own sign-in)"; a held account with no reading says "(no reading
yet)". Never an empty or zero bar: before the reading lands no bars are sent.
A host frame's usage buckets, extra usage, account label and the two new
not-shown reasons are dropped; the reasons are main's alone (the sanitiser
drops them from every payload). The header names the account as today's SSH
tab does; when the start named none it shows "Account not available" with the
reason in its title.

Not built: a usage read on the host with its token. 3.1.1's payload read: not
measured (the Ubuntu host's Claude Code was not signed in on 2026-11-26), so
CLAUDE_STATUS_KEEP is unchanged. No Token account kind exists in the app at
this base (AccountProfile has no sign-in kind), so a Token-signed host is one
this computer does not hold.
