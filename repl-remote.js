const repl = require('repl');
const { RockhopperClient } = require('./rockhopper');

async function main() {
  const rockhopperClient = new RockhopperClient("192.168.6.2");

  rockhopperClient.connect();
  await rockhopperClient.successfulConnection();

  repl.start().context.rockhopperClient = rockhopperClient;
}

main();
