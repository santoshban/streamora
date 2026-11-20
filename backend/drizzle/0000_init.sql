CREATE TABLE `episodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`show_id` integer NOT NULL,
	`season_id` integer NOT NULL,
	`season_number` integer NOT NULL,
	`episode_number` integer NOT NULL,
	`episode_number_end` integer,
	`absolute_number` integer,
	`title` text,
	`overview` text,
	`still` text,
	`air_date` text,
	`runtime_minutes` integer,
	`rating` real,
	`external_ids` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`show_id`) REFERENCES `media_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `episodes_show_se_uq` ON `episodes` (`show_id`,`season_number`,`episode_number`);--> statement-breakpoint
CREATE INDEX `episodes_season_idx` ON `episodes` (`season_id`);--> statement-breakpoint
CREATE TABLE `libraries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`paths` text DEFAULT '[]' NOT NULL,
	`language` text DEFAULT 'en-US' NOT NULL,
	`watch` integer DEFAULT true NOT NULL,
	`agents` text,
	`last_scanned_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `media_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`library_id` integer NOT NULL,
	`media_item_id` integer NOT NULL,
	`episode_id` integer,
	`path` text NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`mtime_ms` integer DEFAULT 0 NOT NULL,
	`container` text,
	`duration_seconds` real,
	`bitrate` integer,
	`video_codec` text,
	`video_profile` text,
	`width` integer,
	`height` integer,
	`frame_rate` real,
	`bit_depth` integer,
	`resolution` text,
	`hdr` text,
	`audio_codec` text,
	`audio_channels` integer,
	`streams` text DEFAULT '[]' NOT NULL,
	`edition` text,
	`source` text,
	`release_group` text,
	`parsed` text DEFAULT '{}' NOT NULL,
	`probed_at` integer,
	`probe_error` text,
	`missing` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_item_id`) REFERENCES `media_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_files_path_uq` ON `media_files` (`path`);--> statement-breakpoint
CREATE INDEX `media_files_item_idx` ON `media_files` (`media_item_id`);--> statement-breakpoint
CREATE INDEX `media_files_episode_idx` ON `media_files` (`episode_id`);--> statement-breakpoint
CREATE TABLE `media_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`library_id` integer NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`sort_title` text NOT NULL,
	`original_title` text,
	`year` integer,
	`release_date` text,
	`tagline` text,
	`overview` text,
	`genres` text DEFAULT '[]' NOT NULL,
	`studios` text DEFAULT '[]' NOT NULL,
	`content_rating` text,
	`rating` real,
	`runtime_minutes` integer,
	`status` text,
	`cast` text DEFAULT '[]' NOT NULL,
	`crew` text DEFAULT '[]' NOT NULL,
	`poster` text,
	`backdrop` text,
	`logo` text,
	`thumb` text,
	`external_ids` text DEFAULT '{}' NOT NULL,
	`match_key` text NOT NULL,
	`folder_path` text,
	`locked` integer DEFAULT false NOT NULL,
	`metadata_sources` text DEFAULT '[]' NOT NULL,
	`metadata_updated_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_items_identity_uq` ON `media_items` (`library_id`,`kind`,`match_key`);--> statement-breakpoint
CREATE INDEX `media_items_kind_idx` ON `media_items` (`kind`);--> statement-breakpoint
CREATE INDEX `media_items_sort_title_idx` ON `media_items` (`sort_title`);--> statement-breakpoint
CREATE INDEX `media_items_created_idx` ON `media_items` (`created_at`);--> statement-breakpoint
CREATE TABLE `plugin_cache` (
	`plugin_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer,
	PRIMARY KEY(`plugin_id`, `key`)
);
--> statement-breakpoint
CREATE INDEX `plugin_cache_expiry_idx` ON `plugin_cache` (`expires_at`);--> statement-breakpoint
CREATE TABLE `plugins` (
	`id` text PRIMARY KEY NOT NULL,
	`enabled` integer NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`version` text,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`avatar` text DEFAULT 'crimson' NOT NULL,
	`is_kids` integer DEFAULT false NOT NULL,
	`is_admin` integer DEFAULT false NOT NULL,
	`pin_hash` text,
	`preferences` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `seasons` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`show_id` integer NOT NULL,
	`season_number` integer NOT NULL,
	`title` text,
	`overview` text,
	`poster` text,
	`air_date` text,
	`external_ids` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`show_id`) REFERENCES `media_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `seasons_show_number_uq` ON `seasons` (`show_id`,`season_number`);--> statement-breakpoint
CREATE TABLE `subtitle_tracks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`media_file_id` integer NOT NULL,
	`source` text NOT NULL,
	`source_key` text NOT NULL,
	`stream_index` integer,
	`path` text,
	`codec` text NOT NULL,
	`language` text,
	`label` text,
	`forced` integer DEFAULT false NOT NULL,
	`hearing_impaired` integer DEFAULT false NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`renderable` integer DEFAULT true NOT NULL,
	`provider_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`media_file_id`) REFERENCES `media_files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subtitle_tracks_source_uq` ON `subtitle_tracks` (`media_file_id`,`source_key`);--> statement-breakpoint
CREATE TABLE `watch_progress` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`media_item_id` integer NOT NULL,
	`episode_id` integer,
	`media_file_id` integer,
	`position_seconds` real DEFAULT 0 NOT NULL,
	`duration_seconds` real,
	`completed` integer DEFAULT false NOT NULL,
	`play_count` integer DEFAULT 0 NOT NULL,
	`last_watched_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_item_id`) REFERENCES `media_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_file_id`) REFERENCES `media_files`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watch_progress_movie_uq` ON `watch_progress` (`profile_id`,`media_item_id`) WHERE "watch_progress"."episode_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `watch_progress_episode_uq` ON `watch_progress` (`profile_id`,`episode_id`) WHERE "watch_progress"."episode_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `watch_progress_recent_idx` ON `watch_progress` (`profile_id`,`last_watched_at`);--> statement-breakpoint
CREATE TABLE `watchlist` (
	`profile_id` integer NOT NULL,
	`media_item_id` integer NOT NULL,
	`added_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`profile_id`, `media_item_id`),
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_item_id`) REFERENCES `media_items`(`id`) ON UPDATE no action ON DELETE cascade
);
