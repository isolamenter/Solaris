import { expect, test } from "@playwright/test";

test("renders the local-first connections flow", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Local provider playground")).toBeVisible();
  await page.getByRole("button", { name: "connections" }).click();
  await page.getByRole("button", { name: "New connection" }).click();
  await expect(page.getByLabel("API key")).toBeVisible();
  await page.getByLabel("Name").fill(`E2E connection ${Date.now()}`);
  await page.getByLabel("API key").fill("test-key");
  await page.getByRole("button", { name: "Save connection" }).click();
  await expect(page.getByRole("button", { name: "Auto add models" })).toBeVisible();
});

test("BFF rejects a cross-origin profile write", async ({ request }) => {
  const response = await request.post("/api/profiles", { headers: { Origin: "http://example.invalid" }, data: { name: "x", pluginId: "gemini", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "not-saved" } });
  expect(response.status()).toBe(403);
  await expect(response.json()).resolves.toMatchObject({ error: { code: "ORIGIN_REJECTED" } });
});

test("Gemini workspace exposes adapted controls and disables unadapted models", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Connections" }).click();
  await page.getByRole("button", { name: "New connection" }).click();
  await page.getByLabel("Name").fill(`Gemini E2E ${Date.now()}`);
  await page.getByLabel("Provider").selectOption("gemini");
  await page.getByLabel("Base URL").fill("https://generativelanguage.googleapis.com");
  await page.getByLabel("API key").fill("test-key");
  await page.getByRole("button", { name: "Save connection" }).click();

  await page.getByPlaceholder("Provider model ID").fill("gemini-2.5-flash-image");
  await page.getByLabel("Generate image").check();
  await expect(page.getByLabel("Edit image")).toHaveCount(0);
  await page.getByRole("button", { name: "Add manual model" }).click();
  await expect(page.getByPlaceholder("Provider model ID")).toHaveValue("");

  await page.getByPlaceholder("Provider model ID").fill("gemini-3-pro-image-preview");
  await page.getByRole("button", { name: "Add manual model" }).click();
  await expect(page.getByPlaceholder("Provider model ID")).toHaveValue("");
  await page.getByPlaceholder("Provider model ID").fill("gemini-3.1-flash-image-preview");
  await page.getByRole("button", { name: "Add manual model" }).click();
  await expect(page.getByPlaceholder("Provider model ID")).toHaveValue("");
  await page.getByPlaceholder("Provider model ID").fill("gemini-3.1-flash-lite-image");
  await page.getByRole("button", { name: "Add manual model" }).click();
  await expect(page.getByPlaceholder("Provider model ID")).toHaveValue("");

  await expect(page.getByText("Not adapted", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Workspace" }).click();

  const modelSelect = page.getByLabel("Model");
  await expect(modelSelect.getByRole("option", { name: /2\.5-flash-image — Not adapted/ })).toHaveAttribute("disabled", "");
  await modelSelect.selectOption({ label: "gemini-3-pro-image-preview" });
  await expect(page.getByText("Aspect ratio")).toBeVisible();
  await expect(page.getByRole("button", { name: "16:9" })).toBeVisible();
  await expect(page.getByRole("button", { name: "4K" })).toBeVisible();
  await expect(page.getByText("Google Search", { exact: true })).toBeVisible();
  await expect(page.getByText("Thinking", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/gateway still supports it/)).toBeVisible();

  await modelSelect.selectOption({ label: "gemini-3.1-flash-image-preview" });
  await expect(page.getByText("Thinking", { exact: true })).toBeVisible();
  await expect(page.getByText("Google Search", { exact: true })).toBeVisible();

  await modelSelect.selectOption({ label: "gemini-3.1-flash-lite-image" });
  await expect(page.getByText("Thinking", { exact: true })).toBeVisible();
  await expect(page.getByText("Google Search", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Resolution", { exact: true })).toHaveCount(0);
  await expect(page.getByText("0 / 14")).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles([
    { name: "first.png", mimeType: "image/png", buffer: Buffer.from("first") },
    { name: "second.png", mimeType: "image/png", buffer: Buffer.from("second") },
  ]);
  await expect(page.getByText("2 / 14")).toBeVisible();
  await page.getByRole("button", { name: "Remove reference 1" }).click();
  await expect(page.getByText("1 / 14")).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply edit" })).toBeVisible();
});
