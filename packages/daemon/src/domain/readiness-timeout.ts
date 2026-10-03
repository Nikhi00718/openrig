import { SettingsStore } from "./user-settings/settings-store.js";

/** Resolve at launch time so a config change applies to the next seat, while
 * preserving explicit millisecond overrides used by callers and tests. */
export function resolveReadinessTimeoutMs(
  explicitMs: number | undefined,
  settings: Pick<SettingsStore, "resolveOne"> = new SettingsStore(),
): number {
  return explicitMs ?? (settings.resolveOne("runtime.readiness_timeout_seconds").value as number) * 1000;
}
