const { WebSocketServer } = require('ws');
var WebSocketClient = require('websocket').client;
const zmq = require("zeromq");
const util = require("util");
const { exec } = require("child_process");
const execPromise = util.promisify(exec);
const fs = require('fs');


/*
WebSocketServer for communication with UI
WebSocketClient for communication with Rockhopper
ZeroMQ for communication with Calibration process
*/

const { getServiceStatus,
  shutdownServices } = require('./services');

const { 
  //getCalibStatus,
  loadCalibProgress,
  runStep
} = require('./calib');

function camelize(str) {
  return str.toLowerCase().replace(/[^a-zA-Z0-9]+(.)/g, (m, chr) => chr.toUpperCase());
}

const STAGES = {
  ERASE_COMPENSATION: 'ERASE_COMPENSATION',
  SETUP_CNC: 'SETUP_CNC',
  SETUP_CMM: 'SETUP_CMM',
  PROBE_MACHINE_POS: 'PROBE_MACHINE_POS',
  SETUP_PART_CSY: 'SETUP_PART_CSY',
  PROBE_SPINDLE_POS: 'PROBE_SPINDLE_POS',
  REPEATABILITY_X: 'REPEATABILITY_X',
  REPEATABILITY_Y: 'REPEATABILITY_Y',
  REPEATABILITY_Z: 'REPEATABILITY_Z',
  REPEATABILITY_A: 'REPEATABILITY_A',
  REPEATABILITY_B: 'REPEATABILITY_B',
  CHARACTERIZE_X: 'CHARACTERIZE_X',
  CHARACTERIZE_Y: 'CHARACTERIZE_Y',
  CHARACTERIZE_Z: 'CHARACTERIZE_Z',
  PROBE_TOP_PLANE: 'PROBE_TOP_PLANE',
  SETUP_CNC_CSY: 'SETUP_CNC_CSY',
  CHARACTERIZE_A: 'CHARACTERIZE_A',
  CHARACTERIZE_B: 'CHARACTERIZE_B',
  WRITE_RESULTS: 'WRITE_RESULTS',
  //verification-only stages
  RESTART_CNC: 'RESTART_CNC',
  SETUP_VERIFY: 'SETUP_VERIFY',
  VERIFY_A: 'VERIFY_A',
  VERIFY_B: 'VERIFY_B',
  WRITE_VERIFY_REPORT: 'WRITE_VERIFY_REPORT'
}

const LOADABLE_STAGE_LIST = [STAGES.PROBE_MACHINE_POS, STAGES.PROBE_SPINDLE_POS, STAGES.CHARACTERIZE_X, STAGES.CHARACTERIZE_Y, STAGES.CHARACTERIZE_Z, 
  STAGES.CHARACTERIZE_A, STAGES.CHARACTERIZE_B,
  STAGES.VERIFY_A, STAGES.VERIFY_B
]
const LOADABLE_STAGES = new Set(LOADABLE_STAGE_LIST)
console.log(LOADABLE_STAGES)

//------CONSTANTS------
const STATE_IDLE = "IDLE"
const STATE_PAUSE = "PAUSE"
const STATE_RUN = "RUN"
const STATE_STEP = "STEP"
const STATE_STOP = "STOP"
const STATE_ERROR = "ERROR"
const STATE_FAIL = "FAIL"
const MODE_CALIB = "calib"
const MODE_VERIFY = "verify"
const MSG_WHY_STEP_COMPLETE = "STEP_COMPLETE"
const MSG_WHY_UPDATE = "UPDATE"
const MSG_WHY_ERROR = "ERROR"
const MSG_WHY_FAIL = "FAIL"
const PROCESS_NEW = "new"
const PROCESS_RESUME = "resume"
const PROCESS_VERIFY = "verify"


//The line breaks in these lists of Stages are organized to show prereqs.
//i.e. to be ready to run a given stage, the stages listed above it must be completed
const CALIB_ORDER = [
  STAGES.ERASE_COMPENSATION,
  STAGES.SETUP_CNC, 
  STAGES.SETUP_CMM,
  STAGES.PROBE_MACHINE_POS,
  STAGES.SETUP_PART_CSY,
  STAGES.PROBE_SPINDLE_POS,
  STAGES.CHARACTERIZE_X, STAGES.CHARACTERIZE_Z, STAGES.CHARACTERIZE_Y,
  STAGES.SETUP_CNC_CSY,
  STAGES.CHARACTERIZE_A, STAGES.CHARACTERIZE_B,
  STAGES.WRITE_RESULTS,
]

