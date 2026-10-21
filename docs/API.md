# Local API contract

Development base URL: `http://127.0.0.1:4000`. Responses are JSON. Mutating requests require an `Origin` that matches the configured frontend origin (`http://127.0.0.1:3000` by default, with `http://localhost:3000` also supported). Session cookies are HttpOnly and SameSite=Lax. The frontend Next.js server forwards the browser cookie and original origin; browser components do not call this API directly.

## Routes

| Method | Path | Purpose | Authorization |
| --- | --- | --- | --- |
| GET | `/api/health` | Process health | Public |
| GET | `/api/auth/me` | Current local session user | Session optional |
| POST | `/api/auth/login` | Sign in and issue session cookie | Public |
| POST | `/api/auth/logout` | Revoke session and clear cookie | Session optional |
| POST | `/api/auth/register` | Create customer account | Public |
| POST | `/api/auth/accept-invitation` | Accept one-time owner invite | Invitation token |
| GET | `/api/catalog/products` | Search/filter/page public items | Public |
| GET | `/api/catalog/products/:slug` | Public product | Public |
| GET | `/api/catalog/shops` | Active shops | Public |
| GET | `/api/catalog/shops/:slug` | Active shop | Public |
| GET | `/api/cart` | Current anonymous cart | Cart cookie |
| GET | `/api/cart/count` | Current cart quantity | Cart cookie |
| POST | `/api/cart/items` | Add to cart | Cart cookie issued if needed |
| PATCH | `/api/cart/items/:productId` | Change/remove cart line | Cart cookie |
| POST | `/api/checkout` | Atomic stock decrement and seller-grouped orders | Public checkout; optional customer session |
| GET | `/api/orders/confirmation?orders=` | Minimal confirmation details | Public order numbers |
| GET | `/api/customer/orders` | Customer's orders | Customer session |
| GET | `/api/merchant/overview` | Merchant metrics and latest orders | Active tenant member |
| GET | `/api/merchant/products` | Tenant products | Active tenant member |
| POST | `/api/merchant/products` | Create product | Owner or manager |
| GET | `/api/merchant/orders` | Tenant orders | Active tenant member |
| PATCH | `/api/merchant/orders/:orderId/status` | Advance fulfilment/cancel with restock | Owner, manager or staff |
| GET | `/api/platform/overview` | Platform metrics and shop list | Platform admin |
| POST | `/api/platform/tenants` | Create tenant and one-time owner invitation | Platform admin |
| PATCH | `/api/platform/tenants/:tenantId/status` | Pause or resume tenant | Platform admin |

## Error response

Errors use `{ "error": "code" }` with HTTP status 4xx or 5xx. The frontend maps these codes to local route feedback. Never rely on a successful UI redirect as proof that a protected mutation succeeded; authorization and tenant ownership are checked by the API.

## Local limits

This API is bound to loopback and designed for a single local process. PGlite data is local. There is no public deployment contract, CORS policy, rate limiting, hosted RLS, live payment callback endpoint, or external delivery adapter yet.
