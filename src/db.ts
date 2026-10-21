import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type LocalDatabase = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
  exec(text: string): Promise<void>;
  transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T>;
};

const globalForDb = globalThis as typeof globalThis & {
  empowerBizDb?: Promise<LocalDatabase>;
};

async function seedDatabase(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(70401321)");
    const tenants = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM tenants",
    );
    if (tenants.rows[0]?.count) {
      await client.query("COMMIT");
      return;
    }
    const shops = [
      ["tenant_maua", "Maua House", "maua-house", "Thoughtful home goods, made for everyday living.", "Home & living", "#137c68"],
      ["tenant_soko", "Soko Studio", "soko-studio", "A little colour for the things you carry.", "Fashion", "#bc6844"],
      ["tenant_kijani", "Kijani Pantry", "kijani-pantry", "Good things for a well-stocked Kenyan kitchen.", "Food & pantry", "#768443"],
    ];
    for (const [id, name, slug, description, category, color] of shops) {
      await client.query(
        "INSERT INTO tenants (id,name,slug,description,category,accent_color) VALUES ($1,$2,$3,$4,$5,$6)",
        [id, name, slug, description, category, color],
      );
    }

    const salt = randomBytes(16).toString("hex");
    const passwordHash = scryptSync("Karibu123!", salt, 64).toString("hex");
    await client.query(
      "INSERT INTO users (id,email,full_name,password_hash,password_salt) VALUES ($1,$2,$3,$4,$5)",
      ["user_maua_owner", "owner@mauahouse.local", "Amina Njeri", passwordHash, salt],
    );
    await client.query(
      "INSERT INTO memberships (user_id,tenant_id,role) VALUES ($1,$2,'owner')",
      ["user_maua_owner", "tenant_maua"],
    );
    const adminSalt = randomBytes(16).toString("hex");
    const adminHash = scryptSync("Karibu123!", adminSalt, 64).toString("hex");
    await client.query(
      "INSERT INTO users (id,email,full_name,password_hash,password_salt,is_platform_admin,account_type) VALUES ($1,$2,$3,$4,$5,true,'platform_admin')",
      ["user_platform_admin", "admin@empowerbiz.local", "empowerBiz Admin", adminHash, adminSalt],
    );

    const products = [
      ["tenant_maua","Woven Market Basket","woven-market-basket","Handwoven sisal basket with leather handles. Made in Kenya.","Home & living",1850,2400,18,"#e9dece"],
      ["tenant_maua","Sunday Ceramic Set","sunday-ceramic-set","A set of two hand-finished ceramic mugs for slow mornings.","Home & living",3200,null,12,"#dce7e1"],
      ["tenant_maua","Linen Cushion Cover","linen-cushion-cover","Soft washed linen, sized for a relaxed living room.","Home & living",1600,null,24,"#eee0d4"],
      ["tenant_maua","Kikapu Storage Pair","kikapu-storage-pair","Two nesting palm-leaf baskets for tidy shelves.","Home & living",2750,3200,9,"#e7dfc8"],
      ["tenant_soko","Coastline Tote","coastline-tote","A roomy everyday tote in locally printed cotton canvas.","Fashion",2200,null,21,"#d9e8e5"],
      ["tenant_soko","Kitenge Weekend Pouch","kitenge-weekend-pouch","A bright zip pouch for travel, errands and small essentials.","Fashion",950,1200,30,"#f0d8c8"],
      ["tenant_soko","Woven Bead Earrings","woven-bead-earrings","Lightweight hand-beaded earrings in warm earthy tones.","Fashion",1250,null,14,"#ebdfc7"],
      ["tenant_soko","Everyday Crossbody","everyday-crossbody","Compact crossbody bag with an adjustable strap.","Fashion",3400,null,7,"#e3ded7"],
      ["tenant_kijani","Kericho Highland Tea","kericho-highland-tea","Bright, full-bodied black tea from the highlands of Kericho.","Food & pantry",780,null,45,"#e1e8d5"],
      ["tenant_kijani","Wildflower Honey","wildflower-honey","Raw small-batch honey harvested from local wildflowers.","Food & pantry",1100,null,28,"#f2e4c5"],
      ["tenant_kijani","Pilau Spice Blend","pilau-spice-blend","A fragrant, freshly milled blend for your favourite pilau.","Food & pantry",420,null,60,"#e9d5bd"],
      ["tenant_kijani","Cocoa & Coconut Granola","cocoa-coconut-granola","Small-batch toasted oats with coconut, seeds and cocoa.","Food & pantry",950,null,16,"#e6d9d0"],
    ] as const;
    for (const item of products) {
      const [tenantId,name,slug,description,category,price,compareAt,stock,color] = item;
      await client.query(
        "INSERT INTO products (id,tenant_id,name,slug,description,category,price_kes,compare_at_kes,stock,sku,color) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [randomUUID(),tenantId,name,slug,description,category,price,compareAt,stock,slug.slice(0, 10).toUpperCase(),color],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function initializeDatabase(): Promise<LocalDatabase> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55432/postgres",
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  try {
    await pool.query("SELECT 1");
    const schema = await readFile(
      join(process.cwd(), "database", "schema.sql"),
      "utf8",
    );
    await pool.query(schema);
    await seedDatabase(pool);
  } catch (error) {
    await pool.end();
    throw new Error(
      "Could not reach the local PGlite database. Start the app with npm run dev so its local database service starts first.",
      { cause: error },
    );
  }
  return {
    query: <T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) =>
      pool.query<T>(text, values),
    exec: async (text: string) => { await pool.query(text); },
    transaction: async <T>(work: (client: PoolClient) => Promise<T>) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export function getDatabase(): Promise<LocalDatabase> {
  globalForDb.empowerBizDb ??= initializeDatabase();
  return globalForDb.empowerBizDb;
}
