/**
 * Server Wrapper for Laptop Tracker
 * This ensures that legacy scripts calling 'node server.js' work correctly
 * by redirecting to the updated cloud-server.js
 */
require('./cloud-server.js');
