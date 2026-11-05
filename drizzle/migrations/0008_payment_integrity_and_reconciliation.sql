ALTER TABLE `outcome_fee_obligations` ADD COLUMN `checkout_id` text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `checkout_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`audit_id` text,
	`finding_id` text NOT NULL,
	`product` text NOT NULL,
	`checkout_url` text NOT NULL,
	`checkout_id` text,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`audit_id`) REFERENCES `audits`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_checkout_attempts_user_audit_finding_product` ON `checkout_attempts` (`user_id`, `audit_id`, `finding_id`, `product`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_checkout_attempts_user_finding_product_null_audit` ON `checkout_attempts` (`user_id`, `finding_id`, `product`) WHERE `audit_id` IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_checkout_attempts_finding_id` ON `checkout_attempts` (`finding_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_checkout_attempts_user_id` ON `checkout_attempts` (`user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `payment_reconciliations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`audit_id` text,
	`finding_id` text NOT NULL,
	`product` text NOT NULL,
	`primary_order_id` text NOT NULL,
	`duplicate_order_id` text NOT NULL,
	`amount_usd` real NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`status` text DEFAULT 'NEEDS_REFUND_REVIEW' NOT NULL,
	`reason` text NOT NULL,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`audit_id`) REFERENCES `audits`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_payment_reconciliations_finding_id` ON `payment_reconciliations` (`finding_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_payment_reconciliations_user_id` ON `payment_reconciliations` (`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_payment_reconciliations_status` ON `payment_reconciliations` (`status`);