const VERIFY_ORDER = [
  STAGES.RESTART_CNC, 
  STAGES.SETUP_CNC,
  STAGES.SETUP_CMM,
  STAGES.SETUP_VERIFY,
  //'VERIFY_X, STAGES.VERIFY_Y, STAGES.VERIFY_Z, 
  STAGES.VERIFY_A, STAGES.VERIFY_B, 
  STAGES.WRITE_VERIFY_REPORT,
]

const A_COMP_PATH = '/var/opt/pocketnc/a.comp';
const B_COMP_PATH = '/var/opt/pocketnc/b.comp';


//------GLOBALS------
var lastCmmPing = 0;
var lastCmmPingSuccesful = false;
var prevCmmPingSuccesful = false;
var interpIdle = false;
var homed = false;

var compensationCleared = false;
var calibStatus = {
  begun: false,
  selectedProcess: null,
  cmmConnected: false,
  cmmError: false,
  cncError: false,
  stages: {
    calib: CALIB_ORDER.reduce((calibArr, stage) => ({...calibArr, [stage]: {completed: false, error: false}}), {}),
    verify: VERIFY_ORDER.reduce((verifyArr, stage) => ({...verifyArr, [stage]: {completed: false, error: false}}), {}),
  },
  processState: STATE_IDLE,
  execState: STATE_IDLE,
  status: STATE_IDLE, 
  currentMode: MODE_VERIFY,
  currentStage: null,
}
calibStatus.stages.calib[STAGES.ERASE_COMPENSATION].completed = true
calibStatus.stages.calib[STAGES.SETUP_CNC].completed = true
calibStatus.stages.calib[STAGES.SETUP_CMM].completed = true
calibStatus.stages.calib[STAGES.PROBE_MACHINE_POS].completed = true
calibStatus.stages.calib[STAGES.SETUP_PART_CSY].completed = true
calibStatus.stages.calib[STAGES.PROBE_SPINDLE_POS].completed = true



//------methods?------
function getMethods(obj) {
  var result = [];
  for (var id in obj) {
    try {
      if (typeof(obj[id]) == "function") {
        result.push(id + ": " + obj[id].toString());
      }
    } catch (err) {
      result.push(id + ": inaccessible");
    }
  }
  return result;
};

