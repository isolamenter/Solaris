import { AppError } from "../errors.js";
import { redact } from "../vault.js";
import type { ProviderProfile } from "./types.js";

const timeoutMs = 90_000;
export function normalizeBaseUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError("BASE_URL_INVALID", "Base URL must be a valid absolute URL"); }
  if (url.username || url.password || url.search || url.hash) throw new AppError("BASE_URL_INVALID", "Base URL cannot contain credentials, query text, or fragments");
  if (url.protocol !== "https:") throw new AppError("BASE_URL_INSECURE", "Provider URLs must use HTTPS");
  return url.toString().replace(/\/$/, "");
}
export function endpoint(profile: ProviderProfile, path: string) {
  if (!path.startsWith("/")) throw new AppError("PLUGIN_PATH_INVALID", "Provider plugin supplied an invalid route", 500);
  return `${normalizeBaseUrl(profile.baseUrl)}${path}`;
}
export async function providerFetch(profile: ProviderProfile, path: string, init: RequestInit & { headers?: Record<string, string> }) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint(profile, path), { ...init, headers: init.headers, signal: init.signal ?? controller.signal });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 2_000);
      throw new AppError("PROVIDER_HTTP", `Provider returned HTTP ${response.status}`, response.status >= 500 ? 502 : 400, redact(body));
    }
    return response;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("PROVIDER_UNAVAILABLE", "Provider could not be reached", 502);
  } finally { clearTimeout(timer); }
}
export function json(value: unknown) { return JSON.stringify(value); }
