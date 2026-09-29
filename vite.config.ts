import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const local = loadEnv(mode, process.cwd(), "SOLARIS_");
  return {
    plugins: [react()],
    root: "src/client",
    define: { __SOLARIS_DEFAULT_SERVER__: JSON.stringify(local.SOLARIS_MOCK_OIDC === "1" ? local.SOLARIS_PUBLIC_ORIGIN ?? null : null) },
    build: { outDir: "../../dist/client", emptyOutDir: true },
  };
});
