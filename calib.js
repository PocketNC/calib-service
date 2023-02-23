//TODO revert expanded threshold on rotary homing error that was put in place to allow data gathering runs to complete despite small errors in home position
const util = require("util");
const { exec } = require("child_process");
const execPromise = util.promisify(exec);
const fs = require('fs');
const camelCase = require('to-camel-case');
const { RockhopperClient } = require('./rockhopper');
const { CommandServer } = require('./command-server');
const ftp = require("basic-ftp");
const archiver = require('archiver');


const POCKETNC_DIRECTORY = process.env.POCKETNC_DIRECTORY;
const POCKETNC_VAR_DIRECTORY = process.env.POCKETNC_VAR_DIRECTORY;
const A_COMP_PATH = POCKETNC_VAR_DIRECTORY + '/a.comp';
const B_COMP_PATH = POCKETNC_VAR_DIRECTORY + '/b.comp';
const OVERLAY_PATH = POCKETNC_VAR_DIRECTORY + '/CalibrationOverlay.inc';
const CALIB_DIR = POCKETNC_VAR_DIRECTORY + "/calib";
const STAGES_DIR = CALIB_DIR + "/stages";
const RESULTS_DIR = POCKETNC_VAR_DIRECTORY + "/calib_results";
const SERVICE_LOG = CALIB_DIR + '/calib-service.log';
const PYTHON_LOG = POCKETNC_VAR_DIRECTORY + '/python.log';
const ROCKHOPPER_LOG = "/var/log/linuxcnc_webserver.log";
const DEFAULT_A_COMP_PATH = POCKETNC_DIRECTORY + '/Settings/a.comp.default';
const DEFAULT_B_COMP_PATH = POCKETNC_DIRECTORY + '/Settings/b.comp.default';
const DEFAULT_10_OVERLAY_PATH = POCKETNC_DIRECTORY + '/Settings/CalibrationOverlay.inc.default';
const DEFAULT_50_OVERLAY_PATH = POCKETNC_DIRECTORY + '/Settings/features/high_speed_spindle/CalibrationOverlay.inc.default';
const XYZ_FILE_PATH = POCKETNC_VAR_DIRECTORY + '/xyz.txt';

