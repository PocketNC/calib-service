//TODO revert expanded threshold on rotary homing error that was put in place to allow data gathering runs to complete despite small errors in home position
const util = require("util");
const { exec } = require("child_process");
const execPromise = util.promisify(exec);
const fs = require('fs');
const camelCase = require('to-camel-case');
const { RockhopperClient } = require('./rockhopper');
const { CommandServer } = require('./command-server');
const ftp = require("basic-ftp");
var archiver = require('archiver');


const POCKETNC_DIRECTORY = process.env.POCKETNC_DIRECTORY;
const POCKETNC_VAR_DIRECTORY = process.env.POCKETNC_VAR_DIRECTORY;
const A_COMP_PATH = POCKETNC_VAR_DIRECTORY + '/a.comp';
const B_COMP_PATH = POCKETNC_VAR_DIRECTORY + '/b.comp';
const OVERLAY_PATH = POCKETNC_VAR_DIRECTORY + '/CalibrationOverlay.inc';
const CALIB_DIR = POCKETNC_VAR_DIRECTORY + "/calib";
const RESULTS_DIR = POCKETNC_VAR_DIRECTORY + "/calib_results";
const CALIB_LOG = CALIB_DIR + '/calib.log';
const SERVICE_LOG = CALIB_DIR + '/calib-service.log';
const DEFAULT_10_OVERLAY_PATH = POCKETNC_DIRECTORY + '/Settings/CalibrationOverlay.inc.default';
const DEFAULT_50_OVERLAY_PATH = POCKETNC_DIRECTORY + '/Settings/features/high_speed_spindle/CalibrationOverlay.inc.default';
const XYZ_FILE_PATH = POCKETNC_VAR_DIRECTORY + '/xyz.txt';


async function copyExistingOverlay() {
  try{
    await fs.copyFile(OVERLAY_PATH, CALIB_DIR + "/CalibrationOverlay.inc.initial", (err) => {console.log(err)})
  } catch(error) {
    console.log('Error copying existing overlay')
    console.log(error);
  }
}
async function copyNewCompFilesToVarDir() {
  try {
    await fs.copyFile(CALIB_DIR + "/CalibrationOverlay.inc", OVERLAY_PATH, (err))
    await fs.copyFile(CALIB_DIR + "/a.comp.raw", A_COMP_PATH)
    await fs.copyFile(CALIB_DIR + "/b.comp.raw", B_COMP_PATH)
  } catch {
    console.log('Error copying new comp files to VAR dir')
  }
}
async function clearLogFiles() {
  fs.writeFileSync(CALIB_LOG, "");
  fs.writeFileSync(SERVICE_LOG, "");
};
async function deleteProgressFiles() {
  await Promise.all([ execPromise(`rm -f ${CALIB_DIR}/Stages.*` )]);
}
async function deleteSaveFiles() {
  await Promise.all([ execPromise(`rm -f cnc_csy_savefile part_csy_savefile`, {cwd: `${CALIB_DIR}`} )]);
}
async function deleteDataFiles() {
  await Promise.all([ execPromise(`rm -f CalibrationOverlay.inc a.comp a.comp.raw a.err b.comp b.comp.raw b.err ver_a.err ver_b.err`, {cwd: `${CALIB_DIR}`}  )]);
}
async function resetCalibDir() {
  await clearLogFiles();

  //Make a backup of the initial CalibrationOverlay, which is in effect until restart for verify
  await copyExistingOverlay();

  await deleteProgressFiles();
  await deleteSaveFiles();
  await deleteDataFiles();
}
async function copyDefaultOverlay(variant) {
  if(variant === "50"){
    await Promise.all([ execPromise(`cp ${DEFAULT_50_OVERLAY_PATH} ${OVERLAY_PATH}`)]);
    return true
  }
  else if(variant === "10"){
    await Promise.all([ execPromise(`cp ${DEFAULT_10_OVERLAY_PATH} ${OVERLAY_PATH}`)]);
    return true
  }
  else{console.log('Variant type not specified, failed to copy'); return false}
}

/**
 * @param {String} sourceDir: /some/folder/to/compress
 * @param {String} outPath: /path/to/created.zip
 * @returns {Promise}
 * Source: https://stackoverflow.com/a/51518100/12222371
 */
function zipDirectory(sourceDir, outPath) {
  const archive = archiver('zip', { zlib: { level: 9 }});
  const stream = fs.createWriteStream(outPath);

  return new Promise((resolve, reject) => {
    archive
      .directory(sourceDir, false)
      .on('error', err => reject(err))
      .pipe(stream)
    ;

    stream.on('close', () => resolve());
    archive.finalize();
  });
}


function readCompensationFiles() {
  var aData = fs.readFileSync(A_COMP_PATH, 'ascii');
  var bData = fs.readFileSync(B_COMP_PATH, 'ascii');
  return {a: aData, b: bData};
}
//TODO change to async, remember to add await to call
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

function readXYZ(){
  var data = fs.readFileSync(XYZ_FILE_PATH, 'ascii');
  var [x,y,z] = data.split(',').map(Number);
  return [x,y,z];
}
function clearXYZFile() {
  if (fs.existsSync(XYZ_FILE_PATH)) {
    fs.writeFileSync(XYZ_FILE_PATH, "");
  }
}
function isFileReady(file) {
  var ready = false;
  if(fs.existsSync(file)){
    try{
      var data = fs.readFileSync(file, 'ascii');
      // fs.open(file, 'r', (err) => console.log(err));
      return (data.length > 2);
    }
    catch (err){
      
    }
  }
  return ready
}

