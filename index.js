// Log to file and to stdout
//
const logFile = fs.createWriteStream('/var/log/penta/calib-service.log', { flags: 'a' });
const logStdout = process.stdout;

console.log = function() {
  logFile.write(util.format.apply(null, arguments) + "\n");
  logStdout.write(util.format.apply(null, arguments) + "\n");
}
console.error = console.log;

const util = require("util");
const { exec } = require("child_process");
const execPromise = util.promisify(exec);
const fs = require('fs');


var process_type = null;
process.argv.forEach(function (val, index, array) {
  console.log(index + ': ' + val);
  if(index === 2){
    process_type = val;
  }
});

/*
WebSocketServer for communication with UI
WebSocketClient for communication with Rockhopper
ZeroMQ for communication with Calibration process
*/


console.log("starting with process type " + process_type);
var calibProcess = new CalibProcess(process_type);
calibProcess.stages.calib[STAGES.ERASE_COMPENSATION].completed = true
// calibProcess.stages.calib[STAGES.SETUP_CNC].completed = true
// calibProcess.stages.calib[STAGES.SETUP_CMM].completed = true
// calibProcess.stages.calib[STAGES.PROBE_MACHINE_POS].completed = true
// calibProcess.stages.calib[STAGES.SETUP_PART_CSY].completed = true
// calibProcess.stages.calib[STAGES.PROBE_SPINDLE_POS].completed = true
// calibProcess.stages.calib[STAGES.CHARACTERIZE_X].completed = true
// calibProcess.stages.calib[STAGES.CHARACTERIZE_Z].completed = true
// calibProcess.stages.calib[STAGES.PROBE_TOP_PLANE].completed = true
// calibProcess.stages.calib[STAGES.PROBE_FIXTURE_BALL_POS].completed = true
// calibProcess.stages.calib[STAGES.CHARACTERIZE_Y].completed = true
// calibProcess.stages.calib[STAGES.SETUP_CNC_CSY].completed = true
// calibProcess.stages.calib[STAGES.CHARACTERIZE_A].completed = true
// calibProcess.stages.calib[STAGES.CHARACTERIZE_B].completed = true
// calibProcess.stages.calib[STAGES.CALC_CALIB].completed = true
// calibProcess.stages.calib[STAGES.WRITE_CALIB].completed = true

// calibProcess.stages.verify[STAGES.RESTART_CNC].completed = true
// calibProcess.stages.verify[STAGES.SETUP_CNC].completed = true
// calibProcess.stages.verify[STAGES.SETUP_CMM].completed = true
// calibProcess.stages.verify[STAGES.SETUP_VERIFY].completed = true
// calibProcess.stages.verify[STAGES.VERIFY_A].completed = true
// calibProcess.stages.verify[STAGES.VERIFY_B].completed = true
// calibProcess.stages.verify[STAGES.CALC_VERIFY].completed = true

var lastCmmPing = 0;
var lastCmmPingSuccesful = false;
var prevCmmPingSuccesful = false;
var interpIdle = false;
var homed = false;

