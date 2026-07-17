import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const profiles = sqliteTable("profiles", {
  id: text("id").primaryKey(), name: text("name").notNull(), pluginId: text("plugin_id").notNull(), baseUrl: text("base_url").notNull(),
  configJson: text("config_json").notNull(), keyEncrypted: text("key_encrypted").notNull(), enabled: integer("enabled", { mode: "boolean" }).notNull(),
  lastTestJson: text("last_test_json"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
});
export const models = sqliteTable("models", {
  id: text("id").primaryKey(), profileId: text("profile_id").notNull(), providerModelId: text("provider_model_id").notNull(), label: text("label").notNull(),
  capabilitiesJson: text("capabilities_json").notNull(), manual: integer("manual", { mode: "boolean" }).notNull(), enabled: integer("enabled", { mode: "boolean" }).notNull(), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
});
export const conversations = sqliteTable("conversations", { id: text("id").primaryKey(), profileId: text("profile_id").notNull(), modelId: text("model_id").notNull(), title: text("title").notNull(), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull() });
export const messages = sqliteTable("messages", { id: text("id").primaryKey(), conversationId: text("conversation_id").notNull(), role: text("role").notNull(), content: text("content").notNull(), assetIdsJson: text("asset_ids_json").notNull(), createdAt: text("created_at").notNull() });
export const runs = sqliteTable("runs", { id: text("id").primaryKey(), profileId: text("profile_id").notNull(), modelId: text("model_id").notNull(), operation: text("operation").notNull(), status: text("status").notNull(), inputJson: text("input_json").notNull(), outputJson: text("output_json"), inspectorJson: text("inspector_json"), errorJson: text("error_json"), conversationId: text("conversation_id"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull() });
export const jobs = sqliteTable("jobs", { id: text("id").primaryKey(), runId: text("run_id").notNull(), state: text("state").notNull(), remoteId: text("remote_id"), attempts: integer("attempts").notNull(), nextPollAt: text("next_poll_at"), leaseToken: text("lease_token"), leaseExpiresAt: text("lease_expires_at"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull() });
export const assets = sqliteTable("assets", { id: text("id").primaryKey(), sha256: text("sha256").notNull().unique(), storageKey: text("storage_key").notNull().unique(), mimeType: text("mime_type").notNull(), byteSize: integer("byte_size").notNull(), createdAt: text("created_at").notNull() });
export const runAssets = sqliteTable("run_assets", { runId: text("run_id").notNull(), assetId: text("asset_id").notNull(), kind: text("kind").notNull() });
export const batchJobs = sqliteTable("batch_jobs", {
  id: text("id").primaryKey(), profileId: text("profile_id").notNull(), modelId: text("model_id").notNull(),
  providerModelId: text("provider_model_id").notNull(), displayName: text("display_name").notNull(),
  status: text("status").notNull(), remoteId: text("remote_id"), totalCount: integer("total_count").notNull(),
  submittedCount: integer("submitted_count").notNull(), succeededCount: integer("succeeded_count").notNull(),
  failedCount: integer("failed_count").notNull(), inspectorJson: text("inspector_json"), errorJson: text("error_json"),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
});
export const batchEntries = sqliteTable("batch_entries", {
  id: text("id").primaryKey(), batchJobId: text("batch_job_id").notNull(), idx: integer("idx").notNull(),
  prompt: text("prompt").notNull(), parametersJson: text("parameters_json").notNull(),
  assetIdsJson: text("asset_ids_json").notNull(), runId: text("run_id"), status: text("status").notNull(),
  errorJson: text("error_json"), createdAt: text("created_at").notNull(),
});