async function waitUntilFileIsReady(file) {
  while(!isFileReady(file)){
    await new Promise(r => setTimeout(r, 1000));
  }
}

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
  PROBE_HOME_OFFSETS: 'PROBE_HOME_OFFSETS',
  CHARACTERIZE_A: 'CHARACTERIZE_A',
  CHARACTERIZE_B: 'CHARACTERIZE_B',
  CALC_CALIB: 'CALC_CALIB',
  WRITE_CALIB: 'WRITE_CALIB',
  //verification-only stages
  RESTART_CNC: 'RESTART_CNC',
  SETUP_CNC_VERIFY: 'SETUP_CNC_VERIFY',
  SETUP_VERIFY: 'SETUP_VERIFY',
  TOOL_PROBE_OFFSET: 'TOOL_PROBE_OFFSET',
  VERIFY_A_HOMING: 'VERIFY_A_HOMING',
  VERIFY_B_HOMING: 'VERIFY_B_HOMING',
  VERIFY_A: 'VERIFY_A',
  VERIFY_B: 'VERIFY_B',
  CALC_VERIFY: 'CALC_VERIFY',
  WRITE_VERIFY: 'WRITE_VERIFY',
  UPLOAD_FILES: 'UPLOAD_FILES',
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
const STATE_COMPLETE = "COMPLETE" //Calibration process has completed succesfully. This process is still active to communicate with UI

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

const ROTARY_VERIFICATION_HOMING_ERROR_THRESHOLD = 0.01;

const Y_POS_PROBING = 0;
const NUM_SAMPLES_HOME_REPEAT_LINEAR = 5;
const NUM_SAMPLES_HOME_REPEAT_ROTARY = 12;
const NUM_VERIFY_HOME_ATTEMPTS = 10;

const B_HOMING_POSITIONS = [-20, 0, 20]
const A_HOMING_POSITIONS = [-5, 0, 20]

const DEFAULT_B_HOME_OFFSET = -5.0
const DEFAULT_A_HOME_OFFSET = -17.5
//#endregion CONSTANTS


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
  STAGES.PROBE_FIXTURE_BALL_POS,
  STAGES.HOMING_Y,
  STAGES.CHARACTERIZE_Y,
  STAGES.PROBE_TOP_PLANE,
  STAGES.SETUP_CNC_CSY,
  STAGES.PROBE_HOME_OFFSETS,
  STAGES.HOMING_A,
  STAGES.HOMING_B,
  STAGES.CHARACTERIZE_A,
  STAGES.CHARACTERIZE_B,
  STAGES.CALC_CALIB,
  STAGES.WRITE_CALIB,
]

const VERIFY_ORDER = [
  STAGES.RESTART_CNC,
  STAGES.SETUP_CNC_VERIFY,
  STAGES.SETUP_CMM,
  STAGES.SETUP_VERIFY,
  STAGES.TOOL_PROBE_OFFSET,
  STAGES.PROBE_HOME_OFFSETS,
  //VERIFY_X, STAGES.VERIFY_Y, STAGES.VERIFY_Z,
  STAGES.VERIFY_A_HOMING,
  STAGES.VERIFY_A,
  STAGES.VERIFY_B_HOMING,
  STAGES.VERIFY_B,
  STAGES.CALC_VERIFY,
  STAGES.WRITE_VERIFY,
  STAGES.UPLOAD_FILES,
]

const V2_10 = "10";
const V2_50 = "50";

