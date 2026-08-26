import { assertProductionConfiguration, createControlServer } from './control-service.js';

const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || '0.0.0.0';
const control = createControlServer();

try {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('PORT is invalid');
  assertProductionConfiguration(control.config);
  control.server.listen(port, host, () => {
    console.log(`DreamStream control service listening on http://${host}:${port}`);
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Control service failed to start');
  process.exitCode = 1;
}

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down`);
  try {
    await control.close();
    process.exitCode = 0;
  } catch (error) {
    console.error('Shutdown failed', error instanceof Error ? error.message : 'Unknown error');
    process.exitCode = 1;
  }
}

process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });
