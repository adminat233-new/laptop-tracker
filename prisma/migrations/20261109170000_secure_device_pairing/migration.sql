ALTER TABLE "devices"
  ALTER COLUMN "pair_code" TYPE VARCHAR(50),
  ADD COLUMN "auth_token_hash" CHAR(64),
  ADD COLUMN "is_lost" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "secure_pairings" (
  "id" SERIAL NOT NULL,
  "pair_id" VARCHAR(50) NOT NULL,
  "pair_code_hash" CHAR(64) NOT NULL,
  "laptop_device_id" VARCHAR(50) NOT NULL,
  "created_at" BIGINT NOT NULL,
  "expires_at" BIGINT NOT NULL,
  "paired_at" BIGINT,
  CONSTRAINT "secure_pairings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "secure_pairings_pair_id_key"
  ON "secure_pairings"("pair_id");
CREATE UNIQUE INDEX "secure_pairings_pair_code_hash_key"
  ON "secure_pairings"("pair_code_hash");
