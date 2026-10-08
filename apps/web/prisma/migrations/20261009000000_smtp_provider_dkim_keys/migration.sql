-- CreateTable
CREATE TABLE "DomainDkimKey" (
    "id" SERIAL NOT NULL,
    "domainId" INTEGER NOT NULL,
    "selector" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DomainDkimKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DomainDkimKey_domainId_key" ON "DomainDkimKey"("domainId");

-- AddForeignKey
ALTER TABLE "DomainDkimKey" ADD CONSTRAINT "DomainDkimKey_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;
