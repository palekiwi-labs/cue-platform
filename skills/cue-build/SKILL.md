---
name: cue-build
description: |
  Use when the session mode is build, or when executing an implementation
  plan.
---

# Build Sessions

A build session delivers working, verified code.

## Purpose and Outputs

- **Purpose**: Implement features, fix bugs, and write tests against an
  agreed specification or plan.
- **Outputs**: Code changes, passing tests, plans (`plan/`), deferred
  obligations as tasks (`task/`), and milestone history (the context log).

## Verification & Manual QA

Implementation outcomes are verified against the agreed specification (`spec/index.md`) or executive plan (`plan/`).

- **Automated & Manual Verification**: For user-facing features, CLI UX, editor plugins, or interactive tools, evaluate whether manual verification by a human operator is appropriate alongside automated tests.
- **Human Attestation**: Never assume or fabricate human-attested verification steps autonomously. Await explicit user confirmation before marking human-verified steps complete.

## Boundaries

- Implement the requested scope only. Capture out-of-scope discoveries as
  `note` or `task` artifacts.

<!-- Placeholder. Extend with behavioural guidance as this mode is
exercised in practice. -->
