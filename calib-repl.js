const repl = require('repl');
const { CalibProcess } = require('./calib');

serial = process.argv[2]
variant = process.argv[3]

async function main() {
  context = repl.start().context
  context.calib = new CalibProcess(serial,variant,"BASIC")
}

main();
