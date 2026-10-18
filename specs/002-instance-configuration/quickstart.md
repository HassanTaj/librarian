# Validation Guide: Secure Installation and Instance Settings

**Status**: Design guide dated 2026-10-19. The new setup/settings code, operator script, fixtures and tests must be implemented before these journeys can pass. Planning did not run application tests or contact providers. Existing command names below were inspected in package.json; no nonexistent v2 test script is claimed.

## Prerequisites and isolation

Use the current repository with its installed compatible Node/dependency set. Preserve unrelated changes. Read the [plan](plan.md), [API contract](contracts/instance-api.md), [configuration contract](contracts/configuration.md) and [data model](data-model.md). Provision only disposable local test infrastructure for test execution: the existing harness accepts loopback MongoDB at `mongodb://127.0.0.1:27018`, generates a unique `librarian_test_*` database/content root and removes only those fixtures. Do not point it at `librarian_dev` or shared/live databases. Keep test-provider credentials synthetic and root files ignored/protected; never paste values into logs or chat.

Retain standalone MongoDB in acceptance coverage, matching the existing CI service. Controlled OIDC/GitHub fixtures must exercise real signature/state/PKCE/nonce and HTTP/application boundaries rather than blanket-mock the behavior. Future v2 fixtures must create distinct host marker/root key/bootstrap files, explicit instance IDs, owner/role identities and restartable Next processes through the existing harness. Use a separate fixture-only approved transport policy for loopback providers; it must not become a production network bypass. Production callbacks/providers need separately approved genuine DEV evidence.

## Run the existing local gates after implementation

Run from `D:\Repos\VPS & Homelab Infrastructure\librarian`. Each command is a separate step; investigate failures before proceeding. Coverage collection includes the unit/integration/client projects and actual server evidence, so repeat targeted suites only when useful during development.

```powershell
npm run test:unit
npm run test:integration
npm run test:coverage
npm run coverage:check
npm run typecheck
npm run lint
npm run build
npm run test:e2e
```

Expected: required tests pass without retries/skips; source provenance and zero-hit inventory are present; statements, branches, functions and lines each >=95% globally, C7 and every applicable existing C1-C6 scope. Scope names/membership/checker schema must be extended first as the plan requires; the current checker only supports C1-C6. Browser acceptance covers Chromium, Firefox and WebKit. Type/lint/build must pass against the completed current source. Missing instrumentation/report or unassigned new runtime file fails acceptance.

For container acceptance, build a disposable local image using the existing Dockerfile/CI pattern, never publish it:

```powershell
docker build --tag librarian:ci .
$env:LIBRARIAN_TEST_IMAGE = 'librarian:ci'
npm run test:container
Remove-Item Env:LIBRARIAN_TEST_IMAGE
```

This block is a future local-only validation procedure, not an operation executed during planning. Do not start/recreate shared Docker services. `npm run validate:artifacts` currently validates 001 and depends on coverage evidence; after the planned v2-aware extension it must validate 002 without weakening 001. Until then use direct v2 Markdown link, identifier, inventory and preservation checks; a v1 validator pass does not prove v2 completeness.

## Acceptance journeys

