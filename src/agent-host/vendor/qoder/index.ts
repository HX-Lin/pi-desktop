import type { Api, Model, OAuthCredentials } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
  getQoderBaseUrl,
  getQoderMode,
  getQoderUserEmailFallback,
  isQoderCNMode,
  toQoderCNFriendlyModel,
} from "./cosy.js";
import {
  addPriceFactorToName,
  getCachedModels,
  isCacheStale,
  staticCnModels,
  staticModels,
  updateQoderModelsCache,
} from "./models.js";
import {
  autoLoginQoderFromEnvironment,
  getCachedCredentials,
  loginQoderForProvider,
  refreshQoderToken,
  refreshQoderTokenCN,
} from "./oauth.js";
import { streamQoder } from "./stream.js";
import { fetchQoderUsage, fetchQoderUsageCN } from "./usage.js";

// pi supports a `fetchUsage` hook on the oauth config at runtime, but it is not
// part of the published ProviderConfig type. Declare the extension locally.
type OAuthConfigWithUsage = NonNullable<ProviderConfig["oauth"]> & {
  fetchUsage: (credentials: OAuthCredentials) => Promise<unknown>;
};

type AccountLoginHandler = (providerID: string) => void;

const MAX_QODER_ACCOUNTS = 10;

function accountProviderID(mode: string, accountNumber: number): string {
  const prefix = isQoderCNMode(mode) ? "qoder-cn" : "qoder";
  return accountNumber === 1 ? prefix : `${prefix}-${accountNumber}`;
}

function modelsForProvider(mode: string, providerID: string): Model<Api>[] {
  const cached = getCachedModels(mode);
  const modelsToUse = cached.length > 0 ? cached : isQoderCNMode(mode) ? staticCnModels : staticModels;

  return modelsToUse.map((m) => {
    const model = isQoderCNMode(mode) ? toQoderCNFriendlyModel(m) : m;
    return {
      ...model,
      name: addPriceFactorToName(model.name, m.priceFactor),
      provider: providerID,
      baseUrl: getQoderBaseUrl(mode),
    };
  }) as unknown as Model<Api>[];
}

function createQoderOAuth(providerID: string, mode: string, onLogin?: AccountLoginHandler): OAuthConfigWithUsage {
  const accountSuffix = providerID.match(/-(\d+)$/);
  const accountNumber = accountSuffix ? Number(accountSuffix[1]) : 1;
  const accountLabel = Number.isInteger(accountNumber) && accountNumber > 1 ? `Account ${accountNumber}` : "Account 1";
  return {
    name: isQoderCNMode(mode) ? `Qoder CN ${accountLabel} (PAT)` : `Qoder ${accountLabel} (Browser OAuth / PAT)`,
    login: (callbacks) => loginQoderForProvider(callbacks, providerID, mode, onLogin),
    refreshToken: isQoderCNMode(mode) ? refreshQoderTokenCN : refreshQoderToken,
    getApiKey: (cred: OAuthCredentials) => cred.access,
    // NOTE: no `modifyModels` hook on purpose. OMP (Bun) does a whole-catalog
    // structuredClone before invoking it, and its bundled catalog contains a
    // model with a non-cloneable property -> "The object can not be cloned."
    // removes qoder from `omp models`. Models are supplied at registration
    // via `modelsForProvider` and refreshed by the startup/session cache hooks.
    fetchUsage: isQoderCNMode(mode) ? fetchQoderUsageCN : fetchQoderUsage,
  };
}

function registerQoderProvider(
  pi: ExtensionAPI,
  providerID: string,
  mode: string,
  onLogin?: AccountLoginHandler,
): void {
  const oauth = createQoderOAuth(providerID, mode, onLogin);
  pi.registerProvider(providerID, {
    name:
      providerID === "qoder-cn"
        ? "Qoder CN (Account 1)"
        : providerID === "qoder"
          ? "Qoder (Account 1)"
          : isQoderCNMode(mode)
            ? `Qoder CN (Account ${providerID.replace("qoder-cn-", "")})`
            : `Qoder (Account ${providerID.replace("qoder-", "")})`,
    baseUrl: getQoderBaseUrl(mode),
    api: "qoder-api" as Api,
    models: modelsForProvider(mode, providerID) as unknown as ProviderConfig["models"],
    oauth: oauth as ProviderConfig["oauth"],
    streamSimple: streamQoder,
  });
}

function registerAccountProvider(pi: ExtensionAPI, accountNumber: number, mode: string): void {
  const providerID = accountProviderID(mode, accountNumber);
  // Desktop instantiates a fresh model runtime per session, so every session
  // must re-register the provider (no module-level dedup).
  registerQoderProvider(pi, providerID, mode);
}

async function initializeAccountProviders(pi: ExtensionAPI, mode: string): Promise<void> {
  for (let accountNumber = 1; accountNumber <= MAX_QODER_ACCOUNTS; accountNumber++) {
    if (accountNumber > 1 && !getCachedCredentials("", accountProviderID(mode, accountNumber - 1))?.access) break;

    const providerID = accountProviderID(mode, accountNumber);
    try {
      await autoLoginQoderFromEnvironment(providerID, mode);
      await refreshModelsAtStartup(providerID, mode);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[pi-provider-qoder] Automatic login failed for ${providerID}: ${message}`);
    }

    registerAccountProvider(pi, accountNumber, mode);
    if (!getCachedCredentials("", providerID)?.access) break;
  }
}

async function refreshModelsAtStartup(providerID: string, mode: string): Promise<void> {
  if (!isCacheStale(mode)) return;

  const credentials = getCachedCredentials("", providerID);
  if (!credentials?.access) return;

  await updateQoderModelsCache(
    credentials.access,
    credentials.userID || "qoder-user",
    credentials.name || (isQoderCNMode(mode) ? "Qoder CN User" : "Qoder User"),
    credentials.email || getQoderUserEmailFallback(mode),
    mode,
  );
}

export default async function (pi: ExtensionAPI) {
  const globalMode = getQoderMode();

  // Fetch stale catalogs before registering providers. Pi waits for the async
  // extension factory, so /model and --list-models receive one coherent model
  // set. Avoid refreshing again from session_start: concurrent Pi processes
  // share the cache, and a post-registration refresh cannot update this
  // session's already-registered model list.
  //
  // Only expose the next account slot after the previous slot is already
  // authenticated. This keeps the model list and /login selector uncluttered.
  await initializeAccountProviders(pi, globalMode);
  await initializeAccountProviders(pi, "cn");
}
