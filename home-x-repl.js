const repl = require('repl');
const { RockhopperClient } = require('./rockhopper');

NUM_SAMPLES_HOME_REPEAT_LINEAR = 5

async function main() {
  const rockhopperClient = new RockhopperClient();

  async function runHomingX() {
    console.log('runHomingX');
    for(let idx = 0; idx < NUM_SAMPLES_HOME_REPEAT_LINEAR; idx++){
      console.log('runHomingX ' + idx);
      const x = (Math.random()*4.5-2)*25.4;
      console.log(`G53 G0 X${x}`);
      await rockhopperClient.mdiCmdAsync(`G53 G0 X${x}`);
      await rockhopperClient.unhomeAxisAsync([0]);
      await rockhopperClient.homeAxisAsync([0]);
      await rockhopperClient.runToCompletion('v2_calib_probe_x_home.ngc')
    }
    await rockhopperClient.runToCompletion('v2_calib_verify_x_home.ngc');
  }

  rockhopperClient.connect();
  await rockhopperClient.successfulConnection();

  context = repl.start().context

  context.rockhopperClient = rockhopperClient;
  context.runHomingX = runHomingX;
}

main();
