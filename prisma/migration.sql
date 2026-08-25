-- Create tables for Laptop Tracker
CREATE TABLE IF NOT EXISTS codes (
  id SERIAL PRIMARY KEY,
  pair_code VARCHAR(10) UNIQUE NOT NULL,
  binary_code TEXT NOT NULL,
  device_id VARCHAR(50),
  device_info TEXT,
  is_paired BOOLEAN DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  paired_at BIGINT
);

CREATE TABLE IF NOT EXISTS devices (
  id SERIAL PRIMARY KEY,
  device_id VARCHAR(50) UNIQUE NOT NULL,
  pair_code VARCHAR(10) NOT NULL,
  device_type VARCHAR(10),
  system_info TEXT,
  last_seen BIGINT,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS locations (
  id SERIAL PRIMARY KEY,
  device_id VARCHAR(50) UNIQUE NOT NULL,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  int_lat BIGINT,
  int_lng BIGINT,
  city VARCHAR(100),
  region VARCHAR(100),
  country VARCHAR(100),
  ip VARCHAR(50),
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS commands (
  id SERIAL PRIMARY KEY,
  command_id VARCHAR(50) UNIQUE NOT NULL,
  device_id VARCHAR(50) NOT NULL,
  command_type VARCHAR(20) NOT NULL,
  params TEXT,
  result TEXT,
  error TEXT,
  status VARCHAR(20) DEFAULT 'pending',
  created_at BIGINT NOT NULL,
  completed_at BIGINT
);
