import type { ScanCompletedEvent } from '@streamora/plugin-sdk';
import type { Logger } from '../../lib/logger.js';
import type { PluginManager } from '../manager.js';

const POST_SCAN_TIMEOUT_MS = 30 * 60_000;

/** Notifies every active `post_scan` plugin after a library scan. Failures are isolated and logged. */
export class PostScanService {
  constructor(
    private readonly plugins: PluginManager,
    private readonly log: Logger,
  ) {}

  /** Resolves when every hook has finished (scanner callers usually don't await it). */
  async dispatch(event: ScanCompletedEvent): Promise<Array<{ provider: string; ok: boolean; error?: string }>> {
    const hooks = this.plugins.getActive('post_scan');
    const settled = await Promise.allSettled(
      hooks.map((hook) =>
        this.plugins.invoke(hook.id, 'postScan.onScanComplete', (o) => hook.impl.onScanComplete(structuredClone(event), o), {
          timeoutMs: POST_SCAN_TIMEOUT_MS,
        }),
      ),
    );
    return settled.map((outcome, i) => {
      const provider = hooks[i]!.id;
      if (outcome.status === 'fulfilled') return { provider, ok: true };
      this.log.warn({ plugin: provider, library: event.library.id, err: outcome.reason }, 'Post-scan hook failed');
      return { provider, ok: false, error: String((outcome.reason as Error)?.message ?? outcome.reason) };
    });
  }
}
