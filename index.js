const util = require("util");
const { exec } = require("child_process");
const execPromise = util.promisify(exec);
const fs = require('fs');

const { CalibProcess } = require('./calib');
const { CalibManagerWorker } = require('./calib-manager-worker');

var serialNum = null;
var variant = null;
process.argv.forEach(function (val, index, array) {
  console.log(index + ': ' + val);
  switch(index){
    case 2:
      serialNum = val;
    case 3:
      variant = val;
  }
});


var calibProcess = new CalibProcess(serialNum, variant);
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
    console.log(calibProcess.commandServer.isConnected())
    console.log(calibProcess.rockhopperClient.connected)
    if(calibProcess.commandServer.isConnected() && calibProcess.rockhopperClient.connected){
      break;
    }
  }
  await calibProcess.cmdRun()
}

async function main() {
  console.log(`Starting CMM calibration process, serial ${serialNum}, spindle RPM ${variant}k`);
  await Promise.all([ pingCmmLoop(), startup() ]);
}

main()
