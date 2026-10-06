# Visto plugin for Claude Code

Puts every Claude Code session on your team's Agent Work board in Visto, and lets teammates approve commands or answer questions from the board — on a laptop or a phone — instead of walking to your terminal.

## One-time setup (under a minute)

1. **Install the plugin**
   ```
   claude plugin marketplace add Carlosgaponte/visto-claude-plugin
   claude plugin install visto@visto
   ```

2. **Sign in.** Your first Claude Code session opens Visto in your browser; sign in with Microsoft and click Approve. The hooks pick up a connected token on their own — nothing to copy or paste.

3. **Nothing else to set up.** Your first session in a repository creates its project, with you as lead; sessions outside a repository go to your personal General project. To see a colleague's existing project, ask its lead to add you.

### Alternative: a manual token

If you'd rather not sign in from the terminal (a headless box, CI, a shared machine), create a personal access token yourself: Visto Settings (link next to Sign out) → API Tokens → New token, name it, copy it once, then put it where Claude Code can see it:
```
export VISTO_API_TOKEN=v2adesk_pat_...
```
Set in the environment, `VISTO_API_TOKEN` always takes precedence over a signed-in session.

## What happens automatically

| Moment | Board |
|---|---|
| You start Claude Code in a repo | Session registered under the matching project |
| You send your first prompt | Card appears in **Requested**, titled with your prompt's first line |
| The model understands the task | Card renamed, moved to **Working** |
| Claude Code would show "Allow this command?" | Card moves to **Needs approval** with the exact command; answer on the board within 60 s or the terminal prompt appears as usual |
| The model needs a decision from you | **Needs approval** / **Needs input**; it waits for the board or for you in the terminal |
| Work done | Card moves to **Review**; a human drags it to **Done** |
| You close the session | Session marked ended; unfinished cards get a red flag |
| Session dies silently | Marked **lost** after 10 minutes |

Sessions are filed automatically: one development project per repository (created on first use, with you as lead), and a personal General project for sessions started outside a repository.

Projects are created automatically per repository, so the first person to open a repo becomes its lead; others who work in it see their sessions there once that lead or an admin adds them as members. Folders with no git remote get a project of their own per person. If an admin later wants a repo inside a curated project, first remove the repo from the auto-created project's settings, then add it to the curated one (a repo can belong to only one project).

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `VISTO_API_TOKEN` | — | Optional. A manual personal access token; skips sign-in and takes precedence over it. |
| `VISTO_BASE_URL` | `https://v2adesk.com` | Change only for a dev server. |
| `VISTO_APPROVAL_WAIT_SECONDS` | `60` | How long a permission prompt waits on the board before falling back to the terminal. |
| `VISTO_DISABLE` | — | Set to `1` to silence the plugin entirely — no sign-in, no network calls. Put it in the environment of any machine that should never connect. |

## Troubleshooting

- **Nothing appears on the board.** If you haven't approved a session in the browser yet, each new session shows a Visto message with the code — open the link in the Visto message and approve it. If the page warns that the request came from a different network, type the code from your terminal to approve; if you didn't start it, click Deny. Otherwise check `echo $VISTO_API_TOKEN`, or that `~/.config/visto/credentials.json` exists. Hooks print one `[visto] ...` line to stderr on failure; run a session with `claude --debug` to see it.
- **Asked to sign in again unexpectedly.** Your connected token was revoked or removed from Settings → API Tokens, or it reached its 90-day expiry (shown next to it in Settings); the next session starts sign-in over.
- **Clicked Deny by mistake.** The plugin waits 24 hours before asking again. To retry sooner, delete `~/.config/visto/backoff.json`.
- **A machine that should never connect** (a shared box, CI, a demo laptop): set `VISTO_DISABLE=1` in its environment and the plugin never starts sign-in or contacts Visto.
- **Permission prompts never reach the board.** The card must exist first (send a prompt). If another request is still open on the card, new ones step aside.
- **"Claude randomly disconnected."** Ask an admin to check the audit log for `oauth.replay_detected`.
