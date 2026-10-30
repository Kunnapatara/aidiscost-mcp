# AIDisCost MCP — Model Context Protocol AI Cost Optimization Server

AIDisCost MCP is a production-grade Model Context Protocol (MCP) tool server and web API designed for engineering teams and AI agents. It detects LLM spend anomalies and systemic waste, generates targeted remediation Fix Packages, and authoritatively verifies realized production savings before attributing outcome-based fees.

---

## 1. Commercial Architecture & Value Proposition

AIDisCost MCP operates on a transparent, outcome-aligned 3-tier commercial model:

1. **Tier 1: Free Cost Audit ($0)**
   - Low-friction acquisition entry point.
   - Comprehensive telemetry ingestion across CSV, JSON, JSONL, and NDJSON formats.
   - Rigorous data health evaluation, deduplication, and anomaly classification.
   - Detects model right-sizing opportunities, retry loops, context window stuffing, and anomalous token spikes.
   - Supports both anonymous ephemeral scans and authenticated persistent audits.

2. **Tier 2: Targeted Fix Package ($49 / finding)**
   - Actionable implementation blueprint for an identified optimization finding.
   - Includes root-cause hypotheses, configuration diffs, test plans, benchmark acceptance criteria, and rollback instructions.
   - Unlocked upon verified payment via Lemon Squeezy with webhook-driven entitlement provisioning.

3. **Tier 3: Contingent Outcome Fee (20% of Verified Savings)**
   - Performance-based compensation strictly contingent upon **server-authoritative post-deployment verification**.
   - Requires genuine production telemetry, rigorous event sampling (minimum 15 post-deployment observations), and a verified unit-cost reduction of at least 10%.
   - **Truth Boundary:** Synthetic sample data, simulation runs, or manipulated observation windows are mathematically barred from generating authoritative verification records or outcome fee obligations.

---

## 2. MCP Tools Specification

AIDisCost MCP exposes 4 core tools compliant with the Model Context Protocol specification:

### `run_cost_audit`
Ingests raw AI telemetry, runs data health heuristics, executes cost optimization rules, and optionally registers finding ownership and records persistence for authenticated users.

- **Parameters:**
  - `telemetry_data` (*string*, required): Raw telemetry payload (up to 1.8MB). Supported formats: CSV, JSON array, JSONL, NDJSON.
  - `source_hint` (*string*, optional): Explicit telemetry source hint (`langfuse`, `helicone`, `opentelemetry`, `custom_logs`).
  - `file_name` (*string*, optional): Telemetry source file name for provenance tracking.
- **Behavior:**
  - Detects telemetry format and schema headers automatically.
  - Generates data health score and confidence grade.
  - When authenticated via Bearer token:
    - Persists audit summary in database/storage with composite foreign keys.
    - Persists normalized findings keyed by `${audit_id}:${finding_id}` to ensure historical immutability.
    - Registers finding ownership in the ownership registry with read-back verification.
    - Returns structured persistence status distinguishing audit analysis from storage writes.
- **Key Output Fields:** `audit_id`, `detected_source`, `total_spend_usd`, `potential_savings_usd`, `annualized_savings_projection_usd`, `data_health`, `findings`, `persistence` (`SUCCESS`, `PARTIAL_SUCCESS`, `FAILED`, `SKIPPED_ANONYMOUS`), `ownership`.

### `get_finding_details`
Retrieves detailed engineering remediation instructions and test criteria for a specific finding.

- **Parameters:**
  - `finding_id` (*string*, required): Unique ID of the finding (e.g., `fnd_right_sizing_gpt-4_gpt-4o-mini`).
  - `audit_id` (*string*, optional): Audit ID containing the finding to disambiguate historical runs.
- **Security & Isolation:**
  - Requires valid user authentication.
  - Strict account isolation: returns `FINDING_NOT_FOUND` if the finding belongs to another account or if parent audit ownership does not match.
- **Key Output Fields:** `finding_id`, `audit_id`, `rule_id`, `baseline_spend_usd`, `candidate_spend_usd`, `estimated_savings_usd`, `annualized_projection_usd`, `fix_package` (unlocked if entitled; locked template if unpurchased), `entitlement` status.

### `check_entitlement`
Verifies whether the requesting user owns active paid entitlements or outcome fee obligations for a finding.

- **Parameters:**
  - `finding_id` (*string*, required): Target finding ID.
  - `audit_id` (*string*, optional): Specific baseline audit ID. If omitted and multiple findings match across different audits for the user, returns a safe fail-closed `AMBIGUOUS_FINDING` error instructing the caller to supply `audit_id`.
- **Security & Isolation:**
  - Requires user authentication. Non-disclosing `FINDING_NOT_FOUND` response on ownership mismatch or unowned finding.
- **Key Output Fields:** `finding_id`, `is_owner`, `fix_package.unlocked`, `outcome_fee` status and details.

### `evaluate_verification`
Evaluates empirical post-deployment telemetry against a baseline finding to authoritatively verify realized savings.

- **Parameters:**
  - `finding_id` (*string*, required): Target baseline finding ID.
  - `telemetry_data` (*string*, required): Post-deployment telemetry payload.
  - `audit_id` (*string*, optional): Specific baseline audit ID.
  - `source_hint` (*string*, optional): Telemetry format hint.
  - `file_name` (*string*, optional): Post-deployment file name.
  - `deployment_timestamp` (*string*, optional): ISO timestamp of production deployment.
