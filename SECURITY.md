# Security policy

## Supported versions

The latest release of the current major version (`v1.x`) is supported. A fix
ships as a new patch release, and `v1` moves to it.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the repository's Security
tab and choose "Report a vulnerability", or go straight to
<https://github.com/JoshSLawrence/synapse-deploy/security/advisories/new>.

Please do not open a public issue for a vulnerability.

Include:

- the version or commit you tested
- what an attacker could do, and what they need to do it
- the steps to reproduce it, with placeholder names instead of real workspace,
  tenant or subscription details

This is a personal project, so the response is best effort: expect an
acknowledgement within 7 days. Fixes are disclosed in a coordinated way,
through a GitHub security advisory.

## Out of scope

- Vulnerabilities in Azure services themselves: report those to the
  [Microsoft Security Response Center][msrc].
- Vulnerabilities in dependencies that Dependabot already tracks.

[msrc]: https://msrc.microsoft.com/
