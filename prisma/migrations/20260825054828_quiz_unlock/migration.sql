-- CreateTable
CREATE TABLE "QuizUnlock" (
    "visitorId" TEXT NOT NULL,
    "target" INTEGER NOT NULL,
    "bonus" INTEGER NOT NULL DEFAULT 0,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuizUnlock_pkey" PRIMARY KEY ("visitorId")
);

-- CreateIndex
CREATE INDEX "QuizUnlock_expiresAt_idx" ON "QuizUnlock"("expiresAt");
