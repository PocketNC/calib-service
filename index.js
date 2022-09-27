const { WebSocketServer } = require('ws');
var WebSocketClient = require('websocket').client;
const zmq = require("zeromq");
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

const PENTA_VAR_DIR = "/var/opt/pocketnc/";
const CALIB_DIR = PENTA_VAR_DIR + "calib/";

const STAGES = {
  ERASE_COMPENSATION: 'ERASE_COMPENSATION',
  SETUP_CNC: 'SETUP_CNC',
  SETUP_CMM: 'SETUP_CMM',
  PROBE_MACHINE_POS: 'PROBE_MACHINE_POS',
  SETUP_PART_CSY: 'SETUP_PART_CSY',
  PROBE_FIXTURE_BALL_POS: 'PROBE_FIXTURE_BALL_POS',
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
  CALC_CALIB: 'CALC_CALIB',
  WRITE_CALIB: 'WRITE_CALIB',
  //verification-only stages
  RESTART_CNC: 'RESTART_CNC',
  SETUP_VERIFY: 'SETUP_VERIFY',
  VERIFY_A_HOMING: 'VERIFY_A_HOMING',
  VERIFY_B_HOMING: 'VERIFY_B_HOMING',
  VERIFY_A: 'VERIFY_A',
  VERIFY_B: 'VERIFY_B',
  CALC_VERIFY: 'CALC_VERIFY',
  WRITE_VERIFY: 'WRITE_VERIFY'
}

