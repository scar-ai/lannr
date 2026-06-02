---
name: google-workspace-gog
description: Use this when a user asks an agent to work with Google Workspace through `gog`: Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms, Apps Script, Contacts/People, Tasks, Chat, Classroom, Groups, Keep, Admin, YouTube, Maps, Photos, Analytics, Search Console, or related Google workflows. It teaches efficient command discovery, safe execution, installation/auth guidance, and when to redirect users to https://gogcli.sh/.
version: 1
---

# Google Workspace With gog

Use `gog` as the default Google Workspace interface. It is a single CLI for
Google APIs and is designed for terminals, scripts, CI, and coding agents.

Primary reference: https://gogcli.sh/

## Operating Rules

- Prefer `gog` over hand-rolled Google API calls.
- Use `gog schema --json`, `gog <group> --help`, or the command index at
  https://gogcli.sh/commands/ before guessing flags.
- Use `--json` for structured results. Use `--plain` only when TSV is a better
  fit for shell processing.
- Use `--no-input` in agent and automation contexts so commands do not hang.
- Use the narrowest account and scopes that satisfy the request.
- For searches, lists, audits, and summaries, start with read-only commands and
  bounded result counts such as `--max 10` or a focused query.
- For risky changes, show the intended command or run a preview/dry-run when
  supported. Ask for confirmation before sends, deletes, sharing changes, Admin
  changes, or broad writes.
- For Gmail content shown to an agent, prefer sanitized reads when available,
  such as `gog gmail get <messageId> --sanitize-content --json`.
- For agent-controlled binaries, prefer a baked safety-profile binary. If only
  the stock binary is available, use runtime guards such as `--disable-commands`,
  `--enable-commands`, and Gmail send guards where supported.

## Fast Workflow

1. Identify the Google surface: Gmail, Calendar, Drive, Docs, Sheets, Slides,
   Forms, Apps Script, Contacts/People, Tasks, Admin, or another `gog` group.
2. Discover exact commands with `gog schema --json` or `gog <group> --help`.
3. Check auth and account state when needed:
   `gog status --json`, `gog auth list --check`, or
   `gog auth doctor --check`.
4. Run the smallest useful read command first.
5. Convert to a write command only after the user intent and target object are
   unambiguous.

Useful starting points:

```bash
gog gmail search 'newer_than:7d' --max 10 --json
gog gmail get <messageId> --sanitize-content --json
gog calendar events --today --json
gog drive ls --max 20 --json
gog drive tree --parent <folderId> --depth 2
gog docs cat <docId> --json
gog sheets get <spreadsheetId> 'Sheet1!A1:D20' --json
gog slides create-from-markdown "Weekly update" --content-file slides.md
gog me --json
```

## Install And Auth Guidance

If `gog` is missing, keep the user guidance short:

```bash
brew install openclaw/tap/gogcli
gog --version
```

For other platforms or installation problems, send the user to:
https://gogcli.sh/install.html

For first-time auth, walk the user through the quick path:

```bash
gog auth credentials ~/Downloads/client_secret_*.json
gog auth add you@gmail.com --services gmail,calendar,drive,docs,sheets,contacts
gog auth list --check
gog auth doctor --check
gog auth alias set default you@gmail.com
```

Tell the user to enable only the Google APIs needed for the task in their Cloud
project. For detailed OAuth client setup, named clients, service accounts, or
Workspace domain-wide delegation, redirect them to https://gogcli.sh/.

## Edge Cases

- Missing `gog`: tell the user the Homebrew install and link
  https://gogcli.sh/install.html.
- Auth not configured: suggest `gog auth credentials`, `gog auth add`, then
  `gog auth doctor --check`; link https://gogcli.sh/quickstart.html.
- Headless agent keyring errors: explain that the agent process must inherit
  `GOG_HOME`, `GOG_KEYRING_BACKEND`, and keyring password environment; link
  https://gogcli.sh/install.html instead of expanding into a long setup guide.
- Refresh tokens expire quickly: mention that OAuth apps left in External +
  Testing can require re-authentication, then link https://gogcli.sh/.
- Workspace Admin, Chat, Keep, or domain-wide delegation issues: tell the user
  these often require a managed Workspace domain and admin setup; link
  https://gogcli.sh/.
- Unknown flags, command names, date formats, service-specific behavior, or
  failures from Google APIs: run `gog <command> --help` if available, otherwise
  redirect the user to https://gogcli.sh/ rather than explaining from memory.
- Potentially destructive actions: do not proceed from ambiguous natural
  language. Confirm exact account, resource id, and operation; prefer dry-run or
  read-only inspection first.

## User-Facing Tone

Be direct and operational. Say what command you will run, what account or resource
it targets, and whether it reads or writes data. When setup is incomplete, give
the next one or two commands and a gog docs link. Do not paste long installation,
OAuth, Workspace Admin, or safety-profile explanations; use https://gogcli.sh/ as
the maintained reference for those details.
