CREATE TABLE `organizations` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL, `created_at` integer NOT NULL);
--> statement-breakpoint
CREATE TABLE `projects` (`id` text PRIMARY KEY NOT NULL, `organization_id` text NOT NULL, `name` text NOT NULL, `owner_user_id` text NOT NULL, `created_at` integer NOT NULL);
--> statement-breakpoint
CREATE INDEX `idx_projects_org` ON `projects` (`organization_id`);
--> statement-breakpoint
CREATE TABLE `project_members` (`id` text PRIMARY KEY NOT NULL, `project_id` text NOT NULL, `user_id` text NOT NULL, `email` text NOT NULL, `role` text NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_members_project_user` ON `project_members` (`project_id`,`user_id`);
--> statement-breakpoint
CREATE TABLE `project_versions` (`id` text PRIMARY KEY NOT NULL, `project_id` text NOT NULL, `file_name` text NOT NULL, `sha256` text NOT NULL, `metadata_json` text, `extraction_status` text NOT NULL, `extraction_reason` text, `created_at` integer NOT NULL);
--> statement-breakpoint
CREATE INDEX `idx_versions_project_created` ON `project_versions` (`project_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `issues` (`id` text PRIMARY KEY NOT NULL, `project_id` text NOT NULL, `version_id` text, `object_type` text NOT NULL, `object_id` text NOT NULL, `title` text NOT NULL, `description` text, `severity` text NOT NULL, `category` text NOT NULL, `status` text NOT NULL, `assignee_id` text, `created_by` text NOT NULL, `created_at` integer NOT NULL);
--> statement-breakpoint
CREATE INDEX `idx_issues_project_status` ON `issues` (`project_id`,`status`);
--> statement-breakpoint
CREATE TABLE `comments` (`id` text PRIMARY KEY NOT NULL, `issue_id` text NOT NULL, `author_id` text NOT NULL, `body` text NOT NULL, `created_at` integer NOT NULL);
--> statement-breakpoint
CREATE INDEX `idx_comments_issue` ON `comments` (`issue_id`);