//------GLOBALS------
class CalibProcess {
  constructor(serialNum, variant) {
    console.log(`serialNum **${serialNum}**`);
    console.log(`variant **${variant}**`);
    this.serialNum = serialNum;
    if(variant !== V2_10 && variant !== V2_50) {
      throw new Error(`Variant must be "${V2_10}" or "${V2_50}"`);
    }
    this.variant = variant;

    this.processType = PROCESS_NEW;
    // this.processType = PROCESS_RESUME;


    this.status = {
      lastStageStartTime: undefined,
      lastStageCompleteTime: undefined,
      begun: false,
      processType: null,
      cmmConnected: false,
      cmmError: false,
      cncError: false,
      currentStep: null,
      currentStage: STAGES.PROBE_MACHINE_POS,
      specFailure: false,
      error: false,
      errorMsg: null,
      calibCompleted: false,
      verifyCompleted: false,
      completed: false,
    }

    this.rockhopperClient = new RockhopperClient();
    this.rockhopperClient.connect();

    this.aHomeErr = null;
    this.bHomeErr = null;

    this.currentStep, this.currentStage = undefined;
    this.stages = {
      calib: CALIB_ORDER.reduce((calibArr, stage) => ({...calibArr, [stage]: {completed: false, error: false, failed: false}}), {}),
      verify: VERIFY_ORDER.reduce((verifyArr, stage) => ({...verifyArr, [stage]: {completed: false, error: false, failed: false}}), {}),
    }
    // this.stages.calib[STAGES.ERASE_COMPENSATION].completed = true
    //  this.stages.calib[STAGES.SETUP_CNC_CALIB].completed = true
    //  this.stages.calib[STAGES.SETUP_CMM].completed = true
    //  this.stages.calib[STAGES.PROBE_MACHINE_POS].completed = true
    //  this.stages.calib[STAGES.SETUP_PART_CSY].completed = true
    //  this.stages.calib[STAGES.PROBE_SPINDLE_POS].completed = true
    //  this.stages.calib[STAGES.HOMING_X].completed = true
    //  this.stages.calib[STAGES.HOMING_Y].completed = true
    //  this.stages.calib[STAGES.HOMING_Z].completed = true
    //  this.stages.calib[STAGES.HOMING_A].completed = true
    //  this.stages.calib[STAGES.HOMING_B].completed = true
    //  this.stages.calib[STAGES.CHARACTERIZE_X].completed = true
    //  this.stages.calib[STAGES.CHARACTERIZE_Z].completed = true
    //  this.stages.calib[STAGES.PROBE_TOP_PLANE].completed = true
    //  this.stages.calib[STAGES.PROBE_FIXTURE_BALL_POS].completed = true
    //  this.stages.calib[STAGES.CHARACTERIZE_Y].completed = true
    //  this.stages.calib[STAGES.SETUP_CNC_CSY].completed = true
    //  this.stages.calib[STAGES.CHARACTERIZE_A].completed = true
    //  this.stages.calib[STAGES.CHARACTERIZE_B].completed = true
    //  this.stages.calib[STAGES.CALC_CALIB].completed = true
    //  this.stages.calib[STAGES.WRITE_CALIB].completed = true

    //  this.stages.verify[STAGES.RESTART_CNC].completed = true
    //  this.stages.verify[STAGES.SETUP_CNC_VERIFY].completed = true
    //  this.stages.verify[STAGES.SETUP_CMM].completed = true
    //  this.stages.verify[STAGES.SETUP_VERIFY].completed = true
    //  this.stages.verify[STAGES.TOOL_PROBE_OFFSET].completed = true

    this.managerStages = {};
    this.managerStatus = {};

    this.commandedState = STATE_IDLE
    this.actualState = STATE_IDLE

    this.readyForVerify = false;
    this.commandServer = new CommandServer(this);

  }



