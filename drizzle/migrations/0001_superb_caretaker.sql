CREATE TABLE `verifications` (
	`id` text PRIMARY KEY NOT NULL,
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
	`verification_confidence` text DEFAULT 'INSUFFICIENT_OBSERVATION' NOT NULL,
	`verification_notes` text,
	`post_deployment_file_name` text,
	`verified_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`finding_id`) REFERENCES `finding_ownerships`(`finding_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_verifications_finding_id` ON `verifications` (`finding_id`);--> statement-breakpoint
CREATE INDEX `idx_verifications_user_id` ON `verifications` (`user_id`);