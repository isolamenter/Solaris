import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // `src-tauri/target` is Cargo build output; Tauri's codegen writes JavaScript
  // into it that is generated, machine-written and never edited by hand.
  { ignores: ["dist/**", "data/**", "node_modules/**", "src-tauri/target/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  { rules: { "@typescript-eslint/no-explicit-any": "error" } },
);
