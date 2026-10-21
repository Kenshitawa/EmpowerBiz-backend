# empowerBiz backend

Local-first Fastify API for the empowerBiz Kenyan commerce platform. This service owns authentication, commerce workflows and the persistent PGlite database. The API binds to loopback by default; it is a development backend, not production hosting.

## Run locally

Requires Node.js 20 or newer. Install and start:

```sh
npm install
npm run dev
```

The API is at `http://127.0.0.1:4000`; its PostgreSQL-compatible socket listens on `127.0.0.1:55432`. Persistent application data is stored in the ignored `.local/database` directory. Keep that directory if local data matters.

Start the frontend separately from the empowerBiz frontend repository (`npm install`, then `npm run dev`). Do not expose the development API to a public network. The frontend forwards session cookies to this API from server-side components/actions.

## Demo accounts

- Merchant: `owner@mauahouse.local` / `Karibu123!`
- Platform admin: `admin@empowerbiz.local` / `Karibu123!`

Use only for local preview.

## API areas

- `/api/auth`: session login/logout, customer registration, owner invitation acceptance, and current user.
- `/api/catalog`: marketplace products and independent shops.
- `/api/cart`, `/api/checkout`: anonymous cart and transactional seller-grouped checkout.
- `/api/customer/orders`: orders scoped to the signed-in customer.
- `/api/merchant`: tenant-scoped products, orders, and fulfilment actions.
- `/api/platform`: admin-only overview, shop onboarding and shop status.

Checkout re-reads stock and current prices and commits seller orders and stock decrements in one database transaction. COD is a local preview; M-Pesa is a non-paying preview. No external service is contacted.

## Checks

```sh
npm run typecheck
npm test
```

The database is local-only. Database-level RLS, hosted authentication, external payment callbacks, delivery partners, production rate limiting, and operational backup/recovery remain future work. Do not deploy this local configuration as a public multitenant service.
