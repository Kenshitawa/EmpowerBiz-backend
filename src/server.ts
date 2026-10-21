import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { z } from "zod";
import { getDatabase } from "./db.js";
import { getPaymentProvider } from "./payments.js";

const sessionCookie = "empowerbiz_local_session";
const cartCookie = "empowerbiz_local_cart";
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 });
await app.register(cookie);

type User = {
  id: string; email: string; full_name: string; is_platform_admin: boolean;
  account_type: "merchant" | "customer" | "platform_admin";
  tenant_id: string | null; role: string | null; tenant_status: string | null;
};

async function currentUser(request: FastifyRequest): Promise<User | null> {
  const token = request.cookies[sessionCookie];
  if (!token) return null;
  const db = await getDatabase();
  const result = await db.query<User>(
    "SELECT u.id,u.email,u.full_name,u.is_platform_admin,u.account_type,m.tenant_id,m.role,t.status AS tenant_status " +
    "FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN memberships m ON m.user_id=u.id " +
    "LEFT JOIN tenants t ON t.id=m.tenant_id WHERE s.token_hash=$1 AND s.expires_at>now() LIMIT 1",
    [hash(token)],
  );
  return result.rows[0] ?? null;
}

function validMutationOrigin(request: FastifyRequest) {
  const origin = request.headers.origin;
  if (!origin) return false;
  return origin === "http://127.0.0.1:3000" || origin === "http://localhost:3000" ||
    origin === process.env.FRONTEND_ORIGIN;
}

app.addHook("onRequest", async (request, reply) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && !validMutationOrigin(request)) {
    return reply.code(403).send({ error: "invalid_origin" });
  }
});

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  const statusCode = error instanceof Error && "statusCode" in error && typeof error.statusCode === "number"
    ? error.statusCode
    : 500;
  const status = statusCode >= 400 ? statusCode : 500;
  reply.code(status).send({ error: status >= 500 ? "internal_error" : "bad_request" });
});

app.get("/api/health", async () => ({ ok: true, service: "empowerBiz backend" }));

app.get("/api/auth/me", async (request) => ({ user: await currentUser(request) }));

app.post<{ Body: { email: string; password: string } }>("/api/auth/login", async (request, reply) => {
  const parsed = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(128) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_credentials" });
  const db = await getDatabase();
  const result = await db.query<{ id: string; password_hash: string; password_salt: string }>(
    "SELECT id,password_hash,password_salt FROM users WHERE lower(email)=lower($1)", [parsed.data.email],
  );
  const account = result.rows[0];
  if (!account) return reply.code(401).send({ error: "invalid_credentials" });
  const supplied = scryptSync(parsed.data.password, account.password_salt, 64);
  const expected = Buffer.from(account.password_hash, "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return reply.code(401).send({ error: "invalid_credentials" });
  }
  const token = randomBytes(32).toString("hex");
  await db.query("INSERT INTO sessions (token_hash,user_id,expires_at) VALUES ($1,$2,now()+interval '14 days')", [hash(token), account.id]);
  reply.setCookie(sessionCookie, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 14 });
  const user = await currentUser({ ...request, cookies: { ...request.cookies, [sessionCookie]: token } } as FastifyRequest);
  return { user };
});

app.post("/api/auth/logout", async (request, reply) => {
  const token = request.cookies[sessionCookie];
  if (token) await (await getDatabase()).query("DELETE FROM sessions WHERE token_hash=$1", [hash(token)]);
  reply.clearCookie(sessionCookie, { path: "/", sameSite: "lax", secure: process.env.NODE_ENV === "production" });
  return { ok: true };
});

