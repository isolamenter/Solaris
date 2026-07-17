import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function readLocalEnv() {
  const file = resolve(process.cwd(), ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const [, name, rawValue] = match;
    if (!name || rawValue === undefined || process.env[name]) continue;
    const value = rawValue.replace(/^("|')|("|')$/g, "");
    process.env[name] = value;
  }
}

readLocalEnv();

export const env = {
  dataDir: resolve(process.env.SOLARIS_DATA_DIR ?? ".solaris-data"),
  port: Number.parseInt(process.env.PORT ?? "3210", 10),
  masterKey: process.env.CREDENTIALS_MASTER_KEY,
  production: process.env.NODE_ENV === "production",
};
