const util = require("util");
const { exec } = require("child_process");
const execPromise = util.promisify(exec);
const fs = require('fs');

const { CalibProcess } = require('./calib');
const { CalibManagerWorker } = require('./calib-manager-worker');


var serialNum = process.argv[2];
var v2variant = process.argv[3];
var processType = "BASIC"; //process.argv[4];

var calibProcess = new CalibProcess(serialNum, v2variant, processType);
var calibManagerWorker = new CalibManagerWorker(calibProcess);
calibManagerWorker.connect();


var lastCmmPing = 0;

async function pingCmmLoop() {
  while(true){

    await new Promise(r => setTimeout(r, 3000));
    try{
      const cmmPing = await execPromise("ping -c 1 10.0.0.1");
      // console.log(cmmPing)
      lastCmmPing = Date.now();
      calibProcess.status.cmmConnected = true;
    }
    catch(e) {
      calibProcess.status.cmmConnected = false;
    }
  }
}

async function startup() {
  while(true){
    await new Promise(r => setTimeout(r, 1000));
    if(calibProcess.commandServer.isConnected() && calibProcess.rockhopperClient.connected){
      break;
    }
  }
  // console.log(calibProcess.stageList);
  await calibProcess.runStages();
}

async function main() {
  console.log(process.versions);
  console.log(`Starting CMM calibration. ${processType} process, serial ${serialNum}, spindle RPM ${v2variant}k`);
  await Promise.all([ pingCmmLoop(), startup() ]);
}

main()
