-- CreateTable
CREATE TABLE "AbInteraction" (
    "id" TEXT NOT NULL,
    "test" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "step" TEXT,
    "idx" INTEGER,
    "attempt" TEXT,
    "path" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AbInteraction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AbInteraction_test_event_bucket_idx" ON "AbInteraction"("test", "event", "bucket");

-- CreateIndex
CREATE INDEX "AbInteraction_visitorId_createdAt_idx" ON "AbInteraction"("visitorId", "createdAt");

-- CreateIndex
CREATE INDEX "AbInteraction_event_step_idx" ON "AbInteraction"("event", "step");

-- CreateIndex
CREATE INDEX "AbInteraction_createdAt_idx" ON "AbInteraction"("createdAt");

