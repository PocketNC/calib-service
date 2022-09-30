const util = require("util");
const { exec } = require("child_process");
const execPromise = util.promisify(exec);
const fs = require('fs');
const camelCase = require('to-camel-case');

const POCKETNC_VAR_DIRECTORY = process.env.POCKETNC_VAR_DIRECTORY;
const CALIB_DIR = POCKETNC_VAR_DIRECTORY + "/calib";

const STAGES = {
  ERASE_COMPENSATION: 'ERASE_COMPENSATION',
  SETUP_CNC: 'SETUP_CNC',
  SETUP_CMM: 'SETUP_CMM',
  PROBE_MACHINE_POS: 'PROBE_MACHINE_POS',
  SETUP_PART_CSY: 'SETUP_PART_CSY',
  PROBE_FIXTURE_BALL_POS: 'PROBE_FIXTURE_BALL_POS',
  PROBE_SPINDLE_POS: 'PROBE_SPINDLE_POS',
  HOMING_X: 'HOMING_X',
  HOMING_Y: 'HOMING_Y',
  HOMING_Z: 'HOMING_Z',
  HOMING_A: 'HOMING_A',
  HOMING_B: 'HOMING_B',
  CHARACTERIZE_X: 'CHARACTERIZE_X',
  CHARACTERIZE_Y: 'CHARACTERIZE_Y',
  CHARACTERIZE_Z: 'CHARACTERIZE_Z',
  PROBE_TOP_PLANE: 'PROBE_TOP_PLANE',
  SETUP_CNC_CSY: 'SETUP_CNC_CSY',
  CHARACTERIZE_A: 'CHARACTERIZE_A',
  CHARACTERIZE_B: 'CHARACTERIZE_B',
  CALC_CALIB: 'CALC_CALIB',
  WRITE_CALIB: 'WRITE_CALIB',
  //verification-only stages
  RESTART_CNC: 'RESTART_CNC',
  SETUP_VERIFY: 'SETUP_VERIFY',
  // VERIFY_A_HOMING: 'VERIFY_A_HOMING',
  // VERIFY_B_HOMING: 'VERIFY_B_HOMING',
  VERIFY_A: 'VERIFY_A',
  VERIFY_B: 'VERIFY_B',
  CALC_VERIFY: 'CALC_VERIFY',
  WRITE_VERIFY: 'WRITE_VERIFY'
}

const LOADABLE_STAGE_LIST = [STAGES.PROBE_MACHINE_POS, STAGES.PROBE_SPINDLE_POS,
  STAGES.HOMING_X, STAGES.HOMING_Y, STAGES.HOMING_Z,
  STAGES.CHARACTERIZE_X, STAGES.CHARACTERIZE_Y, STAGES.CHARACTERIZE_Z,
  STAGES.PROBE_TOP_PLANE,
  STAGES.PROBE_FIXTURE_BALL_POS,
  STAGES.HOMING_A, STAGES.HOMING_B,
  STAGES.CHARACTERIZE_A, STAGES.CHARACTERIZE_B,
  STAGES.VERIFY_A, STAGES.VERIFY_B
]
const LOADABLE_STAGES = new Set(LOADABLE_STAGE_LIST)
console.log(LOADABLE_STAGES)

//------CONSTANTS------
//These STATE_ constants are used to set value of CalibProcess.commandedState and CalibProcess.actualState 
const STATE_IDLE = "IDLE" //not yet in progress
const STATE_PAUSE = "PAUSE" //in progress but paused, or attempting to pause as soon as possible
const STATE_RUN = "RUN" //automatically moving to next STAGE
const STATE_STEP = "STEP" //Starting each STAGE requires manual input
const STATE_STOP = "STOP" //User has commanded a termination of the process, process should stop
const STATE_ERROR = "ERROR" //Something has gone wrong, process should stop
const STATE_FAIL = "FAIL" //The machine has failed a spec check, process should stop

const LEVEL_CALIB = "calib"
const LEVEL_VERIFY = "verify"
const MODE_CALIB = "calib"
const MODE_VERIFY = "verify"
const MSG_WHY_STEP_COMPLETE = "STEP_COMPLETE"
const MSG_WHY_UPDATE = "UPDATE"
const MSG_WHY_ERROR = "ERROR"
const MSG_WHY_FAIL = "FAIL"
const PROCESS_NEW = "new"
const PROCESS_RESUME = "resume"
const PROCESS_VERIFY = "verify"


