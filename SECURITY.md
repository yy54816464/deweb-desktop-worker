# Security Policy

## Reporting a vulnerability

Please use this repository's **Security → Report a vulnerability** flow
(GitHub private security advisories). Do not open a public issue containing
secrets, exploit details, wallet addresses, or user data.

If private advisories are unavailable, open a minimal public issue asking for a
private contact channel; do not include the sensitive details.

## Supported versions

Security fixes target the latest published release and the current `main`
branch. Older releases may not receive fixes.

## Response

Maintainers aim to acknowledge a report within 7 days and to provide a status
update after triage. This is a best-effort open-source project; there is no bug
bounty or guaranteed response time.

## Scope

In scope:

- Cloud-sync control plane, authentication/session handling, rate limits, quota
- Pending uploads, profile/wallpaper pointers, object release and retention
- TapeRelay signing integration and D1 schema/migrations
- Worker source and build/deploy scripts in this repository

Out of scope:

- Android shell, Web frontend, browser or wallet implementations
- Third-party RPC, storage, or wallet providers
- Compromised user devices, social engineering, and physical access

Never include private keys, seed phrases, session tokens, or exported browser
profiles in a report.
