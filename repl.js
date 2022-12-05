const repl = require('repl');
const { RockhopperClient } = require('./rockhopper');

async function main() {
  const rockhopperClient = new RockhopperClient();

  rockhopperClient.connect();
  await rockhopperClient.successfulConnection();

  repl.start().context.rockhopperClient = rockhopperClient;
}

main();
