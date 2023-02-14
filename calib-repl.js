const repl = require('repl');
const { CalibProcess } = require('./calib');
const { CalibManagerWorker } = require('./calib-manager-worker');

serial = process.argv[2]
variant = process.argv[3]

async function main() {
  context = repl.start().context
  context.calib = new CalibProcess(serial,variant,"BASIC")
  context.calibManagerWorker = new CalibManagerWorker(context.calib);
  context.calibManagerWorker.connect();
}

main();
