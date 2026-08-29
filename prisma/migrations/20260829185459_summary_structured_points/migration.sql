/*
  Warnings:

  - You are about to drop the column `analysis` on the `QuizSummary` table. All the data in the column will be lost.
  - Added the required column `bridge` to the `QuizSummary` table without a default value. This is not possible if the table is not empty.
  - Added the required column `lead` to the `QuizSummary` table without a default value. This is not possible if the table is not empty.
  - Added the required column `points` to the `QuizSummary` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "QuizSummary" DROP COLUMN "analysis",
ADD COLUMN     "bridge" TEXT NOT NULL,
ADD COLUMN     "lead" TEXT NOT NULL,
ADD COLUMN     "points" JSONB NOT NULL;
