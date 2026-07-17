import type { FastifyRequest } from "fastify";
import { AppError } from "../errors.js";

export function assertLoopbackHost(request: FastifyRequest, port: number) {
  const host = request.headers.host?.toLowerCase();
  const allowed = new Set([`127.0.0.1:${port}`, `[::1]:${port}`]);
  if (!host || !allowed.has(host)) throw new AppError("HOST_REJECTED", "Solaris accepts only its loopback host", 421);
}
export function assertSameOrigin(request: FastifyRequest, port: number) {
  const origin = request.headers.origin;
  const expected = `http://127.0.0.1:${port}`;
  if (origin !== expected) throw new AppError("ORIGIN_REJECTED", "Cross-origin write requests are not allowed", 403);
}
