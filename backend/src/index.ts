import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './lib/logger.js';
import { createServices } from './services.js';
import { SERVER_VERSION } from './version.js';

// Plugin bundles carry inline source maps, so stack traces point at plugin TS files.
process.setSourceMapsEnabled(true);

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config);
  log.info({ version: SERVER_VERSION, dataDir: config.dataDir, env: config.env }, 'Starting Streamora');

  const services = await createServices(config, log);
  const app = await buildApp(services);
  await services.plugins.init();
  await app.listen({ host: config.host, port: config.port });
  services.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      log.warn('Forced exit');
      process.exit(1);
    }
    shuttingDown = true;
    log.info({ signal }, 'Shutting down');
    try {
      await app.close();
      await services.close();
      process.exit(0);
    } catch (err) {
      log.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  if ((err as NodeJS.ErrnoException)?.code === 'EADDRINUSE') {
    const { port } = err as NodeJS.ErrnoException & { port?: number };
    console.error(
      `Fatal: port ${port ?? ''} is already in use. Another Streamora (the desktop app, or a second \`npm start\`) ` +
        'or another program is listening there. Quit it, or choose another port with PORT (DEV_PORT for `npm run dev`).',
    );
  } else {
    console.error('Fatal: Streamora failed to start\n', err);
  }
  process.exit(1);
});
