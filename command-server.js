const { WebSocketServer } = require('ws');
const { getServiceStatus } = require('./services');


async function cmdSetProcess(processName) {
  console.log(processName)
  if(!calibProcess.begun && [PROCESS_NEW, PROCESS_RESUME, PROCESS_VERIFY].includes(processName)){
    console.log(processName)
    this.calibProcess.selectedProcess = processName;
  }
}

async function cmdStep(calibProcess) {
  console.log('in cmdStep')
  // console.log('args' + args)
  console.log(calibProcess)
  calibProcess.cmdStep.apply(calibProcess)
}




class CommandServer {
  constructor(
    // rockhopperClient,
    calibProcess
  ) {
    this.wss = new WebSocketServer({ port: 8081 });
    this.connections = [];
    this.calibProcess = calibProcess;
    this.commands = {
      getServiceStatus,

      cmdRun: this.cmdRun,
      cmdStep: this.cmdStep,
      cmdStop: this.cmdStop,
      cmdPause: this.cmdPause,
      cmdResume: this.cmdResume,

      cmdSetProcess,
      // cmdSetSkipCmm,
      // cmdRestart,
      // cmdSetSerial,
    }
    this.processCommands = {
      'cmdRun': calibProcess.cmdRun,
      'cmdStep': calibProcess.cmdStep,
      'cmdPause': calibProcess.cmdPause,
      'cmdStop': calibProcess.cmdStop,
      'cmdGetStatus': calibProcess.getStatus,
    };

    this.wss.on('connection', (ws) => {
      console.log('this.commandServer.connections')
      console.log(this.connections)
      this.connections.push(ws);

      ws.on('close', (reasonCode, description) => {
        console.log("Closing connection");
        const index = this.connections.indexOf(ws);
        if(index > -1) {
          this.connections.splice(index, 1);
        } else {
          console.log("WARNING: closed a connection that we don't have a record of.");
        }
      });

      ws.on('message', async (data) => {
        let msg;
        try {
          msg = JSON.parse(data);
          console.log("Message from UI");
          console.log(msg);
          if(Array.isArray(msg)) {
            console.log("Message is array");
            if(msg.length <= 0 || !( this.commands[msg[0]] || this.processCommands[msg[0]] )) {
              console.log("Message unknown");
              throw "Unknown command from UI.";
            }
          } else {
            throw "Command from UI must be an array.";
          }
        } catch(e) {
          console.log(e)
          console.log("error? sending response");
          ws.send(JSON.stringify({ error: "" + e }));
          return;
        }
        console.log('tried 1')
        try {
          console.log("Command found, running")
          var data;
          if(this.commands[msg[0]]){
            data = await this.commands[msg[0]].apply(this, msg.slice(1));
          }
          else if(this.processCommands[msg[0]]){
            data = await this.processCommands[msg[0]].apply(this.calibProcess, msg.slice(1));
          }
          else{
            console.log('somethings wrong')
          }
          ws.send(JSON.stringify({ [msg[0]]: data }));

        } catch(e) {
          console.log('error running UI command')
          console.log(e)
          ws.send(JSON.stringify({ [msg[0]]: { error: "" + (e.stderr || e) }}));
        }
      });
    });
  }

  isConnected() {
    return (this.connections.length > 0)
  }
  cmdStep() {
    this.calibProcess.cmdStep(...arguments);
  }
  cmdRun() {
    this.calibProcess.cmdRun(...arguments);
  }
  cmdStop() {
    this.calibProcess.cmdStop(...arguments);
  }
  cmdPause() {
    this.calibProcess.cmdPause(...arguments);
  }
  cmdResume() {
    this.calibProcess.cmdResume(...arguments);
  }
  getCalibStatus() {
    console.log('getCalibStatus')
    return this.calibProcess;
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
