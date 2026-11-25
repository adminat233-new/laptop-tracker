-- Bootstrap script for a NEW Supabase project.
--
-- Generated from prisma/schema.prisma with:
--   npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
--
-- Run this once in the Supabase SQL Editor of the NEW project. It uses
-- CREATE ... IF NOT EXISTS, so rerunning it will not drop or alter existing
-- data. After it succeeds, copy that project's Transaction Pooler connection
-- string into the Render service's DATABASE_URL environment variable.
--
-- The app does not run prisma db push at startup; schema provisioning is an
-- explicit operator step. GET /api/health confirms DATABASE_URL is reachable.

CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE IF NOT EXISTS "codes" (
    "id" SERIAL NOT NULL,
    "pair_code" VARCHAR(10) NOT NULL,
    "binary_code" TEXT NOT NULL,
    "device_id" VARCHAR(50) NOT NULL,
    "device_info" TEXT,
    "is_paired" BOOLEAN NOT NULL DEFAULT false,
    "created_at" BIGINT NOT NULL,
    "paired_at" BIGINT,

    CONSTRAINT "codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "devices" (
    "id" SERIAL NOT NULL,
    "device_id" VARCHAR(50) NOT NULL,
    "pair_code" VARCHAR(50) NOT NULL,
    "device_type" VARCHAR(10),
    "system_info" TEXT,
    "path_data" TEXT,
    "last_seen" BIGINT,
    "created_at" BIGINT NOT NULL,
    "auth_token_hash" CHAR(64),
    "is_lost" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "secure_pairings" (
    "id" SERIAL NOT NULL,
    "pair_id" VARCHAR(50) NOT NULL,
    "pair_code_hash" CHAR(64) NOT NULL,
    "laptop_device_id" VARCHAR(50) NOT NULL,
    "created_at" BIGINT NOT NULL,
    "expires_at" BIGINT NOT NULL,
    "paired_at" BIGINT,

    CONSTRAINT "secure_pairings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "locations" (
    "id" SERIAL NOT NULL,
    "device_id" VARCHAR(50) NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "accuracy" DOUBLE PRECISION,
    "source" VARCHAR(50),
    "rssi" INTEGER,
    "confidence" INTEGER,
    "updated_at" BIGINT NOT NULL,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "logs" (
    "id" SERIAL NOT NULL,
    "device_id" VARCHAR(50) NOT NULL,
    "tool" VARCHAR(50) NOT NULL,
    "output" TEXT NOT NULL,
    "influence" DOUBLE PRECISION DEFAULT 0,
    "level" VARCHAR(10) DEFAULT 'info',
    "created_at" BIGINT NOT NULL,

    CONSTRAINT "logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "signal_reliability" (
    "id" SERIAL NOT NULL,
    "identifier" VARCHAR(100) NOT NULL,
    "reliability" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "hit_count" INTEGER NOT NULL DEFAULT 0,
    "last_seen" BIGINT NOT NULL,

    CONSTRAINT "signal_reliability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "commands" (
    "id" SERIAL NOT NULL,
    "command_id" VARCHAR(50) NOT NULL,
    "device_id" VARCHAR(50) NOT NULL,
    "command_type" VARCHAR(20) NOT NULL,
    "params" TEXT,
    "result" TEXT,
    "status" VARCHAR(20) DEFAULT 'pending',
    "created_at" BIGINT NOT NULL,
    "completed_at" BIGINT,

    CONSTRAINT "commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sales" (
    "id" SERIAL NOT NULL,
    "pair_code" VARCHAR(10) NOT NULL,
    "total" DOUBLE PRECISION NOT NULL,
    "time" BIGINT NOT NULL,
    "details" TEXT,

    CONSTRAINT "sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "products" (
    "id" SERIAL NOT NULL,
    "pair_code" VARCHAR(10) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "stock" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "codes_pair_code_key" ON "codes"("pair_code");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "devices_device_id_key" ON "devices"("device_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "secure_pairings_pair_id_key" ON "secure_pairings"("pair_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "secure_pairings_pair_code_hash_key" ON "secure_pairings"("pair_code_hash");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "locations_device_id_key" ON "locations"("device_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "logs_device_id_idx" ON "logs"("device_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "signal_reliability_identifier_key" ON "signal_reliability"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "commands_command_id_key" ON "commands"("command_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sales_pair_code_idx" ON "sales"("pair_code");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "products_pair_code_idx" ON "products"("pair_code");

-- Verification: all nine expected tables should be listed.
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'codes', 'devices', 'secure_pairings', 'locations', 'logs',
    'signal_reliability', 'commands', 'sales', 'products'
  )
ORDER BY table_name;
