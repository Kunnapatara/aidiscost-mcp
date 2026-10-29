ALTER TABLE `verifications` ADD COLUMN `audit_id` text REFERENCES `audits`(`id`) ON UPDATE no action ON DELETE cascade;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_verifications_finding_id`;
--> statement-breakpoint
CREATE INDEX `idx_verifications_finding_id` ON `verifications` (`finding_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_verifications_user_audit_finding` ON `verifications` (`user_id`, `audit_id`, `finding_id`);
--> statement-breakpoint
ALTER TABLE `outcome_fee_obligations` ADD COLUMN `audit_id` text REFERENCES `audits`(`id`) ON UPDATE no action ON DELETE cascade;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_outcome_fee_finding_id`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_outcome_fee_user_finding`;
--> statement-breakpoint
CREATE INDEX `idx_outcome_fee_finding_id` ON `outcome_fee_obligations` (`finding_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_outcome_fee_user_audit_finding` ON `outcome_fee_obligations` (`user_id`, `audit_id`, `finding_id`);
