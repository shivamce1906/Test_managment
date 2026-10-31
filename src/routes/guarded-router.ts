import { Router, RequestHandler } from 'express';

/**
 * A Router whose shared middleware runs only for its own routes.
 *
 * Feature routers are mounted at the app root (`app.use(router)`), so `router.use(mw)` would run
 * `mw` for every request passing through, including paths that belong to routers mounted later.
 * That leaked role guards across features (branch logins got 403 on stock/day-end) and made the
 * public webhook require a token. Here the middleware is prepended to each route instead.
 */
export function guardedRouter(...middleware: RequestHandler[]): Router {
  const router = Router();
  for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
    const register = (router[method] as (...args: any[]) => Router).bind(router);
    (router as any)[method] = (path: any, ...handlers: any[]) => register(path, ...middleware, ...handlers);
  }
  return router;
}
