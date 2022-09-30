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
      });
    });
  }

  genCommandPromise = (msgData) => {
    return new Promise((resolve, reject) => {
      const callback = (msg) => {
        switch(msg.code){
          case('?OK'):
            this.unregisterCallback(id);
            resolve();
          case('?ACK'):
            //skip
          case('?ERROR'):
            this.unregisterCallback(id);
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
