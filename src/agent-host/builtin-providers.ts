/**
 * Provider extensions bundled with the app, injected into every agent session
 * via the resource loader's inline extension factories. Users get these
 * providers in the model picker without installing anything.
 */
import type { InlineExtension, ModelRuntime } from "@earendil-works/pi-coding-agent";
import qoderProviderFactory from "./vendor/qoder";

export const BUILTIN_PROVIDER_EXTENSIONS: InlineExtension[] = [{ name: "Qoder", factory: qoderProviderFactory }];

/** Register app-bundled providers on a host-level runtime used by auth APIs. */
export async function registerBuiltinProviders(modelRuntime: ModelRuntime): Promise<void> {
  await qoderProviderFactory({
    registerProvider: (providerId, config) => modelRuntime.registerProvider(providerId, config),
  } as Parameters<typeof qoderProviderFactory>[0]);
  await modelRuntime.refresh({ allowNetwork: false });
}
