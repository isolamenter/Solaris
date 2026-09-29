import { useState, type FormEvent } from "react";
import { describeError } from "./display.js";
import { normalizeServerOrigin } from "./local/scope.js";
import type { ServerSettings } from "./settings.js";

/**
 * The one setting the client cannot derive: the absolute address of the Server.
 *
 * It is shown before sign-in (there is nothing else to do without an address)
 * and from the signed-in shell. Saving a different address does not delete the
 * other Server's local records and does not carry its token: the shell restores
 * the session of whichever Server is configured now.
 */
export function ServerAddress({
  settings,
  current,
  defaultOrigin,
  problem,
  onSaved,
  onUseDefault,
}: {
  settings: ServerSettings;
  /** The address in use, or null when none is configured. */
  current: string | null;
  /** The build's own default, or null when the address must be entered. */
  defaultOrigin: string | null;
  /** Why the stored address is unusable, if it is. */
  problem: string | null;
  onSaved: (origin: string) => void;
  onUseDefault: () => void;
}) {
  const [value, setValue] = useState(current ?? "");
  const [error, setError] = useState("");

  function save(event: FormEvent) {
    event.preventDefault();
    try {
      const origin = normalizeServerOrigin(value);
      settings.write(origin);
      setError("");
      onSaved(origin);
    } catch (thrown) {
      setError(describeError(thrown));
    }
  }

  return (
    <form className="stack" onSubmit={save}>
      <label>
        Server address
        <input
          type="url"
          value={value}
          placeholder="https://solaris.example.com"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      {problem !== null && <p className="warning">The stored Server address is unusable: {problem}</p>}
      {error !== "" && <p className="warning">{error}</p>}
      <p className="muted">
        An absolute http(s) address with no path. It is the Server this window talks to; the Solaris token itself is kept in
        this device&apos;s secure store, one session per Server.
      </p>
      <div className="row">
        <button className="primary" disabled={value.trim() === ""}>
          Use this Server
        </button>
        {defaultOrigin !== null && (
          <button
            type="button"
            onClick={() => {
              settings.clear();
              setValue(defaultOrigin);
              setError("");
              onUseDefault();
            }}
          >
            Use the default ({defaultOrigin})
          </button>
        )}
      </div>
    </form>
  );
}
