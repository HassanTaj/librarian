import { expect, it } from 'vitest';
import { LIMITS, HIGHLIGHT_LANGUAGES } from '../../lib/limits';

it('freezes the approved finite v1 policy values and units', () => {
  expect(LIMITS).toEqual({
    maxCatalogs: 20, maxFiles: 1000, maxPages: 500, maxSnapshotBytes: 52_428_800,
    maxMarkdownBytes: 262_144, maxMetadataBytes: 16_384, maxAssetBytes: 5_242_880, maxGitHubTreeBytes: 7_000_000,
    maxPathBytes: 1024, maxPathSegments: 32, maxMetadataDepth: 8, maxAstNodes: 50_000,
    maxHighlightedLanguages: 16, maxWebhookBytes: 1_048_576, maxControlRepositories: 1000, maxAdminBytes: 32_768, maxPublicApprovalBytes: 65_536,
    maxSearchQueryBytes: 256, maxSearchResults: 20, maxOAuthResponseBytes: 65_536, maxRoleResponseBytes: 524_288, requestTimeoutMs: 30_000,
    ingestionConcurrency: 1, fetchConcurrency: 2, upstreamTimeoutMs: 15_000, attemptTimeoutMs: 120_000,
    leaseMs: 30_000, heartbeatMs: 10_000, recoveryDeadlineMs: 45_000,
    idlePollMs: 5000, activePollMs: 1000, maxAttempts: 5, retryDelaysMs: [5000, 20_000, 60_000, 180_000],
    maxRetryAfterMs: 3_600_000, maxAdmissionReservations: 100_000,
    terminalDetailMs: 1_209_600_000, admissionRate: 60, admissionWindowMs: 60_000,
    maxCommittedGenerations: 3, maxRetainedGenerations: 2, maxStagingGenerations: 1,
    retainedGraceMs: 300_000, maxRetainedAgeMs: 86_400_000,
    maxReadPins: 64, readPinMs: 60_000, maxCacheEntries: 4, maxCacheBytes: 100_663_296,
    cacheIdleMs: 300_000, maxCatalogPayloadBytes: 209_715_200, maxPortalPayloadBytes: 4_294_967_296,
    sessionAbsoluteMs: 28_800_000, roleFreshMs: 900_000,
    roleQueryTimeoutMs: 5000, maxRolePages: 10, rolePageSize: 100, roleLeaseMs: 10_000, roleContenderMs: 2000,
  });
  expect(new Set(HIGHLIGHT_LANGUAGES).size).toBe(LIMITS.maxHighlightedLanguages);
  expect(LIMITS.retryDelaysMs).toHaveLength(LIMITS.maxAttempts - 1);
  expect(LIMITS.readPinMs).toBeGreaterThan(LIMITS.requestTimeoutMs);
  expect(LIMITS.leaseMs).toBeGreaterThan(LIMITS.heartbeatMs);
  expect(LIMITS.maxCatalogPayloadBytes).toBe(LIMITS.maxSnapshotBytes * (LIMITS.maxCommittedGenerations + LIMITS.maxStagingGenerations));
});
