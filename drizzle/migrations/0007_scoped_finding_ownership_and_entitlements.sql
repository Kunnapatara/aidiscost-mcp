PRAGMA foreign_keys = OFF;
--> statement-breakpoint
DROP TABLE IF EXISTS `finding_ownerships_new`;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `finding_ownerships_new` (
	`id` text PRIMARY KEY NOT NULL,
	`finding_id` text NOT NULL,
	`audit_id` text,
	`owner_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`audit_id`) REFERENCES `audits`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT OR IGNORE INTO `finding_ownerships_new` (`id`, `finding_id`, `audit_id`, `owner_id`, `created_at`)
SELECT 
	CASE 
		WHEN `audit_id` IS NOT NULL THEN `owner_id` || ':' || `audit_id` || ':' || `finding_id`
		ELSE `owner_id` || ':' || `finding_id`
	END AS `id`,
	`finding_id`,
	`audit_id`,
	`owner_id`,
	`created_at`
FROM `finding_ownerships`;
--> statement-breakpoint
DROP TABLE `finding_ownerships`;
--> statement-breakpoint
ALTER TABLE `finding_ownerships_new` RENAME TO `finding_ownerships`;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_finding_ownerships_owner_audit_finding` ON `finding_ownerships` (`owner_id`, `audit_id`, `finding_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_finding_ownerships_owner_finding_null_audit` ON `finding_ownerships` (`owner_id`, `finding_id`) WHERE `audit_id` IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_finding_ownerships_finding_id` ON `finding_ownerships` (`finding_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_finding_ownerships_owner_id` ON `finding_ownerships` (`owner_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_finding_ownerships_audit_id` ON `finding_ownerships` (`audit_id`);
--> statement-breakpoint
DROP TABLE IF EXISTS `verifications_new`;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `verifications_new` (
	`id` text PRIMARY KEY NOT NULL,
	`audit_id` text,
	`finding_id` text NOT NULL,
	`user_id` text NOT NULL,
	`stage` text NOT NULL,
	`is_authoritative` integer DEFAULT false NOT NULL,
	`is_simulated` integer DEFAULT false NOT NULL,
	`baseline_start` text NOT NULL,
	`baseline_end` text NOT NULL,
	`baseline_sample_count` integer NOT NULL,
	`baseline_avg_cost_usd` real NOT NULL,
	`deployment_timestamp` text,
	`observation_start` text,
	`observation_end` text,
	`observation_sample_count` integer DEFAULT 0 NOT NULL,
	`post_avg_cost_usd` real DEFAULT 0 NOT NULL,
	`observed_reduction_pct` real DEFAULT 0 NOT NULL,
	`verified_annualized_savings_usd` real DEFAULT 0 NOT NULL,
	`original_estimated_annualized_usd` real,
	`verification_confidence` text DEFAULT 'INSUFFICIENT_OBSERVATION' NOT NULL,
	`verification_notes` text,
	`post_deployment_file_name` text,
	`verified_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`audit_id`) REFERENCES `audits`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `verifications_new` (
	`id`,
	`audit_id`,
	`finding_id`,
	`user_id`,
	`stage`,
	`is_authoritative`,
	`is_simulated`,
	`baseline_start`,
	`baseline_end`,
	`baseline_sample_count`,
	`baseline_avg_cost_usd`,
	`deployment_timestamp`,
	`observation_start`,
	`observation_end`,
	`observation_sample_count`,
	`post_avg_cost_usd`,
	`observed_reduction_pct`,
	`verified_annualized_savings_usd`,
	`original_estimated_annualized_usd`,
	`verification_confidence`,
	`verification_notes`,
	`post_deployment_file_name`,
	`verified_at`,
	`created_at`,
	`updated_at`
)
SELECT
	`id`,
	`audit_id`,
	`finding_id`,
	`user_id`,
	`stage`,
	`is_authoritative`,
	`is_simulated`,
	`baseline_start`,
	`baseline_end`,
	`baseline_sample_count`,
	`baseline_avg_cost_usd`,
	`deployment_timestamp`,
	`observation_start`,
	`observation_end`,
	`observation_sample_count`,
	`post_avg_cost_usd`,
	`observed_reduction_pct`,
	`verified_annualized_savings_usd`,
	`original_estimated_annualized_usd`,
	`verification_confidence`,
	`verification_notes`,
	`post_deployment_file_name`,
	`verified_at`,
	`created_at`,
	`updated_at`
FROM `verifications`;
--> statement-breakpoint
DROP TABLE `verifications`;
--> statement-breakpoint
ALTER TABLE `verifications_new` RENAME TO `verifications`;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_verifications_finding_id` ON `verifications` (`finding_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_verifications_user_audit_finding` ON `verifications` (`user_id`, `audit_id`, `finding_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_verifications_user_finding_null_audit` ON `verifications` (`user_id`, `finding_id`) WHERE `audit_id` IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_verifications_user_id` ON `verifications` (`user_id`);
--> statement-breakpoint
DROP TABLE IF EXISTS `outcome_fee_obligations_new`;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `outcome_fee_obligations_new` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`audit_id` text,
	`finding_id` text NOT NULL,
	`verification_id` text NOT NULL,
	`verified_annualized_savings_usd` real NOT NULL,
	`fee_amount_usd` real NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`status` text NOT NULL,
	`provider` text DEFAULT 'LEMON_SQUEEZY' NOT NULL,
	`checkout_url` text,
	`provider_order_id` text,
	`provider_transaction_id` text,
	`paid_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`audit_id`) REFERENCES `audits`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`verification_id`) REFERENCES `verifications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `outcome_fee_obligations_new` (
	`id`,
	`user_id`,
	`audit_id`,
	`finding_id`,
	`verification_id`,
	`verified_annualized_savings_usd`,
	`fee_amount_usd`,
	`currency`,
	`status`,
	`provider`,
	`checkout_url`,
	`provider_order_id`,
	`provider_transaction_id`,
	`paid_at`,
	`created_at`,
	`updated_at`
)
SELECT
	`id`,
	`user_id`,
	`audit_id`,
	`finding_id`,
	`verification_id`,
	`verified_annualized_savings_usd`,
	`fee_amount_usd`,
	`currency`,
	`status`,
	`provider`,
	`checkout_url`,
	`provider_order_id`,
	`provider_transaction_id`,
	`paid_at`,
	`created_at`,
	`updated_at`
FROM `outcome_fee_obligations`;
--> statement-breakpoint
DROP TABLE `outcome_fee_obligations`;
--> statement-breakpoint
ALTER TABLE `outcome_fee_obligations_new` RENAME TO `outcome_fee_obligations`;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_outcome_fee_finding_id` ON `outcome_fee_obligations` (`finding_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_outcome_fee_user_audit_finding` ON `outcome_fee_obligations` (`user_id`, `audit_id`, `finding_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_outcome_fee_user_finding_null_audit` ON `outcome_fee_obligations` (`user_id`, `finding_id`) WHERE `audit_id` IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_outcome_fee_user_id` ON `outcome_fee_obligations` (`user_id`);
--> statement-breakpoint
ALTER TABLE `entitlements` ADD COLUMN `audit_id` text REFERENCES `audits`(`id`) ON UPDATE no action ON DELETE cascade;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_entitlements_user_finding`;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_entitlements_user_audit_finding` ON `entitlements` (`user_id`, `audit_id`, `finding_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_entitlements_user_finding_null_audit` ON `entitlements` (`user_id`, `finding_id`) WHERE `audit_id` IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_entitlements_finding_id` ON `entitlements` (`finding_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_entitlements_audit_id` ON `entitlements` (`audit_id`);
--> statement-breakpoint
UPDATE `entitlements`
SET `audit_id` = (
  SELECT f.audit_id
  FROM `findings` f
  JOIN `audits` a ON a.id = f.audit_id
  WHERE f.finding_id = `entitlements`.`finding_id`
    AND a.user_id = `entitlements`.`user_id`
  LIMIT 1
)
WHERE `audit_id` IS NULL
  AND (
    SELECT COUNT(DISTINCT f.audit_id)
    FROM `findings` f
    JOIN `audits` a ON a.id = f.audit_id
    WHERE f.finding_id = `entitlements`.`finding_id`
      AND a.user_id = `entitlements`.`user_id`
  ) = 1;
--> statement-breakpoint
UPDATE `verifications`
SET `audit_id` = (
  SELECT f.audit_id
  FROM `findings` f
  JOIN `audits` a ON a.id = f.audit_id
  WHERE f.finding_id = `verifications`.`finding_id`
    AND a.user_id = `verifications`.`user_id`
  LIMIT 1
)
WHERE `audit_id` IS NULL
  AND (
    SELECT COUNT(DISTINCT f.audit_id)
    FROM `findings` f
    JOIN `audits` a ON a.id = f.audit_id
    WHERE f.finding_id = `verifications`.`finding_id`
      AND a.user_id = `verifications`.`user_id`
  ) = 1;
--> statement-breakpoint
UPDATE `outcome_fee_obligations`
SET `audit_id` = (
  SELECT f.audit_id
  FROM `findings` f
  JOIN `audits` a ON a.id = f.audit_id
  WHERE f.finding_id = `outcome_fee_obligations`.`finding_id`
    AND a.user_id = `outcome_fee_obligations`.`user_id`
  LIMIT 1
)
WHERE `audit_id` IS NULL
  AND (
    SELECT COUNT(DISTINCT f.audit_id)
    FROM `findings` f
    JOIN `audits` a ON a.id = f.audit_id
    WHERE f.finding_id = `outcome_fee_obligations`.`finding_id`
      AND a.user_id = `outcome_fee_obligations`.`user_id`
  ) = 1;
--> statement-breakpoint
UPDATE `finding_ownerships`
SET `audit_id` = (
  SELECT f.audit_id
  FROM `findings` f
  JOIN `audits` a ON a.id = f.audit_id
  WHERE f.finding_id = `finding_ownerships`.`finding_id`
    AND a.user_id = `finding_ownerships`.`owner_id`
  LIMIT 1
)
WHERE `audit_id` IS NULL
  AND (
    SELECT COUNT(DISTINCT f.audit_id)
    FROM `findings` f
    JOIN `audits` a ON a.id = f.audit_id
    WHERE f.finding_id = `finding_ownerships`.`finding_id`
      AND a.user_id = `finding_ownerships`.`owner_id`
  ) = 1;
--> statement-breakpoint
UPDATE `finding_ownerships`
SET `id` = `owner_id` || ':' || `audit_id` || ':' || `finding_id`
WHERE `audit_id` IS NOT NULL
  AND `id` NOT LIKE '%:%:%';
--> statement-breakpoint
PRAGMA foreign_keys = ON;
