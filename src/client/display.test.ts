import { describe, expect, it } from "vitest";
import { ApiClientError } from "./api.js";
import { describeError, isAuthRequired } from "./display.js";

function clientError(code: string, envelope = true): ApiClientError {
  return new ApiClientError({ code, message: `${code} from the Server`, status: 401, envelope });
}

describe("session failures", () => {
  it("recognises only the Server's expired-session code", () => {
    expect(isAuthRequired(clientError("AUTH_REQUIRED"))).toBe(true);
    expect(isAuthRequired(clientError("FORBIDDEN"))).toBe(false);
    expect(isAuthRequired(clientError("INTERNAL", false))).toBe(false);
    expect(isAuthRequired(new Error("network down"))).toBe(false);
    expect(isAuthRequired(undefined)).toBe(false);
  });

  it("shows the Server's own code and message, never a raw body", () => {
    expect(describeError(clientError("AUTH_REQUIRED"))).toBe("AUTH_REQUIRED: AUTH_REQUIRED from the Server");
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError({})).toBe("Unexpected error");
  });
});
