# Security policy

## Reporting a vulnerability

Please report it privately, not in a public issue:
**[Report a vulnerability](https://github.com/davidcoulson/HA-Strimmer/security/advisories/new)**
(the repository's Security tab → *Report a vulnerability*).

Include what you sent, what you expected, and what happened, plus the add-on version (shown in the
console header and on the first line of the log). You'll get an acknowledgement within a few days.
A fix ships as a normal add-on release, with an advisory once it's out.

## Supported versions

Only the latest release. The add-on updates from the Supervisor store, and fixes aren't backported.

## What counts

Strimmer sits between your browsers and Home Assistant, so anything that weakens what Home
Assistant would have enforced on its own is in scope. For example:

- Making Home Assistant see a different client address than the real one: forged
  `X-Forwarded-For` reaching `trusted_networks`, or an `ip_ban` that keys on the wrong address.
- A connection receiving entities, registry rows or cached responses that belong to another
  user's or another client's allowlist.
- Reaching the management console or its API (`/pause`, configuration writes) without going
  through Ingress or the access rules in DOCS.
- Making the proxy send requests anywhere other than the configured Home Assistant.
- Anything that lets a request bypass Home Assistant's own authentication.

Not in scope: vulnerabilities in Home Assistant itself (report those to
[Home Assistant](https://www.home-assistant.io/security/)), and anything that needs an
administrator to configure the add-on against their own interest.

This repository is a fork of
[GabrielGoldsteinAnidea/HA-Websocket-Stripper](https://github.com/GabrielGoldsteinAnidea/HA-Websocket-Stripper).
If a flaw is in code the two still share, it's worth telling upstream too.
