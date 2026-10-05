# Security

Arbor holds sign-ins to your AI accounts, runs a proxy on your Mac and reaches your other machines over SSH, so
security reports matter a lot to us.

## Reporting a problem

Please don't open a public issue. Report it privately through
[GitHub's private vulnerability reporting](https://github.com/aaronvanston/arbor/security/advisories/new), with what
you found, the steps to reproduce it and the Arbor version (Settings › About).

You'll hear back within a week. Once a fix is out, the advisory is published with credit to you, unless you'd rather
not be named.

## What's in scope

- The Arbor app and its `arbor` command line, in this repository.
- What Arbor writes to your machines: its scripts, backups and the files it changes for you.
- The update feed: release assets and the signed update list.

Problems in the proxy core itself belong to [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). If you're
not sure where something belongs, report it here and we'll pass it on.

## Supported versions

Only the newest stable release and the newest nightly get fixes. Settings › Updates installs them.
