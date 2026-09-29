import type { Repository } from "../interfaces.js";
import { geminiModelAvailability } from "../providers/geminiAdapter.js";
import type { SolarisService } from "../services.js";
import { MOCK_SUBJECT } from "./mockOidc.js";

const CONNECTION_ID = "12385e62-4eb7-4fa3-a5da-3b6de8af4484";

/** Seed only the explicit mock identity; env remains authoritative on restart. */
export async function configureLocalAccount(repository: Repository, service: SolarisService, input: {
  publicOrigin: string; apiKey: string | undefined; baseUrl: string; model: string;
}): Promise<void> {
  if (!input.apiKey?.trim()) throw new Error("SOLARIS_GEMINI_API_KEY is required when SOLARIS_MOCK_OIDC=1");
  if (!geminiModelAvailability(input.model).adapted) throw new Error("SOLARIS_GEMINI_MODEL must be an adapted Gemini image model");
  const issuer = `${input.publicOrigin}/mock-oidc`;
  const user = repository.findUserByExternalIdentity(issuer, MOCK_SUBJECT) ?? repository.createUserWithIdentity({
    issuer, subject: MOCK_SUBJECT, displayName: "Local developer",
  });
  // A reserved id avoids matching or overwriting connections by display name.
  const existing = repository.listConnections(user.id).find((row) => row.id === CONNECTION_ID);
  if (existing) {
    service.updateConnection(user.id, existing.id, { name: "Local Gemini", baseUrl: input.baseUrl, enabled: true, apiKey: input.apiKey });
  } else {
    service.createConnection(user.id, {
      name: "Local Gemini", adapterId: "gemini", baseUrl: input.baseUrl, apiKey: input.apiKey,
    }, CONNECTION_ID);
  }
  await service.addModel(user.id, CONNECTION_ID, { providerModelId: input.model, capabilities: ["imageGenerate"] });
}
