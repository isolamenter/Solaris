import { useCallback, useEffect, useMemo, useState } from "react";
import type { AdapterDto, ConnectionDto, ModelDto } from "../shared/contracts.js";
import type { SolarisApi } from "./api.js";

/**
 * Adapters, connections and the models of the selected connection. Shared by the
 * workspace and the connections page so both read one source of truth; adapter
 * form fields are never hard-coded in the UI.
 */
export type ConnectionCatalog = {
  adapters: AdapterDto[];
  connections: ConnectionDto[];
  /** Models of the selected connection, including not-adapted rows. */
  models: ModelDto[];
  selectedId: string;
  selected: ConnectionDto | undefined;
  select: (connectionId: string) => void;
  /** Reloads adapters, connections and the selected connection's models. */
  refresh: () => Promise<void>;
  refreshModels: (connectionId: string) => Promise<ModelDto[]>;
};

export function useConnectionCatalog(api: SolarisApi, fail: (error: unknown) => void): ConnectionCatalog {
  const [adapters, setAdapters] = useState<AdapterDto[]>([]);
  const [connections, setConnections] = useState<ConnectionDto[]>([]);
  const [models, setModels] = useState<ModelDto[]>([]);
  const [selectedId, setSelectedId] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [nextAdapters, nextConnections] = await Promise.all([api.listAdapters(), api.listConnections()]);
      setAdapters(nextAdapters);
      setConnections(nextConnections);
      setSelectedId((current) =>
        nextConnections.some((connection) => connection.id === current) ? current : (nextConnections[0]?.id ?? ""),
      );
    } catch (error) {
      fail(error);
    }
  }, [api, fail]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshModels = useCallback(
    async (connectionId: string) => {
      if (!connectionId) {
        setModels([]);
        return [];
      }
      try {
        const next = await api.listModels(connectionId);
        setModels(next);
        return next;
      } catch (error) {
        fail(error);
        return [];
      }
    },
    [api, fail],
  );

  useEffect(() => {
    void refreshModels(selectedId);
  }, [refreshModels, selectedId]);

  const selected = useMemo(
    () => connections.find((connection) => connection.id === selectedId),
    [connections, selectedId],
  );

  return { adapters, connections, models, selectedId, selected, select: setSelectedId, refresh, refreshModels };
}
