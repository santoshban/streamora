/**
 * @streamora/plugin-sdk
 *
 * The plugin contract is *types only*: plugins never import runtime code from
 * the SDK. Everything a plugin can do at runtime is handed to it through the
 * {@link PluginContext} passed to its factory function.
 *
 * ```ts
 * import type { PluginFactory } from '@streamora/plugin-sdk';
 *
 * const createPlugin: PluginFactory = (ctx) => ({
 *   metadata: {
 *     async match(request) { ... },
 *   },
 * });
 *
 * export default createPlugin;
 * ```
 */
export type * from './manifest.js';
export type * from './models.js';
export type * from './context.js';
export type * from './capabilities.js';