| Journey / requirements | Procedure with synthetic fixtures | Required evidence |
|---|---|---|
| Fresh installation: FR001-013; SC001-003 | Empty isolated storage and explicit protected fresh intent; start without optional providers; visit `/repositories/setup`; authorize; complete welcome/database/Zitadel/GitHub/preferences/owner/review. Restart between steps; expire session and reauthorize. | Safe prerequisite guidance, durable draft, no normal delivery/jobs before readiness; verified candidate identity AND current instance-admin role; exactly one ready/owner commit and consumed bootstrap |
| Setup attacks: FR006-008,012-013,025; QG004 | Direct API requests without session; wrong credential/CSRF/origin; guessing/replay/expired cookies; altered revision/state/issuer/subject; two finalizers; interrupt at every write and restart. | Zero unauthorized mutation; bounded 429 quotas across processes; safe errors/logs; exactly one owner; committed adoption failure reports pending/maintenance, never resets setup |
| Provider truth/security: FR010-011,019,024-025 | Fixture discovery succeeds while login fails; App signing succeeds without installation; no webhook delivery; redirects, metadata/private/mapped addresses and DNS answer changes; bad keys and response-size/time limits. | Separate actual check statuses/times/versions; required failures block activation; absent install/delivery visible warning only where allowed; no prohibited outbound connection or secret/body leakage |
| Settings authorization: FR014-015,025; SC004 | Anonymous, wrong issuer/project, catalog-only admin, role-only, binding-only, reader, bound instance admin and owner; call every page/read/test/write/rollback/audit route directly. | Only permitted binding+current-role identities succeed; instance authority grants neither private reading nor catalog mutations; exact 15-minute role deadline/failed refresh fail closed |
| Draft/edit UX: FR016-020; SC005,012 | Save name/description/default folder; Cancel unsaved changes; two editors with one stale token; explicit secret replace, blank inputs and malformed/unknown fields; reboot/recreate and reload canonical state. | Active unchanged until Apply; stale409, invalid input leaves old data; no secret echo; draft and active survive; inline accessible errors, unsaved warning, clear saved/pending/active status |
| Activation/rotation: FR022-026; SC006-007 | Serve private requests, stream bounded assets and run worker during Apply in two v2 processes. Delay requests/claims/publication/cleanup and crash after each catalog fence/commit/adoption. Rotate key/secret; move clock to exact webhook expiry. | One revision per operation; CAS gate rejects new stale admission; all old worker effects fenced; completion <=120s or explicit maintenance; no old heartbeat readiness; one old secret accepted only before deadline, dedupe retained, rejected at/after retirement |
| Provider continuity: FR012,023,030 | Current owner proves target candidate identity/role before issuer/project/client/origin change. Attempt email match, old-provider subject substitution, stale proof, missing dedicated role and owner loss. | Explicit binding continuity; both callbacks registered; old epochs/sessions/role proof rejected; protected verified recovery only, no public first-owner claim |
| Legacy migration: FR027-029,033; SC008,010 | Full legacy fixture with accounts/OAuth ciphertext/roles/catalogs/installation mappings/jobs/receipts/generations. Include `setup` and `settings` catalogs. Enroll with protected operator plus both current admin roles. Review/import; drain v1 before commit; test failures and rollback. | Legacy operation preserved before explicit cutover; no open bootstrap; all IDs/routes/ciphertext/receipts/snapshot pointers recover unchanged; nested pages do not capture existing catalog routes; no silent config merge/fallback |
| Recovery/retention: FR021,030-031,036; SC009,014 | Disconnect DB/provider, remove/substitute key/marker, delete singleton, restore consistent synthetic DB/content, exhaust audit outbox, crash during outbox drain and retired-secret pruning; bump host recovery epoch using protected procedure. | Missing state never fresh; no plaintext history; idempotent audit, bounds enforced; current/previous credentials and snapshots recover; restored setup/OIDC/session authority invalidated; no stale cleanup deletes live generations |
| V1 regressions: FR033-034; QG006 | Run public/anonymous-private/reader/wrong-role/admin-without-reader for HTML, overview, navigation, metadata, search, assets; exact freshness/logout-back/cross-repo/disable/visibility. Exercise signed webhook, dedupe, wrong branch/content, concurrency/lease loss/restart/access loss/last-good and original-blob integrity. | All affected V1/ST01-13 outcomes and original matrix obligations preserved; no private bytes on denied paths; no source execution, rebuild requirement or weakened tests |
| Operator documentation: FR035; SC012 | Follow six planned guides and placeholder local Compose example after implementation; perform protected prepare/enroll/transfer/recovery/key rotation with fixtures; then create catalog, sync/read and edit Settings. | Commands work against actual implementation, placeholders only; no source/provider provisioning automation or private-content publication implied; keyboard/mobile/theme journeys usable |

Capture sanitized pass/fail counts, exact versions/revisions, gate timings, race/crash outcomes and four coverage metrics. Do not record credentials, ciphertext, private docs, environment values or sensitive provider responses as evidence. Fixed policy values and failure outcomes are in research/contracts; tests must assert behavior, not merely CSS classes.

## Live DEV and release evidence remain separate

Before production, BG-01 must measure the declared corpus/resource/latency/ingestion/recovery workload with v2 overhead under 0.5 CPU/512 MB. BG-02 requires separately approved DEV hostname/provider/DB/storage login, refresh, logout, role removal, all private delivery boundaries, signed GitHub sync and consistent restore/previous-image rollback. Full recovery/rollback target is <=30 minutes for that corpus. BG-03 requires explicit image/private-content/infrastructure/deployment approvals, prior image/config/keys and coherent backups, actual infrastructure checkout/provider revalidation, DEV before production, health and browser checks. T087 quickstart completion is not inferred from saved coverage.

Mocked fixtures and this document prove none of those live gates. Do not run remote restarts, sender/role/secret mutations, volume deletion, image publication or deployment during the plan workflow.
