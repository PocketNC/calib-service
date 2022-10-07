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
const { CommandServer } = require('./command-server');
const { CalibManagerWorker } = require('./calib-manager-worker');

var process_type = null;
process.argv.forEach(function (val, index, array) {
  console.log(index + ': ' + val);
  if(index === 2){
    process_type = val;
  }
});


var lastCmmPing = 0;
var lastCmmPingSuccesful = false;
var prevCmmPingSuccesful = false;
var interpIdle = false;
var homed = false;


async function pingCmmLoop() {
  while(true){

    await new Promise(r => setTimeout(r, 3000));
    try{
      const cmmPing = await execPromise("ping -c 1 10.0.0.1");
      // console.log(cmmPing)
      lastCmmPing = Date.now();
      cmmPingSuccesful = true;
      calibProcess.cmmConnected = true;
      // console.log('cmm connected')
    } catch(e) {
      // console.log(e)

      calibProcess.cmmConnected = false;
      cmmPingSuccesful = false;
    }
    if(calibProcess ){//&& cmmPingSuccesful !== prevCmmPingSuccesful){
      try {
        // const data = await getCalibStatus();
        // console.log(data)
        // console.log(commandServer)
        // uiConnection.send(JSON.stringify({ ['getCalibStatus']: data }));
      } catch(e) {
        console.log('error')
        console.log(e)
      }
    }
  }
}

async function pingCmm() {
    await new Promise(r => setTimeout(r, 1000));
    const cmmPing = await execPromise("ping -c 1 10.0.0.1");
    console.log(cmmPing)
    lastCmmPing = cmmPing;
}

var calibProcess = new CalibProcess(process_type);
var commandServer = new CommandServer(calibProcess);
var calibManagerWorker = new CalibManagerWorker(calibProcess);
calibManagerWorker.connect();

async function startup() {
  while(true){
    await new Promise(r => setTimeout(r, 1000));
    console.log('waiting for connections')
    console.log(commandServer.connections.length)
    console.log(calibManagerWorker.connected)
    if(commandServer.isConnected() && calibProcess.rockhopperClient.connected){
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


console.log("starting with process type " + process_type);


