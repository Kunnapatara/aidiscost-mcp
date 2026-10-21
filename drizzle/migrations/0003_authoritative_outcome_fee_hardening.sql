DELETE FROM `outcome_fee_obligations`
WHERE `id` NOT IN (
  SELECT `id` FROM (
    SELECT `id`,
      ROW_NUMBER() OVER (
        PARTITION BY `finding_id`
        ORDER BY
          CASE `status`
            WHEN 'SETTLED' THEN 1
            WHEN 'PAID' THEN 2
            WHEN 'CHECKOUT_CREATED' THEN 3
            WHEN 'PAYABLE' THEN 4
            ELSE 5
          END,
          `updated_at` DESC,
          `created_at` DESC
      ) as rn
    FROM `outcome_fee_obligations`
  ) WHERE rn = 1
);
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_outcome_fee_finding_id`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_outcome_fee_finding_id` ON `outcome_fee_obligations` (`finding_id`);
--> statement-breakpoint
ALTER TABLE `verifications` ADD COLUMN `original_estimated_annualized_usd` real;
