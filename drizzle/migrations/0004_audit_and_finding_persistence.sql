CREATE TABLE `audits` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source` text NOT NULL,
	`total_spend_usd` real NOT NULL,
	`potential_savings_usd` real NOT NULL,
	`annualized_savings_projection_usd` real NOT NULL,
	`is_sample_data` integer DEFAULT false NOT NULL,
	`health_grade` text,
	`health_report_json` text,
	`findings_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_audits_user_id` ON `audits` (`user_id`);
--> statement-breakpoint
CREATE TABLE `findings` (
	`id` text PRIMARY KEY NOT NULL,
	`audit_id` text NOT NULL,
	`finding_id` text NOT NULL,
	`user_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`affected_scope` text,
	`detection_confidence` text,
	`baseline_spend_usd` real NOT NULL,
	`candidate_spend_usd` real,
	`estimated_savings_usd` real NOT NULL,
	`potential_savings_pct` real,
	`annualized_projection_usd` real NOT NULL,
	`eligible_event_count` integer NOT NULL,
	`calculation_method` text,
	`assumptions_json` text,
	`evidence_json` text,
	`status` text DEFAULT 'DETECTED' NOT NULL,
	`is_sample_data` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`audit_id`) REFERENCES `audits`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_findings_audit_finding` ON `findings` (`audit_id`,`finding_id`);
--> statement-breakpoint
CREATE INDEX `idx_findings_user_id` ON `findings` (`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_findings_finding_id` ON `findings` (`finding_id`);
