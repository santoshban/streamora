import fs from 'node:fs';
import { ArtworkService } from './catalog/artwork.js';
import { CatalogService } from './catalog/catalog.js';
import { TrailerService } from './catalog/trailers.js';
import type { AppConfig } from './config.js';
import { libraries } from './db/schema.js';
import { openDatabase, type DatabaseHandle, type DB } from './db/client.js';
import { EventBus } from './lib/events.js';
import { detectFfmpeg, ffprobe, type FfmpegAvailability } from './lib/ffmpeg.js';
import type { Logger } from './lib/logger.js';
import { PinAttemptLimiter } from './lib/pin.js';
import { resolveServerId } from './lib/server-id.js';
import { resolveSessionSecret, SessionSigner } from './lib/session.js';
import { PluginManager } from './plugins/manager.js';
import { MetadataService } from './plugins/services/metadata.js';
import { PostScanService } from './plugins/services/post-scan.js';
import { StreamResolverService } from './plugins/services/streams.js';
import { SubtitleService } from './plugins/services/subtitles.js';
import { normalizeProbe, type MediaProbe } from './media/probe.js';
import { ScanManager } from './scanner/manager.js';
import { LibraryScanner, ProbeUnavailableError } from './scanner/scanner.js';
import { EncoderSelector } from './streaming/encoders.js';
import { TranscodeManager } from './streaming/transcoder.js';
import { SERVER_VERSION } from './version.js';

export interface Services {
  config: AppConfig;
  log: Logger;
  database: DatabaseHandle;
  db: DB;
  events: EventBus;
  sessions: SessionSigner;
  pinAttempts: PinAttemptLimiter;
  plugins: PluginManager;
  metadata: MetadataService;
  subtitles: SubtitleService;
  streams: StreamResolverService;
  postScan: PostScanService;
  ffmpeg: FfmpegAvailability;
  scanner: LibraryScanner;
  scans: ScanManager;
  catalog: CatalogService;
  trailers: TrailerService;
  artwork: ArtworkService;
  encoders: EncoderSelector;
  transcoder: TranscodeManager;
  /** Stays with the data folder; see lib/server-id.ts. */
  serverId: string;
  startedAt: Date;
  /** Starts file watchers and scheduled/startup scans (after plugins are loaded). */
  start(): void;
  close(): Promise<void>;
}

export interface CreateServicesOptions {
  /** Inject a fetch implementation (tests). */
  fetchImpl?: typeof fetch;
  /** Skip ffmpeg detection (tests). */
  ffmpeg?: FfmpegAvailability;
  /** Replace ffprobe (tests). */
  probe?: (file: string, signal?: AbortSignal) => Promise<MediaProbe>;
}

export async function createServices(config: AppConfig, log: Logger, options: CreateServicesOptions = {}): Promise<Services> {
  for (const dir of [config.dataDir, config.cacheDir]) fs.mkdirSync(dir, { recursive: true });

  const database = openDatabase(config.databasePath);
  const events = new EventBus();
  const sessions = new SessionSigner(
    resolveSessionSecret(config.sessionSecret, config.dataDir),
    config.sessionTtlDays * 24 * 60 * 60,
  );

  const plugins = new PluginManager({
    db: database.db,
    log: log.child({ module: 'plugins' }),
    events,
    pluginsDir: config.plugins.dir,
    dataDir: config.dataDir,
    cacheDir: config.cacheDir,
    hotReload: config.plugins.hotReload,
    callTimeoutMs: config.plugins.callTimeoutMs,
    serverVersion: SERVER_VERSION,
    ffmpegPath: config.media.ffmpegPath,
    ffprobePath: config.media.ffprobePath,
    fetchImpl: options.fetchImpl,
  });

  const ffmpeg = options.ffmpeg ?? (await detectFfmpeg(config.media));
  if (!ffmpeg.ffmpeg || !ffmpeg.ffprobe) {
    log.warn(
      { ffmpeg: config.media.ffmpegPath, ffprobe: config.media.ffprobePath },
      'ffmpeg/ffprobe not found: media analysis, transcoding and embedded subtitles will be unavailable',
    );
  } else {
    log.info({ ffmpeg: ffmpeg.ffmpeg, ffprobe: ffmpeg.ffprobe }, 'ffmpeg detected');
  }

  const metadata = new MetadataService(plugins, log.child({ module: 'metadata' }));
  const subtitles = new SubtitleService(plugins, log.child({ module: 'subtitles' }));
  const postScan = new PostScanService(plugins, log.child({ module: 'post-scan' }));

  const probe =
    options.probe ??
    (async (file: string, signal?: AbortSignal): Promise<MediaProbe> => {
      if (!ffmpeg.ffprobe) throw new ProbeUnavailableError();
      return normalizeProbe(await ffprobe(config.media.ffprobePath, file, { signal, timeoutMs: 120_000 }), file);
    });

  const encoders = new EncoderSelector(config.media, log.child({ module: 'transcoder' }));
  const transcoder = new TranscodeManager({
    config,
    log: log.child({ module: 'transcoder' }),
    events,
    encoders,
    probe: (file) => probe(file),
  });

  const scanner = new LibraryScanner({
    db: database.db,
    log: log.child({ module: 'scanner' }),
    events,
    metadata,
    subtitles,
    postScan,
    probe,
    probeAvailable: () => !!options.probe || !!ffmpeg.ffprobe,
    probeConcurrency: config.scan.probeConcurrency,
    onFilesRemoved: async (ids) => {
      for (const id of ids) await transcoder.destroyForFile(id);
    },
  });
  const scans = new ScanManager({
    db: database.db,
    log: log.child({ module: 'scans' }),
    events,
    scanner,
    scanOnStartup: config.scan.onStartup,
    intervalMinutes: config.scan.intervalMinutes,
    watchPolling: config.scan.watchPolling,
  });

  const services: Services = {
    config,
    log,
    database,
    db: database.db,
    events,
    sessions,
    pinAttempts: new PinAttemptLimiter(),
    plugins,
    metadata,
    subtitles,
    streams: new StreamResolverService(plugins, log.child({ module: 'streams' })),
    postScan,
    ffmpeg,
    scanner,
    scans,
    catalog: new CatalogService(database.db),
    trailers: new TrailerService(database.db, metadata, log.child({ module: 'trailers' })),
    artwork: new ArtworkService(
      config.cacheDir,
      () => database.db.select({ paths: libraries.paths }).from(libraries).all().flatMap((l) => l.paths),
      log.child({ module: 'artwork' }),
      options.fetchImpl,
    ),
    encoders,
    transcoder,
    serverId: resolveServerId(config.dataDir),
    startedAt: new Date(),
    start() {
      scans.start();
    },
    async close() {
      await scans.close();
      await transcoder.close();
      await plugins.close();
      database.close();
    },
  };
  return services;
}