const CALIB_ORDER = [
  STAGES.ERASE_COMPENSATION,
  STAGES.SETUP_CNC,
  STAGES.SETUP_CMM,
  STAGES.PROBE_MACHINE_POS,
  STAGES.SETUP_PART_CSY,
  STAGES.PROBE_SPINDLE_POS,
  STAGES.HOMING_X,
  STAGES.CHARACTERIZE_X, 
  STAGES.HOMING_Z,
  STAGES.CHARACTERIZE_Z, 
  STAGES.PROBE_TOP_PLANE,
  STAGES.PROBE_FIXTURE_BALL_POS,
  STAGES.HOMING_Y,
  STAGES.CHARACTERIZE_Y,
  STAGES.SETUP_CNC_CSY,
  STAGES.HOMING_A,
  STAGES.HOMING_B,
  STAGES.CHARACTERIZE_A, STAGES.CHARACTERIZE_B,
  STAGES.CALC_CALIB,
  STAGES.WRITE_CALIB,
]

const VERIFY_ORDER = [
  STAGES.RESTART_CNC,
  STAGES.SETUP_CNC,
  STAGES.SETUP_CMM,
  STAGES.SETUP_VERIFY,
  //'VERIFY_X, STAGES.VERIFY_Y, STAGES.VERIFY_Z,
  // STAGES.VERIFY_A_HOMING, 
  STAGES.VERIFY_A, 
  // STAGES.VERIFY_B_HOMING, 
  STAGES.VERIFY_B, 
  STAGES.CALC_VERIFY,
  STAGES.WRITE_VERIFY,
]


const A_COMP_PATH = POCKETNC_VAR_DIRECTORY + '/a.comp';
const B_COMP_PATH = POCKETNC_VAR_DIRECTORY + '/b.comp';

const Y_POS_PROBING = -63;

function readCompensationFiles() {
  var aData = fs.readFileSync(A_COMP_PATH, 'ascii');
  var bData = fs.readFileSync(B_COMP_PATH, 'ascii');
  return {a: aData, b: bData};
}
function clearCompensationFiles() {
  fs.writeFileSync(A_COMP_PATH, "");
  fs.writeFileSync(B_COMP_PATH, "");
}

//------GLOBALS------
class CalibProcess {
  constructor(processType) {
    this.processType = processType;
    if(processType === PROCESS_VERIFY){
      this.currentLevel = LEVEL_VERIFY;
    }
    else{
      this.currentLevel = LEVEL_CALIB;
    }

    // this.status = {
    //   begun: false,
    //   processType: null,
    //   cmmConnected: false,
    //   cmmError: false,
    //   cncError: false,
    //   stages: {
    //     calib: CALIB_ORDER.reduce((calibArr, stage) => ({...calibArr, [stage]: {completed: false, error: false}}), {}),
    //     verify: VERIFY_ORDER.reduce((verifyArr, stage) => ({...verifyArr, [stage]: {completed: false, error: false}}), {}),
    //   },
    //   processState: STATE_IDLE,
    //   execState: STATE_IDLE,
    //   status: STATE_IDLE,
    //   currentMode: MODE_VERIFY,
    //   currentStep: null,
    //   currentStage: null,
    // }

    this.rockhopperClient = new RockhopperClient()

    this.rockhopperConnected, this.intervalConnectRockhopper = false;
    this.rockhopperClient, this.rockhopperConnection = undefined;

    this.uiConnected = false;
    this.uiConnection = undefined;

    this.skipCmm = false;

    this.cmmConnected = false
    this.lastCmmPing = undefined;

    this.aHomeErr = null;
    this.bHomeErr = null;

    this.currentStep, this.currentStage = undefined;
    this.stages = {
      calib: CALIB_ORDER.reduce((calibArr, stage) => ({...calibArr, [stage]: {completed: false, error: false}}), {}),
      verify: VERIFY_ORDER.reduce((verifyArr, stage) => ({...verifyArr, [stage]: {completed: false, error: false}}), {}),
    }

    this.commandedState = STATE_RUN
    this.actualState = STATE_RUN
  }
  
