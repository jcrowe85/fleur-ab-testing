-- CreateTable
CREATE TABLE "QuizResponse" (
    "id" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "email" TEXT,
    "target" INTEGER NOT NULL,
    "bonus" INTEGER NOT NULL DEFAULT 0,
    "persona" TEXT,
    "answers" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuizResponse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuizResponse_visitorId_idx" ON "QuizResponse"("visitorId");

-- CreateIndex
CREATE INDEX "QuizResponse_createdAt_idx" ON "QuizResponse"("createdAt");

-- CreateIndex
CREATE INDEX "QuizResponse_persona_idx" ON "QuizResponse"("persona");
