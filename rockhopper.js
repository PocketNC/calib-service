const WebSocketClient = require('websocket').client;

class RockhopperClient {
  constructor() {
    this.callbacks = {}
    this.state = {};

    this.connected = false;
    this.intervalConnect = false;

    this.client = new WebSocketClient();
    this.socket = undefined;

    this.client.on('connectFailed', (error) => {
      this.connected = false;
      this.socket = undefined;
      setTimeout(this.connect, 3000);
      console.log('Rockhopper Connect Error: ' + error.toString());
    });

    this.client.on('connect', (socket) => {
      this.connected = true;
      this.socket = socket;
      console.log('Rockhopper Connection established!');

      socket.send(JSON.stringify({id: "LOGIN_ID", user: "default", password: 'default', date: new Date(),}));
      socket.send(JSON.stringify({id: "WATCH_INTERP_STATE", name: "interp_state", command:"watch"}));
      socket.send(JSON.stringify({id: "WATCH_STATE", name: "state", command:"watch"}));
      socket.send(JSON.stringify({id: "WATCH_HOMED", name: "homed", command:"watch"}));

      socket.on('error', (error) => {
        this.connected = false;
        console.log("Rockhopper Connection error: " + error.toString());
      });
      socket.on('close', () => {
        this.connected = false;
        this.socket = undefined;
        this.connect();
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
    });
  }

  genCommandPromise = (msgData) => {
    return new Promise((resolve, reject) => {
      const callback = (msg) => {
        switch(msg.code){
          case('?OK'):
            this.unregisterCallback(msg.id);
            resolve();
          case('?ACK'):
            //skip
          case('?ERROR'):
            this.unregisterCallback(msg.id);
            reject();
        }
      };
      this.registerCallback(msgData.id, callback);
      this.send(JSON.stringify(msgData));
    });
  }

  connect = () => {
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
  
  waitForDoneAndIdle = async (initialTimeout) => {
    console.log(this.state)
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

  runToCompletion = (filename) => {
    const id = "PUT_RUN_TO_COMPLETION_" + Date.now();
    return this.genCommandPromise({
      "0":filename,
      "1":"PROGRAM",
      "id": id,
      "name":"run_to_completion",
      "command":"put",
    });
  }

  programOpenCmd = (filename) => {
    return this.genCommandPromise({
      "0":filename,
      "1":"PROGRAM",
      "id":"PUT_PROGRAM_OPEN_CMD",
      "name":"program_open_cmd",
      "command":"put",
    });
  }

  cycleStart = () => {
    return this.genCommandPromise( {
      "id":"PUT_CYCLE_START_CMD",
      "name":"cycle_start_cmd",
      "command":"put",
    });
  }
  
  // TODO - This one requires more thought as it's going to kill
  // our rockhopper connection
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
    return this.genCommandPromise({
      "0": cmd,
      "id": id,
      "name":"mdi_cmd_async",
      "command":"put",
    })
  }

  homeAxisAsync = (axisIndex) => {
    const id = "PUT_HOME_CMD_ASYNC_" + Date.now();
    return this.genCommandPromise({
      "0": axisIndex,
      "id": id,
      "name":"home_cmd_async",
      "command":"put",
    });
  }

  unhomeAxisAsync = async (axisIndex) => {
    const id = "PUT_UNHOME_CMD_ASYNC_" + Date.now();
    return this.genCommandPromise({
      "0": axisIndex,
      "id": id,
      "name":"unhome_cmd_async",
      "command":"put",
    })
  }


// TODO - Not sure what these are, but I took off async as it wasn't doing anything
  loadStageProgress = (stage) => {
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
  setSkipCmm = (val) => {
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
//

}

module.exports = {
  RockhopperClient
}
