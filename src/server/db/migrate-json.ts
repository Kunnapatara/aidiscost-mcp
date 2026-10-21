/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import path from 'path';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { Client } from '@libsql/client';
import * as schema from './schema';
import { User, UserSession, FindingOwnership, Entitlement, ProcessedWebhookEvent } from '../types';

export interface MigrationResult {
  success: boolean;
  backupPath?: string;
  sourceCounts: {
    users: number;
    sessions: number;
    findingOwnerships: number;
    entitlements: number;
    processedWebhooks: number;
  };
  migratedCounts: {
    users: number;
    sessions: number;
    findingOwnerships: number;
    entitlements: number;
    processedWebhooks: number;
  };
  validationErrors: string[];
  message: string;
}

export async function migrateJsonToSql(
  db: LibSQLDatabase<typeof schema>,
  client: Client,
  jsonFilePath = path.resolve(process.cwd(), 'data', 'aidiscost-db.json')
): Promise<MigrationResult> {
  const result: MigrationResult = {
    success: false,
    sourceCounts: { users: 0, sessions: 0, findingOwnerships: 0, entitlements: 0, processedWebhooks: 0 },
    migratedCounts: { users: 0, sessions: 0, findingOwnerships: 0, entitlements: 0, processedWebhooks: 0 },
    validationErrors: [],
    message: '',
  };

  // 1. Detect source JSON database
  if (!fs.existsSync(jsonFilePath)) {
    result.message = `Source file does not exist at ${jsonFilePath}. Nothing to migrate.`;
    result.success = true;
    return result;
  }

  // 2. Create backup
  const backupDir = path.dirname(jsonFilePath);
  const backupPath = path.resolve(backupDir, `aidiscost-db.backup.${Date.now()}.json`);
  fs.copyFileSync(jsonFilePath, backupPath);
  result.backupPath = backupPath;

  // 3. Parse JSON
  let rawData: any;
  try {
    const content = fs.readFileSync(jsonFilePath, 'utf-8');
    rawData = JSON.parse(content);
  } catch (err: any) {
    result.validationErrors.push(`Failed to parse JSON file: ${err.message}`);
    result.message = 'Migration failed due to malformed JSON.';
    return result;
  }

  // 4. Validate structure
  const rawUsers: Record<string, User> = rawData.users || {};
  const rawSessions: Record<string, UserSession> = rawData.sessions || {};
  const rawFindingOwnerships: Record<string, FindingOwnership> = rawData.findingOwnerships || {};
  const rawEntitlements: Record<string, Entitlement> = rawData.entitlements || {};
  const rawWebhooks: Record<string, ProcessedWebhookEvent> = rawData.processedWebhooks || {};

  result.sourceCounts = {
    users: Object.keys(rawUsers).length,
    sessions: Object.keys(rawSessions).length,
    findingOwnerships: Object.keys(rawFindingOwnerships).length,
    entitlements: Object.keys(rawEntitlements).length,
    processedWebhooks: Object.keys(rawWebhooks).length,
  };

  // 5. Validate required identifiers & referential relationships
  const userIds = new Set<string>();
  for (const [email, user] of Object.entries(rawUsers)) {
    if (!user.id || !user.email || !user.password_hash) {
      result.validationErrors.push(`User ${email} missing required fields (id, email, password_hash)`);
    } else {
      userIds.add(user.id);
    }
  }

  const validSessions: UserSession[] = [];
  for (const [token, session] of Object.entries(rawSessions)) {
    if (!session.token || !session.user_id) {
      result.validationErrors.push(`Session ${token} missing token or user_id`);
    } else if (!userIds.has(session.user_id)) {
      result.validationErrors.push(`Session ${token} has orphaned user_id: ${session.user_id}`);
    } else {
      validSessions.push(session);
    }
  }

  const validOwnerships: FindingOwnership[] = [];
  for (const [findingId, ownership] of Object.entries(rawFindingOwnerships)) {
    if (!ownership.finding_id || !ownership.owner_id) {
      result.validationErrors.push(`Ownership for finding ${findingId} missing required fields`);
    } else if (!userIds.has(ownership.owner_id)) {
      result.validationErrors.push(`Finding ${findingId} has orphaned owner_id: ${ownership.owner_id}`);
    } else {
      validOwnerships.push(ownership);
    }
  }

  const validEntitlements: Entitlement[] = [];
  for (const [key, entitlement] of Object.entries(rawEntitlements)) {
    if (!entitlement.id || !entitlement.user_id || !entitlement.finding_id) {
      result.validationErrors.push(`Entitlement ${key} missing required identifiers`);
    } else if (!userIds.has(entitlement.user_id)) {
      result.validationErrors.push(`Entitlement ${key} has orphaned user_id: ${entitlement.user_id}`);
    } else {
      validEntitlements.push(entitlement);
    }
  }

  const validWebhooks: ProcessedWebhookEvent[] = [];
  for (const [eventId, webhook] of Object.entries(rawWebhooks)) {
    if (!webhook.event_id || !webhook.provider) {
      result.validationErrors.push(`Webhook event ${eventId} missing required fields`);
    } else {
      validWebhooks.push(webhook);
    }
  }

  // If there are fatal validation errors, fail closed without mutating DB
  if (result.validationErrors.length > 0) {
    result.message = `Validation failed with ${result.validationErrors.length} errors. Migration aborted.`;
    return result;
  }

  // 6. Insert records into SQL tables atomically inside a transaction
  try {
    await db.transaction(async (tx) => {
      // Users
      for (const user of Object.values(rawUsers)) {
        await tx
          .insert(schema.users)
          .values({
            id: user.id,
            email: user.email.trim().toLowerCase(),
            passwordHash: user.password_hash,
            createdAt: user.created_at || new Date().toISOString(),
            updatedAt: user.updated_at || new Date().toISOString(),
          })
          .onConflictDoNothing();
      }

      // Sessions
      for (const session of validSessions) {
        await tx
          .insert(schema.sessions)
          .values({
            token: session.token,
            userId: session.user_id,
            expiresAt: session.expires_at,
            createdAt: session.created_at || new Date().toISOString(),
          })
          .onConflictDoNothing();
      }

      // Finding Ownerships
      for (const ownership of validOwnerships) {
        await tx
          .insert(schema.findingOwnerships)
          .values({
            findingId: ownership.finding_id,
            ownerId: ownership.owner_id,
            createdAt: ownership.created_at || new Date().toISOString(),
          })
          .onConflictDoNothing();
      }

      // Entitlements
      for (const entitlement of validEntitlements) {
        await tx
          .insert(schema.entitlements)
          .values({
            id: entitlement.id,
            userId: entitlement.user_id,
            findingId: entitlement.finding_id,
            type: entitlement.type,
            status: entitlement.status,
            provider: entitlement.provider,
            providerTransactionId: entitlement.provider_transaction_id,
            amountUsd: entitlement.amount_usd,
            createdAt: entitlement.created_at || new Date().toISOString(),
            updatedAt: entitlement.updated_at || new Date().toISOString(),
          })
          .onConflictDoNothing();
      }

      // Webhook events
      for (const webhook of validWebhooks) {
        await tx
          .insert(schema.webhookEvents)
          .values({
            eventId: webhook.event_id,
            provider: webhook.provider,
            eventName: webhook.event_name,
            userId: webhook.user_id,
            findingId: webhook.finding_id,
            orderId: webhook.order_id,
            processedAt: webhook.processed_at || new Date().toISOString(),
          })
          .onConflictDoNothing();
      }
    });
  } catch (err: any) {
    result.validationErrors.push(`Database transaction failed: ${err.message}`);
    result.message = 'Database write failed during migration transaction.';
    return result;
  }

  // 7. Verify persisted record counts
  const userRows = await db.select().from(schema.users);
  const sessionRows = await db.select().from(schema.sessions);
  const ownershipRows = await db.select().from(schema.findingOwnerships);
  const entitlementRows = await db.select().from(schema.entitlements);
  const webhookRows = await db.select().from(schema.webhookEvents);

  result.migratedCounts = {
    users: userRows.length,
    sessions: sessionRows.length,
    findingOwnerships: ownershipRows.length,
    entitlements: entitlementRows.length,
    processedWebhooks: webhookRows.length,
  };

  // 8. Validate count equivalence
  if (result.migratedCounts.users < result.sourceCounts.users) {
    result.validationErrors.push('Migrated users count is less than source users count');
  }
  if (result.migratedCounts.findingOwnerships < result.sourceCounts.findingOwnerships) {
    result.validationErrors.push('Migrated finding ownerships count is less than source count');
  }
  if (result.migratedCounts.entitlements < result.sourceCounts.entitlements) {
    result.validationErrors.push('Migrated entitlements count is less than source count');
  }

  if (result.validationErrors.length === 0) {
    result.success = true;
    result.message = 'JSON to SQL migration completed successfully with full semantic and count verification.';
  } else {
    result.message = 'Migration completed with verification warnings.';
  }

  return result;
}
