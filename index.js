const { WebSocketServer } = require('ws');
var WebSocketClient = require('websocket').client;
const zmq = require("zeromq");
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


//------CONSTANTS------
const STATE_IDLE = "IDLE"
const STATE_PAUSE = "PAUSE"
const STATE_RUN = "RUN"
const STATE_STOP = "STOP"
const MSG_WHY_STEP_COMPLETE = "STEP_COMPLETE"
const MSG_WHY_UPDATE = "UPDATE"
const MSG_WHY_ERROR = "ERROR"

var CALIB_ORDER = ['SETUP_CMM', 'PROBE_MACHINE_POS', 'SETUP_PART_CSY', 
// 'PROBE_X', 
'PROBE_Z', 'PROBE_TOP_PLANE', 'SETUP_CNC_CSY', 'PROBE_A', 'PROBE_B', 'WRITE_RESULTS']
var VERIFY_ORDER = ['VERIFY_X', 'VERIFY_Z', 'VERIFY_A', 'VERIFY_B', 'WRITE_REPORT']



//------GLOBALS------
var calibStatus = {
  stages: CALIB_ORDER.reduce((calibArr, stage) => ({...calibArr, [stage]: false}), {}),
  status: null,
}
var interpIdle = false;


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
}


async function startNextStage() {
  
}

async function waitForInterpreterIdle() {
  while(true){
    await new Promise(r => setTimeout(r, 1000));
    if(interpIdle){ break; }
  }
}

async function calibRun() {
  console.log('finding stage to run')
  console.log(calibStatus)
  var stageToRunIdx;
  for(stageToRunIdx = 0; stageToRunIdx < CALIB_ORDER.length; stageToRunIdx++){
    if(!calibStatus.stages[CALIB_ORDER[stageToRunIdx]]){
      break;
    }
    else{
      console.log('already completed: ' + CALIB_ORDER[stageToRunIdx]);
    }
  }
  methodToRun = STAGE_METHODS[CALIB_ORDER[stageToRunIdx]]
  console.log(methodToRun)
  await waitForInterpreterIdle();
  await methodToRun(rockhopperConnection)
}

async function getCalibStatus() {
  console.log('getCalibStatus')
  console.log(calibStatus)
  return calibStatus;
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
        "meta":{"actionEmitters":["@@rockhopper/RESPONSE/PUT/PROGRAM_OPEN_CMD"]}
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
        "meta":{"actionEmitters":["@@rockhopper/RESPONSE/PUT/CYCLE_START_CMD"]}
      }
    )
  )
}
async function runSetupCmm(conn){
  console.log('runSetupCmm');
  await programOpen(conn, 'v2_calib_cmm_setup.ngc');
  await new Promise(r => setTimeout(r, 1000));
  await cycleStart(conn);
}
async function runProbeMachinePos(conn){
  console.log('runProbeMachinePos');
  await programOpen(conn, 'v2_calib_probe_machine_pos.ngc')
  await new Promise(r => setTimeout(r, 1000));
  await cycleStart(conn)
}
async function runSetupPartCsy(conn){
  console.log('runSetupPartCsy');
  await programOpen(conn, 'v2_calib_setup_part_csy.ngc')
  await new Promise(r => setTimeout(r, 1000));
  await cycleStart(conn)
}
async function runProbeX(conn){
  console.log('runProbeX');
  await programOpen(conn, 'v2_calib_probe_x.ngc')
  await new Promise(r => setTimeout(r, 1000));
  await cycleStart(conn)
}
async function runProbeZ(conn){
  console.log('runProbeZ');
  await programOpen(conn, 'v2_calib_probe_z.ngc')
  await new Promise(r => setTimeout(r, 1000));
  await cycleStart(conn)
}
async function runProbeTopPlane(conn){
  console.log('runProbeTopPlane');
  await programOpen(conn, 'v2_calib_probe_top_plane.ngc')
  await new Promise(r => setTimeout(r, 1000));
  await cycleStart(conn)
}
async function runSetupCncCsy(conn){
  console.log('runSetupCncCsy');
  await programOpen(conn, 'v2_calib_setup_cnc_csy.ngc')
  await new Promise(r => setTimeout(r, 1000));
  await cycleStart(conn)
}
async function runProbeA(conn){
  console.log('runProbeA');
  await programOpen(conn, 'v2_calib_probe_a.ngc')
  await new Promise(r => setTimeout(r, 1000));
  await cycleStart(conn)
}
async function runProbeB(conn){
  console.log('runProbeB');
  await programOpen(conn, 'v2_calib_probe_b.ngc')
  await new Promise(r => setTimeout(r, 1000));
  await cycleStart(conn)
}
async function runWriteResults(conn){
  console.log('runWriteResults');
  await programOpen(conn, 'v2_calib_write_results.ngc')
  await cycleStart(conn)
}

