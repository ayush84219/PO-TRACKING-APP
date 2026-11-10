const os = require('os');
const http = require('http');
const { port } = require('./config/env');
const app = require('./app');
const { initSchema } = require('./db/initSchema');
const { startQueueWorker, stopQueueWorker } = require('./services/notificationQueue');
const { startPoWatcher, stopPoWatcher } = require('./services/poWatcher');
const { initSocket } = require('./services/socketService');

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

const server = http.createServer(app);
initSocket(server);

server.listen(port, '0.0.0.0', async () => {
  const localIp = getLocalIp();
  console.log(`\n==============================================`);
  console.log(`🚀 MaterialScan API Server Running!`);
  console.log(`- Local:   http://localhost:${port}`);
  console.log(`- Network: http://${localIp}:${port}`);
  console.log(`==============================================\n`);
  try {
    await initSchema();
    startQueueWorker({ intervalMs: 20000, slaMinutes: 15 });
    startPoWatcher(15000);
  } catch (err) {
    console.error('[Startup Warning] Schema init or worker start failed:', err.message);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[Server Error] Port ${port} is already in use by another process.`);
    console.error(`Make sure no other instance of MaterialScan backend is running.\n`);
  } else {
    console.error('[Server Error]:', err);
  }
  process.exit(1);
});

const gracefulShutdown = () => {
  console.log('\nGracefully shutting down MaterialScan API...');
  stopQueueWorker();
  stopPoWatcher();
  server.close(() => {
    process.exit(0);
  });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
