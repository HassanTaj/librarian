# Mandatory Specification Reconciliation and Requirement Carry-Forward

## Source Specification

`001-librarian-v1-portal`

Before finalizing the new specification for the first-run setup wizard and instance settings dashboard, inspect the complete `001-librarian-v1-portal` specification and all related artifacts.

These may include:

- `spec.md`
- `plan.md`
- `tasks.md`
- `research.md`
- `data-model.md`
- `contracts/`
- `quickstart.md`
- Checklists and acceptance criteria
- Related implementation notes and decision records

Locate these files in the existing repository. Do not assume their contents or locations.

## 1. Perform a Requirement-by-Requirement Audit

Extract every functional and non-functional requirement from `001-librarian-v1-portal`.

For each requirement, determine its actual implementation status:

- **Implemented and verified:** Existing implementation and tests confirm the behavior.
- **Partially implemented:** Some functionality exists, but acceptance criteria are incomplete.
- **Not implemented:** Required behavior is absent.
- **Superseded:** An explicit architectural decision or later approved specification replaces the requirement.
- **Unverifiable:** Evidence is insufficient to determine completion.

Do not mark a requirement implemented based solely on a checked task in `tasks.md`.

Verify against source code, tests, and available implementation evidence.

## 2. Carry Forward Outstanding Requirements

Every partially implemented, unimplemented, or unverifiable requirement must be accounted for in the new specification.

Do not silently discard requirements.

For each outstanding requirement, choose one of the following:

1. **Include in current implementation:** Required for the setup wizard, configuration lifecycle, settings dashboard, authentication, or compatibility.
2. **Carry forward as future work:** Still applicable to Librarian, but independent of the current feature.
3. **Propose supersession or removal:** Conflicts with a newer design, is no longer useful, or creates an unacceptable security or maintenance risk.

Do not remove or supersede existing requirements without documenting the rationale and obtaining owner approval for substantive scope changes.

Requirements outside the current implementation must remain explicitly tracked. Carry-forward does not automatically authorize implementing every outstanding feature.

## 3. Create a Traceability Matrix

Generate a requirement traceability document in the new specification directory.

Suggested filename:

`requirements-traceability.md`

Include:

| Field | Description |
|---|---|
| Requirement ID | Original identifier from `001-librarian-v1-portal` |
| Requirement | Concise statement of the original requirement |
| Original source | Exact source file and section |
| Implementation status | Verified, partial, missing, superseded, or unverifiable |
| Evidence | Source files, tests, and relevant implementation references |
| Disposition | Implement now, carry forward, or propose supersession |
| New requirement ID | Mapping into the new specification |
| Acceptance criteria | Conditions required to consider it completed |
| Priority | Critical, high, medium, or low |

Preserve original requirement identifiers wherever possible.

Maintain bidirectional traceability between the old and new specifications.

No original requirement should disappear without an explicit recorded disposition.

## 4. Reconcile the New Architecture

The new specification must incorporate the following architectural decisions:

- MongoDB remains the persistence layer.
- Zitadel remains the authentication provider.
- GitHub App integration remains the repository-access mechanism.
- Fumadocs/MDX remains the documentation rendering foundation.
- Existing documentation synchronization functionality must be preserved.
- The new first-run wizard manages initial instance setup.
- The Settings dashboard manages subsequent configuration changes.
- Sensitive credentials require secure storage and lifecycle management.
- Redis is deferred and must not be introduced without a demonstrated need.

Review original requirements against these decisions.

Identify conflicts rather than silently rewriting earlier requirements.

## 5. Update the New Specification and Tasks

After reconciliation:

1. Create or update the new feature specification.
2. Incorporate applicable outstanding requirements from `001-librarian-v1-portal`.
3. Define new setup wizard and settings management requirements.
4. Update the implementation plan.
5. Update the data model and relevant contracts.
6. Generate implementation tasks with requirement references.
7. Preserve unfinished requirements outside the current implementation in a clearly identified backlog.
8. Identify dependencies between outstanding v1 requirements and the new configuration architecture.
9. Add regression tests for previously implemented v1 behavior that may be affected.
10. Validate that every in-scope requirement has acceptance criteria and corresponding implementation or test tasks.

Follow the repository's existing specification framework and naming conventions. Do not invent a competing specification structure.

## 6. Preserve Historical Specifications

Do not delete or overwrite `001-librarian-v1-portal`.

Keep it as an immutable historical reference unless a minor correction is essential and explicitly justified.

The new specification should reference the original and explain:

- What has already been delivered
- What remains unfinished
- What is being implemented now
- What has been deferred
- What has been superseded, subject to approval

## 7. Mandatory Reconciliation Report

Before implementing the new feature, provide a summary containing:

- Total original requirements identified
- Number implemented and verified
- Number partially implemented
- Number not implemented
- Number unverifiable
- Number explicitly superseded
- Number being included in the current feature
- Number being carried into the backlog
- Any conflicting requirements requiring owner decisions

All counts must come from the actual specification audit, not estimates.

## Acceptance Gate

**Do not consider the new specification complete until every requirement from `001-librarian-v1-portal` has a documented disposition and traceable destination.**

Do not start implementation until the reconciliation is complete and substantive conflicts have been presented for owner approval.

The final deliverable must include both the new specification and its requirement traceability matrix.
