# Security Policy

`@gethelio/helio-openclaw` is part of the [Helio](https://github.com/gethelio/helio) project and
follows Helio's security process.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull
requests.**

Email **security@helio.so** with:

- a description of the vulnerability and its potential impact;
- steps to reproduce;
- affected versions;
- any known mitigations.

You can expect:

- acknowledgement within **48 hours**;
- an initial severity assessment within **5 business days**;
- progress updates at least every **7 days** until resolution;
- recognition in the release notes once a fix ships (anonymity available on request).

## Supported versions

The project is in pre-release (`0.x`) development. Security fixes are applied to the **latest `0.x`
release** only.

| Version | Supported                |
| ------- | ------------------------ |
| 0.x     | ✅ (latest release only) |
| < 0.1   | ❌                       |

## Scope and threat model

This package is a **cooperative, host-enforced** governance adapter: it translates OpenClaw plugin
hooks into Helio's policy sideband and **fails closed** when Helio is unreachable. It is not a
sandbox — a malicious in-process tool or plugin that bypasses OpenClaw's hook dispatch is outside
what this adapter can prevent (that vector is what Helio's `/install-scan` exists to gate).

In scope: the adapter's hook→sideband translation, its fail-closed guarantees, bearer-token
handling, and the evaluation/audit correlation binding. Vulnerabilities in third-party dependencies
are best reported upstream, but please tell us so we can assess impact and pin or patch.
