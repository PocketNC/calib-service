const util = require("util");
const { exec } = require("child_process");
const execPromise = util.promisify(exec);
const fs = require('fs');

const { CalibProcess } = require('./calib');
const { CalibManagerWorker } = require('./calib-manager-worker');


var serialNum = process.argv[2];
var v2variant = process.argv[3];

var calibProcess = new CalibProcess(serialNum, v2variant, "BASIC");
var calibManagerWorker = new CalibManagerWorker(calibProcess);
calibManagerWorker.connect();

async function main() {
  console.log(process.versions);
  console.log(`Starting calibration upload. serial ${serialNum}, spindle RPM ${v2variant}k`);

  while(true){
    await new Promise(r => setTimeout(r, 1000));
    if(calibProcess.commandServer.isConnected() && calibProcess.rockhopperClient.connected){
      break;
    }
  }

  await calibProcess.runUploadFiles();
  process.exit(0);
}

main()
