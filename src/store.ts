import { DatabaseSync } from 'node:sqlite';

export interface CartItem {
  productId: string;
  name: string;
  price: number;
  qty: number;
}

interface CartRow {
  product_id: string;
  name: string;
  price: number;
  qty: number;
}

export class CartStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cart_items (
        product_id TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        price      REAL NOT NULL,
        qty        REAL NOT NULL
      )
    `);
  }

  addItem(productId: string, name: string, price: number, qty: number): void {
    const existing = this.db
      .prepare('SELECT qty FROM cart_items WHERE product_id = ?')
      .get(productId) as { qty: number } | undefined;

    if (existing) {
      this.db
        .prepare('UPDATE cart_items SET qty = ?, name = ?, price = ? WHERE product_id = ?')
        .run(existing.qty + qty, name, price, productId);
    } else {
      this.db
        .prepare('INSERT INTO cart_items (product_id, name, price, qty) VALUES (?, ?, ?, ?)')
        .run(productId, name, price, qty);
    }
  }

  removeItem(productId: string): boolean {
    const result = this.db.prepare('DELETE FROM cart_items WHERE product_id = ?').run(productId);
    return result.changes > 0;
  }

  clear(): void {
    this.db.exec('DELETE FROM cart_items');
  }

  getItems(): CartItem[] {
    const rows = this.db
      .prepare('SELECT product_id, name, price, qty FROM cart_items ORDER BY product_id')
      .all() as unknown as CartRow[];
    return rows.map((r) => ({
      productId: r.product_id,
      name: r.name,
      price: r.price,
      qty: r.qty,
    }));
  }

  getTotal(): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(price * qty), 0) as total FROM cart_items')
      .get() as { total: number };
    return row.total;
  }

  get size(): number {
    const row = this.db.prepare('SELECT COUNT(*) as n FROM cart_items').get() as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}
