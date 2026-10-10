CREATE TABLE `backlink_automation_budget` (
	`project_id` text PRIMARY KEY NOT NULL,
	`day_key` text DEFAULT '' NOT NULL,
	`day_requests` integer DEFAULT 0 NOT NULL,
	`day_reserved_micros` integer DEFAULT 0 NOT NULL,
	`week_key` text DEFAULT '' NOT NULL,
	`week_requests` integer DEFAULT 0 NOT NULL,
	`month_key` text DEFAULT '' NOT NULL,
	`month_requests` integer DEFAULT 0 NOT NULL,
	`month_reserved_micros` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `backlink_automation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`target` text NOT NULL,
	`status` text NOT NULL,
	`reserved_micros` integer NOT NULL,
	`actual_cost_usd` real,
	`error_code` text,
	`started_at` text NOT NULL,
	`finished_at` text
);
