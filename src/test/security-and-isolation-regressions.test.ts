/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { ServerStorage } from '../server/storage';
import { createDatabaseConnection, initializeDatabaseSchema } from '../server/db/index';
import { DrizzleStorageAdapter } from '../server/db/adapter';
import { createMcpServer } from '../server/mcp/server';
import { User, PersistedAuditRecord, PersistedFindingRecord, AuthoritativeVerification, OutcomeFeeObligation } from '../server/types';

describe('Security, Data Integrity & Persistence Regressions Test Suite', () => {
  let jsonStorage: ServerStorage;
  let drizzleStorage: DrizzleStorageAdapter;

  const mockUserA: User = {
    id: 'usr_sec_a',
    email: 'sec_a@example.com',
    password_hash: 'hash_a',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const mockUserB: User = {
    id: 'usr_sec_b',
    email: 'sec_b@example.com',
    password_hash: 'hash_b',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  beforeEach(async () => {
    jsonStorage = ServerStorage.getInstance('data', 'test-sec-db.json');
    jsonStorage.setTestMode(true);
    jsonStorage.clearAll();
    await jsonStorage.createUser(mockUserA);
    await jsonStorage.createUser(mockUserB);

    const { db, client } = createDatabaseConnection({ url: ':memory:' });
    await initializeDatabaseSchema(client);
    drizzleStorage = new DrizzleStorageAdapter(db, client);
    drizzleStorage.setTestMode(true);
    await drizzleStorage.createUser(mockUserA);
    await drizzleStorage.createUser(mockUserB);
  });

  // =========================================================================
  // TASK 1 REGRESSIONS: MCP Authorization & Cross-Account Isolation
  // =========================================================================
  describe('Task 1: MCP Authorization & Cross-Account Isolation', () => {
    it('get_finding_details: fails closed when finding belongs to another user even if global registry points to requesting user', async () => {
      const auditA: PersistedAuditRecord = {
        audit_id: 'aud_user_a',
        user_id: mockUserA.id,
        source: 'langfuse',
        total_spend_usd: 1000,
        potential_savings_usd: 200,
        annualized_savings_projection_usd: 2400,
        is_sample_data: false,
        findings_count: 1,
        created_at: new Date().toISOString(),
      };
      await jsonStorage.saveAudit(auditA);

      const findingA: PersistedFindingRecord = {
        audit_id: 'aud_user_a',
        finding_id: 'fnd_shared_id',
        user_id: mockUserA.id, // Owned by User A
        rule_id: 'MODEL_RIGHT_SIZING',
        title: 'Title A',
        summary: 'Summary A',
        baseline_spend_usd: 1000,
        estimated_savings_usd: 200,
        annualized_projection_usd: 2400,
        eligible_event_count: 10,
        status: 'DETECTED',
        is_sample_data: false,
        created_at: new Date().toISOString(),
      };
      await jsonStorage.saveFinding(findingA);

      // Malicious scenario: Global registry is maliciously or mistakenly set to User B
      await jsonStorage.registerFindingOwnership('fnd_shared_id', mockUserB.id);

      // User B requests finding details
      const serverB = createMcpServer(mockUserB, jsonStorage);
      const toolB = (serverB as any)._registeredTools['get_finding_details'];
      const resultB = await toolB.handler({ finding_id: 'fnd_shared_id' });

      // MUST FAIL CLOSED with FINDING_NOT_FOUND because findingRecord.user_id !== user.id
      assert.strictEqual(resultB.isError, true);
      const parsed = JSON.parse(resultB.content[0].text);
      assert.strictEqual(parsed.error, 'FINDING_NOT_FOUND');
    });

    it('get_finding_details: fails closed if audit_id belongs to another user', async () => {
      const auditA: PersistedAuditRecord = {
        audit_id: 'aud_owned_by_a',
        user_id: mockUserA.id,
        source: 'langfuse',
        total_spend_usd: 500,
        potential_savings_usd: 100,
        annualized_savings_projection_usd: 1200,
        is_sample_data: false,
        findings_count: 1,
        created_at: new Date().toISOString(),
      };
      await jsonStorage.saveAudit(auditA);

      const findingA: PersistedFindingRecord = {
        audit_id: 'aud_owned_by_a',
        finding_id: 'fnd_a_1',
        user_id: mockUserA.id,
        rule_id: 'MODEL_RIGHT_SIZING',
        title: 'Title A',
        summary: 'Summary A',
        baseline_spend_usd: 500,
        estimated_savings_usd: 100,
        annualized_projection_usd: 1200,
        eligible_event_count: 5,
        status: 'DETECTED',
        is_sample_data: false,
        created_at: new Date().toISOString(),
      };
      await jsonStorage.saveFinding(findingA);

      // User B requests finding specifying User A's audit_id
      const serverB = createMcpServer(mockUserB, jsonStorage);
      const toolB = (serverB as any)._registeredTools['get_finding_details'];
      const resultB = await toolB.handler({ finding_id: 'fnd_a_1', audit_id: 'aud_owned_by_a' });

      assert.strictEqual(resultB.isError, true);
      const parsed = JSON.parse(resultB.content[0].text);
      assert.strictEqual(parsed.error, 'FINDING_NOT_FOUND');
    });

    it('evaluate_verification: rejects evaluate if finding is owned by another user', async () => {
      const auditA: PersistedAuditRecord = {
        audit_id: 'aud_eval_a',
        user_id: mockUserA.id,
        source: 'langfuse',
        total_spend_usd: 1000,
        potential_savings_usd: 200,
        annualized_savings_projection_usd: 2400,
        is_sample_data: false,
        findings_count: 1,
        created_at: new Date().toISOString(),
      };
      await jsonStorage.saveAudit(auditA);

      const findingA: PersistedFindingRecord = {
        audit_id: 'aud_eval_a',
        finding_id: 'fnd_eval_1',
        user_id: mockUserA.id,
        rule_id: 'MODEL_RIGHT_SIZING',
        title: 'Title A',
        summary: 'Summary A',
        baseline_spend_usd: 1000,
        estimated_savings_usd: 200,
        annualized_projection_usd: 2400,
        eligible_event_count: 20,
        status: 'DETECTED',
        is_sample_data: false,
        created_at: new Date().toISOString(),
      };
      await jsonStorage.saveFinding(findingA);

      // User B tries to evaluate verification on User A's finding
      const serverB = createMcpServer(mockUserB, jsonStorage);
      const toolB = (serverB as any)._registeredTools['evaluate_verification'];
      const resultB = await toolB.handler({
        finding_id: 'fnd_eval_1',
        telemetry_data: JSON.stringify([{ id: 'evt_1', cost_usd: 0.01, timestamp: new Date().toISOString() }]),
      });

      assert.strictEqual(resultB.isError, true);
      const parsed = JSON.parse(resultB.content[0].text);
      assert.strictEqual(parsed.error, 'FINDING_NOT_FOUND');
    });
  });

  // =========================================================================
  // TASK 2 REGRESSIONS: Scoped Identity (Verifications & Outcome Fees)
  // =========================================================================
  describe('Task 2: Scoped Identity (Verifications & Outcome Fees)', () => {
    for (const [storageName, getStorageInstance] of [
      ['ServerStorage (JSON)', () => jsonStorage],
      ['DrizzleStorageAdapter (LibSQL)', () => drizzleStorage],
    ] as const) {
      describe(`Storage: ${storageName}`, () => {
        const recurringFindingId = 'fnd_right_sizing_gpt-4_gpt-4o-mini';

        it('isolates verifications across distinct audits and users for the same finding ID', async () => {
          const storage = getStorageInstance();

          // User A - Audit 1
          await storage.saveAudit({
            audit_id: 'aud_a_1',
            user_id: mockUserA.id,
            source: 'langfuse',
            total_spend_usd: 500,
            potential_savings_usd: 100,
            annualized_savings_projection_usd: 1200,
            is_sample_data: false,
            findings_count: 1,
            created_at: new Date().toISOString(),
          });

          // User B - Audit 2
          await storage.saveAudit({
            audit_id: 'aud_b_1',
            user_id: mockUserB.id,
            source: 'helicone',
            total_spend_usd: 800,
            potential_savings_usd: 200,
            annualized_savings_projection_usd: 2400,
            is_sample_data: false,
            findings_count: 1,
            created_at: new Date().toISOString(),
          });

          const verA: AuthoritativeVerification = {
            id: 'ver_a_1',
            finding_id: recurringFindingId,
            audit_id: 'aud_a_1',
            user_id: mockUserA.id,
            stage: 'VERIFIED_RESULT',
            is_authoritative: true,
            is_simulated: false,
            baseline_start: new Date(Date.now() - 86400000 * 10).toISOString(),
            baseline_end: new Date(Date.now() - 86400000 * 5).toISOString(),
            baseline_sample_count: 20,
            baseline_avg_cost_usd: 0.05,
            observation_sample_count: 20,
            post_avg_cost_usd: 0.01,
            observed_reduction_pct: 80,
            verified_annualized_savings_usd: 1200,
            verification_confidence: 'HIGH',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };

          const verB: AuthoritativeVerification = {
            id: 'ver_b_1',
            finding_id: recurringFindingId,
            audit_id: 'aud_b_1',
            user_id: mockUserB.id,
            stage: 'VERIFIED_RESULT',
            is_authoritative: true,
            is_simulated: false,
            baseline_start: new Date(Date.now() - 86400000 * 10).toISOString(),
            baseline_end: new Date(Date.now() - 86400000 * 5).toISOString(),
            baseline_sample_count: 30,
            baseline_avg_cost_usd: 0.10,
            observation_sample_count: 30,
            post_avg_cost_usd: 0.02,
            observed_reduction_pct: 80,
            verified_annualized_savings_usd: 2400,
            verification_confidence: 'HIGH',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };

          await storage.saveVerification(verA);
          await storage.saveVerification(verB);

          // Querying with user and audit scope retrieves the exact corresponding record
          const retrievedA = await storage.getVerificationByFindingId(recurringFindingId, mockUserA.id, 'aud_a_1');
          assert.ok(retrievedA);
          assert.strictEqual(retrievedA.id, 'ver_a_1');
          assert.strictEqual(retrievedA.user_id, mockUserA.id);
          assert.strictEqual(retrievedA.audit_id, 'aud_a_1');
          assert.strictEqual(retrievedA.verified_annualized_savings_usd, 1200);

          const retrievedB = await storage.getVerificationByFindingId(recurringFindingId, mockUserB.id, 'aud_b_1');
          assert.ok(retrievedB);
          assert.strictEqual(retrievedB.id, 'ver_b_1');
          assert.strictEqual(retrievedB.user_id, mockUserB.id);
          assert.strictEqual(retrievedB.audit_id, 'aud_b_1');
          assert.strictEqual(retrievedB.verified_annualized_savings_usd, 2400);
        });

        it('isolates outcome-fee obligations across distinct audits and users for the same finding ID', async () => {
          const storage = getStorageInstance();

          // Seed audits and verifications to satisfy foreign key constraints
          await storage.saveAudit({
            audit_id: 'aud_a_1',
            user_id: mockUserA.id,
            source: 'langfuse',
            total_spend_usd: 500,
            potential_savings_usd: 100,
            annualized_savings_projection_usd: 1200,
            is_sample_data: false,
            findings_count: 1,
            created_at: new Date().toISOString(),
          });

          await storage.saveAudit({
            audit_id: 'aud_b_1',
            user_id: mockUserB.id,
            source: 'helicone',
            total_spend_usd: 800,
            potential_savings_usd: 200,
            annualized_savings_projection_usd: 2400,
            is_sample_data: false,
            findings_count: 1,
            created_at: new Date().toISOString(),
          });

          await storage.saveVerification({
            id: 'ver_a_1',
            finding_id: recurringFindingId,
            audit_id: 'aud_a_1',
            user_id: mockUserA.id,
            stage: 'VERIFIED_RESULT',
            is_authoritative: true,
            is_simulated: false,
            baseline_start: new Date(Date.now() - 86400000 * 10).toISOString(),
            baseline_end: new Date(Date.now() - 86400000 * 5).toISOString(),
            baseline_sample_count: 20,
            baseline_avg_cost_usd: 0.05,
            observation_sample_count: 20,
            post_avg_cost_usd: 0.01,
            observed_reduction_pct: 80,
            verified_annualized_savings_usd: 1200,
            verification_confidence: 'HIGH',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });

          await storage.saveVerification({
            id: 'ver_b_1',
            finding_id: recurringFindingId,
            audit_id: 'aud_b_1',
            user_id: mockUserB.id,
            stage: 'VERIFIED_RESULT',
            is_authoritative: true,
            is_simulated: false,
            baseline_start: new Date(Date.now() - 86400000 * 10).toISOString(),
            baseline_end: new Date(Date.now() - 86400000 * 5).toISOString(),
            baseline_sample_count: 30,
            baseline_avg_cost_usd: 0.10,
            observation_sample_count: 30,
            post_avg_cost_usd: 0.02,
            observed_reduction_pct: 80,
            verified_annualized_savings_usd: 2400,
            verification_confidence: 'HIGH',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });

          const obA: OutcomeFeeObligation = {
            id: 'obl_a_1',
            user_id: mockUserA.id,
            audit_id: 'aud_a_1',
            finding_id: recurringFindingId,
            verification_id: 'ver_a_1',
            verified_annualized_savings_usd: 1000,
            fee_amount_usd: 200,
            currency: 'USD',
            status: 'PAYABLE',
            provider: 'LEMON_SQUEEZY',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };

          const obB: OutcomeFeeObligation = {
            id: 'obl_b_1',
            user_id: mockUserB.id,
            audit_id: 'aud_b_1',
            finding_id: recurringFindingId,
            verification_id: 'ver_b_1',
            verified_annualized_savings_usd: 2500,
            fee_amount_usd: 500,
            currency: 'USD',
            status: 'PAID',
            provider: 'LEMON_SQUEEZY',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };

          await storage.createOutcomeFeeObligation(obA);
          await storage.createOutcomeFeeObligation(obB);

          const fetchedA = await storage.getOutcomeFeeObligation(recurringFindingId, mockUserA.id, 'aud_a_1');
          assert.ok(fetchedA);
          assert.strictEqual(fetchedA.id, 'obl_a_1');
          assert.strictEqual(fetchedA.fee_amount_usd, 200);
          assert.strictEqual(fetchedA.status, 'PAYABLE');

          const fetchedB = await storage.getOutcomeFeeObligation(recurringFindingId, mockUserB.id, 'aud_b_1');
          assert.ok(fetchedB);
          assert.strictEqual(fetchedB.id, 'obl_b_1');
          assert.strictEqual(fetchedB.fee_amount_usd, 500);
          assert.strictEqual(fetchedB.status, 'PAID');

          // User B has paid outcome fee, User A has not
          const hasPaidA = await storage.hasPaidOutcomeFee(mockUserA.id, recurringFindingId, 'aud_a_1');
          assert.strictEqual(hasPaidA, false);

          const hasPaidB = await storage.hasPaidOutcomeFee(mockUserB.id, recurringFindingId, 'aud_b_1');
          assert.strictEqual(hasPaidB, true);
        });
      });
    }
  });

  // =========================================================================
  // TASK 3 REGRESSIONS: Transparent Persistence Handling in run_cost_audit
  // =========================================================================
  describe('Task 3: Transparent Persistence Status in run_cost_audit', () => {
    const sampleCsv = `timestamp,model,prompt_tokens,completion_tokens,cost_usd,application_id,status
2026-10-01T10:00:00Z,gpt-4,100,50,0.01,app-1,SUCCESS
2026-10-01T10:05:00Z,gpt-4,120,60,0.012,app-1,SUCCESS
2026-10-01T10:10:00Z,gpt-4,150,70,0.015,app-1,SUCCESS`;

    it('returns SKIPPED_ANONYMOUS when run unauthenticated', async () => {
      const server = createMcpServer(undefined, jsonStorage);
      const tool = (server as any)._registeredTools['run_cost_audit'];
      const result = await tool.handler({ telemetry_data: sampleCsv });

      assert.strictEqual(result.isError, undefined);
      const parsed = JSON.parse(result.content[0].text);
      assert.ok(parsed.persistence);
      assert.strictEqual(parsed.persistence.status, 'SKIPPED_ANONYMOUS');
      assert.strictEqual(parsed.persistence.audit_saved, false);
      assert.strictEqual(parsed.persistence.findings_saved_count, 0);
    });

    it('returns SUCCESS when run by authenticated user and storage succeeds', async () => {
      const server = createMcpServer(mockUserA, jsonStorage);
      const tool = (server as any)._registeredTools['run_cost_audit'];
      const result = await tool.handler({ telemetry_data: sampleCsv });

      assert.strictEqual(result.isError, undefined);
      const parsed = JSON.parse(result.content[0].text);
      assert.ok(parsed.persistence);
      assert.strictEqual(parsed.persistence.status, 'SUCCESS');
      assert.strictEqual(parsed.persistence.audit_saved, true);
      assert.strictEqual(parsed.persistence.findings_saved_count, parsed.findings_count);

      // Verify audit and findings actually exist in storage
      const storedAudit = await jsonStorage.getAudit(parsed.audit_id);
      assert.ok(storedAudit);
      assert.strictEqual(storedAudit.user_id, mockUserA.id);
    });

    it('returns FAILED or PARTIAL_SUCCESS if storage throws an error', async () => {
      // Mock storage where saveAudit succeeds but saveFinding fails
      const faultyStorage = Object.create(jsonStorage);
      faultyStorage.saveFinding = async () => {
        throw new Error('Database disk full');
      };

      const server = createMcpServer(mockUserA, faultyStorage);
      const tool = (server as any)._registeredTools['run_cost_audit'];
      const result = await tool.handler({ telemetry_data: sampleCsv });

      assert.strictEqual(result.isError, undefined);
      const parsed = JSON.parse(result.content[0].text);
      assert.ok(parsed.persistence);
      if (parsed.findings_count > 0) {
        assert.strictEqual(parsed.persistence.status, 'PARTIAL_SUCCESS');
        assert.strictEqual(parsed.persistence.audit_saved, true);
        assert.strictEqual(parsed.persistence.findings_saved_count, 0);
        assert.ok(parsed.persistence.warning);
      }
    });
  });
});
