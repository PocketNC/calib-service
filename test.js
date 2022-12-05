const { RockhopperClient } = require('./rockhopper');

async function main() {
  const rockhopperClient = new RockhopperClient();

  rockhopperClient.connect();

  await rockhopperClient.successfulConnection();

  try {
    console.log("here");
    await rockhopperClient.programOpenCmd("v2_calib_calc_calib.ngc")
    await rockhopperClient.programOpenCmd("experiment_with_cmm_movement.ngc")
    console.log("here2");
  } catch(e) {
    console.log("here3");
    console.error(e);
  }

  await rockhopperClient.disconnect();
}

main();
