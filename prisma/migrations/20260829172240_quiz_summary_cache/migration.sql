-- CreateTable
CREATE TABLE "QuizSummary" (
    "signature" TEXT NOT NULL,
    "teaser" TEXT NOT NULL,
    "analysis" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "persona" TEXT,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuizSummary_pkey" PRIMARY KEY ("signature")
);

-- CreateIndex
CREATE INDEX "QuizSummary_persona_idx" ON "QuizSummary"("persona");

-- CreateIndex
CREATE INDEX "QuizSummary_createdAt_idx" ON "QuizSummary"("createdAt");
