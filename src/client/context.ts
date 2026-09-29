import { createContext, useContext } from "react";
import type { LocalScope, LocalStore } from "../shared/local.js";
import type { SolarisApi } from "./api.js";

/**
 * Everything a page needs from the shell: the typed Server client for the
 * current session, the client-local store, the local-scope key and the notice
 * bar. Kept in one context so pages never build URLs, tokens or error strings.
 */
export type Services = {
  api: SolarisApi;
  localStore: LocalStore;
  /** Normalized Server origin plus the signed-in Solaris user id (CONTRACTS §10). */
  scope: LocalScope;
  /** Informational message. */
  notify: (text: string) => void;
  /** Failure message; an expired session is signed out instead. */
  fail: (error: unknown) => void;
};

export const ServicesContext = createContext<Services | null>(null);

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (services === null) throw new Error("App services are unavailable outside the signed-in shell");
  return services;
}
