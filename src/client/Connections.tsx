import { useEffect, useState, type FormEvent } from "react";
import type { AdapterDto, AdapterId, ConnectionDto, ModelDto, Operation } from "../shared/contracts.js";
import type { ConnectionCatalog } from "./catalog.js";
import { useServices } from "./context.js";
import { Empty, formatTime, StatusBadge } from "./display.js";

const operationLabels: Record<Operation, string> = { imageGenerate: "Generate image" };

type ConnectionForm = {
  /** null while creating. `adapterId` is immutable after creation. */
  id: string | null;
  name: string;
  adapterId: AdapterId;
  baseUrl: string;
  /** Values for the adapter's non-URL fields, kept as text until submit. */
  config: Record<string, string>;
  apiKey: string;
  enabled: boolean;
};

function formFor(adapterId: AdapterId, connection?: ConnectionDto): ConnectionForm {
  return {
    id: connection?.id ?? null,
    name: connection?.name ?? "",
    adapterId: connection?.adapterId ?? adapterId,
    baseUrl: connection?.baseUrl ?? "",
    config: {},
    // Existing keys are never read back; a blank field keeps the stored one.
    apiKey: "",
    enabled: connection?.enabled ?? true,
  };
}

function adapterConfigFields(adapter: AdapterDto | undefined) {
  return (adapter?.fields ?? []).filter((field) => field.name !== "baseUrl");
}

/** Non-empty config values, numbers converted. Returns null when nothing is set. */
function buildConfig(adapter: AdapterDto | undefined, values: Record<string, string>): Record<string, unknown> | null {
  const config: Record<string, unknown> = {};
  for (const field of adapterConfigFields(adapter)) {
    const raw = values[field.name]?.trim() ?? "";
    if (raw === "") continue;
    config[field.name] = field.type === "number" ? Number(raw) : raw;
  }
  return Object.keys(config).length > 0 ? config : null;
}

