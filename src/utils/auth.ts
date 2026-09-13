import type { MiddlewareHandler } from "hono";

export function bearerAuth(token: string): MiddlewareHandler {
  return async (c, next) => {
    if (!token) return await next();
    if (c.req.header("authorization") === `Bearer ${token}`) return await next();
    return c.text("Unauthorized", 401);
  };
}