const STAGE_METHODS = {
  'SETUP_CMM': runSetupCmm,
  'PROBE_MACHINE_POS': runProbeMachinePos,
  'SETUP_PART_CSY': runSetupPartCsy,
  'PROBE_X': runProbeX,
  'PROBE_Z': runProbeZ,
  'PROBE_TOP_PLANE': runProbeTopPlane,
  'SETUP_CNC_CSY':runSetupCncCsy,
  'PROBE_A': runProbeA,
  'PROBE_B': runProbeB,
  'WRITE_RESULTS': runWriteResults,
}

var commandedState = null;
var actualState = null;

async function setCommandedState(newCommandedState){
  if(['RUN', 'PAUSE', 'STOP'].includes(newCommandedState)){
    commandedState = newCommandedState;
  }
}

async function changeState(newState){
  switch(newState){
    case STATE_RUN:
      await calibRun();
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
    await calibRunNextStage()
  }
  if(commandedState == STATE_RUN){
    await calibRunNextStage()
  }
}

async function cmdRun() {
  await setCommandedState(STATE_RUN);
  if(actualState !== STATE_RUN){
    await calibRun();
  }
}
async function cmdPause() {
  await setCommandedState(STATE_PAUSE);
  if(actualState !== STATE_PAUSE){
    await calibPause();
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

  cmdRun,
  cmdPause,
  cmdStop,
};



/*-----------------------------------------------------------------------------*
                                  UI WebSocket                                  
 *-----------------------------------------------------------------------------*/
const wss = new WebSocketServer({ port: 8081 });

wss.on('connection', function connection(ws) {
  ws.on('message', async function incoming(data) {
    let msg;
    try {
      msg = JSON.parse(data);
      console.log("Message from UI");
      console.log(msg);
      if(Array.isArray(msg)) {
        if(msg.length <= 0 || !commands[msg[0]]) {
          throw "Unknown command.";
        }
      } else {
        throw "Command must be an array.";
      }
    } catch(e) {
      ws.send(JSON.stringify({ error: "" + e }));
      return;
    }
    try {
      const data = await commands[msg[0]].apply(null, msg.slice(1));
      console.log(data)
      ws.send(JSON.stringify({ [msg[0]]: data }));
    } catch(e) {
      console.log('error')
      console.log(e)
      ws.send(JSON.stringify({ [msg[0]]: { error: "" + (e.stderr || e) }}));
    }
  });
});



/*-----------------------------------------------------------------------------*
                              Rockhopper WebSocket                              
 *-----------------------------------------------------------------------------*/
var rockhopperClient = new WebSocketClient();
rockhopperClient.connect('ws://localhost:8000/websocket/');


rockhopperClient.on('connectFailed', function(error) {
  console.log('Connect Error: ' + error.toString());
});


rockhopperClient.on('connect', function(connection) {
  console.log('Connection established!');
  connection.send(JSON.stringify({id: "LOGIN_ID", user: "default", password: 'default', date: new Date(),}));
  connection.send(JSON.stringify({id: "HELLO_WORLD", name: "HELLO WORLD", command:"HELLO WORLD"}));
  connection.send(JSON.stringify({id: "WATCH_INTERP_STATE", name: "interp_state", command:"watch"}));

  rockhopperConnection = connection;

  connection.on('error', function(error) {
      console.log("Connection error: " + error.toString());
  });
  
  connection.on('close', function() {
      console.log('Connection closed!');
  });
  
  connection.on('message', function(message) {
    rockhopperMessage = JSON.parse(message.utf8Data);
    console.log(rockhopperMessage);

    if(rockhopperMessage.id === 'WATCH_INTERP_STATE'){
      //EMC_TASK_INTERP_IDLE = 1,EMC_TASK_INTERP_READING = 2,EMC_TASK_INTERP_PAUSED = 3,EMC_TASK_INTERP_WAITING = 4
      var interpStateVal = rockhopperMessage.data;
      switch(interpStateVal){
        case(1):
          interpIdle = true;
          break;
        default:
          interpIdle = false;
          break;
      }
    }
  });
});



/*-----------------------------------------------------------------------------*
                              CalibManager ZMQ                              
 *-----------------------------------------------------------------------------*/
calibManagerSocket = zmq.socket("pull");

calibManagerSocket.connect("tcp://127.0.0.1:5555");
console.log("calibManagerSocket connected to port 5555");

calibManagerSocket.on("message", async function(msg) {
  console.log("Received ZMQ msg from Calib manager: %s", msg.toString());
  calibStatus = JSON.parse(msg);
  actualState = calibStatus.state;

  if(calibStatus.why === MSG_WHY_STEP_COMPLETE){
    if(commandedState === STATE_RUN && actualState == STATE_IDLE){
      await calibRun();
    }
  }
  else if(calibStatus.why === MSG_WHY_UPDATE){

  }
  else if(calibStatus.why === MSG_WHY_ERROR){

  }

});
