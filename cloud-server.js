const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 9999;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ============= DATABASE =============
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:[YOUR-PASSWORD]@db.hkwqlymebxqaemqzjlcy.supabase.co:5432/postgres',
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
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
    `);
    console.log('Database initialized');
  } finally {
    client.release();
  }
}

// ============= BINARY VERIFICATION =============
function charToBinary(char) {
  return char.charCodeAt(0).toString(2).padStart(8, '0');
}

function codeToBinary(code) {
  return code.split('').map(charToBinary).join(' ');
}

// ============= HEALTH CHECK =============
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: Date.now() });
});

// ============= LAPTOP: Generate & Store Code =============
app.post('/api/generate', async (req, res) => {
  const { systemInfo } = req.body;
  
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let pairCode = '';
  for (let i = 0; i < 8; i++) pairCode += chars.charAt(Math.floor(Math.random() * chars.length));
  
  const binaryCode = codeToBinary(pairCode);
  const deviceId = 'dev_' + crypto.randomBytes(8).toString('hex');
  const now = Date.now();
  
  try {
    await pool.query(
      'INSERT INTO codes (pair_code, binary_code, device_id, created_at) VALUES ($1, $2, $3, $4)',
      [pairCode, binaryCode, deviceId, now]
    );
    await pool.query(
      'INSERT INTO devices (device_id, pair_code, device_type, system_info, last_seen, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [deviceId, pairCode, 'laptop', JSON.stringify(systemInfo), now, now]
    );
    
    console.log(`Generated: ${pairCode} -> ${deviceId}`);
    res.json({ success: true, pairCode, binaryCode, deviceId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============= PHONE: Verify Code =============
app.post('/api/verify', async (req, res) => {
  const { pairCode } = req.body;
  
  try {
    const result = await pool.query('SELECT * FROM codes WHERE pair_code = $1', [pairCode]);
    
    if (result.rows.length === 0) {
      return res.json({ success: false, error: 'Code not found. Generate on laptop first.' });
    }
    
    const codeRecord = result.rows[0];
    const enteredBinary = codeToBinary(pairCode);
    
    if (enteredBinary !== codeRecord.binary_code) {
      return res.json({ success: false, error: 'Binary verification failed' });
    }
    
    await pool.query('UPDATE codes SET is_paired = TRUE, paired_at = $1 WHERE pair_code = $2', [Date.now(), pairCode]);
    
    const deviceResult = await pool.query('SELECT * FROM devices WHERE device_id = $1', [codeRecord.device_id]);
    const locationResult = await pool.query('SELECT * FROM locations WHERE device_id = $1', [codeRecord.device_id]);
    
    const phoneDeviceId = 'dev_' + crypto.randomBytes(8).toString('hex');
    await pool.query(
      'INSERT INTO devices (device_id, pair_code, device_type, system_info, last_seen, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [phoneDeviceId, pairCode, 'phone', '{}', Date.now(), Date.now()]
    );
    
    console.log(`Verified & Paired: ${pairCode}`);
    
    res.json({
      success: true,
      verified: true,
      laptopDeviceId: codeRecord.device_id,
      phoneDeviceId,
      deviceInfo: deviceResult.rows[0] ? JSON.parse(deviceResult.rows[0].system_info || '{}') : null,
      laptopLocation: locationResult.rows[0] || null
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============= LAPTOP: Poll Commands =============
app.get('/api/poll/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  
  try {
    await pool.query('UPDATE devices SET last_seen = $1 WHERE device_id = $2', [Date.now(), deviceId]);
    
    const result = await pool.query(
      "SELECT * FROM commands WHERE device_id = $1 AND status = 'pending'",
      [deviceId]
    );
    
    for (const cmd of result.rows) {
      await pool.query('UPDATE commands SET status = $2 WHERE command_id = $1', [cmd.command_id, 'sent']);
    }
    
    res.json({
      success: true,
      commands: result.rows.map(c => ({
        commandId: c.command_id,
        commandType: c.command_type,
        params: JSON.parse(c.params || '{}')
      }))
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============= LAPTOP: Send Result =============
app.post('/api/result', async (req, res) => {
  const { commandId, result, error } = req.body;
  
  try {
    await pool.query(
      'UPDATE commands SET result = $1, error = $2, status = $3, completed_at = $4 WHERE command_id = $5',
      [result || null, error || null, error ? 'failed' : 'completed', Date.now(), commandId]
    );
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============= LAPTOP: Send Heartbeat =============
app.post('/api/heartbeat', async (req, res) => {
  const { deviceId, location, systemInfo } = req.body;
  
  try {
    await pool.query('UPDATE devices SET last_seen = $1 WHERE device_id = $2', [Date.now(), deviceId]);
    
    if (location) {
      await pool.query(
        `INSERT INTO locations (device_id, lat, lng, int_lat, int_lng, city, region, country, ip, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (device_id) DO UPDATE SET
           lat = $2, lng = $3, int_lat = $4, int_lng = $5, city = $6, region = $7, country = $8, ip = $9, updated_at = $10`,
        [deviceId, location.lat, location.lng,
         location.intLat || Math.round(location.lat * 1000000),
         location.intLng || Math.round(location.lng * 1000000),
         location.city, location.region, location.country, location.ip, Date.now()]
      );
    }
    
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============= PHONE: Send Command =============
app.post('/api/command', async (req, res) => {
  const { deviceId, commandType, params } = req.body;
  
  const commandId = 'cmd_' + crypto.randomBytes(8).toString('hex');
  
  try {
    await pool.query(
      'INSERT INTO commands (command_id, device_id, command_type, params, status, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [commandId, deviceId, commandType, JSON.stringify(params || {}), 'pending', Date.now()]
    );
    
    console.log(`Command: ${commandType} for ${deviceId}`);
    res.json({ success: true, commandId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============= PHONE: Get Result =============
app.get('/api/result/:commandId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM commands WHERE command_id = $1', [req.params.commandId]);
    
    if (result.rows.length === 0) {
      return res.json({ success: true, status: 'pending' });
    }
    
    const cmd = result.rows[0];
    res.json({ success: true, status: cmd.status, result: cmd.result, error: cmd.error });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============= PHONE: Send Location =============
app.post('/api/location/phone', async (req, res) => {
  const { deviceId, location } = req.body;
  
  try {
    await pool.query(
      `INSERT INTO locations (device_id, lat, lng, int_lat, int_lng, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (device_id) DO UPDATE SET
         lat = $2, lng = $3, int_lat = $4, int_lng = $5, updated_at = $6`,
      [deviceId, location.lat, location.lng,
       location.intLat || Math.round(location.lat * 1000000),
       location.intLng || Math.round(location.lng * 1000000),
       Date.now()]
    );
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============= PHONE: Get Status =============
app.get('/api/status/:deviceId', async (req, res) => {
  try {
    const deviceResult = await pool.query('SELECT * FROM devices WHERE device_id = $1', [req.params.deviceId]);
    
    if (deviceResult.rows.length === 0) {
      return res.json({ success: true, isOnline: false });
    }
    
    const device = deviceResult.rows[0];
    const isOnline = (Date.now() - device.last_seen < 15000);
    
    const locationResult = await pool.query('SELECT * FROM locations WHERE device_id = $1', [req.params.deviceId]);
    
    const pairedResult = await pool.query(
      'SELECT * FROM devices WHERE pair_code = $1 AND device_id != $2',
      [device.pair_code, req.params.deviceId]
    );
    
    let pairedLocation = null;
    if (pairedResult.rows.length > 0) {
      const pairedLocResult = await pool.query('SELECT * FROM locations WHERE device_id = $1', [pairedResult.rows[0].device_id]);
      pairedLocation = pairedLocResult.rows[0] || null;
    }
    
    res.json({
      success: true,
      isOnline,
      lastSeen: device.last_seen,
      systemInfo: JSON.parse(device.system_info || '{}'),
      myLocation: locationResult.rows[0] || null,
      pairedLocation
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============= CLEANUP =============
setInterval(async () => {
  try {
    const hourAgo = Date.now() - 3600000;
    await pool.query('DELETE FROM codes WHERE created_at < $1', [hourAgo]);
    await pool.query('DELETE FROM commands WHERE created_at < $1', [hourAgo * 6]);
  } catch (e) {}
}, 600000);

// ============= START =============
initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch(e => {
  console.error('Failed to initialize database:', e);
  process.exit(1);
});

module.exports = app;
