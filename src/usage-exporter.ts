import type { Account, UsageWindow } from "./types.js";
import { AccountStore } from "./store.js";
import { ensureValidToken } from "./account-utils.js";
import { refreshUsageIfNeeded, normalizeProvider } from "./quota.js";
import type { OAuthConfig } from "./oauth.js";

const ONE_HOUR_SECONDS = 60 * 60;
const ONE_WEEK_SECONDS = 7 * 24 * ONE_HOUR_SECONDS;

type UsageExporterOptions = {
  store: AccountStore;
  oauthConfig: OAuthConfig;
  openaiBaseUrl: string;
  mistralBaseUrl: string;
  zaiBaseUrl: string;
};

type ExportRecord = {
  scope: "profile";
  profileId: string;
  email: string;
  accountId: string;
  planType: string;
  fiveHourUsedPercent: number;
  fiveHourResetAtUnix: number;
  fiveHourResetAfterSeconds: number;
  fiveHourWindowSeconds: number;
  weeklyUsedPercent: number;
  weeklyResetAtUnix: number;
  weeklyResetAfterSeconds: number;
  weeklyWindowSeconds: number;
  allowed: boolean;
  limitReached: boolean;
  errorActive: boolean;
};

const env = {
  enabled: readBoolEnv("USAGE_EXPORT_ENABLED", false),
  intervalSeconds: readIntEnv("USAGE_EXPORT_INTERVAL_SECONDS", 300),
  influxUrl: trimTrailingSlash(process.env.INFLUX_URL ?? ""),
  influxOrg: process.env.INFLUX_ORG ?? "",
  influxBucket: process.env.INFLUX_BUCKET ?? "",
  influxToken: process.env.INFLUX_TOKEN ?? "",
  measurementName: process.env.MEASUREMENT_NAME || "codex_usage_limits",
};

export function startUsageExporter(options: UsageExporterOptions): void {
  if (!env.enabled) return;
  validateExporterEnv();

  const run = async () => {
    try {
      await runExport(options);
    } catch (error) {
      console.error(`[usage-export] failed: ${formatError(error)}`);
    }
  };

  setTimeout(run, 5_000);
  setInterval(run, Math.max(1, env.intervalSeconds) * 1000);
  console.log(
    `[usage-export] enabled interval_seconds=${env.intervalSeconds} measurement=${env.measurementName} bucket=${env.influxBucket}`,
  );
}

async function runExport(options: UsageExporterOptions): Promise<void> {
  const accounts = options.store
    .getCachedAccounts()
    .filter((account) => normalizeProvider(account) === "openai");

  if (!accounts.length) {
    console.log("[usage-export] no OpenAI accounts found; skipping");
    return;
  }

  const records = await Promise.all(
    accounts.map((account) => refreshAccountUsage(account, options)),
  );

  await options.store.flushIfDirty();
  const lines = records.map(buildProfileInfluxLine);
  lines.push(buildBundleInfluxLine(records));
  await writeInflux(lines);
  console.log(`[usage-export] wrote ${lines.length} point(s)`);
}

async function refreshAccountUsage(
  account: Account,
  options: UsageExporterOptions,
): Promise<ExportRecord> {
  try {
    const valid = await ensureValidToken(account, options.oauthConfig);
    const usageBaseUrl = usageBaseUrlFor(valid, options);
    const refreshed = await refreshUsageIfNeeded(valid, usageBaseUrl, true);
    await options.store.upsertAccount(refreshed);
    return buildRecord(refreshed);
  } catch (error) {
    console.error(`[usage-export:${account.id}] ${formatError(error)}`);
    return buildRecord({
      ...account,
      state: {
        ...account.state,
        lastError: formatError(error),
      },
    });
  }
}

function usageBaseUrlFor(account: Account, options: UsageExporterOptions): string {
  const provider = normalizeProvider(account);
  if (provider === "mistral") return options.mistralBaseUrl;
  if (provider === "zai") return options.zaiBaseUrl;
  if (provider === "openai-compatible" && account.baseUrl) {
    return trimTrailingSlash(account.baseUrl);
  }
  return options.openaiBaseUrl;
}

function buildRecord(account: Account): ExportRecord {
  const nowUnix = Math.trunc(Date.now() / 1000);
  const primary = readWindow(account.usage?.primary, nowUnix, 5 * ONE_HOUR_SECONDS);
  const secondary = readWindow(account.usage?.secondary, nowUnix, ONE_WEEK_SECONDS);
  const errorActive = Boolean(account.state?.needsTokenRefresh || account.state?.lastError);
  const limitReached =
    primary.usedPercent >= 100 || secondary.usedPercent >= 100;

  return {
    scope: "profile",
    profileId: account.id,
    email: account.email ?? "",
    accountId: account.chatgptAccountId ?? "",
    planType: "",
    fiveHourUsedPercent: primary.usedPercent,
    fiveHourResetAtUnix: primary.resetAtUnix,
    fiveHourResetAfterSeconds: primary.resetAfterSeconds,
    fiveHourWindowSeconds: primary.windowSeconds,
    weeklyUsedPercent: secondary.usedPercent,
    weeklyResetAtUnix: secondary.resetAtUnix,
    weeklyResetAfterSeconds: secondary.resetAfterSeconds,
    weeklyWindowSeconds: secondary.windowSeconds,
    allowed: !errorActive && !limitReached,
    limitReached,
    errorActive,
  };
}

