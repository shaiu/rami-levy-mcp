import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CartStore } from '../src/store.js';

function tempDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rl-store-')), 'cart.db');
}

test('addItem inserts a new product', () => {
  const store = new CartStore(tempDbPath());
  store.addItem('1', 'Milk', 6.9, 2);
  assert.deepEqual(store.getItems(), [{ productId: '1', name: 'Milk', price: 6.9, qty: 2 }]);
  store.close();
});

test('addItem on an existing product increments qty, not overwrites it', () => {
  const store = new CartStore(tempDbPath());
  store.addItem('1', 'Milk', 6.9, 2);
  store.addItem('1', 'Milk', 6.9, 3);
  const items = store.getItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].qty, 5);
  store.close();
});

test('removeItem deletes an existing product and returns true', () => {
  const store = new CartStore(tempDbPath());
  store.addItem('1', 'Milk', 6.9, 1);
  assert.equal(store.removeItem('1'), true);
  assert.deepEqual(store.getItems(), []);
  store.close();
});

test('removeItem on a missing product returns false and changes nothing', () => {
  const store = new CartStore(tempDbPath());
  assert.equal(store.removeItem('does-not-exist'), false);
  store.close();
});

test('clear empties every item', () => {
  const store = new CartStore(tempDbPath());
  store.addItem('1', 'Milk', 6.9, 1);
  store.addItem('2', 'Bread', 8.5, 1);
  store.clear();
  assert.deepEqual(store.getItems(), []);
  store.close();
});

test('getTotal sums price times qty across all items', () => {
  const store = new CartStore(tempDbPath());
  store.addItem('1', 'Milk', 6.9, 2);   // 13.8
  store.addItem('2', 'Bread', 8.5, 1);  // 8.5
  assert.equal(store.getTotal(), 22.3);
  store.close();
});

test('getTotal on an empty cart is 0, not null or NaN', () => {
  const store = new CartStore(tempDbPath());
  assert.equal(store.getTotal(), 0);
  store.close();
});

test('size counts distinct products', () => {
  const store = new CartStore(tempDbPath());
  store.addItem('1', 'Milk', 6.9, 1);
  store.addItem('2', 'Bread', 8.5, 1);
  assert.equal(store.size, 2);
  store.close();
});

test('a cart persists across reopening the same db file', () => {
  const dbPath = tempDbPath();
  const first = new CartStore(dbPath);
  first.addItem('1', 'Milk', 6.9, 1);
  first.close();

  const reopened = new CartStore(dbPath);
  assert.deepEqual(reopened.getItems(), [{ productId: '1', name: 'Milk', price: 6.9, qty: 1 }]);
  reopened.close();
});

test('snapshot + replaceAll restores an earlier cart exactly', () => {
  const store = new CartStore(tempDbPath());
  store.addItem('1', 'Milk', 6.9, 2);
  const before = store.snapshot();
  store.addItem('1', 'Milk', 6.9, 3);
  store.addItem('2', 'Bread', 8.5, 1);
  store.replaceAll(before);
  assert.deepEqual(store.getItems(), [{ productId: '1', name: 'Milk', price: 6.9, qty: 2 }]);
  store.replaceAll([]);
  assert.deepEqual(store.getItems(), []);
  store.close();
});