- **Authoritative Invariants:**
  - Requires genuine, non-sample production telemetry (`is_sample_data: false`).
  - Minimum 15 eligible post-deployment observations.
  - Minimum 10.0% unit-cost reduction on comparable workload.
  - Observation window must be strictly positive and chronological (`start < end`).
  - Scoped to `(audit_id, finding_id, user_id)` to prevent collisions across multiple runs or users.
  - Automatically records authoritative verification in storage and calculates the 20% outcome fee basis when qualified.

---

## 3. Architecture & Data Flow

```
Telemetry Ingestion
   │  (CSV / JSON / JSONL / NDJSON)
   ▼
[Ingestion Pipeline] ──► Format Detection & Normalization
   │
   ▼
[Data Health Evaluator] ──► Deduplication, Model & Cost Coverage
   │
   ▼
[Rules Evaluator] ──► Right-Sizing, Retry Loops, Context Waste
   │
   ▼
[Persistence Layer] ──► Audits & Findings Storage (Composite Key: audit_id:finding_id)
   │
   ├──► [MCP Router] ──► stdio / SSE transport (Claude Desktop, Cursor)
   │
   ├──► [Web API / Auth] ──► Cookie / Bearer Sessions (SHA-256 Hashed at Rest)
   │
   ├──► [Billing / Webhooks] ──► Lemon Squeezy HMAC Verification & Idempotency
   │
   ▼
[Verification Engine] ──► Empirical Post-Deployment Comparator & Outcome Fees
```

---

## 4. Setup & Environment Configuration

### Prerequisites
- Node.js 20+ (or Bun 1.1+)
- npm 10+ (or bun)

### Environment Variables
Configure `.env` using `.env.example` as a template:

```bash
# Server Configuration
PORT=3000
NODE_ENV=production
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173

# Authentication & Session Security
SESSION_SECRET=your-secure-random-session-secret

# Database Storage (LibSQL / Turso)
# In development/test without Turso credentials, storage falls back to local file-backed JSON storage (.aidiscost-storage.json).
# In production, configure TURSO_DATABASE_URL and TURSO_AUTH_TOKEN:
TURSO_DATABASE_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your-turso-auth-token

# Lemon Squeezy Billing Integration
LEMON_SQUEEZY_API_KEY=your-lemon-squeezy-api-key
LEMON_SQUEEZY_STORE_ID=your-store-id
LEMON_SQUEEZY_WEBHOOK_SECRET=your-webhook-signing-secret
LEMON_SQUEEZY_FIX_PACKAGE_VARIANT_ID=123456
LEMON_SQUEEZY_OUTCOME_FEE_VARIANT_ID=654321
```

### Database Migrations
AIDisCost uses Drizzle ORM targeting SQLite / LibSQL. Execute migrations using the provided script:

```bash
# Execute migrations on target database (scripts/migrate-db.ts)
npm run db:migrate
# or with bun:
bun run db:migrate
```

*Note:* When connected to LibSQL/Turso, the database adapter automatically verifies and creates tables, foreign keys, and composite indexes via `initializeDatabaseSchema()` on startup.

---

## 5. MCP Client Integration

AIDisCost MCP supports both stdio transport (direct CLI spawn) and HTTP/SSE transport via the server. Because the server is written in TypeScript and executed via `tsx` or `bun`, use `npx tsx` or `bun` to run `server.ts` directly.

### Claude Desktop Configuration
Add the following to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "aidiscost": {
      "command": "npx",
      "args": ["-y", "tsx", "/path/to/aidiscost-mcp/server.ts"],
      "env": {
        "NODE_ENV": "production",
        "PORT": "3000",
        "SESSION_SECRET": "your-session-secret",
        "TURSO_DATABASE_URL": "libsql://your-db.turso.io",
        "TURSO_AUTH_TOKEN": "your-turso-auth-token"
      }
    }
  }
}
```

*Alternative (using Bun):*
```json
{
  "mcpServers": {
    "aidiscost": {
      "command": "bun",
      "args": ["/path/to/aidiscost-mcp/server.ts"]
    }
  }
}
```

### Cursor Configuration
Add to `.cursor/mcp.json` or your Cursor MCP Settings:

```json
{
  "mcpServers": {
    "aidiscost": {
      "command": "npx",
      "args": ["-y", "tsx", "/path/to/aidiscost-mcp/server.ts"]
    }
  }
}
```

---

## 6. Testing & Quality Verification

```bash
# Run full unit and integration test suite
npm test
# or: bun test

# Run TypeScript type check / linter
npm run lint
# or: bun run lint

# Build web frontend distribution bundle
npm run build
# or: bun run build
```

---

## 7. Security Invariants & Defensive Design

1. **Session Token Hashing at Rest:**
   - Raw session tokens are never stored in plain text. Only SHA-256 digests are persisted in storage.
   - Backward-compatible migration automatically upgrades legacy plaintext sessions upon initial verification.

2. **Account Isolation & Finding Protection:**
   - Finding records and ownership mappings are account-isolated.
   - Mismatched finding access returns non-disclosing 404/not-found errors to prevent ID enumeration.

3. **Strict Webhook Idempotency:**
   - Lemon Squeezy webhooks verify HMAC SHA-256 signatures before reading request payloads.
   - Events are deduplicated across a unique constraint on `event_id` with transaction-scoped rollbacks.

4. **Authoritative Truth Invariant:**
   - Simulated/demo datasets (`is_sample_data: true`) can never establish commercial verification or outcome fee obligations.
   - Unit-cost comparisons require equal scope, chronological observation windows, and a minimum of 15 post-deployment events.
