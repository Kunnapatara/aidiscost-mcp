CREATE TABLE `outcome_fee_obligations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
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
	FOREIGN KEY (`finding_id`) REFERENCES `finding_ownerships`(`finding_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`verification_id`) REFERENCES `verifications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_outcome_fee_user_finding` ON `outcome_fee_obligations` (`user_id`,`finding_id`);--> statement-breakpoint
CREATE INDEX `idx_outcome_fee_finding_id` ON `outcome_fee_obligations` (`finding_id`);--> statement-breakpoint
CREATE INDEX `idx_outcome_fee_user_id` ON `outcome_fee_obligations` (`user_id`);
