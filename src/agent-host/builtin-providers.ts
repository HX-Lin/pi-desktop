/**
 * Extensions bundled with the app and injected into every agent session via the
 * resource loader's inline extension factories: the providers users should see
 * in the model picker without installing anything, plus the memory-script index
 * that tells the model which executables it already has.
 */
import type { InlineExtension, ModelRuntime } from "@earendil-works/pi-coding-agent";
import qoderProviderFactory from "./vendor/qoder";
import { MEMORY_SCRIPTS_EXTENSION } from "./memory-scripts-extension";

export const BUILTIN_PROVIDER_EXTENSIONS: InlineExtension[] = [{ name: "Qoder", factory: qoderProviderFactory }];

/** Every inline extension the app injects into agent sessions. */
export const BUILTIN_SESSION_EXTENSIONS: InlineExtension[] = [...BUILTIN_PROVIDER_EXTENSIONS, MEMORY_SCRIPTS_EXTENSION];

/** Register app-bundled providers on a host-level runtime used by auth APIs. */
export async function registerBuiltinProviders(modelRuntime: ModelRuntime): Promise<void> {
  await qoderProviderFactory({
    registerProvider: (providerId, config) => modelRuntime.registerProvider(providerId, config),
  } as Parameters<typeof qoderProviderFactory>[0]);
  await modelRuntime.refresh({ allowNetwork: false });
}
