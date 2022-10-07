const util = require("util");
const { exec } = require("child_process");
const execPromise = util.promisify(exec);
const fs = require('fs');
const camelCase = require('to-camel-case');
const { RockhopperClient } = require('./rockhopper');


const POCKETNC_VAR_DIRECTORY = process.env.POCKETNC_VAR_DIRECTORY;
const CALIB_DIR = POCKETNC_VAR_DIRECTORY + "/calib";

const STAGES = {
  ERASE_COMPENSATION: 'ERASE_COMPENSATION',
  SETUP_CNC_CALIB: 'SETUP_CNC_CALIB',
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
  SETUP_CNC_VERIFY: 'SETUP_CNC_VERIFY',
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

//#region CONSTANTS
//These STATE_ constants are used to set value of CalibProcess.commandedState and CalibProcess.actualState 
const STATE_INIT = "INIT" //If configuration does not begin process immediately on startup. Currently not used
const STATE_IDLE = "IDLE" //In between stages. Enter this state if commandedState is STATE_STEP upon completion of a stage
const STATE_PAUSE = "PAUSE" //Mid-stage but paused
const STATE_RUN = "RUN" //Automatically progression between stages
const STATE_STEP = "STEP" //Idle after each stage completes
const STATE_STOP = "STOP" //Terminate the process
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
//#endregion


const CALIB_ORDER = [
  STAGES.ERASE_COMPENSATION,
  STAGES.SETUP_CNC_CALIB,
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
  STAGES.SETUP_CNC_VERIFY,
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

function checkSaveFileExists(stage) {
  var filename = CALIB_DIR + "/Stages." + stage.toUpperCase();
  console.log('checkSaveFileExists')
  console.log(filename)
  if (fs.existsSync(filename)) {
    return true;
  }
  else {
    return false;
  }
}

//------GLOBALS------
class CalibProcess {
  constructor(processType) {
    this.processType = PROCESS_NEW;


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

    this.rockhopperClient = new RockhopperClient();
    this.rockhopperClient.connect();

    this.aHomeErr = null;
    this.bHomeErr = null;

    this.currentStep, this.currentStage = undefined;
    this.stages = {
      calib: CALIB_ORDER.reduce((calibArr, stage) => ({...calibArr, [stage]: {completed: false, error: false, failed: false}}), {}),
      verify: VERIFY_ORDER.reduce((verifyArr, stage) => ({...verifyArr, [stage]: {completed: false, error: false, failed: false}}), {}),
    }

    this.commandedState = STATE_IDLE
    this.actualState = STATE_IDLE

    this.results = {};

    this.readyForVerify = true;
  }

  async runProcess() {
    console.log('runProcess')
    this.actualState = STATE_RUN;
    while(this.checkAutoProgressStage){
      console.log('runprocess iteration')
      await this.startNextStage();
    }
  }

  async cmdRun() {
    console.log('cmdRun')
    console.log(this.actualState)
    console.log(this.commandedState)
    this.commandedState = STATE_RUN;
    if ([STATE_INIT, STATE_IDLE].includes(this.actualState)){
      await this.runProcess();
    }
    else if ([STATE_PAUSE].includes(this.actualState)){
      //Continue from mid-stage pause
      //TODO return message
    }
    else if([STATE_ERROR, STATE_FAIL].includes(this.actualState)){
      //Can't run after error, return message
      //TODO return message
    }
    else if([STATE_STOP].includes(this.actualState)){
      //Can't run after stop, return message
      //TODO return message
    }
    else if([STATE_STEP].includes(this.actualState)){
      //Currently running a single stage, just change actualState so that
      //process auto-continues upon completion of current stage
      this.actualState = STATE_RUN;
    }
  }
  async cmdStep() {
    this.commandedState = STATE_STEP;
    if ([STATE_INIT, STATE_IDLE].includes(this.actualState)){
      await this.startNextStage();
    }
    else if ([STATE_PAUSE].includes(this.actualState)){
      //Continue from mid-stage pause
      //TODO return message
    }
    else if([STATE_ERROR, STATE_FAIL].includes(this.actualState)){
      //Can't run after error, return message
      //TODO return message
    }
    else if([STATE_STOP].includes(this.actualState)){
      //Can't run after stop, return message
      //TODO return message
    }
    else if([STATE_RUN].includes(this.actualState)){
      //Currently running stages automatically, just change actualState so that
      //process idles upon completion of current stage
      this.actualState = STATE_STEP;
    }
  }
  async cmdPause() {
    this.commandedState = STATE_PAUSE;
    if ([STATE_INIT, STATE_IDLE].includes(this.actualState)){
      //Already idle, this is just a semantic state change
      this.actualState = STATE_PAUSE;
    }
    else if([STATE_ERROR, STATE_FAIL].includes(this.actualState)){
      //Already stopped, nothing happening to pause
      //TODO return message
    }
    else if([STATE_STOP].includes(this.actualState)){
      //Already stopped, nothing happening to pause
      //TODO return message
    }
    else if([STATE_STEP, STATE_RUN].includes(this.actualState)){
      //Currently running
      //TODO implement more immediate PAUSE
      //For now, we just change commanded state and wait for current stage to complete
    }
  }
  async cmdStop() {
    //Terminate the calibration
    this.commandedState = STATE_STOP;
    if ([STATE_INIT, STATE_IDLE].includes(this.actualState)){
      //Already idle, this is just a semantic state change
      this.actualState = STATE_STOP;
    }
    else if([STATE_PAUSE].includes(this.actualState)){
      //TODO
    }
    else if([STATE_ERROR, STATE_FAIL].includes(this.actualState)){
      //TODO
    }
    else if([STATE_STEP, STATE_RUN].includes(this.actualState)){
      //Currently running
      //TODO implement more immediate STOP
      //For now, we just change commanded state and wait for current stage to complete
    }
  }
  async getStatus() {
    return {'stages': this.stages}
  }

  async receiveUpdate(msg) {
    console.log('receive update')
    // console.log(msg)

    if(msg.stage_completed){
      if(this.readyForVerify){
        this.stages.verify[msg.stage].completed = true;
      }
      else{
        this.stages.calib[msg.stage].completed = true;
      }

      if(this.actualState === STATE_RUN && this.commandedState === STATE_RUN){
        // await this.startNextStage();
        //do nothing, recent change has moved control to method runProcess
      }
      else if(this.actualState === STATE_STEP && this.commandedState === STATE_STEP){
        console.log('setting actual state STATE_IDLE in receive update')
        this.actualState = STATE_IDLE
      }
    }
    else if(msg.why === MSG_WHY_ERROR){
      this.stages[this.readyForVerify ? "verify" : "calib"][msg.stage].error = true;
      this.actualState = STATE_ERROR
    }
    else if(msg.why === MSG_WHY_FAIL){
      this.stages[this.readyForVerify ? "verify" : "calib"][msg.stage].error = true;
      this.actualState = STATE_FAIL
    }
    this.results = msg;
    this.status = msg;

    // status.skipCmm = calibManagerReport.skip_cmm;
    // status.bHomeErr = calibManagerReport.b_home_err;
    // status.aHomeErr = calibManagerReport.a_home_err;
  }
  checkAutoProgressStage() {
    console.log( this.actualState === STATE_RUN && this.commandedState === STATE_RUN)
    return this.actualState === STATE_RUN && this.commandedState === STATE_RUN;
  }
  checkContinueCurrentStage() {
    console.log(this.actualState)
    console.log(this.commandedState)
    console.log([STATE_RUN, STATE_STEP].includes(this.actualState) && [STATE_RUN, STATE_STEP].includes(this.commandedState));
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
          nextStage = VERIFY_ORDER[searchIdx]
          break;
        }
      }
    }
    var nextStageMethodName = camelCase("run_" + nextStage);

    var nextStageMethod = this[nextStageMethodName];

    if(nextStageMethod === undefined){
      console.log('Failed to select next stage to run');
      this.actualState = STATE_ERROR;
      return;
    }
    
    console.log("Running stage method: " + nextStageMethodName)
    // await this.rockhopperClient.waitForDoneAndIdle();
    this.currentStage = nextStage;
    try{
      if(this.processType === PROCESS_RESUME && LOADABLE_STAGES.has(nextStage) && checkSaveFileExists(nextStage)){
        console.log('Loading progress for stage ' + nextStage);
        this.loadStageProgress(nextStage)
      }
      else{
        this.actualState = this.commandedState // commandedState should be either RUN or STEP at this point
        return await this[nextStageMethodName]()
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
      console.log('Compensation files cleared, restarting services.');
      await this.rockhopperClient.restartServices();
      
      //This delay is intended to ensure that the current rockhopper process has halted before we begin polling for connection
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
      console.log('Reconnected to Rockhopper after service restart');
    }
    else{
      console.log('Compensation already cleared');
    }

    //This stage does not run any steps in cmm-calib.
    //Set stage completed and start next stage here, instead of waiting for message from cmm-calib
    this.stages.calib[STAGES.ERASE_COMPENSATION].completed = true;
    // if(this.checkAutoProgressStage()){
    //   this.startNextStage();
    // }
    // else if(this.actualState === STATE_STEP && this.commandedState === STATE_STEP){
    //   this.actualState = STATE_IDLE
    // }
  }

  async runSetupCncCalib(){
    console.log('runSetupCncCalib');
    await this.rockhopperClient.estopCmdAsync(false);
    if(!this.rockhopperClient.state.homed){
      await this.rockhopperClient.homeAxisAsync();
    }

    //This stage does not run any steps in cmm-calib.
    //Set stage completed and start next stage here, instead of waiting for message from cmm-calib
    this.stages.calib[STAGES.SETUP_CNC_CALIB].completed = true;
    // if(this.checkAutoProgressStage()){
    //   this.startNextStage();
    // }
    // else if(this.actualState === STATE_STEP && this.commandedState === STATE_STEP){
    //   this.actualState = STATE_IDLE
    // }
  }
  async runSetupCmm(){
    console.log('runSetupCmm');
    await this.rockhopperClient.runToCompletion('v2_calib_setup_cmm.ngc');
    return
  }
  async runProbeMachinePos(){
    console.log('runProbeMachinePos');
    await this.rockhopperClient.runToCompletion('v2_calib_probe_machine_pos.ngc')
  }
  async runSetupPartCsy(){
    console.log('runSetupPartCsy');
    await this.rockhopperClient.runToCompletion('v2_calib_setup_part_csy.ngc')
  }
  async runProbeSpindlePos(){
    console.log('runProbeSpindlePos');
    await this.rockhopperClient.runToCompletion('v2_calib_probe_spindle_pos.ngc')
  }
  async runProbeFixtureBallPos(){
    console.log('runProbeFixtureBallPos');
    await this.rockhopperClient.runToCompletion('v2_calib_probe_fixture_ball_pos.ngc')
  }
  async runHomingX(){
    console.log('runHomingX');
    for(let idx = 0; idx < 5; idx++){
      console.log('runHomingX ' + idx);
      await this.rockhopperClient.mdiCmdAsync("G0 X60");
      await this.rockhopperClient.unhomeAxisAsync([0]);
      await this.rockhopperClient.homeAxisAsync([0]);
      await this.rockhopperClient.runToCompletion('v2_calib_probe_x_home.ngc')
      if( !this.checkContinueCurrentStage() ){
        console.log('ending homing x early')
        return;
      }
    }
    await this.rockhopperClient.runToCompletion('v2_calib_verify_x_home.ngc');
  }
  async runCharacterizeX(){
    console.log('runCharacterizeX');
    await this.rockhopperClient.runToCompletion('v2_calib_characterize_x.ngc');
  }
  async runHomingY(){
    console.log('runHomingY');
    await this.rockhopperClient.mdiCmdAsync("o<cmm_go_to_clearance_z> call");
    for(let idx = 0; idx < 5; idx++){
      await this.rockhopperClient.runToCompletion('v2_calib_probe_y_home.ngc');
      if( !this.checkContinueCurrentStage() ){
        return;
      }
      await this.rockhopperClient.mdiCmdAsync("G0 Y60");
      await this.rockhopperClient.unhomeAxisAsync([1]);
      await this.rockhopperClient.homeAxisAsync([1]);
    }
    await this.rockhopperClient.runToCompletion('v2_calib_verify_y_home.ngc');
  }
  async runCharacterizeY(){
    console.log('runCharacterizeY');
    await this.rockhopperClient.runToCompletion('v2_calib_characterize_y.ngc');
  }
  async runHomingZ(){
    console.log('runHomingZ');
    await this.rockhopperClient.mdiCmdAsync("G0 X0");
    for(let idx = 0; idx < 5; idx++){
      await this.rockhopperClient.runToCompletion('v2_calib_probe_z_home.ngc')
      if( !this.checkContinueCurrentStage() ){
        return;
      }
      if(idx < 4){
        await this.rockhopperClient.mdiCmdAsync("G0 Z-3.5");
        await this.rockhopperClient.unhomeAxisAsync([2]);
        await this.rockhopperClient.homeAxisAsync([2]);
      }
    }
    await this.rockhopperClient.runToCompletion('v2_calib_verify_z_home.ngc');
  }
  async runCharacterizeZ(){
    console.log('runCharacterizeZ');
    await this.rockhopperClient.runToCompletion('v2_calib_characterize_z.ngc');
  }
  async runProbeTopPlane(){
    console.log('runProbeTopPlane');
    await this.rockhopperClient.runToCompletion('v2_calib_probe_top_plane.ngc');
  }
  async runSetupCncCsy(){
    console.log('runSetupCncCsy');
    await this.rockhopperClient.runToCompletion('v2_calib_setup_cnc_csy.ngc');
  }
  async runHomingA(){
    console.log('runHomingA');
    await this.rockhopperClient.mdiCmdAsync(`G0 Y${Y_POS_PROBING}`);
    for(let idx = 0; idx < 5; idx++){
      await this.rockhopperClient.runToCompletion('v2_calib_probe_a_home.ngc')
  
      if( !this.checkContinueCurrentStage() ){
        return;
      }

      if(idx < 4){
        await this.rockhopperClient.mdiCmdAsync("G0 A-10");
        await this.rockhopperClient.unhomeAxisAsync([3]);
        await this.rockhopperClient.homeAxisAsync([3]);
      }
    }
    await this.rockhopperClient.runToCompletion('v2_calib_verify_a_home.ngc');
  }
  async runCharacterizeA(){
    console.log('runCharacterizeA');
    await this.rockhopperClient.runToCompletion('v2_calib_characterize_a.ngc');
  }
  async runHomingB(){
    console.log('runHomingB');
    await this.rockhopperClient.mdiCmdAsync(`G0 Y${Y_POS_PROBING}`);
    for(let idx = 0; idx < 5; idx++){
      await this.rockhopperClient.runToCompletion('v2_calib_probe_b_home.ngc');
      if( !this.checkContinueCurrentStage() ){
        return;
      }
      if(idx < 4){
        await this.rockhopperClient.mdiCmdAsync("G0 B-10");
        await this.rockhopperClient.unhomeAxisAsync([4]);
        await this.rockhopperClient.homeAxisAsync([4]);
      }
    }
    await this.rockhopperClient.runToCompletion('v2_calib_verify_b_home.ngc');
  }
  async runCharacterizeB(){
    console.log('runCharacterizeB');
    await this.rockhopperClient.runToCompletion('v2_calib_characterize_b.ngc');
  }
  async runCalcCalib(){
    console.log('runCalcCalib');
    await this.rockhopperClient.runToCompletion('v2_calib_calc_calib.ngc');
  }
  async runWriteCalib(){
    console.log('runWriteCalib');
    await this.rockhopperClient.runToCompletion('v2_calib_write_calib.ngc');
    this.readyForVerify = true;
  }
  async runRestartCnc(){
    console.log('runRestartCnc');
    await this.rockhopperClient.restartServices()
    
    //This delay is intended to ensure that the current rockhopper process has halted before we begin polling for connection
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
    console.log('Reconnected to Rockhopper after service restart');

    //This stage does not run any steps in cmm-calib.
    //Set stage completed and start next stage here, instead of waiting for message from cmm-calib
    this.stages.verify[STAGES.RESTART_CNC].completed = true;
    // if(this.checkAutoProgressStage()){
    //   this.startNextStage();
    // }
    // else if(this.actualState === STATE_STEP && this.commandedState === STATE_STEP){
    //   this.actualState = STATE_IDLE
    // }
  }
  async runSetupCncVerify(){
    console.log('runSetupCncVerify');
    await this.rockhopperClient.estopCmdAsync(false);
    if(!this.rockhopperClient.state.homed){
      await this.rockhopperClient.homeAxisAsync();
    }

    //This stage does not run any steps in cmm-calib.
    //Set stage completed and start next stage here, instead of waiting for message from cmm-calib
    this.stages.verify[STAGES.SETUP_CNC_VERIFY].completed = true;
    // if(this.checkAutoProgressStage()){
    //   this.startNextStage();
    // }
    // else if(this.actualState === STATE_STEP && this.commandedState === STATE_STEP){
    //   this.actualState = STATE_IDLE
    // }
  }
  async runSetupVerify(){
    console.log('runSetupVerify');
    await this.rockhopperClient.runToCompletion('v2_calib_setup_verify.ngc');
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
    var homingAttemptsCount = 0;
    while(true){
      await this.rockhopperClient.runToCompletion('v2_calib_probe_a_home.ngc')

      if( !this.checkContinueCurrentStage() ){
        return;
      }
      if(Math.abs(this.results.a_home_err) < 0.01){
        console.log("VERIFY_A home position within range, error " + this.results.aHomeErr);
        break;
      }

      homingAttemptsCount++;
      if(homingAttemptsCount > 10){
        console.log("Halting A-axis homing verification, failed to achieve home position with error <0.01 in 10 attempts");
        this.actualState = STATE_FAIL
        this.stages.verify[STAGES.VERIFY_A].failed = true
        return;
      }
      await this.rockhopperClient.mdiCmdAsync("G0 A-10");
      await this.rockhopperClient.unhomeAxisAsync([3]);
      await this.rockhopperClient.homeAxisAsync([3]);
    }
    await this.rockhopperClient.runToCompletion('v2_calib_verify_a.ngc');
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
    var homingAttemptsCount = 0;
    while(true){
      await this.rockhopperClient.runToCompletion('v2_calib_probe_b_home.ngc')
      if( !this.checkContinueCurrentStage() ){
        return;
      }
      if(Math.abs(this.results.b_home_err) < 0.01){
        console.log("VERIFY_B home position within range, error " + this.results.bHomeErr);
        break;
      }

      homingAttemptsCount++;
      if(homingAttemptsCount > 10){
        console.log("Halting B-axis homing verification, unable to achieve home position with error <0.01");
        this.actualState = STATE_FAIL
        this.stages.verify[STAGES.VERIFY_B].failed = true
        return;
      }
      await this.rockhopperClient.mdiCmdAsync("G0 B-10");
      await this.rockhopperClient.unhomeAxisAsync([4]);
      await this.rockhopperClient.homeAxisAsync([4]);
    }
    await this.rockhopperClient.runToCompletion('v2_calib_verify_b.ngc');
  }
  async runCalcVerify(){
    console.log('runCalcVerify');
    await this.rockhopperClient.runToCompletion('v2_calib_calc_verify.ngc');
  }
  async runWriteVerify(){
    console.log('runWriteVerify');
    await this.rockhopperClient.runToCompletion('v2_calib_write_verify.ngc');
  }
}

module.exports = {
  CalibProcess
};