  checkAutoProgressStage() {
    return this.actualState === STATE_RUN && this.commandedState === STATE_RUN;
  }
  checkContinueCurrentStage() {
    return [STATE_RUN, STATE_STEP].includes(this.actualState) && [STATE_RUN, STATE_STEP].includes(this.commandedState);
  }
  runIntervalConnectRockhopper() {
    if(this.intervalConnectRockhopper !== false) { return }
    this.intervalConnectRockhopper = setInterval(this.connectRockhopper, 3000)
  }
  stopIntervalConnectRockhopper() {
    if(this.intervalConnectRockhopper === false) return
    clearInterval(this.intervalConnectRockhopper)
    this.intervalConnectRockhopper = false
  }
  async getRockhopperConnection() {
    if(this.rockhopperConnection){
      return this.rockhopperConnection;
    }
    await this.connectRockhopper();
    return this.rockhopperConnection;
  }
  async connectRockhopper() {
    this.rockhopperConnected = false;
    if(this.rockhopperClient === undefined){
      this.rockhopperClient = new WebSocketClient();
    }
    this.rockhopperClient.on('connectFailed', function(error) {
      this.rockhopperConnected = false;
      this.rockhopperConnection = undefined;
      // this.runIntervalConnectRockhopper();
      console.log('Rockhopper Connect Error: ' + error.toString());
    });
    this.rockhopperClient.on('connect', function(connection) {
      this.rockhopperConnected = true;
      this.rockhopperConnection = connection;
      this.stopIntervalConnectRockhopper();
      console.log('Rockhopper Connection established!');
      connection.on('error', function(error) {
        this.rockhopperConnected = false;
        // this.runIntervalConnectRockhopper();
        console.log("Rockhopper Connection error: " + error.toString());
      });
      connection.on('close', function() {
        this.rockhopperConnected = false;
        this.rockhopperConnection = undefined;
        // this.runIntervalConnectRockhopper();
        console.log('Rockhopper Connection closed!');
      });
      connection.on('message', function(message) {
        rockhopperMessage = JSON.parse(message.utf8Data);
      });
    })
    this.rockhopperClient.connect('ws://localhost:8000/websocket/');
  }

