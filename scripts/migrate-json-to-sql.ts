/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'path';
import { createDatabaseConnection, initializeDatabaseSchema } from '../src/server/db/index';
import { migrateJsonToSql } from '../src/server/db/migrate-json';

async function run() {
  console.log('[Migration] Starting JSON to SQL migration...');
  const jsonPath = path.resolve(process.cwd(), 'data', 'aidiscost-db.json');

  const { db, client } = createDatabaseConnection();
  await initializeDatabaseSchema(client);

  const result = await migrateJsonToSql(db, client, jsonPath);

  console.log('[Migration] Result:', JSON.stringify(result, null, 2));

  if (!result.success) {
    console.error('[Migration] Failed:', result.message);
    process.exit(1);
  }

  console.log('[Migration] Successfully migrated JSON to SQL database!');
  process.exit(0);
}

run().catch((err) => {
  console.error('[Migration] Unhandled error:', err);
  process.exit(1);
});
