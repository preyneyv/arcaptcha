export interface PlayerStore {
  version: 2;
  apiKey: string;
}

const STORAGE_KEY = "arcaptcha.v2";
const LEGACY_STORAGE_KEY = "arcaptcha.v1";

function defaultStore(): PlayerStore {
  return {
    version: 2,
    apiKey: "",
  };
}

function safeParse(raw: string | null): PlayerStore | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as { apiKey?: unknown; version?: unknown };
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    return {
      version: 2,
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
    };
  } catch {
    return null;
  }
}

function writeStore(store: PlayerStore): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  localStorage.removeItem(LEGACY_STORAGE_KEY);
}

function createAnonymousKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `human-${crypto.randomUUID()}`;
  }

  return `human-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export function readStore(): PlayerStore {
  return (
    safeParse(localStorage.getItem(STORAGE_KEY)) ??
    safeParse(localStorage.getItem(LEGACY_STORAGE_KEY)) ??
    defaultStore()
  );
}

export function getOrCreatePlayerId(): string {
  const store = readStore();
  if (!store.apiKey) {
    const nextStore = {
      ...store,
      apiKey: createAnonymousKey(),
    } satisfies PlayerStore;
    writeStore(nextStore);
    return nextStore.apiKey;
  }

  if (store.version !== 2) {
    writeStore(store);
  }

  return store.apiKey;
}
