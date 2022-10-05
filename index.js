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
      console.log('cmm connected')
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

pingCmmLoop();
// setTimeout(pingCmm, 4000);

async function runCalib() {
  if(actualState !== STATE_ERROR){
    actualState = STATE_RUN;
    await startNextStage();
  }
}
async function stepCalib() {
  actualState = STATE_STEP;
  await startNextStage();
}
async function pauseCalib() {
  actualState = STATE_PAUSE;
  await feedHold();
}


var actualState = null;
var commandedState = null;

async function setCommandedState(newCommandedState){
  if(['RUN', 'PAUSE', 'STOP'].includes(newCommandedState)){
    commandedState = newCommandedState;
  }
}

async function changeState(newState){
  switch(newState){
    case STATE_RUN:
      await runCalib();
      break;
    case STATE_PAUSE:
      await calibPause();
      break;
    case STATE_STOP:
      await calibStop();
      break;
  }

  if(commandedState == STATE_RUN){
  }
  else if(commandedState == STATE_RUN){
    await runCalibNextStage()
  }
  if(commandedState == STATE_RUN){
    await runCalibNextStage()
  }
}


async function cmdSetSerial(serialNum) {
  calibProcess.serialNum = serialNum;
}
async function cmdStep() {
  await setCommandedState(STATE_STEP);

  if(actualState !== STATE_RUN){

    await stepCalib();
  }
}
async function cmdPause() {
  await setCommandedState(STATE_PAUSE);
  if(actualState !== STATE_PAUSE){
    await pauseCalib();
  }
}
async function cmdStop() {
  await setCommandedState(STATE_STOP);
  if(actualState !== STATE_STOP){
    await calibStop();
  }
}
async function cmdSetSkipCmm(val) {
  await rockhopperClient.setSkipCmm(val)
}
async function cmdRestart() {
  calibProcess = new CalibProcess(process_type);
  calibProcess.stages.calib[STAGES.ERASE_COMPENSATION].completed = true
}

console.log("starting with process type " + process_type);


