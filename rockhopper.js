const WebSocketClient = require('websocket').client;

class RockhopperClient {
  constructor() {
    this.callbacks = {}
    this.state = {};

    this.connected = false;
    this.intervalConnect = false;

    this.client = new WebSocketClient();
    this.socket = undefined;

    this.alwaysReconnect = (error) => {
      this.connected = false;
      this.socket = undefined;
      setTimeout(this.connect, 3000);
      console.log('Rockhopper Connect Error: ' + error.toString());
    };

    this.client.on('connectFailed', this.alwaysReconnect);

    this.client.on('connect', (socket) => {
      this.connected = true;
      this.socket = socket;
      console.log('Rockhopper Connection established!');

      socket.send(JSON.stringify({id: "LOGIN_ID", user: "default", password: 'default', date: new Date(),}));

      socket.on('error', (error) => {
        this.connected = false;
        console.log("Rockhopper Connection error: " + error.toString());
      });
      this.socketAlwaysReconnect = () => {
        this.connected = false;
        this.socket = undefined;
        this.connect();
        console.log('Rockhopper Connection closed!');
      };
      socket.on('close', this.socketAlwaysReconnect);

      socket.on('message', (data) => {
        const msg = JSON.parse(data.utf8Data);
        console.log("received message", msg);
        if(this.callbacks[msg.id]){
          this.callbacks[msg.id](msg);
        }
      });
    });
  }

  disconnect = () => {
    this.client.off('connectFailed', this.alwaysReconnect);
    this.socket.off('close', this.socketAlwaysReconnect);
    this.socket.close();
  }

  genCommandPromise = (msgData) => {
    return new Promise((resolve, reject) => {
      const callback = (msg) => {
        if(msg.code === '?OK') {
          this.unregisterCallback(msg.id);
          resolve();
        } else {
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
  };

  // TODO - restructure always connect implementation/api
  // for now this isn't used except for when testing/debugging
  successfulConnection = () => {
    return new Promise((resolve) => {
      const unregisterAndResolve = () => {
        this.client.off("connect", unregisterAndResolve);
        resolve();
      }

      this.client.on("connect", unregisterAndResolve);
    })
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

  runToCompletion = (filename, type="CALIBRATION") => {
    const id = "PUT_RUN_TO_COMPLETION_" + Date.now();
    return this.genCommandPromise({
      "0":filename,
      "1":type,
      "id": id,
      "name":"run_to_completion",
      "command":"put",
    });
  }

  watch = (name, id, callback) => {
    const msgData = {
      id,
      name,
      command: "watch",
    };
    this.registerCallback(msgData.id, callback);
    this.send(JSON.stringify(msgData));
  }

  unwatch = (name, id) => {
    const msgData = {
      id,
      name,
      command: "unwatch",
    };
    this.unregisterCallback(msgData.id);
    this.send(JSON.stringify(msgData));
  }


  programOpenCmd = (filename, type="CALIBRATION") => {
    console.log("programOpenCm", filename, type)
    return this.genCommandPromise({
      "0":filename,
      "1":type,
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