  loadStageProgress = (stage) => {
    this.rockhopperClient.send(
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

  async startNextStage() {
    console.log('startNextStage')
    var searchIdx, nextStage;
    if(this.readyForVerify === false){
      for(searchIdx = 0; searchIdx < CALIB_ORDER.length; searchIdx++){
        if(!this.stages.calib[CALIB_ORDER[searchIdx]].completed){
          nextStage = CALIB_ORDER[searchIdx]
          break;
        }
      }
    }
    else{
      for(searchIdx = 0; searchIdx < VERIFY_ORDER.length; searchIdx++){
        if(!this.stages.verify[VERIFY_ORDER[searchIdx]].completed){
          nextStage = CALIB_ORDER[searchIdx]
          break;
        }
      }
    }
    var nextStageMethodName = "run" + camelCase(nextStage);
    var nextStageMethod = self[nextStageMethodName];

    if(nextStageMethod === undefined){
      console.log('Failed to select next stage to run');
      this.actualState = STATE_ERROR;
      return;
    }
    
    console.log("Running stage method: " + nextStageMethod)
    await this.rockhopperClient.waitForDoneAndIdle();
    this.currentStage = nextStage;
    try{
      if(calibProcess.processType === PROCESS_RESUME && LOADABLE_STAGES.has(nextStage) && checkSaveFileExists(nextStage)){
        console.log('Loading progress for stage ' + nextStage);
        this.loadStageProgress(nextStage)
      }
      else{
        await nextStageMethod()
      }
    }
    catch (err) {
      console.log ('error:', err.message, err.stack)
    }
  }


  //STAGE METHODS
  async runEraseCompensation(){
    console.log('runEraseCompensation');
    var comps = await readCompensationFiles();
    if(comps.a.length > 2 || comps.b.length > 2 ){
      await clearCompensationFiles();
      await this.rockhopperClient.restartServices();
      await new Promise(r => setTimeout(r, 3000));
      this.rockhopperClient.connected = false;
      var waitCount = 0;
      while(!this.rockhopperClient.connected){
        await new Promise(r => setTimeout(r, 1000));
        waitCount++;
        if(waitCount % 5 === 0){
          console.log('Waiting for rockhopper restart')
        }
      }
      console.log('Reconnected to Rockhopper after serivce restart');
    }
    else{
      console.log('Compensation already cleared');
    }
    this.stages.calib[STAGES.ERASE_COMPENSATION].completed = true;
    //This stage does not run any steps in cmm-calib, so instead of waiting for ZMQ message, auto-start next stage here
    if(this.checkAutoProgressStage()){
      this.startNextStage();
    }
  }
  async runSetupCnc(){
    console.log('runSetupCnc');
    await this.rockhopperClient.estopCmdAsync(false);
    if(!this.rockhopperClient.state.homed){
      await this.rockhopperClient.homeAxisAsync();
    }
    //This Stage is ran twice, once each for CALIB and VERIFY
    if(this.readyForVerify){
      this.stages.verify[STAGES.SETUP_CNC].completed = true;
    }
    else{
      this.stages.calib[STAGES.SETUP_CNC].completed = true;
    }
    //This stage does not run any steps in cmm-calib, so instead of waiting for ZMQ message, auto-start next stage here
    if(this.checkAutoProgressStage()){
      this.startNextStage();
    }
  }
  async runSetupCmm(){
    console.log('runSetupCmm');
    await this.rockhopperClient.programOpenCmd('v2_calib_setup_cmm.ngc');
    await new Promise(r => setTimeout(r, 2000));
    await this.rockhopperClient.cycleStart();
  }
  async runProbeMachinePos(){
    console.log('runProbeMachinePos');
    await this.rockhopperClient.programOpenCmd('v2_calib_probe_machine_pos.ngc')
    await new Promise(r => setTimeout(r, 2000));
    await this.rockhopperClient.cycleStart()
  }
  async runSetupPartCsy(){
    console.log('runSetupPartCsy');
    await this.rockhopperClient.programOpenCmd('v2_calib_setup_part_csy.ngc')
    await new Promise(r => setTimeout(r, 2000));
    await this.rockhopperClient.cycleStart()
  }
  async runProbeSpindlePos(){
    console.log('runProbeSpindlePos');
    await this.rockhopperClient.programOpenCmd('v2_calib_probe_spindle_pos.ngc')
    await new Promise(r => setTimeout(r, 2000));
    await this.rockhopperClient.cycleStart()
  }
  async runProbeFixtureBallPos(){
    console.log('runProbeFixtureBallPos');
    await this.rockhopperClient.programOpenCmd('v2_calib_probe_fixture_ball_pos.ngc')
    await new Promise(r => setTimeout(r, 2000));
    await this.rockhopperClient.cycleStart()
  }
  async runHomingX(){
    console.log('runHomingX');
    for(let idx = 0; idx < 5; idx++){
      await this.rockhopperClient.mdiCmdAsync("G0 X60");
      await this.rockhopperClient.waitForDoneAndIdle(100);
      await this.rockhopperClient.unhomeAxisAsync([0]);
      await this.rockhopperClient.waitForDoneAndIdle(100);
      await this.rockhopperClient.homeAxisAsync([0]);
      await this.rockhopperClient.waitForDoneAndIdle(100);
      await this.rockhopperClient.programOpenCmd('v2_calib_probe_x_home.ngc')
      await new Promise(r => setTimeout(r, 1000));
      await this.rockhopperClient.cycleStart();
      await this.rockhopperClient.waitForDoneAndIdle(1000);
      if( !this.checkContinueCurrentStage() ){
        return;
      }
    }
    await this.rockhopperClient.waitForDoneAndIdle(1000);
    await this.rockhopperClient.programOpenCmd('v2_calib_verify_x_home.ngc');
    await new Promise(r => setTimeout(r, 1000));
    await this.rockhopperClient.cycleStart();
  }
  async runCharacterizeX(){
    console.log('runCharacterizeX');
    await this.rockhopperClient.programOpenCmd('v2_calib_characterize_x.ngc');
    await new Promise(r => setTimeout(r, 1000));
    await this.rockhopperClient.cycleStart();
  }
  async runHomingY(){
    console.log('runHomingY');
    await this.rockhopperClient.mdiCmdAsync("o<cmm_go_to_clearance_z> call");
    await new Promise(r => setTimeout(r, 3000));
    for(let idx = 0; idx < 5; idx++){
      await this.rockhopperClient.programOpenCmd('v2_calib_probe_y_home.ngc');
      await new Promise(r => setTimeout(r, 1000));
      await this.rockhopperClient.cycleStart();
      await this.rockhopperClient.waitForDoneAndIdle(1000);
      if( !this.checkContinueCurrentStage() ){
        return;
      }
      await this.rockhopperClient.mdiCmdAsync("G0 Y60");
      await this.rockhopperClient.waitForDoneAndIdle(100);
      await this.rockhopperClient.unhomeAxisAsync([1]);
      await this.rockhopperClient.waitForDoneAndIdle(100);
      await this.rockhopperClient.homeAxisAsync([1]);
      await this.rockhopperClient.waitForDoneAndIdle(100);
    }
    await this.rockhopperClient.waitForDoneAndIdle(1000);
    await this.rockhopperClient.programOpenCmd('v2_calib_verify_y_home.ngc');
    await new Promise(r => setTimeout(r, 1000));
    await this.rockhopperClient.cycleStart();
  }
  async runCharacterizeY(){
    console.log('runCharacterizeY');
    await this.rockhopperClient.programOpenCmd('v2_calib_characterize_y.ngc');
    await new Promise(r => setTimeout(r, 1000));
    await this.rockhopperClient.cycleStart();
  }
  async runHomingZ(){
    console.log('runHomingZ');
    for(let idx = 0; idx < 5; idx++){
      await this.rockhopperClient.programOpenCmd('v2_calib_probe_z_home.ngc')
      await new Promise(r => setTimeout(r, 1000));
      await this.rockhopperClient.cycleStart();
      await this.rockhopperClient.waitForDoneAndIdle(1000);
      if( !this.checkContinueCurrentStage() ){
        return;
      }
      if(idx < 4){
        await this.rockhopperClient.mdiCmdAsync("G0 Z-3.5");
        await this.rockhopperClient.waitForDoneAndIdle(100);
        await this.rockhopperClient.unhomeAxisAsync([2]);
        await this.rockhopperClient.waitForDoneAndIdle(100);
        await this.rockhopperClient.homeAxisAsync([2]);
        await this.rockhopperClient.waitForDoneAndIdle(100);
      }
    }
    await this.rockhopperClient.waitForDoneAndIdle(1000);
  
    await this.rockhopperClient.programOpenCmd('v2_calib_verify_z_home.ngc');
    await new Promise(r => setTimeout(r, 1000));
    await this.rockhopperClient.cycleStart();
  }
  async runCharacterizeZ(){
    console.log('runCharacterizeZ');
    // await performTeleopEnable(conn, true);
    // await new Promise(r => setTimeout(r, 1000));
    await this.rockhopperClient.mdiCmdAsync("G0 X0");
    
    await this.rockhopperClient.programOpenCmd('v2_calib_characterize_z.ngc');
    await new Promise(r => setTimeout(r, 1000));
    await this.rockhopperClient.cycleStart();
  }
  async runProbeTopPlane(){
    console.log('runProbeTopPlane');
    await this.rockhopperClient.programOpenCmd('v2_calib_probe_top_plane.ngc');
    await new Promise(r => setTimeout(r, 2000));
    await this.rockhopperClient.cycleStart();
  }
  async runSetupCncCsy(){
    console.log('runSetupCncCsy');
    await this.rockhopperClient.programOpenCmd('v2_calib_setup_cnc_csy.ngc');
    await new Promise(r => setTimeout(r, 2000));
    await this.rockhopperClient.cycleStart();
  }
  async runHomingA(){
    console.log('runHomingA');
    await this.rockhopperClient.mdiCmdAsync(`G0 Y${Y_POS_PROBING}`);
    for(let idx = 0; idx < 5; idx++){
      await this.rockhopperClient.programOpenCmd('v2_calib_probe_a_home.ngc')
      await new Promise(r => setTimeout(r, 1000));
      await this.rockhopperClient.cycleStart();
      await this.rockhopperClient.waitForDoneAndIdle(1000);
  
      if( !this.checkContinueCurrentStage() ){
        return;
      }
      if(idx < 4){
        await this.rockhopperClient.mdiCmdAsync("G0 A-10");
        await this.rockhopperClient.waitForDoneAndIdle(100);
        await this.rockhopperClient.unhomeAxisAsync([3]);
        await this.rockhopperClient.waitForDoneAndIdle(100);
        await this.rockhopperClient.homeAxisAsync([3]);
        await this.rockhopperClient.waitForDoneAndIdle(100);
      }
    }
    await new Promise(r => setTimeout(r, 1000));
    await this.rockhopperClient.programOpenCmd('v2_calib_verify_a_home.ngc');
    await this.rockhopperClient.cycleStart();
  }
  async runCharacterizeA(){
    console.log('runCharacterizeA');
    await this.rockhopperClient.mdiCmdAsync(`G0 Y${Y_POS_PROBING}`);
    
    await this.rockhopperClient.programOpenCmd('v2_calib_characterize_a.ngc');
    await this.rockhopperClient.cycleStart();
  }
  async runHomingB(){
    console.log('runHomingB');
    await this.rockhopperClient.mdiCmdAsync(`G0 Y${Y_POS_PROBING}`);
  
    for(let idx = 0; idx < 5; idx++){
      await this.rockhopperClient.programOpenCmd('v2_calib_probe_b_home.ngc')
      await new Promise(r => setTimeout(r, 1000));
      await this.rockhopperClient.cycleStart();
      await this.rockhopperClient.waitForDoneAndIdle(1000);
      if( !this.checkContinueCurrentStage() ){
        return;
      }
      if(idx < 4){
        await this.rockhopperClient.mdiCmdAsync("G0 B-10");
        await this.rockhopperClient.waitForDoneAndIdle(100);
        await this.rockhopperClient.unhomeAxisAsync([4]);
        await this.rockhopperClient.waitForDoneAndIdle(100);
        await this.rockhopperClient.homeAxisAsync([4]);
        await this.rockhopperClient.waitForDoneAndIdle(100);
      }
    }
    await new Promise(r => setTimeout(r, 1000));
    await this.rockhopperClient.programOpenCmd('v2_calib_verify_b_home.ngc');
    await this.rockhopperClient.cycleStart();
  }
  async runCharacterizeB(){
    console.log('runCharacterizeB');
    await this.rockhopperClient.mdiCmdAsync(`G0 Y${Y_POS_PROBING}`);
    await this.rockhopperClient.programOpenCmd('v2_calib_characterize_b.ngc');
    await new Promise(r => setTimeout(r, 1000));
    await this.rockhopperClient.cycleStart();
  }
  async runCalcCalib(){
    console.log('runCalcCalib');
    await this.rockhopperClient.programOpenCmd('v2_calib_calc_calib.ngc');
    await new Promise(r => setTimeout(r, 1000));
    await this.rockhopperClient.cycleStart();
  }
  async runWriteCalib(){
    console.log('runWriteCalib');
    await this.rockhopperClient.programOpenCmd('v2_calib_write_calib.ngc');
    await new Promise(r => setTimeout(r, 1000));
    await this.rockhopperClient.cycleStart();
  }
  async runRestartCnc(){
    console.log('runRestartCnc');
    await this.rockhopperClient.restartServices()
    await new Promise(r => setTimeout(r, 3000));
    this.rockhopperClient.connected = false;
    var waitCount = 0;
    while(!this.rockhopperClient.connected){
      await new Promise(r => setTimeout(r, 1000));
      waitCount++;
      if(waitCount % 5 === 0){
        console.log('Waiting for rockhopper restart')
      }
    }
    console.log('Reconnected to Rockhopper after serivce restart');
    this.stages.verify[STAGES.RESTART_CNC].completed = true;
    if(this.checkAutoProgressStage()){
      this.startNextStage();
    }
  }
  async runSetupVerify(){
    console.log('runSetupVerify');
    await this.rockhopperClient.programOpenCmd('v2_calib_setup_verify.ngc');
    await new Promise(r => setTimeout(r, 1000));
    await this.rockhopperClient.cycleStart();
  }
  // async runVerifyAHoming(){
  //   console.log('runVerifyAHoming');
  //   await this.rockhopperClient.mdiCmdAsync(`G0 Y${Y_POS_PROBING}`);
  //   for(let idx = 0; idx < 5; idx++){
  //     await this.rockhopperClient.programOpenCmd('v2_calib_probe_a_home.ngc')
  //     await new Promise(r => setTimeout(r, 1000));
  //     await this.rockhopperClient.cycleStart();
  //     await this.rockhopperClient.waitForDoneAndIdle(1000);
  
  //     if( !this.checkContinueCurrentStage() ){
  //       return;
  //     }
  //     if(idx < 4){
  //       await this.rockhopperClient.mdiCmdAsync("G0 A-10");
  //       await this.rockhopperClient.unhomeAxisAsync([3]);
  //       await this.rockhopperClient.homeAxisAsync([3]);
  //     }
  //   }
  //   await new Promise(r => setTimeout(r, 1000));
  //   await this.rockhopperClient.programOpenCmd('v2_calib_verify_a_homing.ngc');
  //   await this.rockhopperClient.cycleStart();
  // }
  async runVerifyA(){
    console.log('runVerifyA');
    await this.rockhopperClient.mdiCmdAsync(`G0 Y${Y_POS_PROBING}`);
    await new Promise(r => setTimeout(r, 1000));
    await this.rockhopperClient.programOpenCmd('v2_calib_probe_a_home.ngc')
    await new Promise(r => setTimeout(r, 1000));
    await this.rockhopperClient.cycleStart();
    await this.rockhopperClient.waitForDoneAndIdle(1000);
    var homingAttemptsCount = 0;
    while(Math.abs(this.aHomeErr) > 0.01){
      if( !this.checkContinueCurrentStage() ){
        return;
      }
      console.log(this.aHomeErr);
      homingAttemptsCount++;
      await this.rockhopperClient.mdiCmdAsync("G0 A-10");
      await this.rockhopperClient.unhomeAxisAsync([3]);
      await this.rockhopperClient.homeAxisAsync([3]);
      
      await this.rockhopperClient.programOpenCmd('v2_calib_probe_a_home.ngc')
      await new Promise(r => setTimeout(r, 1000));
      await this.rockhopperClient.cycleStart();
      await this.rockhopperClient.waitForDoneAndIdle(1000);
    }
    console.log(Math.abs(this.aHomeErr))
    await this.rockhopperClient.programOpenCmd('v2_calib_verify_a.ngc');
    await new Promise(r => setTimeout(r, 1000));
    await this.rockhopperClient.cycleStart();
  }
  // async runVerifyBHoming(){
  //   console.log('runVerifyBHoming');
  //   await this.rockhopperClient.mdiCmdAsync(`G0 Y${Y_POS_PROBING}`);
  //   for(let idx = 0; idx < 5; idx++){
  //     await this.rockhopperClient.programOpenCmd('v2_calib_probe_b_home.ngc')
  //     await new Promise(r => setTimeout(r, 1000));
  //     await this.rockhopperClient.cycleStart();
  //     await this.rockhopperClient.waitForDoneAndIdle(1000);
  
  //     if( !this.checkContinueCurrentStage() ){
  //       return;
  //     }
  //     if(idx < 4){
  //       await this.rockhopperClient.mdiCmdAsync("G0 B-10");
  //       await this.rockhopperClient.unhomeAxisAsync([4]);
  //       await this.rockhopperClient.homeAxisAsync([4]);
  //     }
  //   }
  //   await new Promise(r => setTimeout(r, 1000));
  //   await this.rockhopperClient.programOpenCmd('v2_calib_verify_b_homing.ngc');
  //   await this.rockhopperClient.cycleStart();
  // }
  async runVerifyB(){
    console.log('runVerifyB');
    await this.rockhopperClient.mdiCmdAsync(`G0 Y${Y_POS_PROBING}A0`);
    await new Promise(r => setTimeout(r, 1000));
    var homingAttemptsCount = 0;
    while(true){
      await this.rockhopperClient.programOpenCmd('v2_calib_probe_b_home.ngc')
      await new Promise(r => setTimeout(r, 1000));
      await this.rockhopperClient.cycleStart();
      await this.rockhopperClient.waitForDoneAndIdle(1000);
      if( !this.checkContinueCurrentStage() ){
        return;
      }
      console.log(this.bHomeErr);
      if(Math.abs(this.bHomeErr) < 0.01){
        break;
      }
      homingAttemptsCount++;
      await this.rockhopperClient.mdiCmdAsync("G0 B-10");
      await this.rockhopperClient.unhomeAxisAsync([4]);
      await this.rockhopperClient.homeAxisAsync([4]);
    }
    console.log(Math.abs(this.bHomeErr))
  
    await this.rockhopperClient.programOpenCmd('v2_calib_verify_b.ngc');
    await new Promise(r => setTimeout(r, 1000));
    await this.rockhopperClient.cycleStart();
  }
  async runCalcVerify(){
    console.log('runCalcVerify');
    await this.rockhopperClient.programOpenCmd('v2_calib_calc_verify.ngc');
    await new Promise(r => setTimeout(r, 1000));
    await this.rockhopperClient.cycleStart();
  }
  async runWriteVerify(){
    console.log('runWriteVerify');
    await this.rockhopperClient.programOpenCmd('v2_calib_write_verify.ngc');
    await new Promise(r => setTimeout(r, 1000));
    await this.rockhopperClient.cycleStart();
  }
}