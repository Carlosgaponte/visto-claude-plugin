# Visto plugin for Claude Code

This repository is the public distribution point for the Visto plugin. Installing
from here puts every Claude Code session on your team's Agent Work board in
[Visto](https://v2adesk.com), and lets teammates approve commands or answer
questions from the board — on a laptop or a phone — instead of walking to your
terminal.

## Install

```
claude plugin marketplace add Carlosgaponte/visto-claude-plugin
claude plugin install visto@visto
```

Your first Claude Code session opens Visto in your browser — sign in and click
Approve. Nothing else to set up: the hooks pick up your connected token on
their own.

See [`plugin/README.md`](plugin/README.md) for how the plugin behaves, its
settings, and troubleshooting.

## Where this comes from

This repository is published, not hand-edited: it's generated from the
`plugin/` source in V2A's `v2adesk` repository by `scripts/publish-plugin.sh`.
Changes should go there, not here.