const LOADABLE_STAGE_LIST = [STAGES.PROBE_MACHINE_POS, STAGES.PROBE_SPINDLE_POS,
  STAGES.CHARACTERIZE_X, STAGES.CHARACTERIZE_Y, STAGES.CHARACTERIZE_Z,
  STAGES.PROBE_TOP_PLANE,
  STAGES.PROBE_FIXTURE_BALL_POS,
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


//The line breaks in these lists of Stages are organized to show prereqs.
//i.e. to be ready to run a given stage, the stages listed above it must be completed
const CALIB_ORDER = [
  STAGES.ERASE_COMPENSATION,
  STAGES.SETUP_CNC,
  STAGES.SETUP_CMM,
  STAGES.PROBE_MACHINE_POS,
  STAGES.SETUP_PART_CSY,
  STAGES.PROBE_SPINDLE_POS,
  STAGES.CHARACTERIZE_X, STAGES.CHARACTERIZE_Z, 
  STAGES.PROBE_TOP_PLANE,
  STAGES.PROBE_FIXTURE_BALL_POS,
  STAGES.CHARACTERIZE_Y,
  STAGES.SETUP_CNC_CSY,
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

const A_COMP_PATH = '/var/opt/pocketnc/a.comp';
const B_COMP_PATH = '/var/opt/pocketnc/b.comp';

const Y_POS_PROBING = -63;

//------GLOBALS------
class RockhopperClient {
  constructor() {
    var self = this;
    this.callbacks = {}
    this.state = {};

    this.connected = false;
    this.intervalConnect = false;

    this.client = new WebSocketClient();
    this.socket = undefined;
    // this.socket.addEventListener("message", (data) => {
    //   const msg = JSON.parse(data);

    //   if(this.callbacks[id]) {
    //     this.callbacks[id](msg);
    //   }
    // });
  }


  genCommandPromise = (id, data) => {
    return new Promise((resolve, reject) => {
      const callback = (msg) => {
        switch(msg.code){
          case('?OK'):
            resolve();
          case('?ACK'):
            //skip
          case('?ERROR'):
            reject();
        }
      };
      this.registerCallback(id, callback);
      this.send(data);
    });
  }
  runIntervalConnect() {
    console.log('runIntervalConnect')
    console.log(this.intervalConnect)
    if(this.intervalConnect !== false) { return }
    this.intervalConnect = setInterval(this.connect, 5000)
  }
  stopIntervalConnect() {
    if(this.intervalConnect === false) return
    clearInterval(this.intervalConnect)
    this.intervalConnect = false
  }
  connect = async () => {
    this.client.on('connectFailed', (error) => {
        this.connected = false;
        this.socket = undefined;
        if(this.intervalConnect === false){
          this.runIntervalConnect();
        }
        console.log('Rockhopper Connect Error: ' + error.toString());
      }
    );
    this.client.on('connect', (socket) => { //function(socket) {
      this.connected = true;
      this.socket = socket;
      this.stopIntervalConnect();
      console.log('Rockhopper Connection established!');
      socket.send(JSON.stringify({id: "LOGIN_ID", user: "default", password: 'default', date: new Date(),}));
      socket.send(JSON.stringify({id: "WATCH_INTERP_STATE", name: "interp_state", command:"watch"}));
      socket.send(JSON.stringify({id: "WATCH_STATE", name: "state", command:"watch"}));
      socket.send(JSON.stringify({id: "WATCH_HOMED", name: "homed", command:"watch"}));


      socket.on('error', (error) => {
        this.connected = false;
        // this.runIntervalConnect();
        console.log("Rockhopper Connection error: " + error.toString());
      });
      socket.on('close', () => {
        this.connected = false;
        this.connection = undefined;
        this.runIntervalConnect();
        console.log('Rockhopper Connection closed!');
      });
      socket.on('message', (data) => {
        const msg = JSON.parse(data.utf8Data);
        if(this.callbacks[msg.id]){
          this.callbacks[msg.id](msg);
        }
        switch(msg.id){
          case('WATCH_INTERP_STATE'):
            this.state.interpState = msg.data
          case('WATCH_STATE'):
            this.state.state = msg.data
          case('WATCH_HOMED'):
            var axesHomed = 0;
            for(let idx = 0; idx < 6; idx++){
              axesHomed += msg.data[idx];
            }
            if(axesHomed === 5){
              this.state.homed = true;
            }
            else { this.state.homed = false; }
          default:
            break;
        }
      });
    })
    this.client.connect('ws://localhost:8000/websocket/');
  }

  registerCallback(id, callback) {
    this.callbacks[id] = callback;
  }
  unregisterCallback(id) {
    delete this.callbacks[id];
  }

  send(msg) {
    this.socket.send(msg);
  }

  async getSocket() {
    if(this.socket){
      return this.socket;
    }
    await this.connect();
    return this.socket;
  }

  waitForDoneAndIdle = async (initialTimeout) => {
    if(initialTimeout){
      await new Promise(r => setTimeout(r, initialTimeout));
    }
    while(true){
      await new Promise(r => setTimeout(r, 100));
      if(this.state.state === 1 && this.state.interpState === 1){ console.log('done and idle'); break; }
    }
  }
  estopCmdAsync = async (val) => {
    this.send(
      JSON.stringify(
        {
          "0":val,
          "id":"PUT_ESTOP_CMD_ASYNC",
          "name":"estop_cmd_async",
          "command":"put",
        }
      )
    )
  }
  programOpenCmd = (filename) => {
    this.send(
      JSON.stringify(
        {
          "0":filename,
          "1":"PROGRAM",
          "id":"PUT_PROGRAM_OPEN_CMD",
          "name":"program_open_cmd",
          "command":"put",
        }
      )
    )
  }
  cycleStart = () => {
    this.send(
      JSON.stringify(
        {
          "id":"PUT_CYCLE_START_CMD",
          "name":"cycle_start_cmd",
          "command":"put",
        }
      )
    )
  }
  restartServices = () => {
    this.send(
      JSON.stringify(
        {
          "id":"PUT_RESTART",
          "name":"restart",
          "command":"put",
        }
      )
    )
  }
  mdiCmdAsync = async (cmd) => {
    const id = "PUT_MDI_CMD_ASYNC_" + Date.now();
    const data = JSON.stringify(
      {
        "0": cmd,
        "id": id,
        "name":"mdi_cmd_async",
        "command":"put",
      }
    )
    return this.genCommandPromise(id,data)
    // new Promise((resolve, reject) => {
    //   const callback = (msg) => {
    //     console.log(msg)
    //     switch(msg.code){
    //       case('?OK'):
    //         resolve();
    //       case('?ACK'):
    //         //skip
    //       case('?ERROR'):
    //         reject();
    //     }
    //   };
    //   this.registerCallback(id, callback);
    //   this.send(data);
    // });
  }
  homeAxisAsync = async (axisIndex) => {
    const id = "PUT_HOME_CMD_ASYNC_" + Date.now();
    const data = JSON.stringify(
      {
        "0": axisIndex,
        "id": id,
        "name":"home_cmd_async",
        "command":"put",
      }
    )
    return this.genCommandPromise(id,data)

    // return new Promise((resolve, reject) => {
    //   const callback = (msg) => {
    //     console.log(msg)
    //     if(msg.ack){
    //       // if this message is acknowlegment, skip it
    //     }
    //     // if this message is completed, then resolve
    //     // if this message indicates error, then reject
    //   };
    //   this.registerCallback(id, callback);
    //   this.send(data);
    // });
  }
  unhomeAxisAsync = async (axisIndex) => {
    console.log('unhomeAxisAsync');
    const id = "PUT_UNHOME_CMD_ASYNC_" + Date.now();
    const data = JSON.stringify(
      {
        "0": axisIndex,
        "id": id,
        "name":"unhome_cmd_async",
        "command":"put",
      }
    )
    return this.genCommandPromise(id,data)

    // return new Promise((resolve, reject) => {
    //   const callback = (msg) => {
    //     console.log(msg)
    //     if(msg.ack){
    //       // if this message is acknowlegment, skip it
    //     }
    //     // if this message is completed, then resolve
    //     // if this message indicates error, then reject
    //   };
    //   this.registerCallback(id, callback);
    //   this.send(data);
    // });
  }
  teleopEnable = async (teleopVal) => {
    this.send(
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
  loadStageProgress = async (stage) => {
    this.send(
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
  setSkipCmm = async (val) => {
    const paramVal = val === true ? 1 : 0;
    this.send(
      JSON.stringify(
        {
          "0": `o<cmm_set_skip_cmm> call [${paramVal}]`,
          "id":"PUT_MDI_CMD",
          "name":"mdi_cmd",
          "command":"put",
        }
      )
    )
  }
}

rockhopperClient = new RockhopperClient();
rockhopperClient.connect();


class CalibProcess {
  constructor(processType) {
    this.processType = processType;
    if(processType === PROCESS_VERIFY){
      this.currentLevel = LEVEL_VERIFY;
    }
    else{
      this.currentLevel = LEVEL_CALIB;
    }

    this.begun = false;
    this.status = STATE_IDLE;

    this.rockhopperClient = new RockhopperClient()

    this.rockhopperConnected, this.intervalConnectRockhopper = false;
    this.rockhopperClient, this.rockhopperConnection = undefined;

    this.calibSocket, this.calibConnection = undefined;

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
}

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


async function startNextStage() {
  console.log('startNextStage')
  var idx, stageToRunIdx, modeToRun;
  // if(calibProcess.selectedProcess == PROCESS_VERIFY){
    for(idx = 0; idx < CALIB_ORDER.length; idx++){
      console.log(calibProcess.stages.calib[CALIB_ORDER[idx]])
      if(!calibProcess.stages.calib[CALIB_ORDER[idx]].completed){
        stageToRunIdx = idx;
        modeToRun = MODE_CALIB;
        break;
      }
      else{
        console.log('already completed: ' + CALIB_ORDER[idx]);
      }
    }
  // }
  console.log(stageToRunIdx)
  if(stageToRunIdx === undefined){
    console.log('calibration already completed, seeking verification step');
    for(idx = 0; idx < VERIFY_ORDER.length; idx++){
      console.log(calibProcess.stages.verify[VERIFY_ORDER[idx]])
      if(!calibProcess.stages.verify[VERIFY_ORDER[idx]].completed){
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
    calibProcess.currentLevel = LEVEL_CALIB
    nextStage = CALIB_ORDER[stageToRunIdx]
    calibProcess.currentMode = MODE_CALIB
    methodToRun = STAGE_METHODS[CALIB_ORDER[stageToRunIdx]]
  }
  else if(modeToRun === MODE_VERIFY){
    calibProcess.currentLevel = LEVEL_VERIFY
    nextStage = VERIFY_ORDER[stageToRunIdx]
    calibProcess.currentMode = MODE_VERIFY
    methodToRun = STAGE_METHODS[VERIFY_ORDER[stageToRunIdx]]
  }
  else{
    console.log('somehow did not select a mode to run');
    actualState = STATE_ERROR;
    return;
  }
  console.log(nextStage)
  console.log(methodToRun)
  await rockhopperClient.waitForDoneAndIdle();
  calibProcess.currentStage = nextStage;
  console.log(calibProcess.selectedProcess)
  try{
    if([PROCESS_NEW, PROCESS_VERIFY].includes(calibProcess.selectedProcess)){
      await methodToRun()
    }
    else if(calibProcess.selectedProcess === PROCESS_RESUME){
      console.log('yes resume')
      if(LOADABLE_STAGES.has(nextStage) && checkSaveFileExists(nextStage)){
        console.log('yes loadable')
        await rockhopperClient.loadStageProgress(nextStage)
      }
      else{
        console.log('no loadable')
        await methodToRun()
      }
    }
  }
  catch (err) {
    console.log ('error:', err.message, err.stack)
  }
}

function checkSaveFileExists(stage) {
  filename = CALIB_DIR + "Stages." + stage.toUpperCase();
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
  return calibProcess;
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
async function runEraseCompensation(conn){
  console.log('runEraseCompensation');
  var comps = await readCompensationFiles();
  if(comps.a.length > 2 || comps.b.length > 2 ){
    await clearCompensationFiles();
    await rockhopperClient.restartServices(conn)
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
  calibProcess.stages.calib['ERASE_COMPENSATION'].completed = true;
  if(commandedState == STATE_RUN){
    runCalib()
  }
}
async function runSetupCnc(conn){
  console.log('runSetupCnc');
  await rockhopperClient.estopCmdAsync(false);
  await new Promise(r => setTimeout(r, 1000));
  if(!rockhopperClient.state.homed){
    await rockhopperClient.homeAxisAsync();
  }
  console.log(calibProcess.currentLevel)
  if(calibProcess.currentLevel === LEVEL_CALIB){
    calibProcess.stages.calib['SETUP_CNC'].completed = true;
  }
  else if(calibProcess.currentLevel === LEVEL_VERIFY){
    calibProcess.stages.verify['SETUP_CNC'].completed = true;
  }
  if(commandedState == STATE_RUN){
    runCalib()
  }
}
async function runSetupCmm(){
  console.log('runSetupCmm');
  await rockhopperClient.programOpenCmd('v2_calib_setup_cmm.ngc');
  await new Promise(r => setTimeout(r, 2000));
  await rockhopperClient.cycleStart();
}
async function runProbeMachinePos(){
  console.log('runProbeMachinePos');
  await rockhopperClient.programOpenCmd('v2_calib_probe_machine_pos.ngc')
  await new Promise(r => setTimeout(r, 2000));
  await rockhopperClient.cycleStart()
}
async function runSetupPartCsy(){
  console.log('runSetupPartCsy');
  await rockhopperClient.programOpenCmd('v2_calib_setup_part_csy.ngc')
  await new Promise(r => setTimeout(r, 2000));
  await rockhopperClient.cycleStart()
}
async function runProbeSpindlePos(){
  console.log('runProbeSpindlePos');
  await rockhopperClient.programOpenCmd('v2_calib_probe_spindle_pos.ngc')
  await new Promise(r => setTimeout(r, 2000));
  await rockhopperClient.cycleStart()
}
async function runProbeFixtureBallPos(){
  console.log('runProbeFixtureBallPos');
  await rockhopperClient.programOpenCmd('v2_calib_probe_fixture_ball_pos.ngc')
  await new Promise(r => setTimeout(r, 2000));
  await rockhopperClient.cycleStart()
}
async function runCharacterizeX(){
  console.log('runCharacterizeX');
  for(let idx = 0; idx < 5; idx++){
    await rockhopperClient.mdiCmdAsync("G0 X60");
    await rockhopperClient.unhomeAxisAsync([0]);
    await rockhopperClient.homeAxisAsync([0]);
    await rockhopperClient.programOpenCmd('v2_calib_probe_x_home.ngc')
    await new Promise(r => setTimeout(r, 1000));
    await rockhopperClient.cycleStart();
    await rockhopperClient.waitForDoneAndIdle(1000);

    // await waitForDoneAndIdle(0);
    // await performTeleopEnable(conn, true);
    // await new Promise(r => setTimeout(r, 1000));
    // await performMdiCmd(conn, "G0 X60" );
    // await waitForDoneAndIdle(1000);
    // await performUnhomeAxis(conn, 0);
    // await waitForUnhomed(1000);
    // await new Promise(r => setTimeout(r, 1000));
    // await rockhopperClient.homeAxis(0)
    // await performHomeAxis(conn, [0]);
    // await waitForHomed(1000);
    // await waitForDoneAndIdle(1000);
    // await new Promise(r => setTimeout(r, 2000));

    // await programOpen(conn, 'v2_calib_probe_x_home.ngc')
    // await new Promise(r => setTimeout(r, 1000));
    // await cycleStart(conn);
    // await waitForDoneAndIdle(1000);
    if(![STATE_RUN, STATE_STEP].includes(actualState)){
      return;
    }
  }
  // await rockhopperClient.performTeleopEnable(true);
  // await new Promise(r => setTimeout(r, 1000));
  await rockhopperClient.programOpenCmd('v2_calib_verify_x_home.ngc');
  await new Promise(r => setTimeout(r, 1000));
  await rockhopperClient.cycleStart();
  await rockhopperClient.waitForDoneAndIdle(1000);
  if(![STATE_RUN, STATE_STEP].includes(actualState)){
    return;
  }
  await new Promise(r => setTimeout(r, 1000));
  await rockhopperClient.programOpenCmd('v2_calib_characterize_x.ngc');
  await new Promise(r => setTimeout(r, 1000));
  await rockhopperClient.cycleStart();
}
async function runCharacterizeY(conn){
  console.log('runCharacterizeY');
  // await performMdiCmd(conn, "o<cmm_go_to_clearance_z> call" );
  await rockhopperClient.mdiCmdAsync("o<cmm_go_to_clearance_z> call");
  await new Promise(r => setTimeout(r, 3000));
  for(let idx = 0; idx < 5; idx++){
    await rockhopperClient.programOpenCmd('v2_calib_probe_y_home.ngc');
    await new Promise(r => setTimeout(r, 1000));
    await rockhopperClient.cycleStart();
    await rockhopperClient.waitForDoneAndIdle(1000);
    if(![STATE_RUN, STATE_STEP].includes(actualState)){
      return;
    }

    // await performTeleopEnable(conn, true);
    await rockhopperClient.mdiCmdAsync("G0 Y60");
    await rockhopperClient.waitForDoneAndIdle(1000);
    await rockhopperClient.unhomeAxisAsync([1]);
    await rockhopperClient.homeAxisAsync([1]);
  }
  await new Promise(r => setTimeout(r, 1000));
  // await performTeleopEnable(conn, true);
  // await new Promise(r => setTimeout(r, 1000));
  await rockhopperClient.programOpenCmd('v2_calib_verify_y_home.ngc');
  await new Promise(r => setTimeout(r, 1000));
  await rockhopperClient.cycleStart();
  await rockhopperClient.waitForDoneAndIdle(1000);
  if(![STATE_RUN, STATE_STEP].includes(actualState)){
    return;
  }
  await new Promise(r => setTimeout(r, 1000));
  await rockhopperClient.programOpenCmd('v2_calib_characterize_y.ngc');
  await new Promise(r => setTimeout(r, 1000));
  await rockhopperClient.cycleStart();

  // await programOpen(conn, 'v2_calib_verify_y_home.ngc');
  // await new Promise(r => setTimeout(r, 1000));
  // await cycleStart(conn);
  // await waitForInterpreterIdle(1000);
  // await programOpen(conn, 'v2_calib_characterize_y.ngc')
  // await new Promise(r => setTimeout(r, 1000));
  // await cycleStart(conn)
}
async function runCharacterizeZ(conn){
  console.log('runCharacterizeZ');
  // await performTeleopEnable(conn, true);
  // await new Promise(r => setTimeout(r, 1000));
  await rockhopperClient.mdiCmdAsync("G0 X0");
  for(let idx = 0; idx < 5; idx++){

    await rockhopperClient.programOpenCmd('v2_calib_probe_z_home.ngc')
    await new Promise(r => setTimeout(r, 1000));
    await rockhopperClient.cycleStart();
    await rockhopperClient.waitForDoneAndIdle(1000);


    // await waitForDoneAndIdle(1000);
    // await programOpen(conn, 'v2_calib_probe_z_home.ngc');
    // await new Promise(r => setTimeout(r, 1000));
    // await cycleStart(conn);
    // await waitForDoneAndIdle(1000);
    if(![STATE_RUN, STATE_STEP].includes(actualState)){
      return;
    }
    if(idx < 4){
      await rockhopperClient.mdiCmdAsync("G0 Z-3.5");
      await rockhopperClient.unhomeAxisAsync([2]);
      await rockhopperClient.homeAxisAsync([2]);

      // await performMdiCmd(conn, "G0 Z-3.5");
      // await waitForDoneAndIdle(1000);
      // await performUnhomeAxis(conn, 2);
      // await waitForUnhomed(1000);
      // await performHomeAxis(conn, [2]);
      // await waitForHomed(1000);
    }
  }
  await new Promise(r => setTimeout(r, 1000));
  // await performTeleopEnable(conn, true);
  await rockhopperClient.programOpenCmd('v2_calib_verify_z_home.ngc');
  // await programOpen(conn, 'v2_calib_verify_z_home.ngc');
  await new Promise(r => setTimeout(r, 1000));
  await rockhopperClient.cycleStart();
  await rockhopperClient.waitForDoneAndIdle(1000);
  await new Promise(r => setTimeout(r, 1000));
  if(![STATE_RUN, STATE_STEP].includes(actualState)){
    return;
  }
  await rockhopperClient.programOpenCmd('v2_calib_characterize_z.ngc');
  await new Promise(r => setTimeout(r, 1000));
  await rockhopperClient.cycleStart();
}
async function runProbeTopPlane(conn){
  console.log('runProbeTopPlane');
  await rockhopperClient.programOpenCmd('v2_calib_probe_top_plane.ngc');
  await new Promise(r => setTimeout(r, 2000));
  await rockhopperClient.cycleStart();
}
async function runSetupCncCsy(conn){
  console.log('runSetupCncCsy');
  await rockhopperClient.programOpenCmd('v2_calib_setup_cnc_csy.ngc');
  await new Promise(r => setTimeout(r, 2000));
  await rockhopperClient.cycleStart();
}
async function runCharacterizeA(conn){
  console.log('runCharacterizeA');
  await rockhopperClient.mdiCmdAsync(`G0 Y${Y_POS_PROBING}`);
  for(let idx = 0; idx < 5; idx++){
    await rockhopperClient.programOpenCmd('v2_calib_probe_a_home.ngc')
    await new Promise(r => setTimeout(r, 1000));
    await rockhopperClient.cycleStart();
    await rockhopperClient.waitForDoneAndIdle(1000);

    if(![STATE_RUN, STATE_STEP].includes(actualState)){
      return;
    }
    if(idx < 4){
      await rockhopperClient.mdiCmdAsync("G0 A-10");
      await rockhopperClient.unhomeAxisAsync([3]);
      await rockhopperClient.homeAxisAsync([3]);
    }
  }
  await new Promise(r => setTimeout(r, 1000));
  await rockhopperClient.programOpenCmd('v2_calib_verify_a_home.ngc');
  await rockhopperClient.cycleStart();
  await rockhopperClient.waitForDoneAndIdle(1000);
  await new Promise(r => setTimeout(r, 1000));
  if(![STATE_RUN, STATE_STEP].includes(actualState)){
    return;
  }
  await rockhopperClient.programOpenCmd('v2_calib_characterize_a.ngc');
  await rockhopperClient.cycleStart();
}
async function runCharacterizeB(conn){
  console.log('runCharacterizeB');
  await rockhopperClient.mdiCmdAsync(`G0 Y${Y_POS_PROBING}`);

  for(let idx = 0; idx < 5; idx++){
    await rockhopperClient.programOpenCmd('v2_calib_probe_b_home.ngc')
    await new Promise(r => setTimeout(r, 1000));
    await rockhopperClient.cycleStart();
    await rockhopperClient.waitForDoneAndIdle(1000);
    if(![STATE_RUN, STATE_STEP].includes(actualState)){
      return;
    }
    if(idx < 4){
      await rockhopperClient.mdiCmdAsync("G0 B-10");
      await rockhopperClient.unhomeAxisAsync([4]);
      await rockhopperClient.homeAxisAsync([4]);
    }
  }
  await new Promise(r => setTimeout(r, 1000));
  await rockhopperClient.programOpenCmd('v2_calib_verify_b_home.ngc');
  await rockhopperClient.cycleStart();
  await rockhopperClient.waitForDoneAndIdle(1000);
  await new Promise(r => setTimeout(r, 1000));
  if(![STATE_RUN, STATE_STEP].includes(actualState)){
    return;
  }
  await rockhopperClient.programOpenCmd('v2_calib_characterize_b.ngc');
  await new Promise(r => setTimeout(r, 1000));
  await rockhopperClient.cycleStart();
}
async function runCalcCalib(conn){
  console.log('runCalcCalib');
  await rockhopperClient.programOpenCmd('v2_calib_calc_calib.ngc');
  await new Promise(r => setTimeout(r, 1000));
  await rockhopperClient.cycleStart();
}
async function runWriteCalib(conn){
  console.log('runWriteCalib');
  await rockhopperClient.programOpenCmd('v2_calib_write_calib.ngc');
  await new Promise(r => setTimeout(r, 1000));
  await rockhopperClient.cycleStart();
}
async function runRestartCnc(conn){
  console.log('runRestartCnc');
  await rockhopperClient.restartServices(conn)
  await new Promise(r => setTimeout(r, 3000));
  rockhopperConnected = false;
  while(!rockhopperConnected){
    await new Promise(r => setTimeout(r, 1000));
    console.log('still waiting for rockhopper')
  }
  console.log('rockhopper restarted');
  calibProcess.stages.verify['RESTART_CNC'].completed = true;
  console.log(calibProcess.stages.verify);
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
  await rockhopperClient.programOpenCmd('v2_calib_setup_verify.ngc');
  await new Promise(r => setTimeout(r, 1000));
  await rockhopperClient.cycleStart();
}
async function runVerifyAHoming(conn){
  console.log('runVerifyAHoming');
  await rockhopperClient.mdiCmdAsync(`G0 Y${Y_POS_PROBING}`);
  for(let idx = 0; idx < 5; idx++){
    await rockhopperClient.programOpenCmd('v2_calib_probe_a_home.ngc')
    await new Promise(r => setTimeout(r, 1000));
    await rockhopperClient.cycleStart();
    await rockhopperClient.waitForDoneAndIdle(1000);

    if(![STATE_RUN, STATE_STEP].includes(actualState)){
      return;
    }
    if(idx < 4){
      await rockhopperClient.mdiCmdAsync("G0 A-10");
      await rockhopperClient.unhomeAxisAsync([3]);
      await rockhopperClient.homeAxisAsync([3]);
    }
  }
  await new Promise(r => setTimeout(r, 1000));
  await rockhopperClient.programOpenCmd('v2_calib_verify_a_homing.ngc');
  await rockhopperClient.cycleStart();
}
async function runVerifyA(conn){
  console.log('runVerifyA');
  await rockhopperClient.mdiCmdAsync(`G0 Y${Y_POS_PROBING}`);
  await new Promise(r => setTimeout(r, 1000));
  await rockhopperClient.programOpenCmd('v2_calib_probe_a_home.ngc')
  await new Promise(r => setTimeout(r, 1000));
  await rockhopperClient.cycleStart();
  await rockhopperClient.waitForDoneAndIdle(1000);
  var homingAttemptsCount = 0;
  while(Math.abs(calibProcess.aHomeErr) > 0.01){
    if(![STATE_RUN, STATE_STEP].includes(actualState)){
      return;
    }
    console.log(calibProcess.aHomeErr);
    homingAttemptsCount++;
    await rockhopperClient.mdiCmdAsync("G0 A-10");
    await rockhopperClient.unhomeAxisAsync([3]);
    await rockhopperClient.homeAxisAsync([3]);
    
    await rockhopperClient.programOpenCmd('v2_calib_probe_a_home.ngc')
    await new Promise(r => setTimeout(r, 1000));
    await rockhopperClient.cycleStart();
    await rockhopperClient.waitForDoneAndIdle(1000);
  }
  console.log(Math.abs(calibProcess.aHomeErr))
  await rockhopperClient.programOpenCmd('v2_calib_verify_a.ngc');
  await new Promise(r => setTimeout(r, 1000));
  await rockhopperClient.cycleStart();
}
async function runVerifyBHoming(conn){
  console.log('runVerifyBHoming');
  await rockhopperClient.mdiCmdAsync(`G0 Y${Y_POS_PROBING}`);
  for(let idx = 0; idx < 5; idx++){
    await rockhopperClient.programOpenCmd('v2_calib_probe_b_home.ngc')
    await new Promise(r => setTimeout(r, 1000));
    await rockhopperClient.cycleStart();
    await rockhopperClient.waitForDoneAndIdle(1000);

    if(![STATE_RUN, STATE_STEP].includes(actualState)){
      return;
    }
    if(idx < 4){
      await rockhopperClient.mdiCmdAsync("G0 B-10");
      await rockhopperClient.unhomeAxisAsync([4]);
      await rockhopperClient.homeAxisAsync([4]);
    }
  }
  await new Promise(r => setTimeout(r, 1000));
  await rockhopperClient.programOpenCmd('v2_calib_verify_b_homing.ngc');
  await rockhopperClient.cycleStart();
}
async function runVerifyB(conn){
  console.log('runVerifyB');
  await rockhopperClient.mdiCmdAsync(`G0 Y${Y_POS_PROBING}A0`);
  await new Promise(r => setTimeout(r, 1000));
  var homingAttemptsCount = 0;
  while(true){
    await rockhopperClient.programOpenCmd('v2_calib_probe_b_home.ngc')
    await new Promise(r => setTimeout(r, 1000));
    await rockhopperClient.cycleStart();
    await rockhopperClient.waitForDoneAndIdle(1000);
    if(![STATE_RUN, STATE_STEP].includes(actualState)){
      return;
    }
    console.log(calibProcess.bHomeErr);
    if(Math.abs(calibProcess.bHomeErr) < 0.01){
      break;
    }
    homingAttemptsCount++;
    await rockhopperClient.mdiCmdAsync("G0 B-10");
    await rockhopperClient.unhomeAxisAsync([4]);
    await rockhopperClient.homeAxisAsync([4]);
  }
  console.log(Math.abs(calibProcess.bHomeErr))

  await rockhopperClient.programOpenCmd('v2_calib_verify_b.ngc');
  await new Promise(r => setTimeout(r, 1000));
  await rockhopperClient.cycleStart();
}
async function runCalcVerify(conn){
  console.log('runCalcVerify');
  await rockhopperClient.programOpenCmd('v2_calib_calc_verify.ngc');
  await new Promise(r => setTimeout(r, 1000));
  await rockhopperClient.cycleStart();
}
async function runWriteVerify(conn){
  console.log('runWriteVerify');
  await rockhopperClient.programOpenCmd('v2_calib_write_verify.ngc');
  await new Promise(r => setTimeout(r, 1000));
  await rockhopperClient.cycleStart();
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
  'PROBE_FIXTURE_BALL_POS': runProbeFixtureBallPos,
  'CHARACTERIZE_X': runCharacterizeX,
  'CHARACTERIZE_Y': runCharacterizeY,
  'CHARACTERIZE_Z': runCharacterizeZ,
  'PROBE_TOP_PLANE': runProbeTopPlane,
  'SETUP_CNC_CSY':runSetupCncCsy,
  'CHARACTERIZE_A': runCharacterizeA,
  'CHARACTERIZE_B': runCharacterizeB,
  'CALC_CALIB': runCalcCalib,
  'WRITE_CALIB': runWriteCalib,
  'RESTART_CNC': runRestartCnc,
  'SETUP_VERIFY': runSetupVerify,
  'VERIFY_A': runVerifyA,
  'VERIFY_B': runVerifyB,
  'CALC_VERIFY': runCalcVerify,
  'WRITE_VERIFY': runWriteVerify,
  [STAGES.VERIFY_A_HOMING]: runVerifyAHoming,
  [STAGES.VERIFY_B_HOMING]: runVerifyBHoming,
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
  if(!calibProcess.begun && [PROCESS_NEW, PROCESS_RESUME, PROCESS_VERIFY].includes(processName)){
    console.log(processName)
    calibProcess.selectedProcess = processName;
  }
}
async function cmdSetSerial(serialNum) {
  calibProcess.serialNum = serialNum;
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
  cmdSetSkipCmm,
  cmdRestart,
  cmdSetSerial,
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
// var rockhopperConnection;
// var rockhopperClient = new WebSocketClient();
// var intervalConnectRockhopper = false;
// var rockhopperConnected = false;

// async function connectRockhopper() {
//   rockhopperConnected = false;
//   rockhopperClient.connect('ws://localhost:8000/websocket/');
// }

// function runIntervalConnectRockhopper() {
//   if(intervalConnectRockhopper !== false) { return }
//   intervalConnectRockhopper = setInterval(connectRockhopper, 3000)
// }

// function stopIntervalConnectRockhopper() {
//   if(intervalConnectRockhopper === false) return
//   clearInterval(intervalConnectRockhopper)
//   intervalConnectRockhopper = false
// }

// rockhopperClient.on('connectFailed', function(error) {
//   rockhopperConnected = false;
//   runIntervalConnectRockhopper();
//   console.log('Rockhopper Connect Error: ' + error.toString());
// });


// rockhopperClient.on('connect', function(connection) {
//   rockhopperConnected = true;
//   stopIntervalConnectRockhopper();
//   console.log('Rockhopper Connection established!');
//   connection.send(JSON.stringify({id: "LOGIN_ID", user: "default", password: 'default', date: new Date(),}));
//   connection.send(JSON.stringify({id: "WATCH_INTERP_STATE", name: "interp_state", command:"watch"}));
//   connection.send(JSON.stringify({id: "WATCH_STATE", name: "state", command:"watch"}));
//   connection.send(JSON.stringify({id: "WATCH_HOMED", name: "homed", command:"watch"}));

//   rockhopperConnection = connection;

//   connection.on('error', function(error) {
//     rockhopperConnected = false;
//     runIntervalConnectRockhopper();
//     console.log("Rockhopper Connection error: " + error.toString());
//   });

//   connection.on('close', function() {
//     rockhopperConnected = false;
//     runIntervalConnectRockhopper();
//     console.log('Rockhopper Connection closed!');
//   });

//   connection.on('message', function(message) {
//     rockhopperMessage = JSON.parse(message.utf8Data);
//     console.log(rockhopperMessage);

//     if(rockhopperMessage.id === 'WATCH_INTERP_STATE'){
//       //EMC_TASK_INTERP_IDLE = 1,EMC_TASK_INTERP_READING = 2,EMC_TASK_INTERP_PAUSED = 3,EMC_TASK_INTERP_WAITING = 4
//       var interpStateVal = rockhopperMessage.data;
//       console.log('WATCH_INTERP_STATE ' + interpStateVal)
//       switch(interpStateVal){
//         case(1):
//           interpIdle = true;
//           break;
//         default:
//           interpIdle = false;
//           break;
//       }
//     }
//     else if(rockhopperMessage.id === 'WATCH_STATE'){
//       var execStateVal = rockhopperMessage.data;
//       console.log('WATCH_STATE ' + execStateVal)
//       switch(execStateVal){
//         case(1):
//           execStateDone = true;
//           break;
//         default:
//           execStateDone = false;
//           break;
//       }
//     }
//     else if(rockhopperMessage.id === 'WATCH_HOMED'){
//       //EMC_TASK_INTERP_IDLE = 1,EMC_TASK_INTERP_READING = 2,EMC_TASK_INTERP_PAUSED = 3,EMC_TASK_INTERP_WAITING = 4

//       var homedData = rockhopperMessage.data;
//       var axesHomed = 0;
//       for(let idx = 0; idx < 6; idx++){
//         axesHomed += homedData[idx];
//       }
//       if(axesHomed === 5){
//         homed = true;
//       }
//       else { homed = false; }
//     }
//     else if(rockhopperMessage.id === 'PUT_HOME_CMD_ASYNC'){

//     }
//   });
// });

// connectRockhopper();



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

  calibProcess.skipCmm = calibManagerReport.skip_cmm;
  calibProcess.status = calibManagerReport.status;
  calibProcess.bHomeErr = calibManagerReport.b_home_err;
  calibProcess.aHomeErr = calibManagerReport.a_home_err;

  if(calibManagerReport.why === MSG_WHY_STEP_COMPLETE){
    if(calibManagerReport.stage_completed){
      calibProcess.stages[calibProcess.currentMode][calibManagerReport.stage].completed = true;
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
    calibProcess.stages[calibProcess.currentMode][calibProcess.currentStage].error = true;
    actualState = STATE_ERROR
  }
  else if(calibManagerReport.why === MSG_WHY_FAIL){
    calibProcess.stages[calibProcess.currentMode][calibProcess.currentStage].error = true;
    actualState = STATE_FAIL
  }

  const data = await getCalibStatus();
  if(uiConnection){
    uiConnection.send(JSON.stringify({ ['getCalibStatus']: data }));
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