export function Connections({ catalog }: { catalog: ConnectionCatalog }) {
  const { api, notify, fail } = useServices();
  const [form, setForm] = useState<ConnectionForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [modelId, setModelId] = useState("");
  const [modelLabel, setModelLabel] = useState("");

  const adapter = catalog.adapters.find((item) => item.id === form?.adapterId);
  const defaultAdapter = catalog.adapters[0];
  const selected = catalog.selected;

  useEffect(() => {
    setConfirmDelete(null);
    setModelId("");
    setModelLabel("");
  }, [catalog.selectedId]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    setBusy(true);
    try {
      const config = buildConfig(adapter, form.config);
      if (form.id) {
        await api.updateConnection(form.id, {
          name: form.name,
          baseUrl: form.baseUrl,
          ...(config === null ? {} : { config }),
          enabled: form.enabled,
          ...(form.apiKey === "" ? {} : { apiKey: form.apiKey }),
        });
        notify(`Updated ${form.name}.`);
      } else {
        const created = await api.createConnection({
          name: form.name,
          adapterId: form.adapterId,
          baseUrl: form.baseUrl,
          ...(config === null ? {} : { config }),
          apiKey: form.apiKey,
        });
        catalog.select(created.id);
        notify(`Created ${created.name}.`);
      }
      setForm(null);
      await catalog.refresh();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  async function testConnection(connection: ConnectionDto) {
    try {
      const result = await api.testConnection(connection.id);
      notify(`${connection.name}: ${result.detail ?? (result.ok ? "connection succeeded" : "connection failed")}`);
    } catch (error) {
      fail(error);
    } finally {
      await catalog.refresh();
    }
  }

  async function refreshModels(connection: ConnectionDto) {
    setRefreshing(true);
    try {
      const models = await api.refreshModels(connection.id);
      await catalog.refreshModels(connection.id);
      const discovered = models.filter((model) => !model.manual).length;
      notify(`Discovery refreshed: ${discovered} discovered model${discovered === 1 ? "" : "s"} (manual models are kept).`);
    } catch (error) {
      fail(error);
    } finally {
      setRefreshing(false);
    }
  }

  async function removeConnection(connection: ConnectionDto) {
    try {
      await api.deleteConnection(connection.id);
      setConfirmDelete(null);
      await catalog.refresh();
    } catch (error) {
      fail(error);
    }
  }

  async function removeModel(model: ModelDto) {
    try {
      await api.deleteModel(model.id);
      if (selected) await catalog.refreshModels(selected.id);
    } catch (error) {
      fail(error);
    }
  }

  async function addModel(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    try {
      await api.addManualModel(selected.id, {
        providerModelId: modelId,
        ...(modelLabel === "" ? {} : { label: modelLabel }),
        capabilities: ["imageGenerate"],
      });
      setModelId("");
      setModelLabel("");
      await catalog.refreshModels(selected.id);
    } catch (error) {
      fail(error);
    }
  }

  return (
    <section>
      <div className="title-row">
        <h2>Connections</h2>
        <button
          className="primary"
          disabled={form === null && defaultAdapter === undefined}
          onClick={() => setForm(form ? null : defaultAdapter ? formFor(defaultAdapter.id) : null)}
        >
          {form ? "Close" : "New connection"}
        </button>
      </div>

      {form && (
        <form className="card stack" onSubmit={(event) => void save(event)}>
          <label>
            Name
            <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
          </label>
          <label>
            Adapter
            <select
              value={form.adapterId}
              disabled={form.id !== null}
              onChange={(event) => setForm({ ...form, adapterId: event.target.value as AdapterId })}
            >
              {catalog.adapters.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Base URL
            <input
              type="url"
              value={form.baseUrl}
              placeholder={adapter?.fields.find((field) => field.name === "baseUrl")?.placeholder}
              onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
              required
            />
          </label>
          {adapterConfigFields(adapter).map((field) => (
            <label key={field.name}>
              {field.label}
              <input
                type={field.type === "number" ? "number" : "text"}
                value={form.config[field.name] ?? ""}
                placeholder={field.placeholder}
                required={field.required}
                onChange={(event) => setForm({ ...form, config: { ...form.config, [field.name]: event.target.value } })}
              />
            </label>
          ))}
          <label>
            API key
            <input
              type="password"
              autoComplete="new-password"
              value={form.apiKey}
              placeholder={form.id ? "Leave blank to keep the stored key" : undefined}
              required={form.id === null}
              onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
            />
          </label>
          {form.id && (
            <label className="check-line">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
              />
              Enabled
            </label>
          )}
          <p className="muted">
            The key is write-only. It is encrypted on the Server and never returned to this page; only its presence is shown.
          </p>
          <button className="primary" disabled={busy}>
            {busy ? "Saving…" : form.id ? "Save changes" : "Save connection"}
          </button>
        </form>
      )}

      {catalog.connections.length === 0 ? (
        <Empty title="No connections yet" text="Add a named connection to a provider, then refresh its models." />
      ) : (
        <div className="connection-grid">
          {catalog.connections.map((connection) => (
            <article
              className={`card connection ${catalog.selectedId === connection.id ? "selected" : ""}`}
              key={connection.id}
              onClick={() => catalog.select(connection.id)}
            >
              <h3>
                {connection.name} {!connection.enabled && <small>disabled</small>}
              </h3>
              <p>{connection.adapterId}</p>
              <p className="muted">{connection.baseUrl}</p>
              <p>
                {connection.hasKey ? "Key stored" : "No key stored"} ·{" "}
                {connection.lastTest
                  ? `${connection.lastTest.ok ? "Test passed" : "Test failed"} ${formatTime(connection.lastTest.at)}${
                      connection.lastTest.detail ? ` — ${connection.lastTest.detail}` : ""
                    }`
                  : "Not tested"}
              </p>
              {confirmDelete === connection.id ? (
                <div className="row">
                  <span>Delete this connection?</span>
                  <button
                    type="button"
                    className="danger"
                    onClick={(event) => {
                      event.stopPropagation();
                      void removeConnection(connection);
                    }}
                  >
                    Delete now
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setConfirmDelete(null);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="row">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void testConnection(connection);
                    }}
                  >
                    Test
                  </button>
                  <button
                    type="button"
                    disabled={refreshing}
                    onClick={(event) => {
                      event.stopPropagation();
                      void refreshModels(connection);
                    }}
                  >
                    Refresh models
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      catalog.select(connection.id);
                      setForm(formFor(connection.adapterId, connection));
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setConfirmDelete(connection.id);
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      {selected && (
        <div className="card stack">
          <div className="title-row">
            <h3>{selected.name} models</h3>
            <button type="button" className="primary" disabled={refreshing} onClick={() => void refreshModels(selected)}>
              {refreshing ? "Refreshing…" : "Refresh models"}
            </button>
          </div>
          {catalog.models.length === 0 ? (
            <p className="muted">No models yet. Refresh discovery, or add a provider model id manually.</p>
          ) : (
            <ul className="model-list">
              {catalog.models.map((model) => (
                <li className={model.adapted ? "" : "unadapted"} key={model.id}>
                  <span>
                    <b>{model.label}</b>
                    <small>
                      {model.providerModelId} ·{" "}
                      {model.capabilities.map((capability) => operationLabels[capability]).join(" · ") || "no operation"}
                      {model.manual ? " · manual" : ""}
                      {model.adapted ? "" : ` · ${model.availabilityMessage ?? "not adapted"}`}
                    </small>
                  </span>
                  <StatusBadge
                    status={model.adapted ? "success" : "unavailable"}
                    label={model.adapted ? "Ready" : "Not adapted"}
                  />
                  <button type="button" onClick={() => void removeModel(model)}>
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form className="inline-form" onSubmit={(event) => void addModel(event)}>
            <input
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              placeholder="Provider model ID"
              required
            />
            <input
              value={modelLabel}
              onChange={(event) => setModelLabel(event.target.value)}
              placeholder="Display name (optional)"
            />
            <button>Add manual model</button>
          </form>
        </div>
      )}
    </section>
  );
}
