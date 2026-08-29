-- CreateTable
CREATE TABLE "QuizProgress" (
    "id" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "attempt" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL DEFAULT 0,
    "furthest" INTEGER NOT NULL DEFAULT 0,
    "answers" JSONB,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuizProgress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuizProgress_startedAt_idx" ON "QuizProgress"("startedAt");

-- CreateIndex
CREATE INDEX "QuizProgress_step_idx" ON "QuizProgress"("step");

-- CreateIndex
CREATE INDEX "QuizProgress_completed_idx" ON "QuizProgress"("completed");

-- CreateIndex
CREATE UNIQUE INDEX "QuizProgress_visitorId_attempt_key" ON "QuizProgress"("visitorId", "attempt");

