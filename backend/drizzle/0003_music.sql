CREATE TABLE `music_albums` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`library_id` integer NOT NULL,
	`artist_id` integer NOT NULL,
	`title` text NOT NULL,
	`sort_title` text NOT NULL,
	`match_key` text NOT NULL,
	`year` integer,
	`genres` text DEFAULT '[]' NOT NULL,
	`cover` text,
	`folder_path` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artist_id`) REFERENCES `music_artists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `music_albums_identity_uq` ON `music_albums` (`library_id`,`artist_id`,`match_key`);--> statement-breakpoint
CREATE INDEX `music_albums_artist_idx` ON `music_albums` (`artist_id`);--> statement-breakpoint
CREATE INDEX `music_albums_created_idx` ON `music_albums` (`created_at`);--> statement-breakpoint
CREATE TABLE `music_artists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`library_id` integer NOT NULL,
	`name` text NOT NULL,
	`sort_name` text NOT NULL,
	`match_key` text NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `music_artists_identity_uq` ON `music_artists` (`library_id`,`match_key`);--> statement-breakpoint
CREATE INDEX `music_artists_sort_idx` ON `music_artists` (`sort_name`);--> statement-breakpoint
CREATE TABLE `music_likes` (
	`profile_id` integer NOT NULL,
	`track_id` integer NOT NULL,
	`liked_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`profile_id`, `track_id`),
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`track_id`) REFERENCES `music_tracks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `music_plays` (
	`profile_id` integer NOT NULL,
	`track_id` integer NOT NULL,
	`play_count` integer DEFAULT 0 NOT NULL,
	`last_played_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`profile_id`, `track_id`),
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`track_id`) REFERENCES `music_tracks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `music_plays_recent_idx` ON `music_plays` (`profile_id`,`last_played_at`);--> statement-breakpoint
CREATE TABLE `music_tracks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`library_id` integer NOT NULL,
	`album_id` integer NOT NULL,
	`artist_id` integer NOT NULL,
	`artist_name` text NOT NULL,
	`title` text NOT NULL,
	`sort_title` text NOT NULL,
	`track_number` integer,
	`disc_number` integer,
	`year` integer,
	`genres` text DEFAULT '[]' NOT NULL,
	`duration_seconds` real,
	`path` text NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`mtime_ms` integer DEFAULT 0 NOT NULL,
	`container` text,
	`codec` text,
	`bitrate` integer,
	`sample_rate` integer,
	`channels` integer,
	`has_embedded_art` integer DEFAULT false NOT NULL,
	`probed_at` integer,
	`probe_error` text,
	`missing` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`album_id`) REFERENCES `music_albums`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artist_id`) REFERENCES `music_artists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `music_tracks_path_uq` ON `music_tracks` (`path`);--> statement-breakpoint
CREATE INDEX `music_tracks_album_idx` ON `music_tracks` (`album_id`);--> statement-breakpoint
CREATE INDEX `music_tracks_artist_idx` ON `music_tracks` (`artist_id`);--> statement-breakpoint
CREATE INDEX `music_tracks_library_idx` ON `music_tracks` (`library_id`);--> statement-breakpoint
CREATE TABLE `playlist_tracks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`playlist_id` integer NOT NULL,
	`track_id` integer NOT NULL,
	`position` integer NOT NULL,
	`added_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`track_id`) REFERENCES `music_tracks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `playlist_tracks_order_idx` ON `playlist_tracks` (`playlist_id`,`position`);--> statement-breakpoint
CREATE TABLE `playlists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `playlists_profile_idx` ON `playlists` (`profile_id`);