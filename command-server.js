const { WebSocketServer } = require('ws');
const { getServiceStatus } = require('./services');

async function getCalibStatus() {
  return this.calibProcess;
}

async function cmdSetProcess(processName) {
  console.log(processName)
  if(!calibProcess.begun && [PROCESS_NEW, PROCESS_RESUME, PROCESS_VERIFY].includes(processName)){
    console.log(processName)
    this.calibProcess.selectedProcess = processName;
  }
}

async function cmdRun() {
  await setCommandedState(STATE_RUN);
  if(actualState !== STATE_RUN){
    await runCalib();
  }
}


class CommandServer {
  constructor({ 
    rockhopperClient,
    calibProcess
  }) {
    this.wss = new WebSocketServer({ port: 8081 });
    this.connections = [];
    this.commands = {
      getServiceStatus,
      getCalibStatus,
      cmdSetProcess,
      cmdRun,
      cmdStep,
      cmdPause,
      cmdStop,
      cmdSetSkipCmm,
      cmdRestart,
      cmdSetSerial,
    };

    this.rockhopperClient = rockhopperClient;
    this.calibProcess = calibProcess;

    wss.on('connection', function connection(ws) {
      this.connections.append(ws);

      ws.on('close', function(reasonCode, description) {
        console.log("Closing connection");
        const index = this.connections.indexOf(ws);
        if(index > -1) {
          this.connections.splice(index, 1);
        } else {
          console.log("WARNING: closed a connection that we don't have a record of.");
        }
      });

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
          const data = await commands[msg[0]].apply(this, msg.slice(1));
          // console.log(data)
          ws.send(JSON.stringify({ [msg[0]]: data }));

        } catch(e) {
          console.log('error running UI command')
          console.log(e)
          ws.send(JSON.stringify({ [msg[0]]: { error: "" + (e.stderr || e) }}));
        }
      });
    });
  }

  send(msg) {
    this.connections.forEach((ws) => {
      ws.send(JSON.stringify(msg));
    });
  }
}

module.exports = {
  CommandServer
};
