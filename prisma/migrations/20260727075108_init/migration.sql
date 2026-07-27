-- CreateTable
CREATE TABLE "AbTest" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hypothesis" TEXT,
    "primaryMetric" TEXT NOT NULL DEFAULT 'add_to_cart',
    "plannedDays" INTEGER NOT NULL DEFAULT 21,
    "startedAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AbTest_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AbEvent" (
    "id" TEXT NOT NULL,
    "test" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "path" TEXT,
    "template" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AbEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AbOrder" (
    "id" TEXT NOT NULL,
    "test" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "visitorId" TEXT,
    "totalPrice" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "placedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AbOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AbEvent_test_event_bucket_idx" ON "AbEvent"("test", "event", "bucket");

-- CreateIndex
CREATE INDEX "AbEvent_createdAt_idx" ON "AbEvent"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AbEvent_test_visitorId_event_key" ON "AbEvent"("test", "visitorId", "event");

-- CreateIndex
CREATE INDEX "AbOrder_test_bucket_placedAt_idx" ON "AbOrder"("test", "bucket", "placedAt");

-- AddForeignKey
ALTER TABLE "AbEvent" ADD CONSTRAINT "AbEvent_test_fkey" FOREIGN KEY ("test") REFERENCES "AbTest"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AbOrder" ADD CONSTRAINT "AbOrder_test_fkey" FOREIGN KEY ("test") REFERENCES "AbTest"("key") ON DELETE CASCADE ON UPDATE CASCADE;
