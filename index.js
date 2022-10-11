const util = require("util");
const { exec } = require("child_process");
const execPromise = util.promisify(exec);
const fs = require('fs');

// Log to file and to stdout
//
const logFile = fs.createWriteStream('/var/opt/pocketnc/calib/calib-service.log', { flags: 'a' });
const logStdout = process.stdout;

console.log = function() {
  logFile.write(util.format.apply(null, arguments) + "\n");
  logStdout.write(util.format.apply(null, arguments) + "\n");
}
console.error = console.log;

const { CalibProcess } = require('./calib');
const { CalibManagerWorker } = require('./calib-manager-worker');

var serialNum = null;
process.argv.forEach(function (val, index, array) {
  console.log(index + ': ' + val);
  if(index === 3){
    serialNum = val;
  }
});


var calibProcess = new CalibProcess(serialNum);
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

function main() {
  pingCmmLoop();
  startup();
}

main()

console.log("Starting CMM calibration process, machine serial " + serialNum);
