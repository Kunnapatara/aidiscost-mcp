ALTER TABLE `finding_ownerships` ADD COLUMN `audit_id` text REFERENCES `audits`(`id`) ON UPDATE no action ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_finding_ownerships_audit_id` ON `finding_ownerships` (`audit_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_verifications_user_finding_null_audit` ON `verifications` (`user_id`, `finding_id`) WHERE `audit_id` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_outcome_fee_user_finding_null_audit` ON `outcome_fee_obligations` (`user_id`, `finding_id`) WHERE `audit_id` IS NULL;
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