function readWindow(
  window: UsageWindow | undefined,
  nowUnix: number,
  defaultWindowSeconds: number,
) {
  const resetAtUnix =
    typeof window?.resetAt === "number" && Number.isFinite(window.resetAt)
      ? Math.trunc(window.resetAt / 1000)
      : 0;
  return {
    usedPercent: clampPercent(window?.usedPercent),
    resetAtUnix,
    resetAfterSeconds: resetAtUnix > 0 ? Math.max(0, resetAtUnix - nowUnix) : 0,
    windowSeconds: window?.windowSeconds ?? (window ? defaultWindowSeconds : 0),
  };
}

function buildProfileInfluxLine(record: ExportRecord): string {
  const tags = [
    ["scope", record.scope],
    ["profile_id", record.profileId],
    ["email", record.email],
    ["account_id", record.accountId],
    ["plan_type", record.planType],
  ]
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `${escapeMeasurement(key)}=${escapeTag(String(value))}`)
    .join(",");

  const fields = [
    ["five_hour_used_percent", asInteger(record.fiveHourUsedPercent)],
    ["five_hour_reset_at_unix", asInteger(record.fiveHourResetAtUnix)],
    ["five_hour_reset_after_seconds", asInteger(record.fiveHourResetAfterSeconds)],
    ["five_hour_window_seconds", asInteger(record.fiveHourWindowSeconds)],
    ["weekly_used_percent", asInteger(record.weeklyUsedPercent)],
    ["weekly_reset_at_unix", asInteger(record.weeklyResetAtUnix)],
    ["weekly_reset_after_seconds", asInteger(record.weeklyResetAfterSeconds)],
    ["weekly_window_seconds", asInteger(record.weeklyWindowSeconds)],
    ["error_active", asInteger(record.errorActive ? 1 : 0)],
    ["allowed", record.allowed ? "true" : "false"],
    ["limit_reached", record.limitReached ? "true" : "false"],
  ]
    .map(([key, value]) => `${escapeMeasurement(key)}=${value}`)
    .join(",");

  return `${escapeMeasurement(env.measurementName)},${tags} ${fields}`;
}

function buildBundleInfluxLine(records: ExportRecord[]): string {
  const totalProfiles = records.length;
  const errorCount = records.filter((record) => record.errorActive).length;
  const fiveHourUsedPercent = average(
    records.map((record) => record.fiveHourUsedPercent),
  );
  const weeklyUsedPercent = average(
    records.map((record) => record.weeklyUsedPercent),
  );
  const errorPercent = totalProfiles > 0 ? (errorCount * 100) / totalProfiles : 0;
  const tags = [
    ["scope", "bundle"],
    ["profile_id", "_bundle"],
    ["email", "_bundle"],
  ]
    .map(([key, value]) => `${escapeMeasurement(key)}=${escapeTag(value)}`)
    .join(",");
  const fields = [
    ["profiles_total", asInteger(totalProfiles)],
    ["profiles_errored", asInteger(errorCount)],
    ["error_percent", asInteger(errorPercent)],
    ["five_hour_used_percent", asInteger(fiveHourUsedPercent)],
    ["weekly_used_percent", asInteger(weeklyUsedPercent)],
    ["five_hour_effective_used_percent", asInteger(Math.max(fiveHourUsedPercent, errorPercent))],
    ["weekly_effective_used_percent", asInteger(Math.max(weeklyUsedPercent, errorPercent))],
  ]
    .map(([key, value]) => `${escapeMeasurement(key)}=${value}`)
    .join(",");

  return `${escapeMeasurement(env.measurementName)},${tags} ${fields}`;
}

async function writeInflux(lines: string[]): Promise<void> {
  const url =
    `${env.influxUrl}/api/v2/write?org=${encodeURIComponent(env.influxOrg)}` +
    `&bucket=${encodeURIComponent(env.influxBucket)}&precision=s`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${env.influxToken}`,
      "Content-Type": "text/plain; charset=utf-8",
    },
    body: `${lines.join("\n")}\n`,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Influx write failed with ${response.status}: ${body || response.statusText}`,
    );
  }
}

function validateExporterEnv(): void {
  for (const [name, value] of [
    ["INFLUX_URL", env.influxUrl],
    ["INFLUX_ORG", env.influxOrg],
    ["INFLUX_BUCKET", env.influxBucket],
    ["INFLUX_TOKEN", env.influxToken],
  ]) {
    if (!value) throw new Error(`USAGE_EXPORT_ENABLED requires ${name}`);
  }
}

function clampPercent(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, value))
    : 0;
}

function average(values: number[]): number {
  return values.length
    ? values.reduce((sum, value) => sum + Number(value ?? 0), 0) / values.length
    : 0;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function escapeMeasurement(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(",", "\\,").replaceAll(" ", "\\ ");
}

function escapeTag(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(",", "\\,")
    .replaceAll("=", "\\=")
    .replaceAll(" ", "\\ ");
}

function asInteger(value: number): string {
  const normalized = Number(value ?? 0);
  return `${Number.isFinite(normalized) ? Math.trunc(normalized) : 0}i`;
}

function readBoolEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function readIntEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
