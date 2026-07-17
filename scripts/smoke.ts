export {};

const port = process.env.PORT ?? "3210";
const response = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { host: `127.0.0.1:${port}` } });
if (!response.ok) throw new Error(`Health check failed: ${response.status}`);
console.log(await response.text());
