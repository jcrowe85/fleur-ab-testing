-- An order can be claimed by more than one test at a time.
--
-- "AbOrder"."id" was the Shopify order id, so the row was unique per order
-- rather than per order per test. With two tests live, a cart carrying both
-- stamps was written twice: the first test created the row, the second
-- upserted the same id and its `update` overwrote `bucket` while leaving
-- `test` alone. The result belonged to neither test -- bf_models_1101 with
-- bucket 'b' -- and both dashboards dropped it.
--
-- id becomes a surrogate, and (test, orderId) carries the uniqueness. Existing
-- rows keep their ids and get orderId backfilled from them, so nothing is
-- renumbered and no row is lost.

ALTER TABLE "AbOrder" ADD COLUMN "orderId" TEXT;

UPDATE "AbOrder" SET "orderId" = "id" WHERE "orderId" IS NULL;

ALTER TABLE "AbOrder" ALTER COLUMN "orderId" SET NOT NULL;

-- Safe because the old primary key already guaranteed one row per order, so
-- no two existing rows can share a (test, orderId) pair.
CREATE UNIQUE INDEX "AbOrder_test_orderId_key" ON "AbOrder"("test", "orderId");
