const repl = require('repl');
const { RockhopperClient } = require('./rockhopper');

async function main() {
  const rockhopperClient = new RockhopperClient();

  await rockhopperClient.connect();

  repl.start().context.rockhopperClient = rockhopperClient;
}

main();