  async cmdRun() {
    console.log('cmdRun')
    this.commandedState = STATE_RUN;
    if ([STATE_INIT, STATE_IDLE].includes(this.actualState)){
      await this.runProcess();
    }
    else if ([STATE_PAUSE].includes(this.actualState)){
      //Continue from mid-stage pause
      //Eventually, PAUSE state could be mid-stage. Currently, PAUSE means "run until current stage finishes", so for now, continuing from pause is the same as continuing from idle
      await this.runProcess();
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
    await this.sendUpdate();
  }
  async cmdResume() {
    this.commandedState = STATE_RUN;
    if ([STATE_INIT, STATE_IDLE].includes(this.actualState)){
      await this.runProcess();
    }
    else if ([STATE_PAUSE].includes(this.actualState)){
      //Continue from mid-stage pause
      //Eventually, PAUSE state could be mid-stage. Currently, PAUSE means "run until current stage finishes", so for now, continuing from pause is the same as continuing from idle
      await this.runProcess();
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
    await this.sendUpdate();
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
    await this.sendUpdate();
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
    await this.sendUpdate();
  }
  async cmdStop() {
    //Terminate the calibration
    console.log('CmdStop, actualState is ' + this.actualState);
    this.commandedState = STATE_STOP;
    await this.sendUpdate();
    if ([STATE_INIT, STATE_IDLE].includes(this.actualState)){
      //Already idle. Exit process
      process.exit(0);
    }
    else if([STATE_PAUSE].includes(this.actualState)){
      process.exit(0);
    }
    else if([STATE_ERROR, STATE_FAIL].includes(this.actualState)){
      //Already idle. Exit process
      process.exit(0);
    }
    else if([STATE_STEP, STATE_RUN].includes(this.actualState)){
      //Currently running
      //TODO implement more immediate STOP
      //For now, we just change commanded state and wait for current stage to complete.
      //In runProcess the commanded state is checked after each stage complete
    }
  }
  async getStatus() {
    return {'stages': this.stages}
  }

  async runProcess() {
    console.log('runProcess')
    this.actualState = STATE_RUN;
    while(this.checkAutoProgressStage()){
      console.log('Running process, OK to continue. Starting next stage.')
      await this.startNextStage();
      await this.sendUpdate();
    }

    if(this.status.completed){
      this.actualState = STATE_COMPLETE
      await this.sendUpdate();
    }
    else if(this.commandedState === STATE_PAUSE){
      //earlier we received a cmdPause, but must have been mid-stage. Now we have returned from running that stage and can pause
      this.actualState = STATE_PAUSE;
    }
    else if(this.commandedState === STATE_STOP){
      //earlier we received a cmdStop, but must have been mid-stage. Now we have returned from running that stage and can exit
      process.exit(0);
    }
    else if(this.commandedState === STATE_RUN && this.actualState === STATE_RUN){
      //Exiting loop but have not finished, not stopping, and still in STATE_RUN. Something is wrong
      this.actualState = STATE_ERROR
      this.status.error = true;
      this.status.errorMsg = "Unable to start next stage";
      await this.sendUpdate();
    }
  }

  async sendUpdate() {
    var update = {};
    update.commandedState = this.commandedState;
    update.actualState = this.actualState;
    update.stages = this.stages;
    update.status = this.status;
    update.managerStatus = this.managerStatus;
    update.spec = this.spec;
    this.commandServer.send({'calibStatus': update});
  }
  async receiveUpdate(msg) {
    console.log('----Update message----')
    console.log(msg)
    this.status.error = msg.status.error;
    this.status.errorMsg = msg.status.error_msg;
    this.status.specFailure = msg.status.spec_failure;
    this.managerStageProgress = msg.stage_progress;
    this.managerStatus = msg.status;
    this.spec = msg.spec;
    if(msg.did_stage_complete){
      //The linuxcnc-python CalibManager has just finished performing a Stage, update our stage progress
      this.status.lastStageCompleteTime = process.uptime();
      if(this.readyForVerify){
        this.stages.verify[msg.stage].completed = true;
      }
      else{
        this.stages.calib[msg.stage].completed = true;
      }

      // if(this.commandedState !== STATE_RUN){
      //   console.log('setting actual state STATE_IDLE in receive update because commanded state is not STATE_RUN, it is ' + this.commandedState)
      //   this.actualState = STATE_IDLE
      // }
    }
    if(msg.why === MSG_WHY_ERROR){
      this.actualState = STATE_ERROR;
      this.stages[this.readyForVerify ? "verify" : "calib"][this.status.currentStage].error = true;
    }
    if(msg.why === MSG_WHY_FAIL){
      this.actualState = STATE_FAIL;
      this.stages[this.readyForVerify ? "verify" : "calib"][this.status.currentStage].failed = true;
    }
    await this.sendUpdate()
  }
  checkAutoProgressStage() {
    console.log("checkAutoProgressStage", this.status.completed, this.status.lastStageCompleteTime, this.status.lastStageStartTime, this.actualState, this.commandedState, this.managerStatus.cmm_error);
    return !this.status.completed && (this.status.lastStageStartTime === undefined || this.status.lastStageCompleteTime > this.status.lastStageStartTime) && this.actualState === STATE_RUN && this.commandedState === STATE_RUN && !this.managerStatus.cmm_error;
  }
  checkContinueCurrentStage() {
    // return [STATE_RUN, STATE_STEP].includes(this.actualState) && [STATE_RUN, STATE_STEP].includes(this.commandedState);
    return true;
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
      console.log('Rockhopper Connect Error: ' + error.toString());
    });
    this.rockhopperClient.on('connect', function(connection) {
      this.rockhopperConnected = true;
      this.rockhopperConnection = connection;
      console.log('Rockhopper Connection established!');
      connection.on('error', function(error) {
        this.rockhopperConnected = false;
        console.log("Rockhopper Connection error: " + error.toString());
      });
      connection.on('close', function() {
        this.rockhopperConnected = false;
        this.rockhopperConnection = undefined;
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

  checkStageProgress() {
    var searchIdx, nextStage;
    for(searchIdx = 0; searchIdx < CALIB_ORDER.length; searchIdx++){
      if(!this.stages.calib[CALIB_ORDER[searchIdx]].completed){
        nextStage = CALIB_ORDER[searchIdx]
        break;
      }
    }
    if(nextStage === undefined && searchIdx == CALIB_ORDER.length){
      this.status.calibCompleted = true;
    }

    if(this.status.calibCompleted){
      for(searchIdx = 0; searchIdx < VERIFY_ORDER.length; searchIdx++){
        if(!this.stages.verify[VERIFY_ORDER[searchIdx]].completed){
          nextStage = VERIFY_ORDER[searchIdx]
          break;
        }
      }
      if(nextStage === undefined && searchIdx == VERIFY_ORDER.length){
        this.status.verifyCompleted = true;
      }
    }

    this.status.completed = this.status.calibCompleted && this.status.verifyCompleted;

    return nextStage;
  }

  async startNextStage() {
    var nextStage = this.checkStageProgress();
    if( nextStage !== undefined){
      this.status.lastStageStartTime = process.uptime();
      await this.runStage(nextStage);
    }
  }

  async runStage(stage) {
    var stageMethodName = camelCase("run_" + stage);

    var stageMethod = this[stageMethodName];

    if(stageMethod === undefined){
      console.log('Failed to select next stage to run');
      this.actualState = STATE_ERROR;
      return;
    }

    console.log("Running stage method: " + stageMethodName)
    // await this.rockhopperClient.waitForDoneAndIdle();
    this.status.currentStage = stage;
    await this.sendUpdate();
    try{
      if(this.processType === PROCESS_RESUME && LOADABLE_STAGES.has(stage) && checkSaveFileExists(stage)){
        console.log('Loading progress for stage ' + stage);
        this.loadStageProgress(stage);
        //dirty hack, wait here for 5 seconds and hope progress has finished loading
        //the problem is that when PROCESS_RESUME was implemented, progressing to next stage occured when a STAGE_COMPLETE
        //message was received from cmm-calib
        //so here in node we could just command the stage to start, and then the process was just listening to messages
        //now, we have implemented run_to_completion in rockhopper, which is used to run each stage, but we have not
        //created any programs for loading progress. Currently there are only owords, loadStageProgress calls them via mdi
        //an easy but verbose solution would be creating program files for each load_stage oword, and run them via run_to_completion
        await new Promise(r => setTimeout(r, 5000));
      }
      else{
        this.actualState = this.commandedState // commandedState should be either RUN or STEP at this point
        return await this[stageMethodName]()
      }
    }
    catch (err) {
      this.actualState = STATE_ERROR;
      console.log ('error:', err.message, err.stack)
    }
  }

  //STAGE METHODS
  async runEraseCompensation(){//TODO rename this stage to something more fitting, maybe SETUP_FILES
    console.log('runEraseCompensation');

    await copyDefaultOverlay(this.variant);
    await resetCalibDir();

    clearCompensationFiles();
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

    //This stage does not run any steps in cmm-calib.
    //Set stage completed and start next stage here, instead of waiting for message from cmm-calib
    this.status.lastStageCompleteTime = process.uptime();
    this.stages.calib[STAGES.ERASE_COMPENSATION].completed = true;
  }

  async runSetupCncCalib(){
    console.log('runSetupCncCalib');
    await this.rockhopperClient.estopCmdAsync(false);
    if(!this.rockhopperClient.state.homed){
      await this.rockhopperClient.homeAxisAsync();
    }

    //This stage does not run any steps in cmm-calib.
    //Set stage completed and start next stage here, instead of waiting for message from cmm-calib
    this.status.lastStageCompleteTime = process.uptime();
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
    await this.rockhopperClient.runToCompletion(`v2_calib_probe_spindle_pos_v2_${this.variant}.ngc`)
  }
  async runProbeFixtureBallPos(){
    console.log('runProbeFixtureBallPos');
    await this.rockhopperClient.runToCompletion('v2_calib_probe_fixture_ball_pos.ngc')
  }
  async runHomingX(){
    console.log('runHomingX');
    await this.rockhopperClient.runToCompletion('v2_calib_init_x_home_state.ngc')
    for(let idx = 0; idx < NUM_SAMPLES_HOME_REPEAT_LINEAR; idx++){
      console.log('runHomingX ' + idx);
      const x = (Math.random()*4.5-2)*25.4;
      console.log(`G53 G0 X${x}`);
      await this.rockhopperClient.mdiCmdAsync(`G53 G0 X${x}`);
      await this.rockhopperClient.unhomeAxisAsync([0]);
      await this.rockhopperClient.homeAxisAsync([0]);
      await this.rockhopperClient.runToCompletion('v2_calib_probe_x_home.ngc')
    }
    await this.rockhopperClient.runToCompletion('v2_calib_verify_x_home.ngc');
  }
  async runCharacterizeX(){
    console.log('runCharacterizeX');
    await this.rockhopperClient.runToCompletion('v2_calib_characterize_x.ngc');
  }
  async runCharacterizeXReverse(){
    console.log('runCharacterizeXReverse');
    await this.rockhopperClient.runToCompletion('v2_calib_characterize_x_reverse.ngc');
  }
  async runHomingY(){
    console.log('runHomingY');
    await this.rockhopperClient.runToCompletion('v2_calib_init_y_home_state.ngc')
    for(let idx = 0; idx < NUM_SAMPLES_HOME_REPEAT_LINEAR; idx++){
      console.log('runHomingY ' + idx);

      const y = (Math.random()*4-2)*25.4;
      console.log(`G53 G0 Y${y}`);

      await this.rockhopperClient.mdiCmdAsync(`G53 G0 Y${y}`);
      await this.rockhopperClient.unhomeAxisAsync([1]);
      await this.rockhopperClient.homeAxisAsync([1]);

      await this.rockhopperClient.runToCompletion('v2_calib_probe_y_home.ngc');
    }
    await this.rockhopperClient.runToCompletion('v2_calib_verify_y_home.ngc');
  }
  async runCharacterizeY(){
    console.log('runCharacterizeY');
    await this.rockhopperClient.runToCompletion('v2_calib_characterize_y.ngc');
  }
  async runCharacterizeYReverse(){
    console.log('runCharacterizeYReverse');
    await this.rockhopperClient.runToCompletion('v2_calib_characterize_y_reverse.ngc');
  }
  async runHomingZ(){
    console.log('runHomingZ');
    await this.rockhopperClient.runToCompletion('v2_calib_init_z_home_state.ngc')
    for(let idx = 0; idx < NUM_SAMPLES_HOME_REPEAT_LINEAR; idx++){
      console.log('runHomingZ ' + idx);
      const z = (-Math.random()*2.5-.5)*25.4;
      console.log(`G53 G0 Z${z}`);
      await this.rockhopperClient.mdiCmdAsync(`G53 G0 Z${z}`);
      await this.rockhopperClient.unhomeAxisAsync([2]);
      await this.rockhopperClient.homeAxisAsync([2]);
      await this.rockhopperClient.runToCompletion('v2_calib_probe_z_home.ngc')
    }
    await this.rockhopperClient.runToCompletion('v2_calib_verify_z_home.ngc');
  }
  async runCharacterizeZ(){
    console.log('runCharacterizeZ');
    await this.rockhopperClient.runToCompletion('v2_calib_characterize_z.ngc');
  }
  async runCharacterizeZReverse(){
    console.log('runCharacterizeZReverse');
    await this.rockhopperClient.runToCompletion('v2_calib_characterize_z_reverse.ngc');
  }
  async runProbeTopPlane(){
    console.log('runProbeTopPlane');
    await this.rockhopperClient.runToCompletion('v2_calib_probe_top_plane.ngc');
  }
  async runSetupCncCsy(){
    console.log('runSetupCncCsy');
    await this.rockhopperClient.runToCompletion('v2_calib_setup_cnc_csy.ngc');
  }
  async runProbeHomeOffsets(){
    console.log('runProbeHomeOffsets');
    await this.rockhopperClient.runToCompletion('v2_calib_probe_home_offsets.ngc');
  }
  async runHomingA(){
    console.log('runHomingA');
    await this.rockhopperClient.mdiCmdAsync(`G0 Y${Y_POS_PROBING}A0B0`);
    await this.rockhopperClient.runToCompletion('v2_calib_init_a_home_state.ngc')
    while(true){
      await Promise.all([ execPromise(`halcmd setp ini.3.home_offset 0` )]);
      var out = await Promise.all([ execPromise(`halcmd -s show pin ini.3.home_offset` )]);
      var idxStart = out[0].stdout.search("IN") + 2;
      var idxEnd = out[0].stdout.search("ini.3.home_offset");
      var curr = parseFloat(out[0].stdout.slice(idxStart, idxEnd))
      if(curr === 0.0){
        break;
      }
      else{
        console.log("Failed to zero A home offset");
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    for(let idx = 0; idx < NUM_SAMPLES_HOME_REPEAT_ROTARY; idx++){
      console.log('runHomingA ' + idx);
      const a = (Math.random()*25-5);
      await this.rockhopperClient.mdiCmdAsync(`G0 A${a}`);
      if( !this.checkContinueCurrentStage() ){
        return;
      }
      await this.rockhopperClient.unhomeAxisAsync([3]);
      if( !this.checkContinueCurrentStage() ){
        return;
      }
      await this.rockhopperClient.homeAxisAsync([3]);
      if( !this.checkContinueCurrentStage() ){
        return;
      }
      await this.rockhopperClient.runToCompletion('v2_calib_probe_a_home.ngc')
      if( !this.checkContinueCurrentStage() ){
        return;
      }
    }
    //ensure we've reset home_offset before moving on, a crash could occur otherwise
    while(true){
      await Promise.all([ execPromise(`halcmd -s setp ini.3.home_offset ${DEFAULT_A_HOME_OFFSET}` )]);
      var out = await Promise.all([ execPromise(`halcmd -s show pin ini.3.home_offset` )]);
      var idxStart = out[0].stdout.search("IN") + 2;
      var idxEnd = out[0].stdout.search("ini.3.home_offset");
      var curr = parseFloat(out[0].stdout.slice(idxStart, idxEnd))
      if(curr === DEFAULT_A_HOME_OFFSET){
        break;
      }
      else{
        console.log("Failed to reset A home offset");
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    await this.rockhopperClient.unhomeAxisAsync([3]);
    await this.rockhopperClient.homeAxisAsync([3]);
    await this.rockhopperClient.runToCompletion('v2_calib_go_to_clearance_y.ngc');
    await this.rockhopperClient.runToCompletion('v2_calib_verify_a_home.ngc');
  }
  async runHomingB(){
    console.log('runHomingB');
    await this.rockhopperClient.mdiCmdAsync(`G0 Y${Y_POS_PROBING}A0B0`);
    await this.rockhopperClient.runToCompletion('v2_calib_init_b_home_state.ngc')
    while(true){
      await Promise.all([ execPromise(`halcmd setp ini.4.home_offset 0` )]);
      var out = await Promise.all([ execPromise(`halcmd -s show pin ini.4.home_offset` )]);
      var idxStart = out[0].stdout.search("IN") + 2;
      var idxEnd = out[0].stdout.search("ini.4.home_offset");
      var curr = parseFloat(out[0].stdout.slice(idxStart, idxEnd))
      if(curr === 0){
        break;
      }
      else{
        console.log("Failed to zero B home offset");
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    for(let idx = 0; idx < NUM_SAMPLES_HOME_REPEAT_ROTARY; idx++){
      console.log('runHomingB ' + idx);
      const b = (Math.random()*40-20);
      await this.rockhopperClient.mdiCmdAsync(`G0 B${b}`);
      if( !this.checkContinueCurrentStage() ){
        return;
      }
      await this.rockhopperClient.unhomeAxisAsync([4]);
      if( !this.checkContinueCurrentStage() ){
        return;
      }
      await this.rockhopperClient.homeAxisAsync([4]);
      if( !this.checkContinueCurrentStage() ){
        return;
      }
      await this.rockhopperClient.runToCompletion('v2_calib_probe_b_home.ngc');
      await this.rockhopperClient.runToCompletion('v2_calib_go_to_clearance_z.ngc');
      if( !this.checkContinueCurrentStage() ){
        return;
      }
    }

    //ensure we've reset home_offset before moving on, a crash could occur otherwise
    while(true){
      await Promise.all([ execPromise(`halcmd -s setp ini.4.home_offset ${DEFAULT_B_HOME_OFFSET}` )]);
      var out = await Promise.all([ execPromise(`halcmd -s show pin ini.4.home_offset` )]);
      var idxStart = out[0].stdout.search("IN") + 2;
      var idxEnd = out[0].stdout.search("ini.4.home_offset");
      var curr = parseFloat(out[0].stdout.slice(idxStart, idxEnd))
      if(curr === DEFAULT_B_HOME_OFFSET){
        break;
      }
      else{
        console.log("Failed to reset B home offset");
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    await this.rockhopperClient.unhomeAxisAsync([4]);
    await this.rockhopperClient.homeAxisAsync([4]);

    await this.rockhopperClient.runToCompletion('v2_calib_verify_b_home.ngc');
    await this.rockhopperClient.runToCompletion('v2_calib_go_to_clearance_y.ngc');
  }
  async runCharacterizeASphere(){
    console.log('runCharacterizeASphere');
    await this.rockhopperClient.runToCompletion('v2_calib_characterize_a_sphere.ngc');
  }
  async runCharacterizeASphereReverse(){
    console.log('runCharacterizeASphereReverse');
    await this.rockhopperClient.runToCompletion('v2_calib_characterize_a_sphere_reverse.ngc');
  }
  async runCharacterizeBSphere(){
    console.log('runCharacterizeBSphere');
    await this.rockhopperClient.runToCompletion('v2_calib_characterize_b_sphere.ngc');
  }
  async runCharacterizeBSphereReverse(){
    console.log('runCharacterizeBSphereReverse');
    await this.rockhopperClient.runToCompletion('v2_calib_characterize_b_sphere_reverse.ngc');
  }
  async runCharacterizeALine(){
    console.log('runCharacterizeALine');
    await this.rockhopperClient.runToCompletion('v2_calib_characterize_a_line.ngc');
  }
  async runCharacterizeALineReverse(){
    console.log('runCharacterizeALineReverse');
    await this.rockhopperClient.runToCompletion('v2_calib_characterize_a_line_reverse.ngc');
  }
  async runCharacterizeBLine(){
    console.log('runCharacterizeBLine');
    await this.rockhopperClient.runToCompletion('v2_calib_characterize_b_line.ngc');
  }
  async runCharacterizeBLineReverse(){
    console.log('runCharacterizeBLineReverse');
    await this.rockhopperClient.runToCompletion('v2_calib_characterize_b_line_reverse.ngc');
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
    this.status.lastStageCompleteTime = process.uptime();
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
    this.status.lastStageCompleteTime = process.uptime();
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
  async runToolProbeOffset() {
    console.log('runToolProbeOffset');
    /*
    perform a tool probe
    move for clearance
    at position where tool probe touch occurred, probe spindle tip with CMM
    probe the fixture plane at Y0 A90
    calculate PROBE_SENSOR_123_OFFSET
    use difference in Z-position between this spindle position and the plane at Y0A90 to calculate PROBE_SENSOR_123_OFFSET
    PROBE_SENSOR_123_OFFSET = TOOL_PROBE_Z - (FIXTURE_PLANE_Z - 1" + 3") (minus 1" for fixture thickness, plus 3" for long side of 123 block)
    */

    // perform a tool probe
    // clearXYZFile()

    await this.rockhopperClient.runToCompletion('v2_calib_tool_probe_offset.ngc');
  }
  async runVerifyAHoming(){
    console.log('runVerifyAHoming');
    await this.rockhopperClient.mdiCmdAsync(`G0 Y${Y_POS_PROBING}`);

    for(let idx = 0; idx < NUM_SAMPLES_HOME_REPEAT_ROTARY; idx++){
      const goto = A_HOMING_POSITIONS[idx%A_HOMING_POSITIONS.length]
      await this.rockhopperClient.mdiCmdAsync(`G0 A${goto}`);
      if( !this.checkContinueCurrentStage() ){
        return;
      }
      await this.rockhopperClient.unhomeAxisAsync([3]);
      if( !this.checkContinueCurrentStage() ){
        return;
      }
      await this.rockhopperClient.homeAxisAsync([3]);
      if( !this.checkContinueCurrentStage() ){
        return;
      }
      await this.rockhopperClient.runToCompletion('v2_calib_probe_a_home_verify.ngc')
      if( !this.checkContinueCurrentStage() ){
        return;
      }
    }
    await this.rockhopperClient.runToCompletion('v2_calib_verify_a_home.ngc');
  }
  async runVerifyA(){
    console.log('runVerifyA');

    while(true){
      var out = await Promise.all([ execPromise(`halcmd -s show pin ini.3.home_offset` )]);
      var idxStart = out[0].stdout.search("IN") + 2;
      var idxEnd = out[0].stdout.search("ini.3.home_offset");
      var curr = parseFloat(out[0].stdout.slice(idxStart, idxEnd));

      var aHomeOffset = curr + this.managerStatus.a_home.avg

      await Promise.all([ execPromise(`halcmd -s setp ini.3.home_offset ${aHomeOffset}` )]);
      
      break;
      // var out = await Promise.all([ execPromise(`halcmd -s show pin ini.4.home_offset` )]);
      // var idxStart = out[0].stdout.search("IN") + 2;
      // var idxEnd = out[0].stdout.search("ini.4.home_offset");
      // var curr = parseFloat(out[0].stdout.slice(idxStart, idxEnd))
      // if(curr === 0.0){
      //   break;
      // }
      // else{
      //   console.log("Failed to zero A home offset");
      //   await new Promise(r => setTimeout(r, 1000));
      // }
    }

    await this.rockhopperClient.mdiCmdAsync(`G0 A0Y${Y_POS_PROBING}`);
    var homingAttemptsCount = 0;
    var threshold = ROTARY_VERIFICATION_HOMING_ERROR_THRESHOLD; //TODO remove
    while(true){
      await this.rockhopperClient.runToCompletion('v2_calib_probe_a_home_verify.ngc')

      if( !this.checkContinueCurrentStage() ){
        return;
      }
      // if(Math.abs(this.managerStatus.a_home_err) < ROTARY_VERIFICATION_HOMING_ERROR_THRESHOLD){
      if(Math.abs(this.managerStatus.a_home_err) < threshold){ //TODO remove and uncomment above line
        console.log("VERIFY_A home position within range, error " + this.managerStatus.a_home_err);
        break;
      }

      homingAttemptsCount++;
      if(homingAttemptsCount > NUM_VERIFY_HOME_ATTEMPTS){
        console.log("Halting A-axis homing verification, failed to achieve home position with error <0.01 in 10 attempts");
        threshold = threshold * 10; //TODO change this so process stops. Delete this threshold expansion and uncomment next 3 lines
        // this.actualState = STATE_FAIL
        // this.stages.verify[STAGES.VERIFY_A].failed = true
        // return;
      }
      await this.rockhopperClient.mdiCmdAsync("G0 A-5");
      await this.rockhopperClient.unhomeAxisAsync([3]);
      await this.rockhopperClient.homeAxisAsync([3]);
    }
    await this.rockhopperClient.runToCompletion('v2_calib_verify_a.ngc');
  }
  async runVerifyBHoming(){
    console.log('runVerifyBHoming');
    await this.rockhopperClient.mdiCmdAsync(`G0 Y${Y_POS_PROBING}`);

    for(let idx = 0; idx < NUM_SAMPLES_HOME_REPEAT_ROTARY; idx++){
      const goto = B_HOMING_POSITIONS[idx%B_HOMING_POSITIONS.length]
      await this.rockhopperClient.mdiCmdAsync(`G0 B${goto}`);
      if( !this.checkContinueCurrentStage() ){
        return;
      }
      await this.rockhopperClient.unhomeAxisAsync([4]);
      if( !this.checkContinueCurrentStage() ){
        return;
      }
      await this.rockhopperClient.homeAxisAsync([4]);
      if( !this.checkContinueCurrentStage() ){
        return;
      }
      await this.rockhopperClient.runToCompletion('v2_calib_probe_b_home_verify.ngc');
      if( !this.checkContinueCurrentStage() ){
        return;
      }
    }

    await this.rockhopperClient.runToCompletion('v2_calib_verify_b_home.ngc');
    
  }
  async runVerifyB(){
    console.log('runVerifyB');

    while(true){
      var out = await Promise.all([ execPromise(`halcmd -s show pin ini.4.home_offset` )]);
      var idxStart = out[0].stdout.search("IN") + 2;
      var idxEnd = out[0].stdout.search("ini.4.home_offset");
      var curr = parseFloat(out[0].stdout.slice(idxStart, idxEnd));

      var bHomeOffset = curr + this.managerStatus.b_home.avg

      await Promise.all([ execPromise(`halcmd -s setp ini.4.home_offset ${bHomeOffset}` )]);
      
      break;
      // var out = await Promise.all([ execPromise(`halcmd -s show pin ini.4.home_offset` )]);
      // var idxStart = out[0].stdout.search("IN") + 2;
      // var idxEnd = out[0].stdout.search("ini.4.home_offset");
      // var curr = parseFloat(out[0].stdout.slice(idxStart, idxEnd))
      // if(curr === 0.0){
      //   break;
      // }
      // else{
      //   console.log("Failed to zero A home offset");
      //   await new Promise(r => setTimeout(r, 1000));
      // }
    }

    var homingAttemptsCount = 0;
    var threshold = ROTARY_VERIFICATION_HOMING_ERROR_THRESHOLD; //TODO remove
    while(true){
      await this.rockhopperClient.runToCompletion('v2_calib_probe_b_home_verify.ngc')
      if( !this.checkContinueCurrentStage() ){
        return;
      }
      // if(Math.abs(this.managerStatus.b_home_err) < ROTARY_VERIFICATION_HOMING_ERROR_THRESHOLD){
      if(Math.abs(this.managerStatus.b_home_err) < threshold){ //TODO remove and uncomment above line
        console.log("VERIFY_B home position within range, error " + this.managerStatus.b_home_err);
        break;
      }

      homingAttemptsCount++;
      if(homingAttemptsCount > NUM_VERIFY_HOME_ATTEMPTS){
        console.log("Halting B-axis homing verification, unable to achieve home position with error <0.01");
        threshold = threshold * 10; //TODO delete this and uncomment next 3 lines
        // this.actualState = STATE_FAIL
        // this.stages.verify[STAGES.VERIFY_B].failed = true
        // return;
      }
      await this.rockhopperClient.mdiCmdAsync("G0 B-5");
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
  async runUploadFiles(){
    console.log('runUploadFiles');

    var date = new Date();
    let year = date.getFullYear();
    let month = date.getMonth() + 1;
    let day = date.getDate();

    var detailsName = ["details", this.serialNum, year, month, day].join("-") + ".zip";
    var resultsName = ["calib", this.serialNum, year, month, day].join("-") + ".zip";

    zipDirectory(RESULTS_DIR, POCKETNC_VAR_DIRECTORY + "/" + resultsName).then(() => {}).catch((err) => (console.log('Error zipping results dir' + err)));
    zipDirectory(CALIB_DIR, POCKETNC_VAR_DIRECTORY + "/" + detailsName).then(() => {}).catch((err) => (console.log('Error zipping calib dir' + err)));
    const client = new ftp.Client();
    try {
      await client.access({
        host: "10.0.0.10",
        port: 5000
      });

      await client.uploadFrom(POCKETNC_VAR_DIRECTORY + "/" + resultsName, resultsName);
      await client.uploadFrom(POCKETNC_VAR_DIRECTORY + "/" + detailsName, detailsName);
    } catch(err) {
      console.log(err);
    }

    client.close();
  }

  async runTestProgram() {
    console.log('runWriteVerify');
    await this.rockhopperClient.runToCompletion('v2_calib_test.ngc');
  }
}

module.exports = {
  CalibProcess
};