var compensationCleared = false;
var calibStatus = {
  begun: false,
  processType: null,
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
  currentStep: null,
  currentStage: null,
}
// calibStatus.stages.calib[STAGES.ERASE_COMPENSATION].completed = true
// calibStatus.stages.calib[STAGES.SETUP_CNC].completed = true
// calibStatus.stages.calib[STAGES.SETUP_CMM].completed = true
// calibStatus.stages.calib[STAGES.PROBE_MACHINE_POS].completed = true
// calibStatus.stages.calib[STAGES.SETUP_PART_CSY].completed = true
// calibStatus.stages.calib[STAGES.PROBE_SPINDLE_POS].completed = true
// calibStatus.stages.calib[STAGES.CHARACTERIZE_X].completed = true
// calibStatus.stages.calib[STAGES.CHARACTERIZE_Y].completed = true
// calibStatus.stages.calib[STAGES.CHARACTERIZE_Z].completed = true
// calibStatus.stages.calib[STAGES.PROBE_TOP_PLANE].completed = true
// calibStatus.stages.calib[STAGES.SETUP_CNC_CSY].completed = true
// calibStatus.stages.calib[STAGES.CHARACTERIZE_A].completed = true
// calibStatus.stages.calib[STAGES.CHARACTERIZE_B].completed = true


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
      calibProcess.cmmConnected = true;
    } catch(e) {
      // console.log(e)

      calibProcess.cmmConnected = false;
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



function checkSaveFileExists(stage) {
  filename = CALIB_DIR + "/Stages." + stage.toUpperCase();
  if (fs.existsSync(filename)) {
    return true;
  }
  else {
    return false;
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

function readCompensationFiles() {
  var aData = fs.readFileSync(A_COMP_PATH, 'ascii');
  var bData = fs.readFileSync(B_COMP_PATH, 'ascii');
  return {a: aData, b: bData};
}
function clearCompensationFiles() {
  fs.writeFileSync(A_COMP_PATH, "");
  fs.writeFileSync(B_COMP_PATH, "");
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
// async function runEraseCompensation(conn){
//   console.log('runEraseCompensation');
//   var comps = await readCompensationFiles();
//   if(comps.a.length > 2 || comps.b.length > 2 ){
//     await clearCompensationFiles();
//     await rockhopperClient.restartServices(conn)
//     await new Promise(r => setTimeout(r, 3000));
//     rockhopperConnected = false;
//     while(!rockhopperConnected){
//       await new Promise(r => setTimeout(r, 1000));
//       console.log('still waiting for rockhopper')
//     }
//     console.log('rockhopper restarted');
//   }
//   else{
//     console.log('Compensation already cleared');
//   }
//   calibProcess.stages.calib['ERASE_COMPENSATION'].completed = true;
//   if(commandedState == STATE_RUN){
//     runCalib()
//   }
// }
// async function runSetupCnc(conn){
//   console.log('runSetupCnc');
//   await rockhopperClient.estopCmdAsync(false);
//   await new Promise(r => setTimeout(r, 1000));
//   if(!rockhopperClient.state.homed){
//     await rockhopperClient.homeAxisAsync();
//   }
//   console.log(calibProcess.currentLevel)
//   if(calibProcess.currentLevel === LEVEL_CALIB){
//     calibProcess.stages.calib['SETUP_CNC'].completed = true;
//   }
//   else if(calibProcess.currentLevel === LEVEL_VERIFY){
//     calibProcess.stages.verify['SETUP_CNC'].completed = true;
//   }
//   if(commandedState == STATE_RUN){
//     runCalib()
//   }
// }
// async function runSetupCmm(){
//   console.log('runSetupCmm');
//   await rockhopperClient.programOpenCmd('v2_calib_setup_cmm.ngc');
//   await new Promise(r => setTimeout(r, 2000));
//   await rockhopperClient.cycleStart();
// }
// async function runProbeMachinePos(){
//   console.log('runProbeMachinePos');
//   await rockhopperClient.programOpenCmd('v2_calib_probe_machine_pos.ngc')
//   await new Promise(r => setTimeout(r, 2000));
//   await rockhopperClient.cycleStart()
// }
// async function runSetupPartCsy(){
//   console.log('runSetupPartCsy');
//   await rockhopperClient.programOpenCmd('v2_calib_setup_part_csy.ngc')
//   await new Promise(r => setTimeout(r, 2000));
//   await rockhopperClient.cycleStart()
// }
// async function runProbeSpindlePos(){
//   console.log('runProbeSpindlePos');
//   await rockhopperClient.programOpenCmd('v2_calib_probe_spindle_pos.ngc')
//   await new Promise(r => setTimeout(r, 2000));
//   await rockhopperClient.cycleStart()
// }
// async function runProbeFixtureBallPos(){
//   console.log('runProbeFixtureBallPos');
//   await rockhopperClient.programOpenCmd('v2_calib_probe_fixture_ball_pos.ngc')
//   await new Promise(r => setTimeout(r, 2000));
//   await rockhopperClient.cycleStart()
// }
// async function runCharacterizeX(){
//   console.log('runCharacterizeX');
//   for(let idx = 0; idx < 5; idx++){
//     await rockhopperClient.mdiCmdAsync("G0 X60");
//     await rockhopperClient.unhomeAxisAsync([0]);
//     await rockhopperClient.homeAxisAsync([0]);
//     await rockhopperClient.programOpenCmd('v2_calib_probe_x_home.ngc')
//     await new Promise(r => setTimeout(r, 1000));
//     await rockhopperClient.cycleStart();
//     await rockhopperClient.waitForDoneAndIdle(1000);

//     if(![STATE_RUN, STATE_STEP].includes(actualState)){
//       return;
//     }
//   }

//   await rockhopperClient.programOpenCmd('v2_calib_verify_x_home.ngc');
//   await new Promise(r => setTimeout(r, 1000));
//   await rockhopperClient.cycleStart();
//   await rockhopperClient.waitForDoneAndIdle(1000);
//   if(![STATE_RUN, STATE_STEP].includes(actualState)){
//     return;
//   }
//   await new Promise(r => setTimeout(r, 1000));
//   await rockhopperClient.programOpenCmd('v2_calib_characterize_x.ngc');
//   await new Promise(r => setTimeout(r, 1000));
//   await rockhopperClient.cycleStart();
// }
// async function runCharacterizeY(conn){
//   console.log('runCharacterizeY');
//   // await performMdiCmd(conn, "o<cmm_go_to_clearance_z> call" );
//   await rockhopperClient.mdiCmdAsync("o<cmm_go_to_clearance_z> call");
//   await new Promise(r => setTimeout(r, 3000));
//   for(let idx = 0; idx < 5; idx++){
//     await rockhopperClient.programOpenCmd('v2_calib_probe_y_home.ngc');
//     await new Promise(r => setTimeout(r, 1000));
//     await rockhopperClient.cycleStart();
//     await rockhopperClient.waitForDoneAndIdle(1000);
//     if(![STATE_RUN, STATE_STEP].includes(actualState)){
//       return;
//     }

//     // await performTeleopEnable(conn, true);
//     await rockhopperClient.mdiCmdAsync("G0 Y60");
//     await rockhopperClient.waitForDoneAndIdle(1000);
//     await rockhopperClient.unhomeAxisAsync([1]);
//     await rockhopperClient.homeAxisAsync([1]);
//   }
//   await new Promise(r => setTimeout(r, 1000));
//   // await performTeleopEnable(conn, true);
//   // await new Promise(r => setTimeout(r, 1000));
//   await rockhopperClient.programOpenCmd('v2_calib_verify_y_home.ngc');
//   await new Promise(r => setTimeout(r, 1000));
//   await rockhopperClient.cycleStart();
//   await rockhopperClient.waitForDoneAndIdle(1000);
//   if(![STATE_RUN, STATE_STEP].includes(actualState)){
//     return;
//   }
//   await new Promise(r => setTimeout(r, 1000));
//   await rockhopperClient.programOpenCmd('v2_calib_characterize_y.ngc');
//   await new Promise(r => setTimeout(r, 1000));
//   await rockhopperClient.cycleStart();

//   // await programOpen(conn, 'v2_calib_verify_y_home.ngc');
//   // await new Promise(r => setTimeout(r, 1000));
//   // await cycleStart(conn);
//   // await waitForInterpreterIdle(1000);
//   // await programOpen(conn, 'v2_calib_characterize_y.ngc')
//   // await new Promise(r => setTimeout(r, 1000));
//   // await cycleStart(conn)
// }
// async function runCharacterizeZ(conn){
//   console.log('runCharacterizeZ');
//   // await performTeleopEnable(conn, true);
//   // await new Promise(r => setTimeout(r, 1000));
//   await rockhopperClient.mdiCmdAsync("G0 X0");
//   for(let idx = 0; idx < 5; idx++){

//     await rockhopperClient.programOpenCmd('v2_calib_probe_z_home.ngc')
//     await new Promise(r => setTimeout(r, 1000));
//     await rockhopperClient.cycleStart();
//     await rockhopperClient.waitForDoneAndIdle(1000);


//     // await waitForDoneAndIdle(1000);
//     // await programOpen(conn, 'v2_calib_probe_z_home.ngc');
//     // await new Promise(r => setTimeout(r, 1000));
//     // await cycleStart(conn);
//     // await waitForDoneAndIdle(1000);
//     if(![STATE_RUN, STATE_STEP].includes(actualState)){
//       return;
//     }
//     if(idx < 4){
//       await rockhopperClient.mdiCmdAsync("G0 Z-3.5");
//       await rockhopperClient.unhomeAxisAsync([2]);
//       await rockhopperClient.homeAxisAsync([2]);

//       // await performMdiCmd(conn, "G0 Z-3.5");
//       // await waitForDoneAndIdle(1000);
//       // await performUnhomeAxis(conn, 2);
//       // await waitForUnhomed(1000);
//       // await performHomeAxis(conn, [2]);
//       // await waitForHomed(1000);
//     }
//   }
//   await new Promise(r => setTimeout(r, 1000));
//   // await performTeleopEnable(conn, true);
//   await rockhopperClient.programOpenCmd('v2_calib_verify_z_home.ngc');
//   // await programOpen(conn, 'v2_calib_verify_z_home.ngc');
//   await new Promise(r => setTimeout(r, 1000));
//   await rockhopperClient.cycleStart();
//   await rockhopperClient.waitForDoneAndIdle(1000);
//   await new Promise(r => setTimeout(r, 1000));
//   if(![STATE_RUN, STATE_STEP].includes(actualState)){
//     return;
//   }
//   await rockhopperClient.programOpenCmd('v2_calib_characterize_z.ngc');
//   await new Promise(r => setTimeout(r, 1000));
//   await rockhopperClient.cycleStart();
// }
// async function runProbeTopPlane(conn){
//   console.log('runProbeTopPlane');
//   await rockhopperClient.programOpenCmd('v2_calib_probe_top_plane.ngc');
//   await new Promise(r => setTimeout(r, 2000));
//   await rockhopperClient.cycleStart();
// }
// async function runSetupCncCsy(conn){
//   console.log('runSetupCncCsy');
//   await rockhopperClient.programOpenCmd('v2_calib_setup_cnc_csy.ngc');
//   await new Promise(r => setTimeout(r, 2000));
//   await rockhopperClient.cycleStart();
// }
// async function runCharacterizeA(conn){
//   console.log('runCharacterizeA');
//   await rockhopperClient.mdiCmdAsync(`G0 Y${Y_POS_PROBING}`);
//   for(let idx = 0; idx < 5; idx++){
//     await rockhopperClient.programOpenCmd('v2_calib_probe_a_home.ngc')
//     await new Promise(r => setTimeout(r, 1000));
//     await rockhopperClient.cycleStart();
//     await rockhopperClient.waitForDoneAndIdle(1000);

//     if(![STATE_RUN, STATE_STEP].includes(actualState)){
//       return;
//     }
//     if(idx < 4){
//       await rockhopperClient.mdiCmdAsync("G0 A-10");
//       await rockhopperClient.unhomeAxisAsync([3]);
//       await rockhopperClient.homeAxisAsync([3]);
//     }
//   }
//   await new Promise(r => setTimeout(r, 1000));
//   await rockhopperClient.programOpenCmd('v2_calib_verify_a_home.ngc');
//   await rockhopperClient.cycleStart();
//   await rockhopperClient.waitForDoneAndIdle(1000);
//   await new Promise(r => setTimeout(r, 1000));
//   if(![STATE_RUN, STATE_STEP].includes(actualState)){
//     return;
//   }
//   await rockhopperClient.programOpenCmd('v2_calib_characterize_a.ngc');
//   await rockhopperClient.cycleStart();
// }
// async function runCharacterizeB(conn){
//   console.log('runCharacterizeB');
//   await rockhopperClient.mdiCmdAsync(`G0 Y${Y_POS_PROBING}`);

//   for(let idx = 0; idx < 5; idx++){
//     await rockhopperClient.programOpenCmd('v2_calib_probe_b_home.ngc')
//     await new Promise(r => setTimeout(r, 1000));
//     await rockhopperClient.cycleStart();
//     await rockhopperClient.waitForDoneAndIdle(1000);
//     if(![STATE_RUN, STATE_STEP].includes(actualState)){
//       return;
//     }
//     if(idx < 4){
//       await rockhopperClient.mdiCmdAsync("G0 B-10");
//       await rockhopperClient.unhomeAxisAsync([4]);
//       await rockhopperClient.homeAxisAsync([4]);
//     }
//   }
//   await new Promise(r => setTimeout(r, 1000));
//   await rockhopperClient.programOpenCmd('v2_calib_verify_b_home.ngc');
//   await rockhopperClient.cycleStart();
//   await rockhopperClient.waitForDoneAndIdle(1000);
//   await new Promise(r => setTimeout(r, 1000));
//   if(![STATE_RUN, STATE_STEP].includes(actualState)){
//     return;
//   }
//   await rockhopperClient.programOpenCmd('v2_calib_characterize_b.ngc');
//   await new Promise(r => setTimeout(r, 1000));
//   await rockhopperClient.cycleStart();
// }
// async function runCalcCalib(conn){
//   console.log('runCalcCalib');
//   await rockhopperClient.programOpenCmd('v2_calib_calc_calib.ngc');
//   await new Promise(r => setTimeout(r, 1000));
//   await rockhopperClient.cycleStart();
// }
// async function runWriteCalib(conn){
//   console.log('runWriteCalib');
//   await rockhopperClient.programOpenCmd('v2_calib_write_calib.ngc');
//   await new Promise(r => setTimeout(r, 1000));
//   await rockhopperClient.cycleStart();
// }
// async function runRestartCnc(conn){
//   console.log('runRestartCnc');
//   await rockhopperClient.restartServices(conn)
//   await new Promise(r => setTimeout(r, 3000));
//   rockhopperConnected = false;
//   while(!rockhopperConnected){
//     await new Promise(r => setTimeout(r, 1000));
//     console.log('still waiting for rockhopper')
//   }
//   console.log('rockhopper restarted');
//   calibProcess.stages.verify['RESTART_CNC'].completed = true;
//   console.log(calibProcess.stages.verify);
//   if(commandedState == STATE_RUN){
//     runCalib()
//   }
// }
// async function runHomingX(conn){
//   console.log('runHomingX');
//   for (let i = 0; i < 5; i++){
//     await performMdiCmd(conn, "G0 X2.5");
//     await waitForExecStateDone();
//     await performHomeAxis(conn, [0]);
//     await waitForExecStateDone();
//     await programOpen(conn, 'v2_calib_probe_x_pos.ngc')
//     await new Promise(r => setTimeout(r, 1000));
//     await cycleStart(conn)
//   }
// }
// async function runSetupVerify(conn){
//   console.log('runSetupVerify');
//   await rockhopperClient.programOpenCmd('v2_calib_setup_verify.ngc');
//   await new Promise(r => setTimeout(r, 1000));
//   await rockhopperClient.cycleStart();
// }
// async function runVerifyAHoming(conn){
//   console.log('runVerifyAHoming');
//   await rockhopperClient.mdiCmdAsync(`G0 Y${Y_POS_PROBING}`);
//   for(let idx = 0; idx < 5; idx++){
//     await rockhopperClient.programOpenCmd('v2_calib_probe_a_home.ngc')
//     await new Promise(r => setTimeout(r, 1000));
//     await rockhopperClient.cycleStart();
//     await rockhopperClient.waitForDoneAndIdle(1000);

//     if(![STATE_RUN, STATE_STEP].includes(actualState)){
//       return;
//     }
//     if(idx < 4){
//       await rockhopperClient.mdiCmdAsync("G0 A-10");
//       await rockhopperClient.unhomeAxisAsync([3]);
//       await rockhopperClient.homeAxisAsync([3]);
//     }
//   }
//   await new Promise(r => setTimeout(r, 1000));
//   await rockhopperClient.programOpenCmd('v2_calib_verify_a_homing.ngc');
//   await rockhopperClient.cycleStart();
// }
// async function runVerifyA(conn){
//   console.log('runVerifyA');
//   await rockhopperClient.mdiCmdAsync(`G0 Y${Y_POS_PROBING}`);
//   await new Promise(r => setTimeout(r, 1000));
//   await rockhopperClient.programOpenCmd('v2_calib_probe_a_home.ngc')
//   await new Promise(r => setTimeout(r, 1000));
//   await rockhopperClient.cycleStart();
//   await rockhopperClient.waitForDoneAndIdle(1000);
//   var homingAttemptsCount = 0;
//   while(Math.abs(calibProcess.aHomeErr) > 0.01){
//     if(![STATE_RUN, STATE_STEP].includes(actualState)){
//       return;
//     }
//     console.log(calibProcess.aHomeErr);
//     homingAttemptsCount++;
//     await rockhopperClient.mdiCmdAsync("G0 A-10");
//     await rockhopperClient.unhomeAxisAsync([3]);
//     await rockhopperClient.homeAxisAsync([3]);
    
//     await rockhopperClient.programOpenCmd('v2_calib_probe_a_home.ngc')
//     await new Promise(r => setTimeout(r, 1000));
//     await rockhopperClient.cycleStart();
//     await rockhopperClient.waitForDoneAndIdle(1000);
//   }
//   console.log(Math.abs(calibProcess.aHomeErr))
//   await rockhopperClient.programOpenCmd('v2_calib_verify_a.ngc');
//   await new Promise(r => setTimeout(r, 1000));
//   await rockhopperClient.cycleStart();
// }
// async function runVerifyBHoming(conn){
//   console.log('runVerifyBHoming');
//   await rockhopperClient.mdiCmdAsync(`G0 Y${Y_POS_PROBING}`);
//   for(let idx = 0; idx < 5; idx++){
//     await rockhopperClient.programOpenCmd('v2_calib_probe_b_home.ngc')
//     await new Promise(r => setTimeout(r, 1000));
//     await rockhopperClient.cycleStart();
//     await rockhopperClient.waitForDoneAndIdle(1000);

//     if(![STATE_RUN, STATE_STEP].includes(actualState)){
//       return;
//     }
//     if(idx < 4){
//       await rockhopperClient.mdiCmdAsync("G0 B-10");
//       await rockhopperClient.unhomeAxisAsync([4]);
//       await rockhopperClient.homeAxisAsync([4]);
//     }
//   }
//   await new Promise(r => setTimeout(r, 1000));
//   await rockhopperClient.programOpenCmd('v2_calib_verify_b_homing.ngc');
//   await rockhopperClient.cycleStart();
// }
// async function runVerifyB(conn){
//   console.log('runVerifyB');
//   await rockhopperClient.mdiCmdAsync(`G0 Y${Y_POS_PROBING}A0`);
//   await new Promise(r => setTimeout(r, 1000));
//   var homingAttemptsCount = 0;
//   while(true){
//     await rockhopperClient.programOpenCmd('v2_calib_probe_b_home.ngc')
//     await new Promise(r => setTimeout(r, 1000));
//     await rockhopperClient.cycleStart();
//     await rockhopperClient.waitForDoneAndIdle(1000);
//     if(![STATE_RUN, STATE_STEP].includes(actualState)){
//       return;
//     }
//     console.log(calibProcess.bHomeErr);
//     if(Math.abs(calibProcess.bHomeErr) < 0.01){
//       break;
//     }
//     homingAttemptsCount++;
//     await rockhopperClient.mdiCmdAsync("G0 B-10");
//     await rockhopperClient.unhomeAxisAsync([4]);
//     await rockhopperClient.homeAxisAsync([4]);
//   }
//   console.log(Math.abs(calibProcess.bHomeErr))

//   await rockhopperClient.programOpenCmd('v2_calib_verify_b.ngc');
//   await new Promise(r => setTimeout(r, 1000));
//   await rockhopperClient.cycleStart();
// }
// async function runCalcVerify(conn){
//   console.log('runCalcVerify');
//   await rockhopperClient.programOpenCmd('v2_calib_calc_verify.ngc');
//   await new Promise(r => setTimeout(r, 1000));
//   await rockhopperClient.cycleStart();
// }
// async function runWriteVerify(conn){
//   console.log('runWriteVerify');
//   await rockhopperClient.programOpenCmd('v2_calib_write_verify.ngc');
//   await new Promise(r => setTimeout(r, 1000));
//   await rockhopperClient.cycleStart();
// }

// const STAGE_METHODS = {
//   'ERASE_COMPENSATION': runEraseCompensation,
//   'SETUP_CNC': runSetupCnc,
//   'SETUP_CMM': runSetupCmm,
//   'PROBE_MACHINE_POS': runProbeMachinePos,
//   'SETUP_PART_CSY': runSetupPartCsy,
//   'PROBE_SPINDLE_POS': runProbeSpindlePos,
//   'PROBE_FIXTURE_BALL_POS': runProbeFixtureBallPos,
//   'CHARACTERIZE_X': runCharacterizeX,
//   'CHARACTERIZE_Y': runCharacterizeY,
//   'CHARACTERIZE_Z': runCharacterizeZ,
//   'PROBE_TOP_PLANE': runProbeTopPlane,
//   'SETUP_CNC_CSY':runSetupCncCsy,
//   'CHARACTERIZE_A': runCharacterizeA,
//   'CHARACTERIZE_B': runCharacterizeB,
//   'CALC_CALIB': runCalcCalib,
//   'WRITE_CALIB': runWriteCalib,
//   'RESTART_CNC': runRestartCnc,
//   'SETUP_VERIFY': runSetupVerify,
//   'VERIFY_A': runVerifyA,
//   'VERIFY_B': runVerifyB,
//   'CALC_VERIFY': runCalcVerify,
//   'WRITE_VERIFY': runWriteVerify,
//   [STAGES.VERIFY_A_HOMING]: runVerifyAHoming,
//   [STAGES.VERIFY_B_HOMING]: runVerifyBHoming,
// }

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
  // calibProcess.stages.calib[STAGES.SETUP_CNC].completed = true
  // calibProcess.stages.calib[STAGES.SETUP_CMM].completed = true
  // calibProcess.stages.calib[STAGES.PROBE_MACHINE_POS].completed = true
  // calibProcess.stages.calib[STAGES.SETUP_PART_CSY].completed = true
  // calibProcess.stages.calib[STAGES.PROBE_SPINDLE_POS].completed = true
  // calibProcess.stages.calib[STAGES.CHARACTERIZE_X].completed = true
  // calibProcess.stages.calib[STAGES.CHARACTERIZE_Z].completed = true
  // calibProcess.stages.calib[STAGES.PROBE_TOP_PLANE].completed = true
  // calibProcess.stages.calib[STAGES.PROBE_FIXTURE_BALL_POS].completed = true
  // calibProcess.stages.calib[STAGES.CHARACTERIZE_Y].completed = true
  // calibProcess.stages.calib[STAGES.SETUP_CNC_CSY].completed = true
  // calibProcess.stages.calib[STAGES.CHARACTERIZE_A].completed = true
  // calibProcess.stages.calib[STAGES.CHARACTERIZE_B].completed = true
  // calibProcess.stages.calib[STAGES.CALC_CALIB].completed = true
  // calibProcess.stages.calib[STAGES.WRITE_CALIB].completed = true

  // calibProcess.stages.verify[STAGES.RESTART_CNC].completed = true
  // calibProcess.stages.verify[STAGES.SETUP_CNC].completed = true
  // calibProcess.stages.verify[STAGES.SETUP_CMM].completed = true
  // calibProcess.stages.verify[STAGES.SETUP_VERIFY].completed = true
  // calibProcess.stages.verify[STAGES.VERIFY_A].completed = true
  // calibProcess.stages.verify[STAGES.VERIFY_B].completed = true
}