const BASIC_STAGE_LIST = [
  "ERASE_COMPENSATION", 
  "SETUP_CMM", 
  "PROBE_MACHINE_POS", 
  "PROBE_SPINDLE_POS", 
  "HOMING_X", 
  "CHARACTERIZE_X", 
  "HOMING_Z", 
  "CHARACTERIZE_Z",
  "PROBE_FIXTURE_BALL_POS", 
  "HOMING_Y", 
  "CHARACTERIZE_Y", 
  "PROBE_OFFSETS",
  "HOMING_A", 
  "HOMING_B", 
  "CHARACTERIZE_A_LINE", 
  "CHARACTERIZE_B_LINE",
  "CALIBRATE",
  "VERIFY_OFFSETS",
  "VERIFY_A_LINE", 
  "VERIFY_B_LINE",
  "UPLOAD_FILES"
];
const ADVANCED_STAGE_LIST = ["ERASE_COMPENSATION", "SETUP_CMM", "PROBE_MACHINE_POS", "PROBE_SPINDLE_POS", "HOMING_X", "CHARACTERIZE_X", "HOMING_Z", "CHARACTERIZE_Z", "PROBE_FIXTURE_BALL_POS", "HOMING_Y", "CHARACTERIZE_Y", "PROBE_TOP_PLANE", "PROBE_HOME_OFFSETS", "HOMING_A", "HOMING_B", "CHARACTERIZE_A_LINE", "CHARACTERIZE_B_LINE", "TOOL_PROBE_OFFSET", "PRODUCE_CALIBRATION", "APPLY_CALIBRATION", "RESTART_CNC", "VERIFY_X", "VERIFY_Y", "VERIFY_Z", "VERIFY_A", "VERIFY_B"];

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
  fs.writeFileSync(SERVICE_LOG, "");
};
async function deleteProgressFiles() {
  await execPromise(`rm -f ${CALIB_DIR}/Stages.*` );
}
async function deleteSaveFiles() {
  await execPromise(`rm -f cnc_csy_savefile part_csy_savefile`, {cwd: `${CALIB_DIR}`} );
}
async function deleteDataFiles() {
  await execPromise(`rm -f CalibrationOverlay.inc a.comp a.comp.raw a.err b.comp b.comp.raw b.err ver_a.err ver_b.err`, {cwd: `${CALIB_DIR}`}  );
}
async function resetCalibDir() {
  await clearLogFiles();

  //Make a backup of the initial CalibrationOverlay, which is in effect until restart for verify
  await copyExistingOverlay();

  await deleteProgressFiles();
  await deleteSaveFiles();
  await deleteDataFiles();
}
async function copyDefaultOverlay(v2variant) {
  if(v2variant === "50"){
    await execPromise(`cp ${DEFAULT_50_OVERLAY_PATH} ${OVERLAY_PATH}`);
    return true
  }
  else if(v2variant === "10"){
    await execPromise(`cp ${DEFAULT_10_OVERLAY_PATH} ${OVERLAY_PATH}`);
    return true
  }
  else{console.log('v2variant type not specified, failed to copy'); return false}
}
async function copyDefaultCompensation() {
  await Promise.all([ execPromise(`cp ${DEFAULT_A_COMP_PATH} ${A_COMP_PATH}`),  
                      execPromise(`cp ${DEFAULT_B_COMP_PATH} ${B_COMP_PATH}`)]);
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
  console.log('checkSaveFileExists', filename)
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
//These STATE_ constants are used to set value of CalibProcess.stateRequested and CalibProcess.processState
const STATE_INIT = "INIT" //If configuration does not begin process immediately on startup. Currently not used
const STATE_IDLE = "IDLE" //In between stages. Enter this state if stateRequested is STATE_STEP upon completion of a stage
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
  constructor(serialNum, v2variant, processType) {
    console.log(`serialNum **${serialNum}**`);
    console.log(`v2variant **${v2variant}**`);
    this.serialNum = serialNum;
    if(v2variant !== V2_10 && v2variant !== V2_50) {
      throw new Error(`v2variant must be "${V2_10}" or "${V2_50}"`);
    }
    this.v2variant = v2variant;
    if(!["BASIC", "ADVANCED"].includes(processType)) {
      throw new Error(`processType must be BASIC or ADVANCED"`);
    }
    this.processType = processType;
    this.stageList = processType === "BASIC" ? BASIC_STAGE_LIST : ADVANCED_STAGE_LIST;

    this.linuxcnc_updates = {};

    this.status = {
      processType: null,
      cmmConnected: false,
      cmmError: false,
      cncError: false,
      currentStep: null,
      currentStage: null,
      specFailure: false,
      error: false,
      errorMsg: null,
      calibCompleted: false,
      verifyCompleted: false,
      completed: false,
    }

    this.rockhopperClient = new RockhopperClient();
    this.rockhopperClient.connect();
    const watchErrorStatusItem = (msg) => {
      if(msg.id === "LOGIN_ID" && msg.code === "?OK") {
        this.rockhopperClient.watch("error", "WATCH_ERROR_ID", this.errorCallback.bind(this));
      }
    }
    this.rockhopperClient.registerCallback("LOGIN_ID", watchErrorStatusItem);

    this.aHomeErr = null;
    this.bHomeErr = null;

    this.currentStep, this.currentStage = undefined;
    
    this.managerStatus = {};

    this.stateRequested = STATE_IDLE
    this.processState = STATE_IDLE

    this.readyForVerify = false;
    this.commandServer = new CommandServer(this);

    this.stageIdx = 0;
    this.lastStageCompleteIdx = -1;
    this.currentStageIdx = -1;

    this.error = null;
    this.errorMsg = null;
  }

  async runStages(startIdx){
    this.stateRequested = STATE_RUN;
    this.processState = STATE_RUN;
    var stageIdx;
    for(stageIdx = startIdx; stageIdx <= this.stageList.length-1; stageIdx++){
      const [shouldContinue, newState] = this.checkStartNextStage()
      if( !shouldContinue ){
        console.log(`Halting Calib process, reason ${newState}`)
        this.processState = newState;
        await this.sendUpdate();
        if( [STATE_STOP].includes(this.processState)){
          process.exit(0);
        }
        break;
      }
      var stage = this.stageList[stageIdx];
      console.log(`Running stage ${stage}`);
      this.currentStage = stage;
      this.currentStageIdx = stageIdx;

      var stageMethodName = camelCase("run_" + stage);
      console.log('stageMethodName', stageMethodName)
      await this.sendUpdate();
      try{
        if(this[stageMethodName]){
          console.log('running custom method', stageMethodName)
          await this[stageMethodName]();
        }
        else{
          console.log('running std method', stageMethodName)
          await this.runStdStage(stage);
        }
        this.lastStageCompleteIdx = stageIdx;
        if(this.lastStageCompleteIdx === this.stageList.length-1){
          this.processState = STATE_COMPLETE;
          await this.sendUpdate();
          process.exit(0);
        }
      }
      catch (err) {
        this.processState = STATE_ERROR;
        this.error = true;
        this.errorMsg = err.toString();

        this.uploadErrorFiles()

        console.log(err);
        console.log('ERROR running stage:', stage);
        break;
      }  
    }
  }

  async backupExistingStageData(stageDir){
    console.log(`backupExistingStageData ${stageDir}`)
    if(fs.existsSync(stageDir)){
      var numBackups = 0;
      var backupDir = stageDir + "." + numBackups.toString();
      while(fs.existsSync(backupDir))
      {
        numBackups++;
        backupDir = stageDir + "." + numBackups.toString();
      }
      
      console.log(`backupExistingStageData ${backupDir}`)
      await fs.cp(stageDir, backupDir, {recursive: true},(err) => {if (err) {console.error(`Error during backup of existing stage ${err}`)}});
    }
  }

  //TODO also save the actual active home offset values from halcmd
  async saveMachineState(stageDir){
    try{
      await fs.copyFile(OVERLAY_PATH, stageDir + "/CalibrationOverlay.inc", (err) => {console.log(err)})
      await fs.copyFile(A_COMP_PATH, stageDir + "/a.comp", (err) => {console.log(err)})
      await fs.copyFile(B_COMP_PATH, stageDir + "/b.comp", (err) => {console.log(err)})
    } catch(error) {
      console.log(`Error saving machine state ${error}`)
    }
  }

  async performActionIfOk(action){
    if( this.error ){
      throw Error(`Error detected ${this.errorMsg}, bailing on action ${action} in stage ${this.currentStage}`)
    }
    await action()
  }


  async cmdRun() {
    console.log('cmdRun')
    this.stateRequested = STATE_RUN;
    if ([STATE_INIT, STATE_IDLE].includes(this.processState)){
      await this.runProcess();
    }
    else if ([STATE_PAUSE].includes(this.processState)){
      //Continue from mid-stage pause
      //Eventually, PAUSE state could be mid-stage. Currently, PAUSE means "run until current stage finishes", so for now, continuing from pause is the same as continuing from idle
      await this.runProcess();
    }
    else if([STATE_ERROR, STATE_FAIL].includes(this.processState)){
      //Can't run after error, return message
      //TODO return message
    }
    else if([STATE_STOP].includes(this.processState)){
      //Can't run after stop, return message
      //TODO return message
    }
    else if([STATE_STEP].includes(this.processState)){
      //Currently running a single stage, just change processState so that
      //process auto-continues upon completion of current stage
      this.processState = STATE_RUN;
    }
    await this.sendUpdate();
  }
  async cmdResume() {
    console.log('cmdResume')
    this.stateRequested = STATE_RUN;
    if ([STATE_INIT, STATE_IDLE].includes(this.processState)){
      await this.runStages(startIdx=this.lastStageCompleteIdx+1);
    }
    else if ([STATE_PAUSE].includes(this.processState)){
      //TODO enable continue from mid-stage pause
      //Eventually, PAUSE state could be mid-stage. Currently, PAUSE means "run until current stage finishes", so for now, continuing from pause is the same as continuing from idle
      await this.runStages(startIdx=this.lastStageCompleteIdx+1);
    }
    else if([STATE_ERROR, STATE_FAIL].includes(this.processState)){
      //Need to clear error state before can resume
      //TODO return message
    }
    else if([STATE_STOP].includes(this.processState)){
      //Currently stopped, start from the beginning
      await this.runStages(startIdx=0);
    }
    else if([STATE_STEP, STATE_RUN].includes(this.processState)){
      //Currently running, can't resume
      //TODO return message

    }
    await this.sendUpdate();
  }
  async cmdStep() {
    this.stateRequested = STATE_STEP;
    if ([STATE_INIT, STATE_IDLE].includes(this.processState)){
      await this.startNextStage();
    }
    else if ([STATE_PAUSE].includes(this.processState)){
      //Continue from mid-stage pause
      //TODO return message
    }
    else if([STATE_ERROR, STATE_FAIL].includes(this.processState)){
      //Can't run after error, return message
      //TODO return message
    }
    else if([STATE_STOP].includes(this.processState)){
      //Can't run after stop, return message
      //TODO return message
    }
    else if([STATE_RUN].includes(this.processState)){
      //Currently running stages automatically, just change processState so that
      //process idles upon completion of current stage
      this.processState = STATE_STEP;
    }
    await this.sendUpdate();
  }
  async cmdPause() {
    console.log('cmdPause')
    this.stateRequested = STATE_PAUSE;
    if ([STATE_INIT, STATE_IDLE].includes(this.processState)){
      //Can't pause before starting
      //TODO return message
    }
    else if([STATE_ERROR, STATE_FAIL].includes(this.processState)){
      //Already stopped, nothing happening to pause
      //TODO return message
    }
    else if([STATE_STOP].includes(this.processState)){
      //Already stopped, nothing happening to pause
      //TODO return message
    }
    else if([STATE_STEP, STATE_RUN].includes(this.processState)){
      //Currently running
      //TODO implement more immediate PAUSE
      //For now, we just change commanded state and wait for current stage to complete
    }
    await this.sendUpdate();
  }
  async cmdStop() {
    //Terminate the calibration
    console.log('CmdStop, processState is ' + this.processState);
    this.stateRequested = STATE_STOP;
    await this.sendUpdate();
    if ([STATE_INIT, STATE_IDLE, STATE_COMPLETE, STATE_STOP].includes(this.processState)){
      //Already idle. Exit process
      process.exit(0);
    }
    else if([STATE_PAUSE].includes(this.processState)){
      process.exit(0);
    }
    else if([STATE_ERROR, STATE_FAIL].includes(this.processState)){
      //Already idle. Exit process
      process.exit(0);
    }
    else if([STATE_STEP, STATE_RUN].includes(this.processState)){
      //Currently running
      //TODO implement more immediate STOP
      //For now, we just change commanded state and wait for current stage to complete.
      //In runProcess the commanded state is checked after each stage complete
    }
  }
  async getStatus() {
    return {'stages': this.stages}
  }
  checkError(){
    if(this.error){
      return false;
    }
    return true;
  }
  checkContinueCurrentStage() {
    return this.checkError()
  }

  checkStartNextStage() {
    if(this.error){
      return [false,STATE_ERROR];
    }
    else if(this.stateRequested === STATE_PAUSE){
      return [false,STATE_PAUSE]
    }
    else if(this.stateRequested === STATE_STOP){
      return [false,STATE_STOP]
    }

    return [true,''];
  }

  async runProcess() {
    console.log('runProcess')
    this.processState = STATE_RUN;
    while(this.checkAutoProgressStage()){
      console.log('Running process, OK to continue. Starting next stage.')
      await this.startNextStage();
      await this.sendUpdate();
    }

    if(this.status.completed){
      this.processState = STATE_COMPLETE
      await this.sendUpdate();
    }
    else if(this.stateRequested === STATE_PAUSE){
      //earlier we received a cmdPause, but must have been mid-stage. Now we have returned from running that stage and can pause
      this.processState = STATE_PAUSE;
    }
    else if(this.stateRequested === STATE_STOP){
      //earlier we received a cmdStop, but must have been mid-stage. Now we have returned from running that stage and can exit
      process.exit(0);
    }
    else if(this.stateRequested === STATE_RUN && this.processState === STATE_RUN){
      //Exiting loop but have not finished, not stopping, and still in STATE_RUN. Something is wrong
      this.processState = STATE_ERROR
      this.status.error = true;
      this.status.errorMsg = "Unable to start next stage";
      await this.sendUpdate();
    }
  }

  async receiveUpdate(msg) {
    console.log('zmq message')
    console.log(msg)
    for(const prop in msg){
      this.linuxcnc_updates[prop] = msg[prop];
    }
  }

  async sendUpdate() {
    var update = {};
    update.stateRequested = this.stateRequested;
    update.processState = this.processState;
    update.stages = this.stages;
    update.status = this.status;
    update.status.currentStageIdx = this.currentStageIdx;
    update.status.currentStage = this.currentStageIdx === -1 ? "Not Started" : BASIC_STAGE_LIST[this.currentStageIdx];
    update.managerStatus = this.managerStatus;
    update.spec = this.spec;
    this.commandServer.send({'calibStatus': update});
  }

  async errorCallback(msg) {
    console.log("in error callback", msg);
    if(msg.data.type && msg.data.type === 'error'){
      this.error = true;
      this.errorMsg = msg.data.text;

      //Send an extra abort to Rockhopper, timing issues mean we could have started the next thing before this message arrived
      await this.rockhopperClient.abortCmd();

      this.uploadErrorFiles();
    }
  }

  
  //STAGE METHODS
  async runStdStage(stage){
    await this.performActionIfOk(() => {
      var stageProgramFile = `v2_calib_${stage.toLowerCase()}.ngc`
      console.log(`Running standard stage ${stage}, file ${stageProgramFile}`);
      return this.rockhopperClient.runToCompletion(stageProgramFile);
    });
  }
  //Most stages consist of a single G-code program, but some require an additional layer of control so have custom methods here
  async runEraseCompensation(){//TODO rename this stage to something more fitting, maybe SETUP_FILES
    console.log('runEraseCompensation');

    // Set static IP address
    await execPromise('connmanctl config $(connmanctl services | egrep -o "ethernet.*$") --ipv4 manual 10.0.0.100 255.255.255.0');

    await copyDefaultOverlay(this.v2variant);
    await copyDefaultCompensation();
    await resetCalibDir();

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
    
    await this.performActionIfOk(() => this.rockhopperClient.estopCmdAsync(false));
    if(!this.rockhopperClient.state.homed){
      await this.performActionIfOk(() => this.rockhopperClient.homeAxisAsync());
    }
    
  }
  async runProbeSpindlePos(){
    console.log('runProbeSpindlePos');
    await this.performActionIfOk(() => 
      this.rockhopperClient.runToCompletion(`v2_calib_probe_spindle_pos_v2_${this.v2variant}.ngc`)
    );
  }
  async runHomingX(){
    console.log('runHomingX');
    await this.performActionIfOk(() => this.rockhopperClient.runToCompletion('v2_calib_init_x_home_state.ngc'))
    for(let idx = 0; idx < NUM_SAMPLES_HOME_REPEAT_LINEAR; idx++){
      console.log('runHomingX ' + idx);
      const x = (Math.random()*4.5-2)*25.4;
      console.log(`G53 G0 X${x}`);
      await this.performActionIfOk(() => this.rockhopperClient.mdiCmdAsync(`G53 G0 X${x}`));
      await this.performActionIfOk(() => this.rockhopperClient.unhomeAxisAsync([0]));
      await this.performActionIfOk(() => this.rockhopperClient.homeAxisAsync([0]));
      await this.performActionIfOk(() => this.rockhopperClient.runToCompletion('v2_calib_probe_x_home.ngc'))
    }
    await this.performActionIfOk(() => this.rockhopperClient.runToCompletion('v2_calib_verify_x_home.ngc'));
  }
  async runHomingY(){
    console.log('runHomingY');
    await this.performActionIfOk(() => this.rockhopperClient.runToCompletion('v2_calib_init_y_home_state.ngc'));
    for(let idx = 0; idx < NUM_SAMPLES_HOME_REPEAT_LINEAR; idx++){
      console.log('runHomingY ' + idx);

      const y = (Math.random()*4-2)*25.4;
      console.log(`G53 G0 Y${y}`);

      await this.performActionIfOk(() => this.rockhopperClient.mdiCmdAsync(`G53 G0 Y${y}`));
      await this.performActionIfOk(() => this.rockhopperClient.unhomeAxisAsync([1]));
      await this.performActionIfOk(() => this.rockhopperClient.homeAxisAsync([1]));

      await this.performActionIfOk(() => this.rockhopperClient.runToCompletion('v2_calib_probe_y_home.ngc'));
    }
    await this.performActionIfOk(() => this.rockhopperClient.runToCompletion('v2_calib_verify_y_home.ngc'));
  }
  async runHomingZ(){
    console.log('runHomingZ');
    await this.performActionIfOk(() => this.rockhopperClient.runToCompletion('v2_calib_init_z_home_state.ngc'));
    for(let idx = 0; idx < NUM_SAMPLES_HOME_REPEAT_LINEAR; idx++){
      console.log('runHomingZ ' + idx);
      const z = (-Math.random()*2.5-.5)*25.4;
      console.log(`G53 G0 Z${z}`);
      await this.performActionIfOk(() => this.rockhopperClient.mdiCmdAsync(`G53 G0 Z${z}`));
      await this.performActionIfOk(() =>  this.rockhopperClient.unhomeAxisAsync([2]));
      await this.performActionIfOk(() =>  this.rockhopperClient.homeAxisAsync([2]));
      await this.performActionIfOk(() =>  this.rockhopperClient.runToCompletion('v2_calib_probe_z_home.ngc'));
    }
    await this.performActionIfOk(() => this.rockhopperClient.runToCompletion('v2_calib_verify_z_home.ngc'));
  }
  async runHomingA(){
    console.log('runHomingA');
    await this.performActionIfOk(() => this.rockhopperClient.mdiCmdAsync(`G0 Y${Y_POS_PROBING}A0B0`));
    await this.performActionIfOk(() => this.rockhopperClient.runToCompletion('v2_calib_init_a_home_state.ngc'));
    while(true){
      await execPromise(`halcmd setp ini.3.home_offset 0`);
      var out = await execPromise(`halcmd -s show pin ini.3.home_offset` );
      var idxStart = out.stdout.search("IN") + 2;
      var idxEnd = out.stdout.search("ini.3.home_offset");
      var curr = parseFloat(out.stdout.slice(idxStart, idxEnd))
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
      await this.performActionIfOk(() => this.rockhopperClient.mdiCmdAsync(`G0 A${a}`));
      await this.performActionIfOk(() => this.rockhopperClient.unhomeAxisAsync([3]));
      await this.performActionIfOk(() => this.rockhopperClient.homeAxisAsync([3]));
      await this.performActionIfOk(() => this.rockhopperClient.runToCompletion('v2_calib_probe_a_home.ngc'));
    }
    //ensure we've reset home_offset before moving on, a crash could occur otherwise
    while(true){
      await execPromise(`halcmd -s setp ini.3.home_offset ${DEFAULT_A_HOME_OFFSET}` );
      var out = await execPromise(`halcmd -s show pin ini.3.home_offset` );
      var idxStart = out.stdout.search("IN") + 2;
      var idxEnd = out.stdout.search("ini.3.home_offset");
      var curr = parseFloat(out.stdout.slice(idxStart, idxEnd))
      if(curr === DEFAULT_A_HOME_OFFSET){
        break;
      }
      else{
        console.log("Failed to reset A home offset");
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    await this.performActionIfOk(() => this.rockhopperClient.unhomeAxisAsync([3]));
    await this.performActionIfOk(() => this.rockhopperClient.homeAxisAsync([3]));
    await this.performActionIfOk(() => this.rockhopperClient.runToCompletion('v2_calib_go_to_clearance_y.ngc'));
    await this.performActionIfOk(() => this.rockhopperClient.runToCompletion('v2_calib_verify_a_home.ngc'));
  }
  async runHomingB(){
    console.log('runHomingB');
    await this.performActionIfOk(() => this.rockhopperClient.mdiCmdAsync(`G0 Y${Y_POS_PROBING}A0B0`));
    await this.performActionIfOk(() => this.rockhopperClient.runToCompletion('v2_calib_init_b_home_state.ngc'))
    while(true){
      await execPromise(`halcmd setp ini.4.home_offset 0` );
      var out = await execPromise(`halcmd -s show pin ini.4.home_offset` );
      var idxStart = out.stdout.search("IN") + 2;
      var idxEnd = out.stdout.search("ini.4.home_offset");
      var curr = parseFloat(out.stdout.slice(idxStart, idxEnd))
      if(curr === 0){
        break;
      }
      else{
        console.log("Failed to zero B home offset");
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    
    await this.performActionIfOk(() => this.rockhopperClient.runToCompletion('v2_calib_go_to_clearance_z.ngc'));
    for(let idx = 0; idx < NUM_SAMPLES_HOME_REPEAT_ROTARY; idx++){
      console.log('runHomingB ' + idx);
      const b = (Math.random()*40-20);
      await this.performActionIfOk(() => this.rockhopperClient.mdiCmdAsync(`G0 B${b}`));
      await this.performActionIfOk(() => this.rockhopperClient.unhomeAxisAsync([4]));
      await this.performActionIfOk(() => this.rockhopperClient.homeAxisAsync([4]));
      await this.performActionIfOk(() => this.rockhopperClient.runToCompletion('v2_calib_probe_b_home.ngc'));
      await this.performActionIfOk(() => this.rockhopperClient.runToCompletion('v2_calib_go_to_clearance_z.ngc'));
    }

    //ensure we've reset home_offset before moving on, a crash could occur otherwise
    while(true){
      await execPromise(`halcmd -s setp ini.4.home_offset ${DEFAULT_B_HOME_OFFSET}` );
      var out = await execPromise(`halcmd -s show pin ini.4.home_offset` );
      var idxStart = out.stdout.search("IN") + 2;
      var idxEnd = out.stdout.search("ini.4.home_offset");
      var curr = parseFloat(out.stdout.slice(idxStart, idxEnd))
      if(curr === DEFAULT_B_HOME_OFFSET){
        break;
      }
      else{
        console.log("Failed to reset B home offset");
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    await this.performActionIfOk(() => this.rockhopperClient.unhomeAxisAsync([4]));
    await this.performActionIfOk(() => this.rockhopperClient.homeAxisAsync([4]));

    await this.performActionIfOk(() => this.rockhopperClient.runToCompletion('v2_calib_verify_b_home.ngc'));
    await this.performActionIfOk(() => this.rockhopperClient.runToCompletion('v2_calib_go_to_clearance_y.ngc'));
  }
  async runCalibrate(){
    console.log('runCalibrate');
    await this.performActionIfOk(() => this.rockhopperClient.runToCompletion('v2_calib_calibrate.ngc'));

    await this.performActionIfOk(() => this.rockhopperClient.restartServices());

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

    await this.performActionIfOk(() => this.rockhopperClient.estopCmdAsync(false));
    if(!this.rockhopperClient.state.homed){
      await this.performActionIfOk(() => this.rockhopperClient.homeAxisAsync());
    }
  }
  async runVerifyALine(){
    console.log('runVerifyALine');
    await this.performActionIfOk(() => this.rockhopperClient.mdiCmdAsync(`G0 Y${Y_POS_PROBING}A0B0`));
    let homingAttemptsCount = 0;
    let totalError = 0;
    while(true){
      await this.performActionIfOk(() => this.rockhopperClient.runToCompletion('v2_calib_probe_a_home_verify.ngc'));

      if(Math.abs(this.linuxcnc_updates.a_pos) < ROTARY_VERIFICATION_HOMING_ERROR_THRESHOLD){
        console.log("VERIFY_A home position within range, error " + this.linuxcnc_updates.a_pos);
        break;
      }

      homingAttemptsCount++;
      totalError += this.linuxcnc_updates.a_pos;
      if(homingAttemptsCount == NUM_VERIFY_HOME_ATTEMPTS) {
        // We would expect this to not happen, but there seems to be a discrepency that we're not accounting for.
        // Let's average the small value that we found and update the home offset accordingly, then do the check
        // again. If we fail at that point, it's an error.
        console.log("A-axis homing verification failed to achieve home position with error <0.01 in 10 attempts. Averaging results and changing home offset, then attempt another 10 times.");
        const overlay = await this.rockhopperClient.getConfigOverlay();
        const a_home_offset_param = overlay.parameters.find((param) => param.values.section == "JOINT_3" && param.values.name == "HOME_OFFSET");
        const a_home_offset = parseFloat(a_home_offset_param.values.value)+(totalError/homingAttemptsCount);
        a_home_offset_param.values.value = a_home_offset.toString();
        await this.rockhopperClient.setConfigOverlay(overlay);
        await execPromise(`halcmd setp ini.3.home_offset ${a_home_offset.toFixed(8)}`);
      } else if(homingAttemptsCount == 2*NUM_VERIFY_HOME_ATTEMPTS) {
        this.processState = STATE_FAIL
        throw new Error("Halting A-axis homing verification, failed to achieve home position with error <0.01 in 10 attempts, even after adjusting home offset again.");
      }
      await this.performActionIfOk(() => this.rockhopperClient.mdiCmdAsync("G0 A-5"));
      await this.performActionIfOk(() => this.rockhopperClient.unhomeAxisAsync([3]));
      await this.performActionIfOk(() => this.rockhopperClient.homeAxisAsync([3]));
    }
    await this.performActionIfOk(() => this.rockhopperClient.runToCompletion('v2_calib_verify_a_line.ngc'));
  }
  
  async runVerifyBLine(){
    console.log('runVerifyBLine');

    let homingAttemptsCount = 0;
    let totalError = 0;
    while(true){
      await this.performActionIfOk(() => this.rockhopperClient.runToCompletion('v2_calib_probe_b_home_verify.ngc'));
      let b_pos = this.linuxcnc_updates.b_pos;
      if(b_pos > 180) {
        b_pos -= 360;
      }

      if(Math.abs(b_pos) < ROTARY_VERIFICATION_HOMING_ERROR_THRESHOLD) {
        console.log("VERIFY_B home position within range, error " + b_pos);
        break;
      }

      homingAttemptsCount++;
      totalError += b_pos;
      if(homingAttemptsCount == NUM_VERIFY_HOME_ATTEMPTS) {
        // We would expect this to not happen, but there seems to be a discrepency that we're not accounting for.
        // Let's average the small value that we found and update the home offset accordingly, then do the check
        // again. If we fail at that point, it's an error.
        console.log("B-axis homing verification failed to achieve home position with error <0.01 in 10 attempts. Averaging results and changing home offset, then attempt another 10 times.");
        const overlay = await this.rockhopperClient.getConfigOverlay();
        const b_home_offset_param = overlay.parameters.find((param) => param.values.section == "JOINT_4" && param.values.name == "HOME_OFFSET");
        const b_home_offset = parseFloat(b_home_offset_param.values.value)+(totalError/homingAttemptsCount);
        b_home_offset_param.values.value = b_home_offset.toString();
        await this.rockhopperClient.setConfigOverlay(overlay);
        await execPromise(`halcmd setp ini.4.home_offset ${b_home_offset.toFixed(8)}`);
      } else if(homingAttemptsCount == 2*NUM_VERIFY_HOME_ATTEMPTS) {
        this.processState = STATE_FAIL
        throw new Error("Halting B-axis homing verification, failed to achieve home position with error <0.01 in 10 attempts, even after adjusting home offset again.");
      }
      await this.performActionIfOk(() => this.rockhopperClient.mdiCmdAsync("G0 B-5"));
      await this.performActionIfOk(() => this.rockhopperClient.unhomeAxisAsync([4]));
      await this.performActionIfOk(() => this.rockhopperClient.homeAxisAsync([4]));
    }
    await this.performActionIfOk(() => this.rockhopperClient.runToCompletion('v2_calib_verify_b_line.ngc'));
  }
  async runUploadFiles(){
    console.log('runUploadFiles');
    /*
    *Copies python log into calib dir
    *Zip and FTP upload two bundles: one for entire calib dir, one with only calibration files
    *Convert calibrationOverlay to legacy format, then write it and comp files to emmc
    */

    var date = new Date();
    let year = date.getFullYear();
    let month = date.getMonth() + 1;
    let day = date.getDate();

    var detailsName = ["details", this.serialNum, year, month, day].join("-") + ".zip";
    var resultsName = ["calib", this.serialNum, year, month, day].join("-") + ".zip";

    const resultsArchive = archiver('zip', { zlib: { level: 9 }});
    const resultsStream = fs.createWriteStream(POCKETNC_VAR_DIRECTORY + "/" + resultsName);
    resultsArchive.pipe(resultsStream);
    resultsArchive.file(A_COMP_PATH, { name: 'a.comp' });
    resultsArchive.file(B_COMP_PATH, { name: 'b.comp' });
    resultsArchive.file(OVERLAY_PATH, { name: 'CalibrationOverlay.inc' });
    await resultsArchive.finalize();

    const detailsArchive = archiver('zip', { zlib: { level: 9 }});
    const detailsStream = fs.createWriteStream(POCKETNC_VAR_DIRECTORY + "/" + detailsName);
    detailsArchive.pipe(detailsStream);

    detailsArchive.directory(CALIB_DIR, false);
    detailsArchive.file(A_COMP_PATH, { name: 'a.comp' });
    detailsArchive.file(B_COMP_PATH, { name: 'b.comp' });
    detailsArchive.file(OVERLAY_PATH, { name: 'CalibrationOverlay.inc' });
    detailsArchive.file(PYTHON_LOG, { name: 'python.log' });
    detailsArchive.file(ROCKHOPPER_LOG, { name: 'linuxcnc_webserver.log' });

    await detailsArchive.finalize();

    const client = new ftp.Client();
    const NUM_ATTEMPTS = 5;
    let num_failed_attempts = 0;
    for(let i = 0; i < NUM_ATTEMPTS; i++) {
      try {
        await client.access({
          host: "10.0.0.10",
          port: 5000
        });
        break;
      } catch(err) {
        num_failed_attempts++;
        console.log("Failed attempt", num_failed_attempts, "of", NUM_ATTEMPTS, " when connecting to 10.0.0.10:5000");
        await new Promise((resolve) => setTimeout(resolve, 500*Math.pow(2,i)));
        if(num_failed_attempts == NUM_ATTEMPTS) {
          throw err;
        }
      }
    }

    num_failed_attempts = 0;
    for(let i = 0; i < NUM_ATTEMPTS; i++) {
      try {
        await client.uploadFrom(POCKETNC_VAR_DIRECTORY + "/" + resultsName, resultsName);
        break;
      } catch(err) {
        num_failed_attempts++;
        console.log("Failed attempt", num_failed_attempts, "of", NUM_ATTEMPTS, " when uploading", resultsName);
        await new Promise((resolve) => setTimeout(resolve, 500*Math.pow(2,i)));
        if(num_failed_attempts == NUM_ATTEMPTS) {
          throw err;
        }
      }
    }

    num_failed_attempts = 0;
    for(let i = 0; i < NUM_ATTEMPTS; i++) {
      try {
        await client.uploadFrom(POCKETNC_VAR_DIRECTORY + "/" + detailsName, detailsName);
        break;
      } catch(err) {
        num_failed_attempts++;
        console.log("Failed attempt", num_failed_attempts, "of", NUM_ATTEMPTS, " when uploading", detailsName);
        await new Promise((resolve) => setTimeout(resolve, 500*Math.pow(2,i)));
        if(num_failed_attempts == NUM_ATTEMPTS) {
          throw err;
        }
      }
    }

    client.close();
    
    await this.rockhopperClient.writeLegacyCalibration();

    // Set back to DHCP
    await execPromise('connmanctl config $(connmanctl services | egrep -o "ethernet.*$") --ipv4 dhcp')
  }
  async uploadErrorFiles(){
    console.log('uploadErrorFiles');
    /*
    *Copies python log into calib dir
    *Zip and FTP upload two bundles: one for entire calib dir, one with only calibration files
    *Convert calibrationOverlay to legacy format, then write it and comp files to emmc
    */

    var date = new Date();
    let year = date.getFullYear();
    let month = date.getMonth() + 1;
    let day = date.getDate();

    var detailsName = ["details", this.serialNum, year, month, day, "FAILED"].join("-") + ".zip";

    const detailsArchive = archiver('zip', { zlib: { level: 9 }});
    const detailsStream = fs.createWriteStream(POCKETNC_VAR_DIRECTORY + "/" + detailsName);
    detailsArchive.pipe(detailsStream);

    detailsArchive.directory(CALIB_DIR, false);
    detailsArchive.file(A_COMP_PATH, { name: 'a.comp' });
    detailsArchive.file(B_COMP_PATH, { name: 'b.comp' });
    detailsArchive.file(OVERLAY_PATH, { name: 'CalibrationOverlay.inc' });
    detailsArchive.file(PYTHON_LOG, { name: 'python.log' });
    detailsArchive.file(ROCKHOPPER_LOG, { name: 'linuxcnc_webserver.log' });

    await detailsArchive.finalize();

    const client = new ftp.Client();
    const NUM_ATTEMPTS = 5;
    let num_failed_attempts = 0;
    for(let i = 0; i < NUM_ATTEMPTS; i++) {
      try {
        await client.access({
          host: "10.0.0.10",
          port: 5000
        });
        break;
      } catch(err) {
        num_failed_attempts++;
        console.log("Failed attempt", num_failed_attempts, "of", NUM_ATTEMPTS, " when connecting to 10.0.0.10:5000");
        await new Promise((resolve) => setTimeout(resolve, 500*Math.pow(2,i)));
        if(num_failed_attempts == NUM_ATTEMPTS) {
          throw err;
        }
      }
    }

    num_failed_attempts = 0;
    for(let i = 0; i < NUM_ATTEMPTS; i++) {
      try {
        await client.uploadFrom(POCKETNC_VAR_DIRECTORY + "/" + detailsName, detailsName);
        break;
      } catch(err) {
        num_failed_attempts++;
        console.log("Failed attempt", num_failed_attempts, "of", NUM_ATTEMPTS, " when uploading", detailsName);
        await new Promise((resolve) => setTimeout(resolve, 500*Math.pow(2,i)));
        if(num_failed_attempts == NUM_ATTEMPTS) {
          throw err;
        }
      }
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
