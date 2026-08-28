# Security policy

## Reporting a vulnerability

Please do not publish suspected vulnerabilities, exploit details, credentials,
secret URLs, or sensitive logs in a public issue. Open a minimal request through
the [Runmesh issue tracker](https://github.com/aloneio/runmesh/issues) that
asks for a private reporting channel, without including exploit details, then
wait for a maintainer response. If GitHub private vulnerability reporting is
available for this repository, prefer that channel.

Include, once a private channel is established:

- affected version, commit, or deployment component;
- a concise impact statement and reproduction steps or proof of concept;
- prerequisites and any suggested mitigation; and
- a safe contact method and disclosure coordination preference.

Avoid sending administrator passwords, MCP URL credentials, Runner tokens,
enrollment codes, production workspace contents, or customer data.

## Scope and response expectations

The Worker control plane, Runner, protocol package, dashboard, bootstrap paths,
repository dependencies, and documentation are in scope for reports. Social
engineering, service availability attacks, and vulnerabilities in unsupported
or locally modified deployments may be out of scope, but reports are still
welcome.

Maintainers aim to acknowledge a credible private report within seven calendar
days and, when practical, to provide a status update within 30 calendar days.
These are targets rather than guarantees; reports may require more time for
triage, reproduction, upstream coordination, or remediation.

This repository provides no fix-time, support, bounty, or
guaranteed-disclosure commitment. A maintainer may request clarification,
acknowledge a report, publish a fix or advisory, or decline a report based on
impact and available capacity. Do not disclose details publicly until the
maintainer and reporter agree on a disclosure plan, or 90 calendar days have
passed after the initial private report without a mutually agreed extension.

## Operational security

The software processes high-value local credentials and can operate on local
workspaces. Follow the deployment and security guidance in
[`docs/security.md`](../docs/security.md), use least privilege, protect Runner
hosts, configure log redaction, and rotate credentials if exposure is
suspected. The project license does not provide security warranties; see
[`LICENSE`](../LICENSE).