app.post<{ Body: { full_name: string; email: string; password: string } }>("/api/auth/register", async (request, reply) => {
  const parsed = z.object({ full_name: z.string().min(2).max(120), email: z.string().email().max(254), password: z.string().min(12).max(128) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "validation" });
  const db = await getDatabase();
  const userId = randomUUID();
  const salt = randomBytes(16).toString("hex");
  const passwordHash = scryptSync(parsed.data.password, salt, 64).toString("hex");
  try {
    await db.query("INSERT INTO users (id,email,full_name,password_hash,password_salt,account_type) VALUES ($1,$2,$3,$4,$5,'customer')", [userId, parsed.data.email.toLowerCase(), parsed.data.full_name, passwordHash, salt]);
  } catch {
    return reply.code(409).send({ error: "exists" });
  }
  const token = randomBytes(32).toString("hex");
  await db.query("INSERT INTO sessions (token_hash,user_id,expires_at) VALUES ($1,$2,now()+interval '14 days')", [hash(token), userId]);
  reply.setCookie(sessionCookie, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 14 });
  return { user: await currentUser({ ...request, cookies: { ...request.cookies, [sessionCookie]: token } } as FastifyRequest) };
});

app.get<{ Querystring: Record<string, string | undefined> }>("/api/catalog/products", async (request) => {
  const db = await getDatabase();
  const q = request.query;
  const values: unknown[] = [];
  const filters = ["p.published=true", "p.stock>0", "t.status='active'"];
  const add = (value: unknown) => { values.push(value); return "$" + values.length; };
  if (q.q?.trim()) { const p = add("%" + q.q.trim() + "%"); filters.push(`(p.name ILIKE ${p} OR p.description ILIKE ${p} OR p.category ILIKE ${p} OR t.name ILIKE ${p})`); }
  if (q.category) filters.push(`p.category=${add(q.category)}`);
  if (q.shop) filters.push(`t.slug=${add(q.shop)}`); else filters.push("p.marketplace=true");
  for (const [raw, operator] of [[q.minPrice, ">="], [q.maxPrice, "<="]] as const) {
    const amount = Number(raw);
    if (raw && Number.isSafeInteger(amount) && amount >= 0) filters.push(`p.price_kes${operator}${add(amount)}`);
  }
  const sort = q.sort === "price-asc" ? "p.price_kes ASC" : q.sort === "price-desc" ? "p.price_kes DESC" : "p.created_at DESC";
  const pageNumber = Number(q.page ?? 1);
  const page = Number.isSafeInteger(pageNumber) && pageNumber > 0 ? Math.min(pageNumber, 10000) : 1;
  const pageSize = 8;
  const where = filters.join(" AND ");
  const [products, count] = await Promise.all([
    db.query("SELECT p.*,t.name AS tenant_name,t.slug AS tenant_slug FROM products p JOIN tenants t ON t.id=p.tenant_id WHERE " + where + ` ORDER BY ${sort} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, values),
    db.query<{ count: number }>("SELECT count(*)::int AS count FROM products p JOIN tenants t ON t.id=p.tenant_id WHERE " + where, values),
  ]);
  const total = count.rows[0]?.count ?? 0;
  return { products: products.rows, total, page, pageSize, pageCount: Math.ceil(total / pageSize) };
});

app.get<{ Params: { slug: string } }>("/api/catalog/products/:slug", async (request, reply) => {
  const result = await (await getDatabase()).query("SELECT p.*,t.name AS tenant_name,t.slug AS tenant_slug FROM products p JOIN tenants t ON t.id=p.tenant_id WHERE p.slug=$1 AND p.published=true AND t.status='active' LIMIT 1", [request.params.slug]);
  if (!result.rows[0]) return reply.code(404).send({ error: "not_found" });
  return { product: result.rows[0] };
});

app.get("/api/catalog/shops", async () => {
  const result = await (await getDatabase()).query("SELECT t.*,count(p.id)::int AS product_count FROM tenants t LEFT JOIN products p ON p.tenant_id=t.id AND p.published=true WHERE t.status='active' GROUP BY t.id ORDER BY t.name");
  return { shops: result.rows };
});
app.get<{ Params: { slug: string } }>("/api/catalog/shops/:slug", async (request, reply) => {
  const result = await (await getDatabase()).query("SELECT * FROM tenants WHERE slug=$1 AND status='active' LIMIT 1", [request.params.slug]);
  if (!result.rows[0]) return reply.code(404).send({ error: "not_found" });
  return { shop: result.rows[0] };
});

async function ensureCart(request: FastifyRequest, reply: FastifyReply) {
  let key = request.cookies[cartCookie];
  if (!key) {
    key = randomBytes(18).toString("hex");
    reply.setCookie(cartCookie, key, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 30 });
  }
  const db = await getDatabase();
  await db.query("INSERT INTO carts (id,session_key) VALUES ($1,$2) ON CONFLICT (session_key) DO NOTHING", [randomUUID(), key]);
  return key;
}

app.get("/api/cart", async (request, reply) => {
  const key = request.cookies[cartCookie];
  if (!key) return { items: [] };
  const result = await (await getDatabase()).query("SELECT p.*,t.name AS tenant_name,t.slug AS tenant_slug,ci.quantity FROM carts c JOIN cart_items ci ON ci.cart_id=c.id JOIN products p ON p.id=ci.product_id JOIN tenants t ON t.id=p.tenant_id WHERE c.session_key=$1 ORDER BY ci.ctid", [key]);
  return { items: result.rows };
});
app.get("/api/cart/count", async (request) => {
  const key = request.cookies[cartCookie];
  if (!key) return { count: 0 };
  const result = await (await getDatabase()).query<{ count: number }>("SELECT coalesce(sum(ci.quantity),0)::int AS count FROM carts c JOIN cart_items ci ON ci.cart_id=c.id WHERE c.session_key=$1", [key]);
  return { count: result.rows[0]?.count ?? 0 };
});
app.post<{ Body: { product_id: string; quantity: number } }>("/api/cart/items", async (request, reply) => {
  const parsed = z.object({ product_id: z.string().min(1), quantity: z.number().int().min(1).max(20) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "validation" });
  const db = await getDatabase();
  const product = await db.query<{ id: string; stock: number }>("SELECT p.id,p.stock FROM products p JOIN tenants t ON t.id=p.tenant_id WHERE p.id=$1 AND p.published=true AND t.status='active'", [parsed.data.product_id]);
  if (!product.rows[0] || product.rows[0].stock < parsed.data.quantity) return reply.code(409).send({ error: "stock" });
  const key = await ensureCart(request, reply);
  const cart = await db.query<{ id: string }>("SELECT id FROM carts WHERE session_key=$1", [key]);
  await db.query("INSERT INTO cart_items (cart_id,product_id,quantity) VALUES ($1,$2,$3) ON CONFLICT (cart_id,product_id) DO UPDATE SET quantity=LEAST(cart_items.quantity+EXCLUDED.quantity,20)", [cart.rows[0].id, parsed.data.product_id, parsed.data.quantity]);
  return { ok: true };
});
app.patch<{ Params: { productId: string }; Body: { quantity: number } }>("/api/cart/items/:productId", async (request, reply) => {
  const parsed = z.object({ quantity: z.number().int().min(0).max(20) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "validation" });
  const key = request.cookies[cartCookie];
  if (parsed.data.quantity === 0) {
    await (await getDatabase()).query("DELETE FROM cart_items ci USING carts c WHERE ci.cart_id=c.id AND c.session_key=$1 AND ci.product_id=$2", [key ?? "", request.params.productId]);
  } else {
    await (await getDatabase()).query("UPDATE cart_items ci SET quantity=LEAST($3,(SELECT stock FROM products WHERE id=ci.product_id)) FROM carts c WHERE ci.cart_id=c.id AND c.session_key=$1 AND ci.product_id=$2", [key ?? "", request.params.productId, parsed.data.quantity]);
  }
  return { ok: true };
});

app.post<{ Body: { customer_name: string; customer_email: string; customer_phone: string; delivery_address: string; payment_method: "cash_on_delivery" | "mpesa_demo" } }>("/api/checkout", async (request, reply) => {
  const parsed = z.object({ customer_name: z.string().min(2).max(120), customer_email: z.string().email().max(254), customer_phone: z.string().min(9).max(20), delivery_address: z.string().min(8).max(500), payment_method: z.enum(["cash_on_delivery", "mpesa_demo"]) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "details" });
  const key = request.cookies[cartCookie];
  const db = await getDatabase();
  const items = await db.query<{ product_id: string; tenant_id: string; name: string; price_kes: number; quantity: number; stock: number }>("SELECT p.id AS product_id,p.tenant_id,p.name,p.price_kes,ci.quantity,p.stock FROM carts c JOIN cart_items ci ON ci.cart_id=c.id JOIN products p ON p.id=ci.product_id JOIN tenants t ON t.id=p.tenant_id WHERE c.session_key=$1 AND p.published=true AND t.status='active' ORDER BY p.tenant_id", [key ?? ""]);
  if (!items.rows.length) return reply.code(409).send({ error: "empty" });
  if (items.rows.some((item) => item.stock < item.quantity)) return reply.code(409).send({ error: "stock" });
  const customer = await currentUser(request);
  const grouped = new Map<string, typeof items.rows>();
  for (const item of items.rows) grouped.set(item.tenant_id, [...(grouped.get(item.tenant_id) ?? []), item]);
  const amount = items.rows.reduce((sum, item) => sum + item.price_kes * item.quantity, 0);
  const payment = await getPaymentProvider(parsed.data.payment_method).start({ orderNumber: "checkout-" + randomUUID(), amountKes: amount, customerPhone: parsed.data.customer_phone });
  if (payment.status === "failed") return reply.code(400).send({ error: "payment" });
  const orderNumbers: string[] = [];
  try {
    await db.transaction(async (client) => {
      for (const [tenantId, sellerItems] of grouped) {
        const total = sellerItems.reduce((sum, item) => sum + item.price_kes * item.quantity, 0);
        const orderId = randomUUID();
        const orderNumber = "EB-" + orderId.replaceAll("-", "").slice(0, 12).toUpperCase();
        await client.query("INSERT INTO orders (id,order_number,tenant_id,customer_user_id,customer_name,customer_email,customer_phone,delivery_address,payment_method,payment_status,total_kes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [orderId, orderNumber, tenantId, customer?.account_type === "customer" ? customer.id : null, parsed.data.customer_name, parsed.data.customer_email, parsed.data.customer_phone, parsed.data.delivery_address, parsed.data.payment_method, payment.status, total]);
        for (const item of sellerItems) {
          const updated = await client.query("UPDATE products SET stock=stock-$2 WHERE id=$1 AND stock >= $2 RETURNING id", [item.product_id, item.quantity]);
          if (!updated.rows.length) throw new Error("Stock changed during checkout");
          await client.query("INSERT INTO order_items (id,order_id,product_id,product_name,quantity,unit_price_kes) VALUES ($1,$2,$3,$4,$5,$6)", [randomUUID(), orderId, item.product_id, item.name, item.quantity, item.price_kes]);
        }
        orderNumbers.push(orderNumber);
      }
      await client.query("DELETE FROM cart_items ci USING carts c WHERE ci.cart_id=c.id AND c.session_key=$1", [key ?? ""]);
    });
  } catch {
    return reply.code(409).send({ error: "stock" });
  }
  return { orderNumbers };
});

app.get<{ Querystring: { orders?: string } }>("/api/orders/confirmation", async (request) => {
  const orderNumbers = (request.query.orders ?? "").split(",").filter((value) => /^EB-[A-Z0-9-]+$/.test(value)).slice(0, 10);
  const result = orderNumbers.length ? await (await getDatabase()).query("SELECT o.order_number,o.total_kes,o.status,o.payment_method,o.payment_status,t.name AS tenant_name FROM orders o JOIN tenants t ON t.id=o.tenant_id WHERE o.order_number=ANY($1::text[]) ORDER BY o.created_at", [orderNumbers]) : { rows: [] };
  return { orders: result.rows };
});
app.get("/api/customer/orders", async (request, reply) => {
  const user = await currentUser(request);
  if (!user) return reply.code(401).send({ error: "unauthorized" });
  if (user.account_type !== "customer") return reply.code(403).send({ error: "forbidden" });
  const result = await (await getDatabase()).query("SELECT o.order_number,t.name AS tenant_name,o.total_kes,o.status,o.payment_method,o.payment_status,o.created_at FROM orders o JOIN tenants t ON t.id=o.tenant_id WHERE o.customer_user_id=$1 ORDER BY o.created_at DESC", [user.id]);
  return { orders: result.rows };
});

app.get("/api/merchant/products", async (request, reply) => {
  const user = await currentUser(request);
  if (!user?.tenant_id || user.tenant_status !== "active") return reply.code(401).send({ error: "unauthorized" });
  const result = await (await getDatabase()).query("SELECT id,name,category,price_kes,stock,published,created_at FROM products WHERE tenant_id=$1 ORDER BY created_at DESC", [user.tenant_id]);
  return { products: result.rows };
});
app.get("/api/merchant/orders", async (request, reply) => {
  const user = await currentUser(request);
  if (!user?.tenant_id || user.tenant_status !== "active") return reply.code(401).send({ error: "unauthorized" });
  const result = await (await getDatabase()).query("SELECT o.id,o.order_number,o.customer_name,o.customer_email,o.customer_phone,o.delivery_address,o.payment_method,o.payment_status,o.status,o.total_kes,o.created_at,(SELECT json_agg(json_build_object('product_name',oi.product_name,'quantity',oi.quantity,'unit_price_kes',oi.unit_price_kes)) FROM order_items oi WHERE oi.order_id=o.id) AS items FROM orders o WHERE o.tenant_id=$1 ORDER BY o.created_at DESC", [user.tenant_id]);
  return { orders: result.rows };
});
app.post<{ Body: { name: string; description: string; category: string; price_kes: number; stock: number } }>("/api/merchant/products", async (request, reply) => {
  const user = await currentUser(request);
  if (!user?.tenant_id || user.tenant_status !== "active" || !["owner", "manager"].includes(user.role ?? "")) return reply.code(403).send({ error: "forbidden" });
  const parsed = z.object({ name: z.string().min(2).max(120), description: z.string().min(8).max(1000), category: z.string().min(2).max(60), price_kes: z.number().int().min(1).max(10_000_000), stock: z.number().int().min(0).max(1_000_000) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "validation" });
  const db = await getDatabase();
  const base = parsed.data.name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const slug = base + "-" + randomUUID().slice(0, 6);
  await db.query("INSERT INTO products (id,tenant_id,name,slug,description,category,price_kes,stock,sku,color) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [randomUUID(), user.tenant_id, parsed.data.name, slug, parsed.data.description, parsed.data.category, parsed.data.price_kes, parsed.data.stock, slug.slice(0, 10).toUpperCase(), "#e4ebe2"]);
  return { ok: true };
});
app.patch<{ Params: { orderId: string }; Body: { status: string } }>("/api/merchant/orders/:orderId/status", async (request, reply) => {
  const user = await currentUser(request);
  if (!user?.tenant_id || user.tenant_status !== "active" || !["owner", "manager", "staff"].includes(user.role ?? "")) return reply.code(403).send({ error: "forbidden" });
  const status = z.enum(["confirmed", "packing", "shipped", "delivered", "cancelled"]).safeParse(request.body?.status);
  if (!status.success) return reply.code(400).send({ error: "validation" });
  const allowed: Record<string, string[]> = { placed: ["confirmed", "cancelled"], confirmed: ["packing", "cancelled"], packing: ["shipped", "cancelled"], shipped: ["delivered"] };
  const db = await getDatabase();
  const updated = await db.transaction(async (client) => {
    const current = await client.query<{ status: string }>("SELECT status FROM orders WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [request.params.orderId, user.tenant_id]);
    if (!current.rows[0] || !allowed[current.rows[0].status]?.includes(status.data)) return false;
    if (status.data === "cancelled") await client.query("UPDATE products p SET stock=p.stock+oi.quantity FROM order_items oi WHERE oi.order_id=$1 AND oi.product_id=p.id AND p.tenant_id=$2", [request.params.orderId, user.tenant_id]);
    await client.query("UPDATE orders SET status=$3 WHERE id=$1 AND tenant_id=$2", [request.params.orderId, user.tenant_id, status.data]);
    return true;
  });
  if (!updated) return reply.code(409).send({ error: "transition" });
  return { ok: true };
});

app.get("/api/platform/overview", async (request, reply) => {
  const admin = await currentUser(request);
  if (!admin?.is_platform_admin) return reply.code(403).send({ error: "forbidden" });
  const db = await getDatabase();
  const [shopCount, productCount, orderCount, sales, shops] = await Promise.all([
    db.query("SELECT count(*)::int AS count FROM tenants"),
    db.query("SELECT count(*)::int AS count FROM products WHERE published=true"),
    db.query("SELECT count(*)::int AS count FROM orders"),
    db.query("SELECT coalesce(sum(total_kes),0)::int AS total FROM orders WHERE status<>'cancelled'"),
    db.query("SELECT t.id,t.name,t.slug,t.category,t.status,count(DISTINCT p.id)::int AS products,count(DISTINCT o.id)::int AS orders FROM tenants t LEFT JOIN products p ON p.tenant_id=t.id LEFT JOIN orders o ON o.tenant_id=t.id GROUP BY t.id ORDER BY t.name"),
  ]);
  return { shopCount: shopCount.rows[0]?.count, productCount: productCount.rows[0]?.count, orderCount: orderCount.rows[0]?.count, sales: sales.rows[0]?.total, shops: shops.rows };
});
app.get("/api/merchant/overview", async (request, reply) => {
  const user = await currentUser(request);
  if (!user?.tenant_id || user.tenant_status !== "active") return reply.code(403).send({ error: "forbidden" });
  const db = await getDatabase();
  const [products, orders, sales, openOrders, tenant, latest] = await Promise.all([
    db.query("SELECT count(*)::int AS count FROM products WHERE tenant_id=$1", [user.tenant_id]),
    db.query("SELECT count(*)::int AS count FROM orders WHERE tenant_id=$1", [user.tenant_id]),
    db.query("SELECT coalesce(sum(total_kes),0)::int AS total FROM orders WHERE tenant_id=$1 AND status<>'cancelled'", [user.tenant_id]),
    db.query("SELECT count(*)::int AS count FROM orders WHERE tenant_id=$1 AND status NOT IN ('delivered','cancelled')", [user.tenant_id]),
    db.query("SELECT name FROM tenants WHERE id=$1", [user.tenant_id]),
    db.query("SELECT id,order_number,customer_name,total_kes,status,created_at FROM orders WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 5", [user.tenant_id]),
  ]);
  return { productCount: products.rows[0]?.count, orderCount: orders.rows[0]?.count, sales: sales.rows[0]?.total, openOrders: openOrders.rows[0]?.count, tenant: tenant.rows[0], latest: latest.rows };
});

app.post<{ Body: { name: string; category: string; description: string; owner_name: string; owner_email: string } }>("/api/platform/tenants", async (request, reply) => {
  const admin = await currentUser(request);
  if (!admin?.is_platform_admin) return reply.code(403).send({ error: "forbidden" });
  const parsed = z.object({ name: z.string().min(2).max(100), category: z.string().min(2).max(60), description: z.string().min(8).max(500), owner_name: z.string().min(2).max(120), owner_email: z.string().email().max(254) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "validation" });
  const db = await getDatabase();
  const token = randomBytes(32).toString("base64url");
  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const base = parsed.data.name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const salt = randomBytes(16).toString("hex");
  const temporaryHash = scryptSync(randomBytes(32).toString("hex"), salt, 64).toString("hex");
  const color = ["#137c68", "#bc6844", "#768443", "#6f718d", "#9a674c"][Math.floor(Math.random() * 5)];
  try {
    await db.transaction(async (client) => {
      const existingUser = await client.query("SELECT 1 FROM users WHERE lower(email)=lower($1)", [parsed.data.owner_email]);
      if (existingUser.rows.length) throw new Error("email_exists");
      const collision = await client.query("SELECT 1 FROM tenants WHERE slug=$1", [base]);
      const slug = base + (collision.rows.length ? "-" + randomUUID().slice(0, 4) : "");
      await client.query("INSERT INTO tenants (id,name,slug,description,category,accent_color) VALUES ($1,$2,$3,$4,$5,$6)", [tenantId, parsed.data.name, slug, parsed.data.description, parsed.data.category, color]);
      await client.query("INSERT INTO users (id,email,full_name,password_hash,password_salt,account_type) VALUES ($1,$2,$3,$4,$5,'merchant')", [ownerId, parsed.data.owner_email.toLowerCase(), parsed.data.owner_name, temporaryHash, salt]);
      await client.query("INSERT INTO memberships (user_id,tenant_id,role) VALUES ($1,$2,'owner')", [ownerId, tenantId]);
      await client.query("INSERT INTO owner_invitations (id,tenant_id,email,token_hash,expires_at,created_by) VALUES ($1,$2,$3,$4,now()+interval '7 days',$5)", [randomUUID(), tenantId, parsed.data.owner_email.toLowerCase(), hash(token), admin.id]);
    });
  } catch (error) {
    if (error instanceof Error && error.message === "email_exists") return reply.code(409).send({ error: "email_exists" });
    throw error;
  }
  return { token, shopName: parsed.data.name };
});
app.patch<{ Params: { tenantId: string }; Body: { status: "active" | "paused" } }>("/api/platform/tenants/:tenantId/status", async (request, reply) => {
  const admin = await currentUser(request);
  if (!admin?.is_platform_admin) return reply.code(403).send({ error: "forbidden" });
  const parsed = z.object({ status: z.enum(["active", "paused"]) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "validation" });
  await (await getDatabase()).query("UPDATE tenants SET status=$2 WHERE id=$1", [request.params.tenantId, parsed.data.status]);
  return { ok: true };
});
app.post<{ Body: { token: string; full_name: string; email: string; password: string } }>("/api/auth/accept-invitation", async (request, reply) => {
  const parsed = z.object({ token: z.string().min(32).max(100), full_name: z.string().min(2).max(120), email: z.string().email().max(254), password: z.string().min(12).max(128) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "validation" });
  const db = await getDatabase();
  const digest = hash(parsed.data.token);
  const salt = randomBytes(16).toString("hex");
  const passwordHash = scryptSync(parsed.data.password, salt, 64).toString("hex");
  try {
    await db.transaction(async (client) => {
      const invitation = await client.query<{ id: string; email: string }>("SELECT id,email FROM owner_invitations WHERE token_hash=$1 AND accepted_at IS NULL AND expires_at>now() FOR UPDATE", [digest]);
      const row = invitation.rows[0];
      if (!row || row.email.toLowerCase() !== parsed.data.email.toLowerCase()) throw new Error("invalid_invite");
      const update = await client.query("UPDATE owner_invitations SET accepted_at=now() WHERE id=$1 AND accepted_at IS NULL RETURNING id", [row.id]);
      if (!update.rows.length) throw new Error("invalid_invite");
      await client.query("UPDATE users SET full_name=$2,password_hash=$3,password_salt=$4 WHERE lower(email)=lower($1)", [row.email, parsed.data.full_name, passwordHash, salt]);
    });
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_invite") return reply.code(400).send({ error: "invalid_invite" });
    throw error;
  }
  return { ok: true };
});

async function start() {
  const root = process.cwd();
  const localDir = join(root, ".local");
  await mkdir(localDir, { recursive: true });
  const dbProcess = new PGlite(join(localDir, "database"));
  await dbProcess.waitReady;
  await dbProcess.exec(await readFile(join(root, "database", "schema.sql"), "utf8"));
  const socket = new PGLiteSocketServer({ db: dbProcess, host: "127.0.0.1", port: 55432 });
  await socket.start();
  process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:55432/postgres";
  try {
    await getDatabase();
    const port = Number(process.env.PORT ?? 4000);
    await app.listen({ port, host: "127.0.0.1" });
    app.log.info("Local data stored in .local/database");
  } catch (error) {
    await socket.stop();
    await dbProcess.close();
    throw error;
  }
  const close = async () => { await app.close(); await socket.stop(); await dbProcess.close(); };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

await start();