async function pingCmmLoop() {
  while(true){

    await new Promise(r => setTimeout(r, 3000));
    try{
      const cmmPing = await execPromise("ping -c 1 10.0.0.1");
      // console.log(cmmPing)
      lastCmmPing = Date.now();
      cmmPingSuccesful = true;
      calibStatus.cmmConnected = true;
    } catch(e) {
      // console.log(e)

      calibStatus.cmmConnected = false;
      cmmPingSuccesful = false;
    }
    if(uiConnection ){//&& cmmPingSuccesful !== prevCmmPingSuccesful){
      try {
        const data = await getCalibStatus();
        // console.log(data)
        uiConnection.send(JSON.stringify({ ['getCalibStatus']: data }));
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

pingCmmLoop();
// setTimeout(pingCmm, 4000);


async function startNextStage() {
  console.log('finding stage to run')
  var idx, stageToRunIdx, modeToRun;
  if(calibStatus.selectedProcess !== PROCESS_VERIFY){
    console.log('unexpected calibration');
    for(idx = 0; idx < CALIB_ORDER.length; idx++){
      if(!calibStatus.stages.calib[CALIB_ORDER[idx]].completed){
        stageToRunIdx = idx;
        modeToRun = MODE_CALIB;
        break;
      }
      else{
        console.log('already completed: ' + CALIB_ORDER[idx]);
      }
    }
  }
  console.log(stageToRunIdx)
  if(stageToRunIdx === undefined){
    console.log('calibration already completed, seeking verification step');
    for(idx = 0; idx < VERIFY_ORDER.length; idx++){
      console.log(calibStatus.stages.verify[VERIFY_ORDER[idx]])
      if(!calibStatus.stages.verify[VERIFY_ORDER[idx]].completed){
        stageToRunIdx = idx;
        modeToRun = MODE_VERIFY;
        break;
      }
      else{
        console.log('already completed: ' + CALIB_ORDER[idx]);
      }
    }
  }
  var nextStage;
  if(modeToRun === MODE_CALIB){
    nextStage = CALIB_ORDER[stageToRunIdx]
    calibStatus.currentMode = MODE_CALIB
    methodToRun = STAGE_METHODS[CALIB_ORDER[stageToRunIdx]]
  }
  else if(modeToRun === MODE_VERIFY){
    nextStage = VERIFY_ORDER[stageToRunIdx]
    calibStatus.currentMode = MODE_VERIFY
    methodToRun = STAGE_METHODS[VERIFY_ORDER[stageToRunIdx]]
  }
  else{
    console.log('somehow did not select a mode to run');
    actualState = STATE_ERROR;
    return;
  }
  await waitForInterpreterIdle();
  calibStatus.currentStage = nextStage;
  console.log(calibStatus.selectedProcess)
  try{
    if([PROCESS_NEW, PROCESS_VERIFY].includes(calibStatus.selectedProcess)){
      await methodToRun(rockhopperConnection)
    }
    else if(calibStatus.selectedProcess === PROCESS_RESUME){
      console.log('yes resume')
      if(LOADABLE_STAGES.has(nextStage)){
        console.log('yes loadable')
        loadStageProgress(rockhopperConnection, nextStage)
      }
      else{
        console.log('no loadable')
        await methodToRun(rockhopperConnection)
      }
    }
  }
  catch (err) {
    console.log ('error:', err.message, err.stack)
  }
}

async function waitForInterpreterIdle() {
  while(true){
    await new Promise(r => setTimeout(r, 100));
    if(interpIdle){ console.log('interp now idle'); break; }
  }
}
async function waitForExecStateDone(initialTimeout) {
  if(initialTimeout){
    await new Promise(r => setTimeout(r, initialTimeout));
  }
  while(true){
    await new Promise(r => setTimeout(r, 100));
    if(execStateDone){ console.log('exec now done'); break; }
  }
}
async function waitForDoneAndIdle(initialTimeout) {
  if(initialTimeout){
    await new Promise(r => setTimeout(r, initialTimeout));
  }
  while(true){
    await new Promise(r => setTimeout(r, 100));
    if(execStateDone && interpIdle){ console.log('done and idle'); break; }
  }
}
async function waitForHomed(initialTimeout) {
  if(initialTimeout){
    await new Promise(r => setTimeout(r, initialTimeout));
  }
  while(true){
    await new Promise(r => setTimeout(r, 100));
    if(homed){ console.log('now homed'); break; }
  }
}
async function waitForUnhomed(initialTimeout) {
  if(initialTimeout){
    await new Promise(r => setTimeout(r, initialTimeout));
  }
  while(true){
    await new Promise(r => setTimeout(r, 100));
    if(!homed){ console.log('now unhomed'); break; }
  }
}
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
async function readCompensationFiles() {
  var aData = fs.readFileSync(A_COMP_PATH, 'ascii');
  var bData = fs.readFileSync(B_COMP_PATH, 'ascii');
  return {a: aData, b: bData};
}
async function clearCompensationFiles() {
  fs.writeFileSync(A_COMP_PATH, "");
  fs.writeFileSync(B_COMP_PATH, "");
}
async function getCalibStatus() {
  return calibStatus;
}
async function feedHold(rockhopperConnection){
  rockhopperConnection.send(
    JSON.stringify(
      {
        "id":"PUT_FEED_HOLD_CMD",
        "name":"feed_hold_cmd",
        "command":"put",
      }
    )
  )
}
async function restartServices(rockhopperConnection){
  rockhopperConnection.send(
    JSON.stringify(
      {
        "id":"PUT_RESTART",
        "name":"restart",
        "command":"put",
      }
    )
  )
}
async function programOpen(rockhopperConnection, programName){
  rockhopperConnection.send(
    JSON.stringify(
      {
        "0":programName,
        "1":"PROGRAM",
        "id":"PUT_PROGRAM_OPEN_CMD",
        "name":"program_open_cmd",
        "command":"put",
      }
    )
  )
}
async function cycleStart(rockhopperConnection) {
  rockhopperConnection.send(
    JSON.stringify(
      {
        "id":"PUT_CYCLE_START_CMD",
        "name":"cycle_start_cmd",
        "command":"put",
      }
    )
  )
}
async function disableEstop(rockhopperConnection){
  rockhopperConnection.send(
    JSON.stringify(
      {
        "0":false,
        "id":"PUT_ESTOP_CMD",
        "name":"estop_cmd",
        "command":"put",
      }
    )
  )
}
async function performHoming(rockhopperConnection){
  rockhopperConnection.send(
    JSON.stringify(
      {
        "id":"PUT_HOME_CMD",
        "name":"home_cmd",
        "command":"put",
      }
    )
  )
}
async function loadStageProgress(rockhopperConnection, stage) {
  rockhopperConnection.send(
    JSON.stringify(
      {
        "0": "o<v2_calib_load_stage_" + stage.toLowerCase() + "> call",
        "id":"PUT_MDI_CMD",
        "name":"mdi_cmd",
        "command":"put",
      }
    )
  )
}
async function performTeleopEnable(rockhopperConnection, teleopVal){
  rockhopperConnection.send(
    JSON.stringify(
      {
        "0": teleopVal,
        "id":"PUT_TELEOP_ENABLE",
        "name":"teleop_enable",
        "command":"put",
      }
    )
  )
}
async function performMdiCmd(rockhopperConnection, cmd){
  execStateDone = false;
  interpIdle = false;
  rockhopperConnection.send(
    JSON.stringify(
      {
        "0": cmd,
        "id":"PUT_MDI_CMD",
        "name":"mdi_cmd",
        "command":"put",
      }
    )
  )
}
async function performHomeAxis(rockhopperConnection, axisIndices){
  rockhopperConnection.send(
    JSON.stringify(
      {
        "0": axisIndices,
        "id":"PUT_HOME_CMD",
        "name":"home_cmd",
        "command":"put",
      }
    )
  )
}
async function performUnhomeAxis(rockhopperConnection, axisIndex){
  console.log('performing unhome')
  rockhopperConnection.send(
    JSON.stringify(
      {
        "0": false,
        "id":"PUT_TELEOP_ENABLE",
        "name":"teleop_enable",
        "command":"put",
      }
    )
  )
  await new Promise(r => setTimeout(r, 1000));
  rockhopperConnection.send(
    JSON.stringify(
      {
        "0": axisIndex,
        "id":"PUT_UNHOME",
        "name":"unhome",
        "command":"put",
      }
    )
  )
}
async function runEraseCompensation(conn){
  console.log('runEraseCompensation');
  var comps = await readCompensationFiles();
  if(comps.a.length > 2 || comps.b.length > 2 ){
    await clearCompensationFiles();
    await restartServices(conn)
    await new Promise(r => setTimeout(r, 3000));
    rockhopperConnected = false;
    while(!rockhopperConnected){
      await new Promise(r => setTimeout(r, 1000));
      console.log('still waiting for rockhopper')
    }
    console.log('rockhopper restarted');
  }
  else{
    console.log('Compensation already cleared');
  }
  calibStatus.stages.calib['ERASE_COMPENSATION'].completed = true;
  if(commandedState == STATE_RUN){
    runCalib()
  }
}
async function runSetupCnc(conn){
  console.log('runSetupCnc');
  await disableEstop(conn);
  if(!homed){
    await new Promise(r => setTimeout(r, 1000));
    await performHoming(conn);
    await waitForHomed();
  }
  if(calibStatus.currentMode === MODE_CALIB){
    calibStatus.stages.calib['SETUP_CNC'].completed = true;
  }
  else if(calibStatus.currentMode === MODE_VERIFY){
    calibStatus.stages.verify['SETUP_CNC'].completed = true;
  }
  if(commandedState == STATE_RUN){
    runCalib()
  }
}
async function runSetupCmm(conn){
  console.log('runSetupCmm');
  await programOpen(conn, 'v2_calib_setup_cmm.ngc');
  await new Promise(r => setTimeout(r, 2000));
  await cycleStart(conn);
}
async function runProbeMachinePos(conn){
  console.log('runProbeMachinePos');
  await programOpen(conn, 'v2_calib_probe_machine_pos.ngc')
  await new Promise(r => setTimeout(r, 2000));
  await cycleStart(conn)
}
async function runSetupPartCsy(conn){
  console.log('runSetupPartCsy');
  await programOpen(conn, 'v2_calib_setup_part_csy.ngc')
  await new Promise(r => setTimeout(r, 2000));
  await cycleStart(conn)
}
async function runProbeSpindlePos(conn){
  console.log('runProbeSpindlePos');
  await programOpen(conn, 'v2_calib_probe_spindle_pos.ngc')
  await new Promise(r => setTimeout(r, 2000));
  await cycleStart(conn)
}
async function runCharacterizeX(conn){
  console.log('runCharacterizeX');
  for(let idx = 0; idx < 5; idx++){
    await waitForDoneAndIdle(0);
    await performTeleopEnable(conn, true);
    await new Promise(r => setTimeout(r, 1000));
    await performMdiCmd(conn, "G0 X60" );
    await waitForDoneAndIdle(1000);
    await performUnhomeAxis(conn, 0);
    await waitForUnhomed(1000);
    await new Promise(r => setTimeout(r, 1000));
    await performHomeAxis(conn, [0]);
    await waitForHomed(1000);
    await waitForDoneAndIdle(1000);
    await new Promise(r => setTimeout(r, 2000));
    await programOpen(conn, 'v2_calib_probe_x_home.ngc')
    await new Promise(r => setTimeout(r, 1000));
    await cycleStart(conn);
    await waitForDoneAndIdle(1000);
    if(![STATE_RUN, STATE_STEP].includes(actualState)){
      return;
    }
  }
  await new Promise(r => setTimeout(r, 1000));
  await performTeleopEnable(conn, true);
  await new Promise(r => setTimeout(r, 1000));
  await programOpen(conn, 'v2_calib_verify_x_home.ngc');
  console.log("opened v2_calib_verify_x_home")
  await new Promise(r => setTimeout(r, 1000));
  await cycleStart(conn);
  console.log("started v2_calib_verify_x_home")

  await waitForDoneAndIdle(1000);
  console.log("finished v2_calib_verify_x_home")
  await new Promise(r => setTimeout(r, 1000));
  await programOpen(conn, 'v2_calib_characterize_x.ngc');
  await new Promise(r => setTimeout(r, 1000));
  await cycleStart(conn);
}
async function runCharacterizeY(conn){
  console.log('runCharacterizeY');
  await performMdiCmd(conn, "o<cmm_go_to_clearance_z> call" );
  await new Promise(r => setTimeout(r, 2000));
  for(let idx = 0; idx < 5; idx++){
    await programOpen(conn, 'v2_calib_probe_y_home.ngc')
    await new Promise(r => setTimeout(r, 1000));
    await cycleStart(conn);
    await waitForDoneAndIdle(1000);
    await waitForExecStateDone(1000);
    if(![STATE_RUN, STATE_STEP].includes(actualState)){
      return;
    }
    await performTeleopEnable(conn, true);
    await performMdiCmd(conn, "G0 Y60" );
    await waitForExecStateDone(1000);
    await performUnhomeAxis(conn, 1);
    await waitForUnhomed(1000);
    await performHomeAxis(conn, [1]);
    await waitForHomed(1000);
  }
  await new Promise(r => setTimeout(r, 1000));
  await performTeleopEnable(conn, true);
  await programOpen(conn, 'v2_calib_verify_y_home.ngc');
  await new Promise(r => setTimeout(r, 1000));
  await cycleStart(conn);
  await waitForInterpreterIdle(1000);
  await programOpen(conn, 'v2_calib_characterize_y.ngc')
  await new Promise(r => setTimeout(r, 1000));
  await cycleStart(conn)
}
async function runCharacterizeZ(conn){
  console.log('runCharacterizeZ');
  await performTeleopEnable(conn, true);
  await new Promise(r => setTimeout(r, 1000));
  await performMdiCmd(conn, "G0 X0" );
  for(let idx = 0; idx < 5; idx++){
    await waitForExecStateDone();
    await programOpen(conn, 'v2_calib_probe_z_home.ngc');
    await new Promise(r => setTimeout(r, 1000));
    await waitForExecStateDone(1000);
    if(![STATE_RUN, STATE_STEP].includes(actualState)){
      return;
    }
    await performMdiCmd(conn, "G0 Z3.5");
    await waitForExecStateDone(1000);
    await performHomeAxis(conn, [2]);
    await waitForExecStateDone(1000);
  }
  await new Promise(r => setTimeout(r, 1000));
  await performTeleopEnable(conn, true);
  await programOpen(conn, 'v2_calib_verify_z_home.ngc');
  await new Promise(r => setTimeout(r, 1000));
  await cycleStart(conn);
  await waitForInterpreterIdle(1000);
  await programOpen(conn, 'v2_calib_characterize_z.ngc')
  await new Promise(r => setTimeout(r, 2000));
  await cycleStart(conn)
}
async function runProbeTopPlane(conn){
  console.log('runProbeTopPlane');
  await programOpen(conn, 'v2_calib_probe_top_plane.ngc')
  await new Promise(r => setTimeout(r, 2000));
  await cycleStart(conn)
}
async function runSetupCncCsy(conn){
  console.log('runSetupCncCsy');
  await programOpen(conn, 'v2_calib_setup_cnc_csy.ngc')
  await new Promise(r => setTimeout(r, 2000));
  await cycleStart(conn)
}
async function runCharacterizeA(conn){
  console.log('runCharacterizeA');
  await programOpen(conn, 'v2_calib_characterize_a.ngc')
  await new Promise(r => setTimeout(r, 2000));
  await cycleStart(conn)
}
async function runCharacterizeB(conn){
  console.log('runCharacterizeB');
  await programOpen(conn, 'v2_calib_characterize_b.ngc')
  await new Promise(r => setTimeout(r, 2000));
  await cycleStart(conn)
}
async function runWriteResults(conn){
  console.log('runWriteResults');
  await programOpen(conn, 'v2_calib_write_results.ngc')
  await cycleStart(conn)
}
async function runRestartCnc(conn){
  console.log('runRestartCnc');
  await restartServices(conn)
  await new Promise(r => setTimeout(r, 3000));
  rockhopperConnected = false;
  while(!rockhopperConnected){
    await new Promise(r => setTimeout(r, 1000));
    console.log('still waiting for rockhopper')
  }
  console.log('rockhopper restarted');
  calibStatus.stages.verify['RESTART_CNC'].completed = true;
  console.log(calibStatus.stages.verify);
  if(commandedState == STATE_RUN){
    runCalib()
  }
}
async function runHomingX(conn){
  console.log('runHomingX');
  for (let i = 0; i < 5; i++){
    await performMdiCmd(conn, "G0 X2.5");
    await waitForExecStateDone();
    await performHomeAxis(conn, [0]);
    await waitForExecStateDone();
    await programOpen(conn, 'v2_calib_probe_x_pos.ngc')
    await new Promise(r => setTimeout(r, 1000));
    await cycleStart(conn)
  }
}
async function runSetupVerify(conn){
  console.log('runSetupVerify');
  await programOpen(conn, 'v2_calib_setup_verify.ngc')
  await new Promise(r => setTimeout(r, 2000));
  await cycleStart(conn)
}
async function runVerifyA(conn){
  console.log('runVerifyA');
  await programOpen(conn, 'v2_calib_verify_a.ngc')
  await new Promise(r => setTimeout(r, 2000));
  await cycleStart(conn)
}
async function runVerifyB(conn){
  console.log('runVerifyB');
  await programOpen(conn, 'v2_calib_verify_b.ngc')
  await new Promise(r => setTimeout(r, 2000));
  await cycleStart(conn)
}
async function runWriteVerifyReport(conn){
  console.log('runWriteVerifyReport');
  await programOpen(conn, 'v2_calib_write_verify_report.ngc')
  await new Promise(r => setTimeout(r, 2000));
  await cycleStart(conn)
}

// const STAGE_METHODS = {}
// Object.keys(STAGES).forEach(stage => {
//   const camelName = camelize(stage);
//   const capsCamelName = camelName.charAt(0).toUpperCase() + camelName.slice(1);
//   console.log(capsCamelName)
//   STAGE_METHODS[stage] = this['run' + capsCamelName];
// })
// console.log(STAGE_METHODS)

const STAGE_METHODS = {
  'ERASE_COMPENSATION': runEraseCompensation,
  'SETUP_CNC': runSetupCnc,
  'SETUP_CMM': runSetupCmm,
  'PROBE_MACHINE_POS': runProbeMachinePos,
  'SETUP_PART_CSY': runSetupPartCsy,
  'PROBE_SPINDLE_POS': runProbeSpindlePos,
  'CHARACTERIZE_X': runCharacterizeX,
  'CHARACTERIZE_Y': runCharacterizeY,
  'CHARACTERIZE_Z': runCharacterizeZ,
  'PROBE_TOP_PLANE': runProbeTopPlane,
  'SETUP_CNC_CSY':runSetupCncCsy,
  'CHARACTERIZE_A': runCharacterizeA,
  'CHARACTERIZE_B': runCharacterizeB,
  'WRITE_RESULTS': runWriteResults,
  'RESTART_CNC': runRestartCnc,
  'SETUP_VERIFY': runSetupVerify,
  'VERIFY_A': runVerifyA,
  'VERIFY_B': runVerifyB,
  'WRITE_VERIFY_REPORT': runWriteVerifyReport,
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


async function cmdSetProcess(processName) {
  console.log(processName)
  if(!calibStatus.begun && [PROCESS_NEW, PROCESS_RESUME, PROCESS_VERIFY].includes(processName)){
    console.log(processName)
    calibStatus.selectedProcess = processName;
  }
}
async function cmdRun() {
  await setCommandedState(STATE_RUN);
  if(actualState !== STATE_RUN){
    await runCalib();
  }
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


const commands = {
  getServiceStatus,

  getCalibStatus,

  loadCalibProgress,
  runStep,

  cmdSetProcess,
  cmdRun,
  cmdStep,
  cmdPause,
  cmdStop,
};



/*-----------------------------------------------------------------------------*
                                  UI WebSocket                                  
 *-----------------------------------------------------------------------------*/
var uiConnection;
const wss = new WebSocketServer({ port: 8081 });

wss.on('connection', function connection(ws) {
  uiConnection = ws;
  ws.on('message', async function incoming(data) {
    let msg;
    try {
      msg = JSON.parse(data);
      console.log("Message from UI");
      console.log(msg);
      if(Array.isArray(msg)) {
        if(msg.length <= 0 || !commands[msg[0]]) {
          throw "Unknown command from UI.";
        }
      } else {
        throw "Command from UI must be an array.";
      }
    } catch(e) {
      ws.send(JSON.stringify({ error: "" + e }));
      return;
    }
    try {
      const data = await commands[msg[0]].apply(null, msg.slice(1));
      // console.log(data)
      ws.send(JSON.stringify({ [msg[0]]: data }));

    } catch(e) {
      console.log('error running UI command')
      console.log(e)
      ws.send(JSON.stringify({ [msg[0]]: { error: "" + (e.stderr || e) }}));
    }
  });
});



/*-----------------------------------------------------------------------------*
                              Rockhopper WebSocket                              
 *-----------------------------------------------------------------------------*/
var rockhopperConnection;
var rockhopperClient = new WebSocketClient();
var intervalConnectRockhopper = false;
var rockhopperConnected = false;

async function connectRockhopper() {
  rockhopperConnected = false;
  rockhopperClient.connect('ws://localhost:8000/websocket/');
}

function runIntervalConnectRockhopper() {
  if(intervalConnectRockhopper !== false) { return }
  intervalConnectRockhopper = setInterval(connectRockhopper, 3000)
}

function stopIntervalConnectRockhopper() {
  if(intervalConnectRockhopper === false) return
  clearInterval(intervalConnectRockhopper)
  intervalConnectRockhopper = false
}

rockhopperClient.on('connectFailed', function(error) {
  rockhopperConnected = false;
  runIntervalConnectRockhopper();
  console.log('Rockhopper Connect Error: ' + error.toString());
});


rockhopperClient.on('connect', function(connection) {
  rockhopperConnected = true;
  stopIntervalConnectRockhopper();
  console.log('Rockhopper Connection established!');
  connection.send(JSON.stringify({id: "LOGIN_ID", user: "default", password: 'default', date: new Date(),}));
  connection.send(JSON.stringify({id: "WATCH_INTERP_STATE", name: "interp_state", command:"watch"}));
  connection.send(JSON.stringify({id: "WATCH_STATE", name: "state", command:"watch"}));
  connection.send(JSON.stringify({id: "WATCH_HOMED", name: "homed", command:"watch"}));

  rockhopperConnection = connection;

  connection.on('error', function(error) {
    rockhopperConnected = false;
    runIntervalConnectRockhopper();
    console.log("Rockhopper Connection error: " + error.toString());
  });
  
  connection.on('close', function() {
    rockhopperConnected = false;
    runIntervalConnectRockhopper();
    console.log('Rockhopper Connection closed!');
  });
  
  connection.on('message', function(message) {
    rockhopperMessage = JSON.parse(message.utf8Data);
    console.log(rockhopperMessage);

    if(rockhopperMessage.id === 'WATCH_INTERP_STATE'){
      //EMC_TASK_INTERP_IDLE = 1,EMC_TASK_INTERP_READING = 2,EMC_TASK_INTERP_PAUSED = 3,EMC_TASK_INTERP_WAITING = 4
      var interpStateVal = rockhopperMessage.data;
      console.log('WATCH_INTERP_STATE ' + interpStateVal)
      switch(interpStateVal){
        case(1):
          interpIdle = true;
          break;
        default:
          interpIdle = false;
          break;
      }
    }
    else if(rockhopperMessage.id === 'WATCH_STATE'){
      var execStateVal = rockhopperMessage.data;
      console.log('WATCH_STATE ' + execStateVal)
      switch(execStateVal){
        case(1):
          execStateDone = true;
          break;
        default:
          execStateDone = false;
          break;
      }
    }
    else if(rockhopperMessage.id === 'WATCH_HOMED'){
      //EMC_TASK_INTERP_IDLE = 1,EMC_TASK_INTERP_READING = 2,EMC_TASK_INTERP_PAUSED = 3,EMC_TASK_INTERP_WAITING = 4

      var homedData = rockhopperMessage.data;
      var axesHomed = 0;
      for(let idx = 0; idx < 6; idx++){
        axesHomed += homedData[idx];
      }
      if(axesHomed === 5){
        homed = true;
      }
      else { homed = false; }
    }
  });
});

connectRockhopper();



/*-----------------------------------------------------------------------------*
                              CalibManager ZMQ                              
 *-----------------------------------------------------------------------------*/
var calibConnection;
var calibSocket = zmq.socket("pull");

var intervalConnectCalib = false;

async function connectCalib() {
  console.log('attempting connect calib')
  calibSocket.connect('ipc:///tmp/cmm');
}

function runIntervalConnectCalib() {
  if(intervalConnectCalib !== false) { return; }
  intervalConnectCalib = setInterval(connectCalib, 3000)
}

function stopIntervalConnectCalib() {
  if(intervalConnectCalib === false) { return; }
  clearInterval(intervalConnectCalib);
  intervalConnectCalib = false;
}

calibSocket.on('connectFailed', function(error) {
  runIntervalConnectCalib();
  console.log('Calib Connect Error: ' + error.toString());
});

calibSocket.on('connect', function(connection) {
  stopIntervalConnectCalib();
  console.log('Calib Connection established!');
});


calibSocket.on("message", async function(msg) {
  console.log("Received ZMQ msg from Calib manager: %s", msg.toString());
  var calibManagerReport = JSON.parse(msg);
  
  const data = await getCalibStatus();
  if(uiConnection){
    uiConnection.send(JSON.stringify({ ['getCalibStatus']: data }));
  }

  

  if(calibManagerReport.why === MSG_WHY_STEP_COMPLETE){
    if(calibManagerReport.stage_completed){
      calibStatus.stages[calibStatus.currentMode][calibManagerReport.stage].completed = true;
    }
    if(calibManagerReport.state == STATE_IDLE){
      if(commandedState === STATE_RUN){
        await runCalib();
      }
      else if(commandedState === STATE_STEP){
        actualState = STATE_IDLE
      }
    }
    else{
      console.log('step completed but not advancing because not idle');
    }
  }
  else if(calibManagerReport.why === MSG_WHY_UPDATE){

  }
  else if(calibManagerReport.why === MSG_WHY_ERROR){
    calibStatus.stages[calibStatus.currentMode][calibStatus.currentStage].error = true;
    actualState = STATE_ERROR
  }
  else if(calibManagerReport.why === MSG_WHY_FAIL){
    calibStatus.stages[calibStatus.currentMode][calibStatus.currentStage].error = true;
    actualState = STATE_FAIL
  }

});

connectCalib();

// calibManagerSocket.connect("tcp://127.0.0.1:5555");
// console.log("calibManagerSocket connected to port 5555");

// calibManagerSocket.on("message", async function(msg) {
//   console.log("Received ZMQ msg from Calib manager: %s", msg.toString());
//   var calibManagerStatus = JSON.parse(msg);
//   calibStatus.stages = calibManagerStatus.stages;
//   calibStatus.status = calibManagerStatus.status;

//   actualState = calibManagerStatus.state;

//   if(calibManagerStatus.why === MSG_WHY_STEP_COMPLETE){
//     if(commandedState === STATE_RUN && actualState == STATE_IDLE){
//       await runCalib();
//     }
//   }
//   else if(calibManagerStatus.why === MSG_WHY_UPDATE){

//   }
//   else if(calibManagerStatus.why === MSG_WHY_ERROR){

//   }

// });
